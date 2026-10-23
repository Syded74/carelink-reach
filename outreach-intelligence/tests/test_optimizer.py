import copy

import pytest

from carelink_oi import data_adapter, optimizer, planning, synthetic

DEMAND = [
    {"community_id": "village-a", "name": "A", "pending": 12, "barrier_level": "high", "data_coverage": 1.0},
    {"community_id": "village-b", "name": "B", "pending": 5, "barrier_level": "low", "data_coverage": 1.0},
    {"community_id": "village-c", "name": "C", "pending": 9, "barrier_level": "high", "data_coverage": 0.58},
]
DAY = synthetic.DAY


def res(name="baseline", **override):
    r = copy.deepcopy(synthetic.scenario(name))
    r.update(override)
    return r


def minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def check_constraints(result, resources, demand=DEMAND):
    pending = {d["community_id"]: d["pending"] for d in demand}
    workers = {w["id"]: w for w in resources["workers"]}
    seen = set()
    for t in result["trips"]:
        w = workers[t["worker"]]
        assert t["day"] in w["available_days"], "only available workers"
        assert (t["worker"], t["day"]) not in seen, "no worker in two places on one day"
        seen.add((t["worker"], t["day"]))
        assert t["total_minutes"] <= minutes(w["hours"]["end"]) - minutes(w["hours"]["start"])
        assert t["total_minutes"] == t["travel_minutes"] + t["service_minutes"]
        vehicle = next(v for v in resources["vehicles"] if v["id"] == t["vehicle"])
        assert t["day"] in vehicle["available_days"], "no nonexistent transport"
        assert all(n >= 1 for n in t["served"].values())
    for day in resources["planning_days"]:
        used = [t["vehicle"] for t in result["trips"] if t["day"] == day]
        assert len(used) == len(set(used)), "a vehicle serves one trip per day"
    for c, n in result["served"].items():
        assert 0 <= n <= pending[c]


def test_baseline_matches_hand_calculation():
    r = optimizer.solve(DEMAND, res())
    assert r["status"] == "OPTIMAL"
    assert r["served"] == {"village-a": 12, "village-b": 3, "village-c": 0}
    assert r["trips"][0]["route"] == ["facility", "village-a", "village-b", "facility"]
    assert r["trips"][0]["total_minutes"] == 95 + 2 * 20 + 15 * 15 == 360
    check_constraints(r, res())


@pytest.mark.parametrize("name", synthetic.SCENARIOS)
def test_hard_constraints_hold_in_every_scenario(name):
    r = optimizer.solve(DEMAND, res(name))
    if name == "infeasible-confirmed":
        assert r["status"] == "INFEASIBLE" and r["trips"] == []
        assert "275 minutes" in r["reasons"][0] and "180 minutes" in r["reasons"][0]
    else:
        check_constraints(r, res(name))


def test_unavailable_worker_and_missing_vehicle():
    away = res(workers=[{**synthetic.NURSE_1, "available_days": ["2026-10-23"]}])
    r = optimizer.solve(DEMAND, away)
    assert r["trips"] == [] and sum(r["served"].values()) == 0
    no_vehicle = res(vehicles=[])
    r2 = optimizer.solve(DEMAND, no_vehicle)
    assert r2["trips"] == []
    assert any("no vehicle" in b for b in optimizer.explain(DEMAND, no_vehicle, None, r2)["binding"])


def test_one_vehicle_two_nurses_binds_transport():
    r = optimizer.solve(DEMAND, res("second-nurse-no-vehicle"))
    assert len(r["trips"]) == 1
    x = optimizer.explain(DEMAND, res("second-nurse-no-vehicle"), None, r)
    assert any("Transport" in b and "Nurse 2" in b for b in x["binding"])
    vehicle = next(w for w in x["what_if"] if "vehicle" in w["change"])
    assert vehicle["extra_items_served"] > 0 and x["needs_more_resources"]


def test_confirmed_assignment_is_never_dropped():
    confirmed = res(confirmed_assignments=[{"worker": "nurse-1", "day": DAY, "community": "village-c", "min_followups": 2}])
    r = optimizer.solve(DEMAND, confirmed)
    assert r["status"] == "OPTIMAL" and r["served"]["village-c"] >= 2
    check_constraints(r, confirmed)


def test_fairness_minimum_coverage_is_hard_and_its_cost_visible():
    base = optimizer.solve(DEMAND, res())
    fair = optimizer.solve(DEMAND, res(), {"min_coverage": {"enabled": True, "communities": ["village-c"], "min_followups": 1}})
    assert base["served"]["village-c"] == 0 and fair["served"]["village-c"] >= 1
    assert sum(fair["served"].values()) < sum(base["served"].values())
    impossible = optimizer.solve(DEMAND, res(workers=[{**synthetic.NURSE_1, "hours": {"start": "08:00", "end": "10:00"}}]),
                                 {"min_coverage": {"enabled": True, "communities": ["village-c"], "min_followups": 1}})
    assert impossible["status"] == "INFEASIBLE"


def test_poor_reporting_raises_priority_not_lowers_it():
    p = optimizer.priorities(DEMAND, optimizer.DEFAULT_POLICY)
    assert p["village-c"]["weight"] > p["village-a"]["weight"] > p["village-b"]["weight"]


def test_unserved_communities_are_reported_with_reasons():
    r = optimizer.solve(DEMAND, res())
    x = optimizer.explain(DEMAND, res(), None, r)
    assert r["unserved"]["village-c"] == 9
    assert "deferred" in x["communities"]["village-c"] and "next planning cycle" in x["communities"]["village-c"]
    assert "15.2" in x["communities"]["village-c"], "the trade-off figure comes from re-solving"


def test_deterministic_for_fixed_inputs():
    assert optimizer.solve(DEMAND, res("second-nurse-second-vehicle")) == optimizer.solve(DEMAND, res("second-nurse-second-vehicle"))


def test_missing_travel_time_is_an_error_not_a_guess():
    broken = res()
    broken["travel_minutes"] = {"facility": {"village-a": 45, "village-b": 20}}
    with pytest.raises(optimizer.PlanningError, match="No documented travel time"):
        optimizer.solve(DEMAND, broken)


def test_alternatives_differ_from_the_recommendation():
    plan = planning.build(data_adapter.parse(synthetic.hackathon_dataset()), res())
    chosen = [t["route"] for t in plan["result"]["trips"]]
    assert plan["alternatives"]
    for alt in plan["alternatives"]:
        assert [t["route"] for t in alt["trips"]] != chosen
        assert alt["weighted_served"] <= plan["result"]["weighted_served"]


def typed_demand():
    # Mixed documented work: household requests and ANC, PNC and CWC follow-ups (encounters per type).
    return [
        {"community_id": "village-a", "name": "A", "pending": 6, "barrier_level": "high", "data_coverage": 1.0,
         "by_type": {"request": 2, "anc": 2, "cwc": 2}},
        {"community_id": "village-b", "name": "B", "pending": 3, "barrier_level": "low", "data_coverage": 1.0,
         "by_type": {"pnc": 1, "cwc": 2}},
    ]


def test_visit_types_use_their_own_service_minutes_and_respect_working_hours():
    r = res()
    r["service"] = {**r["service"], "minutes_by_type": {"request": 20, "anc": 30, "pnc": 30, "cwc": 25}}
    out = optimizer.solve(typed_demand(), r)
    assert out["status"] in ("OPTIMAL", "FEASIBLE")
    for t in out["trips"]:
        expected = r["service"]["setup_minutes_per_stop"] * len(t["route"][1:-1]) + sum(
            r["service"]["minutes_by_type"][vt] * n for c in t["served_by_type"] for vt, n in t["served_by_type"][c].items())
        assert t["service_minutes"] == expected
        assert t["total_minutes"] <= t["available_minutes"]
        assert all(sum(types.values()) == t["served"][c] for c, types in t["served_by_type"].items())
    for c, types in out["served_by_type"].items():
        for vt, n in types.items():
            assert n <= out["pending_by_type"][c][vt]
    # Longer visit types cost more time: with ANC at 120 minutes, fewer items fit in the same hours.
    slow = copy.deepcopy(r)
    slow["service"]["minutes_by_type"]["anc"] = 120
    assert sum(optimizer.solve(typed_demand(), slow)["served"].values()) <= sum(out["served"].values())


def test_workers_serve_only_visit_types_they_are_qualified_for_and_unmet_work_is_explained():
    r = res()
    r["service"] = {**r["service"], "minutes_by_type": {"request": 20, "anc": 30, "pnc": 30, "cwc": 25}}
    for w in r["workers"]:
        w["qualifications"] = ["request", "cwc"]
    out = optimizer.solve(typed_demand(), r)
    assert all(t["served_by_type"][c].get(vt, 0) == 0 for t in out["trips"] for c in t["served_by_type"] for vt in ("anc", "pnc"))
    assert out["unserved_by_type"]["village-a"].get("anc") == 2 and out["unserved_by_type"]["village-b"].get("pnc") == 1
    text = optimizer.explain(typed_demand(), r, optimizer.DEFAULT_POLICY, out)
    assert "no available worker is qualified" in text["communities"]["village-a"]
    assert "ANC follow-up 0 of 2" in text["summary"] and "household request" in text["summary"]


def test_untyped_demand_keeps_the_previous_single_service_time():
    out = optimizer.solve(DEMAND, res())
    assert all(set(types) <= {"routine"} for types in out["pending_by_type"].values())
    assert all(t["service_minutes"] == res()["service"]["setup_minutes_per_stop"] * len(t["route"][1:-1]) + res()["service"]["minutes_per_followup"] * sum(t["served"].values())
               for t in out["trips"])


def test_fairness_rules_are_configurable_and_default_to_the_original_rule():
    base = {"community_id": "c", "name": "C", "pending": 3, "barrier_level": "low", "data_coverage": 1.0}
    default = optimizer.priorities([dict(base, days_since_outreach=90, unserved_planned=5)], optimizer.DEFAULT_POLICY)["c"]
    assert default["underserved_index"] == 0.0, "coverage terms are off unless configured"
    policy = {**optimizer.DEFAULT_POLICY, "underserved_components": {"barrier": 0.3, "reporting_gap": 0.3, "outreach_gap": 0.2, "unserved_planned": 0.2}}
    recent = optimizer.priorities([dict(base, days_since_outreach=7, unserved_planned=0)], policy)["c"]
    overdue = optimizer.priorities([dict(base, days_since_outreach=60, unserved_planned=5)], policy)["c"]
    never = optimizer.priorities([dict(base, days_since_outreach=None)], policy)["c"]
    unknown = optimizer.priorities([dict(base)], policy)["c"]
    assert recent["outreach_gap"] == 0.0 and overdue["outreach_gap"] == 1.0 and overdue["unserved_planned"] == 1.0
    assert overdue["underserved_index"] == 0.4 and overdue["weight"] > recent["weight"]
    assert never["outreach_gap"] == 1.0, "no documented outreach at all is a full gap"
    assert unknown["outreach_gap"] == 0.0, "a missing indicator is neutral, never invented"


def test_infeasible_commitment_names_the_real_cause():
    r = res()
    w = r["workers"][0]
    r["confirmed_assignments"] = [{"worker": w["id"], "day": DAY, "community": "village-b", "min_followups": 12}]
    out = optimizer.solve(DEMAND, r)
    assert out["status"] == "INFEASIBLE"
    assert any("requires 12 item(s), but only 5 documented item(s) are pending" in x for x in out["reasons"])
