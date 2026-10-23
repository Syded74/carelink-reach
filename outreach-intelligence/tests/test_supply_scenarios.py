"""Supply-, equipment- and fuel-aware scheduling: deterministic scenarios (docs/SUPPLY_AWARE_OPTIMIZATION.md).

All quantities are illustrative test values. Requirements per visit type are configuration, not clinical rules.
"""
import copy

from carelink_oi import optimizer, readiness, synthetic

DAY = synthetic.DAY
MINUTES = {"request": 20, "anc": 30, "pnc": 30, "cwc": 25}
NEEDS = {"request": {"consumables": {}, "equipment": []},
         "anc": {"consumables": {"anc-supplies": 1}, "equipment": ["bp-monitor"]},
         "pnc": {"consumables": {"pnc-supplies": 1}, "equipment": ["bp-monitor"]},
         "cwc": {"consumables": {"cwc-supplies": 1}, "equipment": ["growth-set"]}}


def item(rid, available, status="simulated", unit="pack"):
    return {"id": rid, "name": rid, "unit": unit, "category": "supply", "available": float(available), "status": status, "source": "test"}


def stock(**over):
    inv = {"anc-supplies": item("anc-supplies", 10), "pnc-supplies": item("pnc-supplies", 10), "cwc-supplies": item("cwc-supplies", 10),
           "bp-monitor": item("bp-monitor", 2, unit="device"), "growth-set": item("growth-set", 2, unit="set"), "fuel": item("fuel", 20, unit="litres")}
    inv.update(over)
    return inv


def resources(inventory=None, vehicles=None, workers=None):
    r = copy.deepcopy(synthetic.scenario("baseline"))
    r["service"] = {**r["service"], "minutes_by_type": MINUTES}
    r["inventory"] = inventory if inventory is not None else stock()
    r["requirements"] = NEEDS
    r["fuel"] = {"resource": "fuel", "litres_per_travel_minute": 0.03}
    for w in r["workers"]:
        w["qualifications"] = ["request", "anc", "pnc", "cwc"]
    if vehicles is not None:
        r["vehicles"] = vehicles
    if workers is not None:
        r["workers"] = workers
    return r


def demand():
    return [{"community_id": "village-a", "name": "A", "pending": 6, "barrier_level": "high", "data_coverage": 1.0,
             "by_type": {"request": 1, "anc": 2, "cwc": 3}},
            {"community_id": "village-b", "name": "B", "pending": 3, "barrier_level": "low", "data_coverage": 1.0,
             "by_type": {"pnc": 1, "cwc": 2}}]


def used(out, rid):
    return out["resource_usage"][rid]["planned"]


def test_a_adequate_capacity_schedules_without_artificial_shortage():
    r = resources()
    for w in r["workers"]:
        w["hours"] = {"start": "08:00", "end": "16:00"}
    out = optimizer.solve(demand(), r)
    assert out["status"] in ("OPTIMAL", "FEASIBLE")
    assert sum(out["served"].values()) == 9, "everything fits; no resource is short"
    assert not any(u["binding"] for u in out["resource_usage"].values())
    for t in out["trips"]:
        assert t["total_minutes"] <= t["available_minutes"]
    # With the original six-hour day the nurse's time binds instead, and the explanation says so.
    tight = optimizer.solve(demand(), resources())
    text = optimizer.explain(demand(), resources(), optimizer.DEFAULT_POLICY, tight)
    assert sum(tight["served"].values()) < 9 and any("Working hours" in b for b in text["binding"])


def test_b_supply_shortage_limits_only_the_affected_service_and_is_explained():
    out = optimizer.solve(demand(), resources(stock(**{"cwc-supplies": item("cwc-supplies", 2)})))
    served_cwc = sum(types.get("cwc", 0) for types in out["served_by_type"].values())
    assert served_cwc == 2 and used(out, "cwc-supplies") == 2, "never more child welfare visits than packs"
    assert sum(t.get("anc", 0) for t in out["served_by_type"].values()) == 2, "ANC is unaffected by the CWC shortage"
    text = optimizer.explain(demand(), resources(stock(**{"cwc-supplies": item("cwc-supplies", 2)})), optimizer.DEFAULT_POLICY, out)
    assert any("limited by cwc-supplies" in line for line in text["communities"].values())
    assert any("cwc-supplies" in b for b in text["binding"])
    assert any("more pack of cwc-supplies" in w["change"] or "more pack" in w["change"] for w in text["what_if"])


def test_c_no_motorbike_means_no_trip_and_the_reason_is_transport():
    out = optimizer.solve(demand(), resources(vehicles=[]))
    assert out["trips"] == [] or out["status"] == "INFEASIBLE"
    text = optimizer.explain(demand(), resources(vehicles=[]), optimizer.DEFAULT_POLICY, out)
    assert any("vehicle" in b.lower() or "transport" in b.lower() for b in text.get("binding", [])) or out["status"] == "INFEASIBLE"


def test_d_limited_fuel_bounds_travel_and_is_explained():
    out = optimizer.solve(demand(), resources(stock(fuel=item("fuel", 1.5, unit="litres"))))
    travel = sum(t["travel_minutes"] for t in out["trips"])
    assert travel * 0.03 <= 1.5 + 1e-9, "planned travel never needs more fuel than is usable"
    assert sum(out["served"].values()) < 9
    text = optimizer.explain(demand(), resources(stock(fuel=item("fuel", 1.5, unit="litres"))), optimizer.DEFAULT_POLICY, out)
    assert any("Fuel" in b for b in text["binding"])


def test_e_one_worker_two_communities_no_double_assignment():
    base = resources()
    out = optimizer.solve(demand(), resources(workers=[base["workers"][0]]))
    assert out["trips"], "the one worker still makes a trip"
    days = [(t["worker"], t["day"]) for t in out["trips"]]
    assert len(days) == len(set(days)), "one trip per worker per day"
    for t in out["trips"]:
        assert t["total_minutes"] <= t["available_minutes"]


def test_g_mixed_services_one_supply_unavailable_others_proceed():
    inv = stock(**{"anc-supplies": item("anc-supplies", 0, status="unavailable")})
    out = optimizer.solve(demand(), resources(inv))
    by = {vt: sum(t.get(vt, 0) for t in out["served_by_type"].values()) for vt in ("request", "anc", "pnc", "cwc")}
    assert by["anc"] == 0 and by["request"] == 1 and by["cwc"] == 5 and by["pnc"] == 1
    text = optimizer.explain(demand(), resources(inv), optimizer.DEFAULT_POLICY, out)
    assert any("anc-supplies is recorded as unavailable" in line for line in text["communities"].values())


def test_h_unknown_or_stale_stock_is_never_treated_as_available():
    inv = stock(**{"cwc-supplies": item("cwc-supplies", 0, status="unknown"), "growth-set": item("growth-set", 0, status="stale", unit="set")})
    out = optimizer.solve(demand(), resources(inv))
    assert sum(t.get("cwc", 0) for t in out["served_by_type"].values()) == 0
    text = optimizer.explain(demand(), resources(inv), optimizer.DEFAULT_POLICY, out)
    assert any("needs confirmation" in line for line in text["communities"].values())
    assert any("unknown" in c for c in text["needs_confirmation"]) and any("stale" in c for c in text["needs_confirmation"])
    # A requirement naming a resource with no readiness entry at all also counts as zero.
    r = resources(inv)
    r["requirements"] = {**NEEDS, "request": {"consumables": {"leaflets": 1}, "equipment": []}}
    assert sum(t.get("request", 0) for t in optimizer.solve(demand(), r)["served_by_type"].values()) == 0


def test_readiness_records_override_configuration_and_go_stale():
    config = {"resources": [{"id": "cwc-supplies", "name": "CWC supplies", "category": "supply", "unit": "pack", "quantity": 10, "status": "simulated"}],
              "resource_policy": {"stale_after_days": 7}}
    assert readiness.inventory(config, [], "2026-10-22")["cwc-supplies"]["available"] == 10
    rec = {"reported_date": 1792627200000, "fields": {"resource_id": "cwc-supplies", "status": "confirmed", "quantity": 4, "reserved": 1,
                                                      "verified_date": "2026-10-20", "actor": "rseidu"}}
    inv = readiness.inventory(config, [rec], "2026-10-22")["cwc-supplies"]
    assert (inv["available"], inv["status"], inv["verified_by"], inv["source"]) == (3, "confirmed", "rseidu", "readiness record in CHT")
    old = readiness.inventory(config, [rec], "2026-11-05")["cwc-supplies"]
    assert old["status"] == "stale" and old["available"] == 0, "a confirmation older than 7 days is not planned with"
    unknown = {"reported_date": rec["reported_date"] + 1, "fields": {"resource_id": "cwc-supplies", "status": "unknown", "actor": "rseidu"}}
    assert readiness.inventory(config, [rec, unknown], "2026-10-22")["cwc-supplies"]["available"] == 0


def test_f_fixed_calendar_is_traceable_warns_or_enforces_and_commitments_stay():
    import json
    from pathlib import Path
    from carelink_oi import data_adapter, planning
    district = json.loads((Path(__file__).resolve().parents[2] / "planning" / "tolon-district.json").read_text())
    fac = district["facilities"][0]
    raw = synthetic.hackathon_dataset()
    raw = {**raw, "communities": [{"id": c["id"], "name": c["name"], "barrier_level": "low"} for c in fac["communities"]], "history": [], "current": []}
    ds = data_adapter.parse(raw)
    path = Path(__file__).resolve().parent / "_district.json"
    for enforced, day, expect_workers in ((False, "2026-11-02", True), (True, "2026-11-02", False), (True, "2026-11-03", True)):
        fac["outreach_calendar"]["enforced"] = enforced
        path.write_text(json.dumps(district))
        res = planning.live_resources(ds, path, day=day, facility=fac["id"])
        assert bool(res["workers"][0]["available_days"]) == expect_workers, (enforced, day)
        assert res["calendar"]["source"].startswith("Weekly activity plan observed at Kalpohini CHPS") and res["calendar"]["verification_status"] == "unverified"
        res["inventory"], res["requirements"] = {}, {}
        out = optimizer.solve([{"community_id": fac["communities"][0]["id"], "name": "T", "pending": 1, "barrier_level": "low", "data_coverage": 1.0}], res)
        text = optimizer.explain([{"community_id": fac["communities"][0]["id"], "name": "T", "pending": 1, "barrier_level": "low", "data_coverage": 1.0}], res, optimizer.DEFAULT_POLICY, out)
        if day == "2026-11-02":  # a Monday: static services in the observed weekly schedule
            assert any(("Calendar warning" if not enforced else "kept for static services") in b for b in text["binding"])
    path.unlink()
    # An approved commitment is a fixed input the next plan keeps (existing rule).
    r = resources()
    w = r["workers"][0]
    r["confirmed_assignments"] = [{"worker": w["id"], "day": DAY, "community": "village-a", "min_followups": 1}]
    out = optimizer.solve(demand(), r)
    assert any(t["worker"] == w["id"] and "village-a" in t["route"] for t in out["trips"])


def test_observed_chps_week_tuesday_outreach_friday_school_health_integrated_trip():
    """The demonstration facility's observed weekly schedule (Kalpohini CHPS): Tuesday is the routine outreach day;
    Friday is school health (warned while not enforced, blocked when enforced); ANC, PNC and CWC share one Tuesday trip."""
    import json
    from pathlib import Path
    from carelink_oi import data_adapter, planning
    district = json.loads((Path(__file__).resolve().parents[2] / "planning" / "tolon-district.json").read_text())
    fac = district["facilities"][0]
    cal = fac["outreach_calendar"]
    assert cal["days"]["tue"] == "outreach" and cal["days"]["fri"] == "school health services" and cal["enforced"] is False
    raw = synthetic.hackathon_dataset()
    raw = {**raw, "communities": [{"id": c["id"], "name": c["name"], "barrier_level": "low"} for c in fac["communities"]], "history": [], "current": []}
    ds = data_adapter.parse(raw)
    path = Path(__file__).resolve().parent / "_district_week.json"
    one = fac["communities"][0]["id"]
    need = [{"community_id": one, "name": "T", "pending": 3, "barrier_level": "low", "data_coverage": 1.0, "by_type": {"anc": 1, "pnc": 1, "cwc": 1}}]
    try:
        for enforced, day, expect_workers, warning in ((False, "2026-10-27", True, None), (False, "2026-10-30", True, "Calendar warning"),
                                                        (True, "2026-10-30", False, "kept for school health services"), (True, "2026-10-27", True, None),
                                                        (False, "2026-10-28", True, "defaulter tracing and home visits")):
            cal["enforced"] = enforced
            path.write_text(json.dumps(district))
            # The facility's configured staff qualifications, motorbikes, fuel, supplies and equipment all still apply.
            res = planning.live_resources(ds, path, day=day, facility=fac["id"])
            assert bool(res["workers"][0]["available_days"]) == expect_workers, (enforced, day)
            out = optimizer.solve(need, res)
            text = optimizer.explain(need, res, optimizer.DEFAULT_POLICY, out)
            if warning:
                assert any(warning in b for b in text["binding"]), (day, text["binding"])
            else:
                assert not any(b.startswith("Calendar") for b in text["binding"])
            if day == "2026-10-27":  # Tuesday: one trip serves ANC, PNC and CWC together
                trips = [t for t in out["trips"] if one in t["route"]]
                assert len(trips) == 1
                served = trips[0].get("served_by_type", {}).get(one, {})
                assert served.get("anc") == 1 and served.get("pnc") == 1 and served.get("cwc") == 1, served
    finally:
        path.unlink(missing_ok=True)
