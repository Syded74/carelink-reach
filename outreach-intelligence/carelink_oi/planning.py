"""Connects the demand estimate to the optimiser and builds a complete, explained plan."""
from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path

from . import FORECAST_VERSION, PLANNER_VERSION, forecast, optimizer, synthetic, readiness
from .data_adapter import Dataset

DEFAULT_SERVICE = {"setup_minutes_per_stop": 20, "minutes_per_followup": 15}


def demand_from(estimate: dict) -> list[dict]:
    """Planning demand = documented pending routine items now. The estimate only adjusts priority."""
    out = []
    for c in estimate["communities"]:
        cur = c["current"] or {}
        out.append({"community_id": c["community_id"], "name": c["community"], "pending": int(cur.get("pending_followups", 0)),
                    "urgent_items_excluded": int(cur.get("urgent_items_excluded", 0)), "barrier_level": c["barrier_level"],
                    "data_coverage": c["data_coverage_12w"], "estimate": c["estimate"], "recent_mean": c["recent_mean"],
                    "last_visit": cur.get("last_visit"),
                    # Where the documented workload comes from (counts only), shown next to the estimate.
                    "sources": {k: int(cur.get(k, 0)) for k in ("open_requests", "open_maternal_followups", "open_child_followups",
                                                                 "unique_people", "unique_households")},
                    # Coverage indicators for the fairness rules and the coordinator's coverage view.
                    "days_since_outreach": None if int(cur.get("days_since_outreach", -1)) < 0 else int(cur["days_since_outreach"]),
                    "unserved_planned": int(cur.get("unserved_planned", 0)), "visits_completed_4w": int(cur.get("visits_completed_4w", 0)),
                    # Documented visits by type, so the scheduler can apply per-type time and qualifications.
                    "by_type": {t: int(cur.get(f"encounters_{t}", 0)) for t in ("request", "anc", "pnc", "cwc") if cur.get(f"encounters_{t}")}})
    return out


def build(dataset: Dataset, resources: dict, policy: dict | None = None, *, with_alternatives: bool = True) -> dict:
    estimate = forecast.estimate(dataset)
    demand = [d for d in demand_from(estimate) if not resources.get("communities") or d["community_id"] in resources["communities"]]
    result = optimizer.solve(demand, resources, policy)
    policy_used = result["policy"]
    explanation = optimizer.explain(demand, resources, policy_used, result)
    alts = []
    if with_alternatives and result["status"] != "INFEASIBLE":
        for alt in optimizer.alternatives(demand, resources, policy_used, result):
            alts.append({"trips": alt["trips"], "served": alt["served"], "weighted_served": alt["weighted_served"],
                         "travel_minutes": alt["travel_minutes"],
                         "difference": f"{alt['weighted_served']} weighted items vs {result['weighted_served']} in the recommended plan"})
    urgent = sum(d["urgent_items_excluded"] for d in demand)
    return {
        "planner_version": PLANNER_VERSION, "model_version": FORECAST_VERSION, "dataset_id": dataset.dataset_id,
        "dataset_sha256": dataset.sha256, "synthetic": dataset.synthetic, "as_of": dataset.as_of,
        "demand": demand, "resources": resources, "policy": policy_used, "result": result, "explanation": explanation,
        "alternatives": alts,
        "urgent_note": (f"{urgent} danger-sign review(s) are not part of this routine plan. They follow professionally defined "
                        "referral procedures and must not wait for an outreach schedule.") if urgent else None,
    }


def hackathon_resources(name: str = "baseline") -> dict:
    return copy.deepcopy(synthetic.scenario(name))


def live_resources(dataset: Dataset, resources_file: str | Path, day: str | None = None, season: str = "dry", facility: str | None = None,
                   readiness_records: list[dict] | None = None, include_test_records: bool = False) -> dict:
    """Converts a planning resources file into optimiser resources for one day.

    planning/tolon-district.json lists several facilities, so the facility picks its staff, vehicles
    and travel times; a single-facility file (the test fixture) is used as it is.
    """
    src = json.loads(Path(resources_file).read_text())
    if "facilities" in src:
        chosen = next((f for f in src["facilities"] if f["id"] == facility), None)
        if chosen is None:
            raise ValueError("Unknown facility for planning.")
        src = {**src, **chosen, "facility": chosen["id"]}
    day = day or (dt.date.fromisoformat(dataset.as_of) + dt.timedelta(days=1)).isoformat()
    weekday = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][dt.date.fromisoformat(day).weekday()]
    facility = src["facility"]
    matrix = {("facility" if a == facility else a): {("facility" if b == facility else b): t for b, t in row.items()}
              for a, row in src["travel_minutes"][season].items()}
    covers = {}
    for c in dataset.communities:
        if c.get("responsible_worker"):
            covers.setdefault(c["responsible_worker"], []).append(c["id"])
    # Supplies, equipment and fuel: configured (simulated) values overridden by readiness confirmed in CHT.
    # Staleness is judged on the day the plan is made, not the (possibly later) outreach date.
    supply = {"inventory": readiness.inventory(src, readiness_records, dt.date.today().isoformat(), include_test_records), "requirements": readiness.requirements(src),
              "fuel": readiness.fuel(src)} if src.get("resources") else {}
    # The facility's weekly activity calendar: when enforced, staff are not available for outreach on other days.
    cal = src.get("outreach_calendar") or {}
    activity = (cal.get("days") or {}).get(weekday)
    blocked = bool(cal.get("enforced")) and activity is not None and activity != "outreach"
    calendar = {"calendar": {"weekday": weekday, "activity": activity or "not set", "enforced": bool(cal.get("enforced")),
                             "outreach_days": [d for d, a in (cal.get("days") or {}).items() if a == "outreach"],
                             "source": cal.get("source", ""), "verification_status": cal.get("verification_status", "unverified")}} if cal else {}
    return {
        **supply, **calendar,
        "label": f"Live CHT staff and vehicles for {day} ({season} season, estimated travel times)", "scenario": "live",
        "facility": "facility", "planning_days": [day], "travel_minutes": matrix,
        # Minutes on site per visit type, from the facility configuration (planning assumptions, not clinical rules).
        "service": {**DEFAULT_SERVICE, "minutes_by_type": {k: int(v) for k, v in src.get("service_minutes_by_visit_type", {}).items() if k != "note"}},
        "max_stops_per_trip": 3, "confirmed_assignments": [],
        "workers": [{"id": s["id"], "name": s["name"], "role": s.get("role", "CHO"), "available_days": [day] if weekday in s["available"] and not blocked else [],
                     "hours": dict(src["working_hours"]), "communities": covers.get(s["id"], []), "qualifications": s.get("qualifications", ["request", "anc", "pnc", "cwc"])}
                    for s in src["staff"]],
        "vehicles": [{"id": v["id"], "name": v.get("name", v["id"]), "available_days": [day] if weekday in v["available"] else []}
                     for v in src["vehicles"]],
    }
