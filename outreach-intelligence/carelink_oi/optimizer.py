"""Constraint-aware outreach scheduling with Google OR-Tools CP-SAT (mathematical optimisation, not ML).

Formulation (exact for the enumerated trips):
- A trip is a round route from the facility through 1..max_stops communities. For each subset of
  communities the shortest visiting order is precomputed from the documented travel matrix.
- x[w,d,r] = 1 if worker w makes trip r on day d. At most one trip per worker per day, so nobody
  is in two places at once.
- y[w,d,c] = routine follow-up items served in community c (only on a trip that visits c, and at
  least one if it visits), split by visit type: y[w,d,c,t] for household requests, ANC, PNC and CWC
  follow-ups (or one "routine" type when the demand has no breakdown). A worker serves only the
  types they are qualified for.
- Time: trip travel + setup per stop + the configured minutes for each visit type x items <= the
  worker's hours that day. Minutes per type are operational planning assumptions, not clinical rules.
- Transport: trips per day <= vehicles available that day (each trip needs its own vehicle; no
  trip without one).
- Demand: items served per community <= its documented pending items.
- Confirmed assignments are fixed and may not be dropped; minimum-coverage policies are hard.
- Supplies, equipment and fuel (optional "inventory", "requirements", "fuel"; carelink_oi.readiness):
  consumables used per visit type <= usable stock; workers offering a type that needs equipment on a
  day <= equipment on hand; travel minutes x litres per minute <= usable fuel. Only simulated or
  confirmed, fresh quantities are usable; unknown or stale ones count as zero and are reported.
Objective: maximise weighted items served, where the weight adds fairness for communities with
high transport barriers or poor data coverage, and growth from the demand estimate; minus a travel
penalty; plus continuity for communities in the previous plan. Weights are configurable policy.
If the constraints cannot all hold, the result is INFEASIBLE and no plan is produced.
"""
from __future__ import annotations

import copy
import datetime as dt
from itertools import combinations, permutations

from ortools.sat.python import cp_model

from . import PLANNER_VERSION

SCALE = 1000
DEFAULT_POLICY = {
    "fairness_weight": 0.5,       # extra weight per item for barrier / poor data coverage (0..1 index)
    "growth_weight": 0.3,         # extra weight when the estimate is above recent weekly average
    "travel_penalty_per_minute": 0.01,
    "continuity_bonus": 0.5,      # per community kept from the previous plan
    "previous_plan_communities": [],
    "min_coverage": {"enabled": False, "communities": [], "min_followups": 1},
    # How the underserved index is built (weights are normalised). The defaults reproduce the original
    # rule (barrier and reporting gap only); planning/tolon-district.json can add the coverage terms.
    "underserved_components": {"barrier": 0.5, "reporting_gap": 0.5, "outreach_gap": 0.0, "unserved_planned": 0.0},
    "outreach_grace_days": 14, "outreach_full_gap_days": 60, "unserved_planned_cap": 5,
}


class PlanningError(ValueError):
    pass


DAY_NAMES = {"mon": "Monday", "tue": "Tuesday", "wed": "Wednesday", "thu": "Thursday", "fri": "Friday", "sat": "Saturday", "sun": "Sunday"}
VISIT_TYPES = {"routine": "routine item", "request": "household request", "anc": "ANC follow-up",
               "pnc": "PNC follow-up", "cwc": "child welfare follow-up"}


def pending_by_type(demand: list[dict]) -> dict[str, dict[str, int]]:
    """Documented items per community and visit type; anything without a type is "routine"."""
    out = {}
    for d in demand:
        typed = {t: int(n) for t, n in (d.get("by_type") or {}).items() if int(n) > 0}
        rest = int(d["pending"]) - sum(typed.values())
        if rest > 0:
            typed["routine"] = typed.get("routine", 0) + rest
        out[d["community_id"]] = typed
    return out


def minutes_for(service: dict, visit_type: str) -> int:
    return int((service.get("minutes_by_type") or {}).get(visit_type, service["minutes_per_followup"]))


def qualified(worker: dict, visit_type: str) -> bool:
    """Any worker may serve untyped routine items; typed visits need the matching qualification."""
    quals = worker.get("qualifications")
    return visit_type == "routine" or quals is None or visit_type in quals


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def travel_lookup(matrix: dict):
    def travel(a: str, b: str) -> int:
        if a == b:
            return 0
        value = matrix.get(a, {}).get(b, matrix.get(b, {}).get(a))
        if value is None:
            # Never infer road time from straight-line distance: a missing estimate is an input error.
            raise PlanningError(f"No documented travel time between {a} and {b}")
        return int(value)
    return travel


def trip_options(communities: list[str], travel, facility: str, max_stops: int) -> list[dict]:
    from .routing import ENUMERATE_UP_TO, shortest_round_trip
    options = []
    for k in range(1, min(max_stops, len(communities)) + 1):
        for subset in combinations(sorted(communities), k):
            if k > ENUMERATE_UP_TO:  # too many orders to try: OR-Tools routing sequences the stops
                options.append(shortest_round_trip(facility, list(subset), travel))
                continue
            best = None
            for order in permutations(subset):
                legs = [travel(facility, order[0])] + [travel(a, b) for a, b in zip(order, order[1:])] + [travel(order[-1], facility)]
                if best is None or (sum(legs), order) < (best["travel"], best["stops"]):
                    best = {"stops": order, "travel": sum(legs), "legs": legs}
            options.append(best)
    return options


def priorities(demand: list[dict], policy: dict) -> dict[str, dict]:
    """Per-community weight, with its parts, so the explanation can show exactly why."""
    out = {}
    for d in demand:
        barrier = {"high": 1.0, "low": 0.0}.get(d.get("barrier_level"), 0.5)
        coverage_gap = 1.0 - float(d.get("data_coverage", 1.0))
        # Days without documented outreach beyond a grace period (no outreach recorded at all counts as a full gap
        # only when the export says so; unknown is neutral), and planned work that past outreach days left undone.
        since = d.get("days_since_outreach", "unknown")
        grace, full = policy["outreach_grace_days"], max(policy["outreach_full_gap_days"], policy["outreach_grace_days"] + 1)
        outreach_gap = 1.0 if since is None else 0.0 if since == "unknown" else min(1.0, max(0.0, (since - grace) / (full - grace)))
        unserved = min(1.0, float(d.get("unserved_planned", 0)) / max(1, policy["unserved_planned_cap"]))
        parts = {"barrier": barrier, "reporting_gap": coverage_gap, "outreach_gap": outreach_gap, "unserved_planned": unserved}
        weights = policy["underserved_components"]
        underserved = round(sum(weights.get(k, 0) * v for k, v in parts.items()) / max(sum(weights.values()), 1e-9), 3)
        recent, est = d.get("recent_mean"), d.get("estimate")
        growth = round(min(1.0, max(0.0, (est - recent) / max(recent, 1.0))), 3) if recent is not None and est is not None else 0.0
        weight = round(1.0 + policy["fairness_weight"] * underserved + policy["growth_weight"] * growth, 3)
        out[d["community_id"]] = {"weight": weight, "underserved_index": underserved, "barrier": barrier,
                                  "coverage_gap": round(coverage_gap, 3), "growth": growth,
                                  "outreach_gap": round(outreach_gap, 3), "unserved_planned": round(unserved, 3)}
    return out


def solve(demand: list[dict], resources: dict, policy: dict | None = None, *, extra=None, time_limit: float = 10.0) -> dict:
    """demand: [{community_id, name, pending, barrier_level, data_coverage, estimate, recent_mean}]."""
    policy = {**DEFAULT_POLICY, **(policy or {})}
    travel = travel_lookup(resources["travel_minutes"])
    facility = resources["facility"]
    service = resources["service"]
    pending = {d["community_id"]: int(d["pending"]) for d in demand}
    typed = pending_by_type(demand)
    names = {d["community_id"]: d.get("name", d["community_id"]) for d in demand}
    prio = priorities(demand, policy)
    days = list(resources["planning_days"])
    workers = {w["id"]: w for w in resources["workers"]}
    vehicles_on = {d: [v["id"] for v in resources["vehicles"] if d in v["available_days"]] for d in days}
    allowed = {wid: [c for c in pending if not w.get("communities") or c in w["communities"]] for wid, w in workers.items()}
    for a in resources.get("confirmed_assignments", []):
        if a["worker"] not in workers or a["community"] not in pending or a["day"] not in days:
            raise PlanningError(f"Confirmed assignment refers to an unknown worker, community or day: {a}")

    model = cp_model.CpModel()
    x, y, trip_of, yt_ = {}, {}, {}, {}
    for wid, w in workers.items():
        for day in days:
            if day not in w["available_days"]:
                continue
            opts = trip_options([c for c in allowed[wid] if pending[c] > 0 or _confirmed(resources, wid, day, c)],
                                travel, facility, resources.get("max_stops_per_trip", 3))
            hours = _minutes(w["hours"]["end"]) - _minutes(w["hours"]["start"])
            xs = []
            for i, o in enumerate(opts):
                quickest = min([minutes_for(service, vt) for c in o["stops"] for vt in typed[c] if qualified(w, vt)] or [service["minutes_per_followup"]])
                if o["travel"] + service["setup_minutes_per_stop"] * len(o["stops"]) + quickest > hours:
                    continue
                var = model.NewBoolVar(f"x_{wid}_{day}_{i}")
                x[(wid, day, i)] = var
                trip_of[(wid, day, i)] = o
                xs.append((var, o))
            if not xs:
                continue
            model.Add(sum(v for v, _ in xs) <= 1)
            service_minutes = []
            for c in allowed[wid]:
                visits = [v for v, o in xs if c in o["stops"]]
                yv = model.NewIntVar(0, pending[c], f"y_{wid}_{day}_{c}")
                y[(wid, day, c)] = yv
                parts = []
                for vt, n in typed[c].items():
                    yt = model.NewIntVar(0, n if qualified(w, vt) else 0, f"y_{wid}_{day}_{c}_{vt}")
                    yt_[(wid, day, c, vt)] = yt
                    parts.append(yt)
                    service_minutes.append(minutes_for(service, vt) * yt)
                model.Add(yv == sum(parts))
                if visits:
                    model.Add(yv <= pending[c] * sum(visits))
                    model.Add(yv >= sum(visits))
                else:
                    model.Add(yv == 0)
            model.Add(sum(v * (o["travel"] + service["setup_minutes_per_stop"] * len(o["stops"])) for v, o in xs)
                      + sum(service_minutes) <= hours)
    for day in days:
        trips = [v for (wid, d, i), v in x.items() if d == day]
        if trips:
            model.Add(sum(trips) <= len(vehicles_on[day]))
    total = {c: sum(v for (wid, d, cc), v in y.items() if cc == c) for c in pending}
    for c in pending:
        model.Add(total[c] <= pending[c])
        for vt, n in typed[c].items():
            model.Add(sum(v for (wid, d, cc, tt), v in yt_.items() if cc == c and tt == vt) <= n)
    visited = {c: sum(v for k, v in x.items() if c in trip_of[k]["stops"]) for c in pending}
    infeasible_reasons = []
    for a in resources.get("confirmed_assignments", []):
        key = [v for k, v in x.items() if k[0] == a["worker"] and k[1] == a["day"] and a["community"] in trip_of[k]["stops"]]
        if not key:
            infeasible_reasons.append(_confirmed_reason(a, workers, vehicles_on, travel, facility, service, names))
            continue
        model.Add(sum(key) == 1)
        model.Add(y[(a["worker"], a["day"], a["community"])] >= int(a.get("min_followups", 1)))
    cov = policy["min_coverage"]
    if cov.get("enabled"):
        for c in cov.get("communities", []):
            if c in pending:
                model.Add(total[c] >= min(int(cov.get("min_followups", 1)), pending[c]))
    inventory = resources.get("inventory") or {}
    needs = resources.get("requirements") or {}
    fuel = resources.get("fuel")
    scale = 100
    # A required resource with no readiness entry counts as zero: never assumed available.
    required = {rid for spec in needs.values() for rid in list(spec.get("consumables", {})) + list(spec.get("equipment", []))}
    for rid in required - set(inventory):
        inventory = {**inventory, rid: {"name": rid, "unit": "", "available": 0.0, "status": "unknown", "category": "unknown"}}
    resources = {**resources, "inventory": inventory}
    for rid, item in inventory.items():
        terms = [int(round(needs.get(vt, {}).get("consumables", {}).get(rid, 0) * scale)) * v for (wid, d, c, vt), v in yt_.items()
                 if needs.get(vt, {}).get("consumables", {}).get(rid)]
        if terms:
            model.Add(sum(terms) <= int(item["available"] * scale))
    # Equipment: a worker offers a visit type that day only if a set is free for them.
    carries = {}
    for (wid, d, c, vt), v in yt_.items():
        for rid in needs.get(vt, {}).get("equipment", []):
            key = (wid, d, rid)
            if key not in carries:
                carries[key] = model.NewBoolVar(f"carry_{wid}_{d}_{rid}")
            model.Add(v <= pending[c] * carries[key])
    for d in days:
        for rid in {k[2] for k in carries}:
            model.Add(sum(u for (wid, dd, r), u in carries.items() if dd == d and r == rid) <= int((inventory.get(rid) or {}).get("available", 0)))
    if fuel:
        litres = (inventory.get(fuel["resource"]) or {}).get("available", 0)
        model.Add(sum(v * int(round(trip_of[k]["travel"] * fuel["litres_per_travel_minute"] * 1000)) for k, v in x.items()) <= int(litres * 1000))
    if extra:
        extra(model, x, y, trip_of, total, visited)

    travel_total = sum(v * trip_of[k]["travel"] for k, v in x.items())
    objective = (sum(int(round(prio[c]["weight"] * SCALE)) * total[c] for c in pending)
                 - int(round(policy["travel_penalty_per_minute"] * SCALE)) * travel_total
                 + sum(int(round(policy["continuity_bonus"] * SCALE)) * visited[c] for c in policy["previous_plan_communities"] if c in pending))
    model.Maximize(objective)

    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.max_time_in_seconds = time_limit
    status = solver.Solve(model)
    base = {"planner_version": PLANNER_VERSION, "solver": f"OR-Tools CP-SAT", "policy": policy, "priorities": prio,
            "names": names, "pending": pending, "pending_by_type": typed, "days": days}
    if infeasible_reasons or status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        if not infeasible_reasons:
            infeasible_reasons = _diagnose(demand, resources, policy, workers, vehicles_on, travel, facility, service, names)
        return {**base, "status": "INFEASIBLE", "reasons": infeasible_reasons, "trips": [], "served": {}, "unserved": {}}

    trips = []
    used_vehicles = {d: 0 for d in days}
    for (wid, day, i), var in sorted(x.items(), key=lambda kv: (kv[0][1], kv[0][0], kv[0][2])):
        if not solver.Value(var):
            continue
        o = trip_of[(wid, day, i)]
        served = {c: solver.Value(y[(wid, day, c)]) for c in o["stops"]}
        by_type = {c: {vt: solver.Value(yt_[(wid, day, c, vt)]) for vt in typed[c] if solver.Value(yt_[(wid, day, c, vt)])} for c in o["stops"]}
        hours = _minutes(workers[wid]["hours"]["end"]) - _minutes(workers[wid]["hours"]["start"])
        service_min = service["setup_minutes_per_stop"] * len(o["stops"]) + sum(minutes_for(service, vt) * n for c in o["stops"] for vt, n in by_type[c].items())
        vehicle = vehicles_on[day][used_vehicles[day]]
        used_vehicles[day] += 1
        trips.append({"worker": wid, "worker_name": workers[wid]["name"], "day": day, "vehicle": vehicle,
                      "route": ["facility", *o["stops"], "facility"], "legs_minutes": o["legs"], "served": served, "served_by_type": by_type,
                      "travel_minutes": o["travel"], "service_minutes": service_min,
                      "total_minutes": o["travel"] + service_min, "available_minutes": hours,
                      "slack_minutes": hours - o["travel"] - service_min})
    served = {c: int(solver.Value(total[c])) for c in pending}
    served_typed = {c: {vt: sum(t["served_by_type"].get(c, {}).get(vt, 0) for t in trips) for vt in typed[c]} for c in pending}
    usage = resource_usage(resources, trips, served_typed)
    return {**base, "served_by_type": served_typed, "resource_usage": usage,
            "unserved_by_type": {c: {vt: n - served_typed[c][vt] for vt, n in typed[c].items() if n - served_typed[c][vt]} for c in pending}, "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
            "objective": round(solver.ObjectiveValue() / SCALE, 3), "trips": trips, "served": served,
            "unserved": {c: pending[c] - served[c] for c in pending},
            "weighted_served": round(sum(prio[c]["weight"] * served[c] for c in pending), 2),
            "travel_minutes": sum(t["travel_minutes"] for t in trips), "vehicles_on": vehicles_on,
            "idle_workers": {d: [w for w in workers if d in workers[w]["available_days"] and not any(t["worker"] == w and t["day"] == d for t in trips)] for d in days}}


def resource_usage(resources: dict, trips: list[dict], served_typed: dict) -> dict:
    """Planned use per resource: a plan allocation, never a deduction from stock."""
    inventory, needs, fuel = resources.get("inventory") or {}, resources.get("requirements") or {}, resources.get("fuel")
    out = {}
    for rid, item in inventory.items():
        planned = 0.0
        for types in served_typed.values():
            for vt, n in types.items():
                planned += n * needs.get(vt, {}).get("consumables", {}).get(rid, 0)
        if any(rid in needs.get(vt, {}).get("equipment", []) for vt in needs):
            planned = max(sum(1 for t in trips if any(rid in needs.get(vt, {}).get("equipment", []) for c in t["served_by_type"] for vt in t["served_by_type"][c]) and t["day"] == d)
                          for d in {t["day"] for t in trips}) if trips else 0
        if fuel and fuel["resource"] == rid:
            planned = round(sum(t["travel_minutes"] for t in trips) * fuel["litres_per_travel_minute"], 2)
        used = any(rid in needs.get(vt, {}).get("equipment", []) or rid in needs.get(vt, {}).get("consumables", {}) for vt in needs) or (fuel and fuel["resource"] == rid)
        if used:
            out[rid] = {"name": item["name"], "unit": item["unit"], "planned": round(planned, 2), "available": item["available"],
                        "status": item["status"], "verified_at": item.get("verified_at"), "source": item.get("source"),
                        "binding": item["available"] - planned < 1e-6}
    return out


def resource_reasons(resources: dict, result: dict, visit_type: str) -> list[str]:
    """Why a visit type was left unserved for resource reasons, from readiness and planned use only."""
    needs = (resources.get("requirements") or {}).get(visit_type, {})
    inventory, usage = resources.get("inventory") or {}, result.get("resource_usage", {})
    out = []
    for rid in list(needs.get("consumables", {})) + list(needs.get("equipment", [])):
        item = inventory.get(rid, {"name": rid, "status": "unknown", "available": 0, "unit": ""})
        if item["status"] in ("unknown", "stale"):
            out.append(f"{item['name']} availability is {item['status']} (needs confirmation before it can be planned)")
        elif item["status"] == "unavailable" or item["available"] <= 0:
            out.append(f"{item['name']} is recorded as unavailable")
        elif usage.get(rid, {}).get("binding"):
            out.append(f"limited by {item['name']} ({item['available']:g} {item['unit']} usable, all planned)")
    return out


def _confirmed(resources, wid, day, c):
    return any(a["worker"] == wid and a["day"] == day and a["community"] == c for a in resources.get("confirmed_assignments", []))


def _confirmed_reason(a, workers, vehicles_on, travel, facility, service, names):
    w = workers[a["worker"]]
    if a["day"] not in w["available_days"]:
        return f"Confirmed assignment: {w['name']} is not available on {a['day']}."
    if not vehicles_on[a["day"]]:
        return f"Confirmed assignment: no vehicle is available on {a['day']}."
    hours = _minutes(w["hours"]["end"]) - _minutes(w["hours"]["start"])
    need = 2 * travel(facility, a["community"]) + service["setup_minutes_per_stop"] + service["minutes_per_followup"] * int(a.get("min_followups", 1))
    return (f"Confirmed assignment for {names[a['community']]} needs at least {need} minutes "
            f"(round trip {2 * travel(facility, a['community'])} + setup {service['setup_minutes_per_stop']} + "
            f"{a.get('min_followups', 1)} x {service['minutes_per_followup']}), but {w['name']} has {hours} minutes.")


def _diagnose(demand, resources, policy, workers, vehicles_on, travel, facility, service, names):
    pending = {d["community_id"]: int(d["pending"]) for d in demand}
    reasons = [_confirmed_reason(a, workers, vehicles_on, travel, facility, service, names) for a in resources.get("confirmed_assignments", [])]
    # A commitment can ask for more items than are now documented (for example after some were completed).
    for a in resources.get("confirmed_assignments", []):
        if int(a.get("min_followups", 1)) > pending.get(a["community"], 0):
            reasons.append(f"A confirmed assignment in {names.get(a['community'], a['community'])} on {a['day']} requires "
                           f"{a.get('min_followups', 1)} item(s), but only {pending.get(a['community'], 0)} documented item(s) are pending there.")
    trips_needed = len({(a["worker"], a["day"]) for a in resources.get("confirmed_assignments", [])})
    for day in resources["planning_days"]:
        confirmed_today = len({a["worker"] for a in resources.get("confirmed_assignments", []) if a["day"] == day})
        if confirmed_today > len(vehicles_on[day]):
            reasons.append(f"{confirmed_today} confirmed trips on {day} but only {len(vehicles_on[day])} vehicle(s).")
    if policy["min_coverage"].get("enabled"):
        reasons.append("The minimum-coverage policy for " + ", ".join(names.get(c, c) for c in policy["min_coverage"]["communities"])
                       + " cannot be met together with the other constraints.")
        # Name the resources that block the guaranteed communities' visit types.
        typed = pending_by_type(demand)
        for c in policy["min_coverage"]["communities"]:
            for vt in typed.get(c, {}):
                for why in resource_reasons(resources, {}, vt):
                    reasons.append(f"{names.get(c, c)}: {VISIT_TYPES.get(vt, vt)} visits cannot be planned: {why}.")
    return reasons or [f"No plan satisfies all constraints ({trips_needed} confirmed trips)."]


def counterfactual_more(demand, resources, policy, base: dict, community: str) -> dict:
    """Re-solve requiring one more served item in `community`: why was it not served?"""
    need = base["served"][community] + 1

    def require(model, x, y, trip_of, total, visited):
        model.Add(total[community] >= need)
    alt = solve(demand, resources, policy, extra=require)
    if alt["status"] == "INFEASIBLE":
        return {"feasible": False}
    return {"feasible": True, "weighted_served": alt["weighted_served"], "served": alt["served"],
            "travel_minutes": alt["travel_minutes"]}


def alternatives(demand, resources, policy, base: dict, k: int = 2) -> list[dict]:
    """Next-best feasible plans, each with a different set of trips (no-good cuts)."""
    # Plans are compared by (day, route) regardless of which worker drives it, so swapping two
    # equivalent workers on the same route is not offered as an "alternative".
    seen = [{(t["day"], tuple(t["route"])) for t in base["trips"]}]
    out = []
    for _ in range(k):
        def exclude(model, x, y, trip_of, total, visited, seen=list(seen)):
            for plan in seen:
                uses = []
                for day, route in plan:
                    same = [v for key, v in x.items() if key[1] == day and ("facility", *trip_of[key]["stops"], "facility") == route]
                    if not same:
                        break
                    flag = model.NewBoolVar("")
                    model.Add(sum(same) >= 1).OnlyEnforceIf(flag)
                    model.Add(sum(same) == 0).OnlyEnforceIf(flag.Not())
                    uses.append(flag)
                else:
                    model.Add(sum(uses) <= len(uses) - 1)
        alt = solve(demand, resources, policy, extra=exclude)
        if alt["status"] == "INFEASIBLE" or not alt["trips"]:
            break
        out.append(alt)
        seen.append({(t["day"], tuple(t["route"])) for t in alt["trips"]})
    return out


def what_if(demand, resources, policy, base: dict) -> list[dict]:
    """Would more hours or transport serve more documented items? Reported, never assumed."""
    out = []
    longer = copy.deepcopy(resources)
    for w in longer["workers"]:
        end = _minutes(w["hours"]["end"]) + 60
        w["hours"]["end"] = f"{end // 60:02d}:{end % 60:02d}"
    more_vehicle = copy.deepcopy(resources)
    more_vehicle["vehicles"].append({"id": "extra-vehicle", "name": "One more vehicle (hypothetical)", "available_days": list(resources["planning_days"])})
    options = [("one more working hour for each worker", longer), ("one more vehicle each day", more_vehicle)]
    # Supplies, equipment and fuel that bound this plan: what if 50% more were confirmed? (hypothetical)
    for rid, u in (base.get("resource_usage") or {}).items():
        if u["binding"] and u["status"] in ("simulated", "confirmed") and sum(base.get("unserved", {}).values()):
            more = copy.deepcopy(resources)
            item = more["inventory"][rid]
            item["available"] = max(item["available"] * 1.5, item["available"] + 1)
            options.append((f"{item['available'] - u['available']:g} more {u['unit']} of {u['name']} (hypothetical)", more))
    for label, res in options:
        alt = solve(demand, res, policy)
        if alt["status"] != "INFEASIBLE":
            gain = sum(alt["served"].values()) - sum(base["served"].values())
            out.append({"change": label, "extra_items_served": gain, "served": alt["served"]})
    return out


def explain(demand, resources, policy, result: dict) -> dict:
    """Plain-language explanation built only from the solver's inputs and outputs."""
    names = result["names"]
    if result["status"] == "INFEASIBLE":
        return {"summary": "No feasible plan: the constraints cannot all be met. Nothing was scheduled.",
                "reasons": result["reasons"], "communities": {}, "binding": [], "needs_more_resources": None}
    prio = result["priorities"]
    service = resources["service"]
    lines, binding = {}, []
    visits = {}
    for t in result["trips"]:
        for c, n in t["served"].items():
            visits.setdefault(c, []).append(f"{t['worker_name']} on {t['day']}: {n} item(s)")
    for c, trips in visits.items():
        p = prio[c]
        why = [f"{result['pending'][c]} documented routine follow-up item(s) pending"]
        if p["barrier"] >= 1:
            why.append("high reported transport barrier")
        if p["coverage_gap"] >= 0.25:
            why.append(f"only {round((1 - p['coverage_gap']) * 100)}% of recent weeks reported (possible access gap)")
        if p["growth"] > 0:
            why.append("estimated demand above its recent average")
        n = result["served"][c]
        covered = "all" if n == result["pending"][c] else f"{n} of {result['pending'][c]}"
        lines[c] = (f"{names[c]} is included ({'; '.join(trips)}): {', '.join(why)}. "
                    f"Covers {covered} item(s); priority weight {p['weight']}.")
    # The shortest visit still left unmet: a day with less slack than that is full.
    unmet_types = {vt for types in result.get("unserved_by_type", {}).values() for vt in types}
    shortest = min([minutes_for(service, vt) for vt in unmet_types] or [service["minutes_per_followup"]])
    for t in result["trips"]:
        if t["slack_minutes"] < shortest:
            binding.append(f"Working hours: {t['worker_name']}'s day on {t['day']} is full "
                           f"({t['total_minutes']} of {t['available_minutes']} minutes).")
    for day in result["days"]:
        if result["idle_workers"][day] and len(result["vehicles_on"][day]) == sum(t["day"] == day for t in result["trips"]):
            idle = ", ".join(resources_name(resources, w) for w in result["idle_workers"][day])
            binding.append(f"Transport: {idle} available on {day}, but every vehicle is already in use.")
        if not result["vehicles_on"][day]:
            binding.append(f"Transport: no vehicle available on {day}, so no trip is possible.")
    for c, left in result["unserved"].items():
        if not left:
            continue
        cf = counterfactual_more(demand, resources, policy, result, c)
        p = prio[c]
        what = "is deferred" if result["served"][c] == 0 else f"is partly covered ({result['served'][c]} of {result['pending'][c]})"
        if not cf["feasible"]:
            reason = (f"no available worker, vehicle and working time can reach it (round trip "
                      f"{2 * travel_lookup(resources['travel_minutes'])(resources['facility'], c)} minutes plus visits)")
        else:
            reason = (f"covering one more item there would lower the weighted items served from "
                      f"{result['weighted_served']} to {cf['weighted_served']} (travel {result['travel_minutes']} → {cf['travel_minutes']} min), "
                      f"so time is better spent where more documented items can be covered")
        note = f"{names[c]} {what}: {reason}. {left} item(s) remain visible for the next planning cycle."
        for vt, n in result.get("unserved_by_type", {}).get(c, {}).items():
            if vt != "routine" and not any(qualified(w, vt) and set(w["available_days"]) & set(result["days"]) for w in resources["workers"]):
                note += f" {n} {VISIT_TYPES.get(vt, vt)}(s) cannot be planned: no available worker is qualified for them."
            for why in resource_reasons(resources, result, vt):
                note += f" {n} {VISIT_TYPES.get(vt, vt)}(s) not planned: {why}."
        if result["served"][c] == 0 and p["underserved_index"] >= 0.5:
            note += " It has high access barriers or poor reporting: consider the minimum-coverage policy."
        lines[c] = f"{lines[c]} {note}" if c in lines else note
    extra = what_if(demand, resources, policy, result)
    unmet = sum(result["unserved"].values())
    summary = (f"Covers {sum(result['served'].values())} of {sum(result['pending'].values())} documented routine items "
               f"with {len(result['trips'])} trip(s); {unmet} remain unmet.")
    totals = {}
    for c, types in result.get("pending_by_type", {}).items():
        for vt, n in types.items():
            got = result["served_by_type"][c].get(vt, 0)
            totals[vt] = (totals.get(vt, (0, 0))[0] + got, totals.get(vt, (0, 0))[1] + n)
    if set(totals) - {"routine"}:
        summary += " By visit type: " + ", ".join(f"{VISIT_TYPES.get(vt, vt)} {got} of {n}" for vt, (got, n) in sorted(totals.items())) + "."
    # The facility's weekly calendar (traceable to its configured source).
    cal = resources.get("calendar")
    if cal and cal["activity"] != "outreach":
        usual = ", ".join(DAY_NAMES.get(d, d) for d in cal["outreach_days"]) or "no day"
        if cal["enforced"]:
            binding.append(f"Calendar: {DAY_NAMES.get(cal['weekday'], cal['weekday'])} is kept for {cal['activity']}; outreach is planned on {usual}. "
                           "Choose an outreach day, or change the calendar with the facility.")
        else:
            binding.append(f"Calendar warning: {DAY_NAMES.get(cal['weekday'], cal['weekday'])} is usually {cal['activity']} at this facility; "
                           f"its usual outreach day is {usual} ({cal['verification_status']} calendar, not enforced).")
    # Supplies, equipment and fuel: planned use against what is usable, and what needs confirming.
    resource_lines, confirm = [], []
    for rid, u in result.get("resource_usage", {}).items():
        label = {"simulated": "simulated value", "confirmed": f"confirmed {u.get('verified_at') or ''}".strip()}.get(u["status"], u["status"])
        resource_lines.append(f"{u['name']}: {u['planned']:g} of {u['available']:g} {u['unit']} usable planned ({label}).")
        if u["binding"] and unmet:
            binding.append(f"Resources: {u['name']} is fully used by this plan ({u['available']:g} {u['unit']}).")
        if u["status"] in ("unknown", "stale"):
            confirm.append(f"{u['name']} ({u['status']}): confirm availability to plan the services that need it.")
    fuel = resources.get("fuel")
    if fuel and unmet and fuel["resource"] in result.get("resource_usage", {}):
        u = result["resource_usage"][fuel["resource"]]
        travel = travel_lookup(resources["travel_minutes"])
        # Fuel binds when what is left cannot cover a round trip to any community with unmet work.
        cheapest = min((2 * travel(resources["facility"], c) * fuel["litres_per_travel_minute"] for c, left in result["unserved"].items() if left), default=0)
        if u["binding"] or u["available"] - u["planned"] < cheapest:
            binding.append(f"Fuel: {u['available'] - u['planned']:g} {u['unit']} left after this plan, less than the "
                           f"{cheapest:g} {u['unit']} the nearest round trip to unmet work needs.")
    return {"summary": summary, "communities": lines, "binding": binding or ["No single constraint is fully used."],
            "resources": resource_lines, "needs_confirmation": confirm,
            "what_if": extra, "needs_more_resources": [e for e in extra if e["extra_items_served"] > 0] if unmet else []}


def resources_name(resources, worker_id):
    return next((w["name"] for w in resources["workers"] if w["id"] == worker_id), worker_id)
