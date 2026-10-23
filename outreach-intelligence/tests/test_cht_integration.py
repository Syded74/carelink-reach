"""The CHT planning service: adjudication (the single authority on plan decisions), idempotency,
assignments, and a full cycle against an in-memory CHT."""
import copy
import json
from pathlib import Path

import pytest

from carelink_oi import cht_integration as ci, synthetic

CONFIG = Path(__file__).resolve().parents[2]
FACILITY = "carelink-demo-facility"


def proposal(status="OPTIMAL", trips=None):
    return {"_id": "carelink-oi-proposal-r1", "form": ci.F["proposal"], "reported_date": 1,
            "fields": {"requested_by": "coord", "requested_by_contact": "c-coord", "planner_version": "p", "input_sha256": "h",
                       "demand": [{"community_id": "c1", "name": "Community 1"}],
                       "schedule": {"status": status, "trips": trips or [], "served": {}, "unserved": {}, "pending": {}}}}


def event(eid, action, actor, expected, at, notes=""):
    return {"_id": eid, "form": ci.F["review"], "reported_date": at,
            "fields": {"patient_id": FACILITY, "proposal_id": "carelink-oi-proposal-r1", "action": action, "actor": actor, "expected_event": expected, "notes": notes}}


def ack(d):
    return ci.ack_doc(proposal(), d, FACILITY)


def run(events, acks=()):
    return ci.adjudicate(proposal(), events, list(acks))


def test_full_lifecycle_is_accepted_in_order():
    p = proposal()["_id"]
    events = [event("e1", "submit", "coord", p, 2), event("e2", "review", "super", "e1", 3), event("e3", "approve", "super", "e2", 4)]
    out = run(events)
    assert [(d["event"]["_id"], d["result"], d["state_after"]) for d in out] == [("e1", "accepted", "proposed"), ("e2", "accepted", "reviewed"), ("e3", "accepted", "approved")]


@pytest.mark.parametrize("events, reason", [
    ([event("e1", "submit", "super", "carelink-oi-proposal-r1", 2)], "Only the person who requested"),
    ([event("e1", "submit", "coord", "carelink-oi-proposal-r1", 2), event("e2", "review", "coord", "e1", 3)], "Separation of duties"),
    ([event("e1", "approve", "super", "carelink-oi-proposal-r1", 2)], "Cannot approve a plan that is draft"),
])
def test_server_rejects_invalid_decisions(events, reason):
    out = run(events)
    assert out[-1]["result"] == "rejected" and reason in out[-1]["reason"]


def test_coordinator_cannot_approve_own_plan_even_after_a_review():
    p = proposal()["_id"]
    out = run([event("e1", "submit", "coord", p, 2), event("e2", "review", "super", "e1", 3), event("e3", "approve", "coord", "e2", 4)])
    assert out[-1]["result"] == "rejected" and "Separation of duties" in out[-1]["reason"]


def test_only_the_reviewer_decides_and_rejection_needs_a_reason():
    p = proposal()["_id"]
    base = [event("e1", "submit", "coord", p, 2), event("e2", "review", "super", "e1", 3)]
    assert "must record the decision" in run(base + [event("e3", "approve", "super2", "e2", 4)])[-1]["reason"]
    assert "needs a reason" in run(base + [event("e3", "reject", "super", "e2", 4, notes=" ")])[-1]["reason"]
    assert run(base + [event("e3", "reject", "super", "e2", 4, notes="Travel times wrong")])[-1]["state_after"] == "rejected"


def test_two_reviewers_acting_at_once_is_a_conflict_and_neither_applies():
    p = proposal()["_id"]
    out = run([event("e1", "submit", "coord", p, 2), event("e2", "review", "super", "e1", 3), event("e2b", "review", "super2", "e1", 3)])
    conflicts = [d for d in out if d["result"] == "conflict"]
    assert {d["event"]["_id"] for d in conflicts} == {"e2", "e2b"}
    assert all(d["state_after"] == "proposed" for d in conflicts)
    # afterwards one reviewer acts again on the current step and it is accepted
    acks = [ack(d) for d in out]
    again = run([event("e1", "submit", "coord", p, 2), event("e2", "review", "super", "e1", 3), event("e2b", "review", "super2", "e1", 3),
                 event("e4", "review", "super", "e1", 9)], acks)
    assert [(d["event"]["_id"], d["result"]) for d in again] == [("e4", "accepted")]


def test_stale_decision_is_rejected_not_applied():
    p = proposal()["_id"]
    first = run([event("e1", "submit", "coord", p, 2)])
    out = run([event("e1", "submit", "coord", p, 2), event("e9", "submit", "coord", p, 5)], [ack(d) for d in first])
    assert out == [] or out[-1]["result"] == "rejected"
    late = run([event("e1", "submit", "coord", p, 2), event("e2", "review", "super", "e1", 3), event("e9", "review", "super2", p, 5)],
               [ack(d) for d in first])
    assert any(d["event"]["_id"] == "e9" and d["result"] == "rejected" and "stale" in d["reason"] for d in late)


def test_acknowledged_events_are_never_decided_twice():
    p = proposal()["_id"]
    events = [event("e1", "submit", "coord", p, 2)]
    acks = [ack(d) for d in run(events)]
    assert run(events, acks) == []


def test_infeasible_plans_cannot_go_forward():
    out = ci.adjudicate(proposal("INFEASIBLE"), [event("e1", "submit", "coord", "carelink-oi-proposal-r1", 2)], [])
    assert out[0]["result"] == "rejected" and "infeasible" in out[0]["reason"]


# Dates relative to the real clock: the Node link helper (lib/oi-links.js) skips outreach days already in the past.
import datetime as _dt
TODAY = _dt.date.today().isoformat()
DAY = (_dt.date.today() + _dt.timedelta(days=1)).isoformat()

TRIP = {"worker": "cho-1", "worker_name": "CHO A", "day": DAY, "vehicle": "motorbike-1",
        "route": ["facility", "c1", "facility"], "served": {"c1": 3}}


def test_assignments_have_stable_ids_and_never_double_book():
    p = proposal(trips=[TRIP])
    docs, refusal = ci.assignments_for(p, [])
    assert refusal is None and [d["_id"] for d in docs] == [f"carelink-oi-assignment-carelink-oi-proposal-r1-{DAY}-c1"]
    assert docs[0]["fields"]["patient_id"] == "c1", "attached to the community so it reaches that CHO"
    again, _ = ci.assignments_for(p, docs)
    assert [d["_id"] for d in again] == [d["_id"] for d in docs], "same proposal: same ids, so a retry creates nothing new"
    other = copy.deepcopy(docs[0])
    other["fields"]["proposal_id"] = "carelink-oi-proposal-other"
    none, refusal = ci.assignments_for(p, [other])
    assert none == [] and "already assigned" in refusal


class FakeCht:
    """In-memory CHT: create() behaves like PUT with a stable id (409 → 'exists')."""

    def __init__(self, docs):
        self.store = {d["_id"]: d for d in docs}

    def docs(self):
        return list(self.store.values())

    def create(self, doc):
        if doc["_id"] in self.store:
            return "exists"
        self.store[doc["_id"]] = doc
        return "created"


def live_dataset():
    raw = synthetic.hackathon_dataset()
    current_week = [{"community_id": c["id"], "period_start": "2026-10-19", "requests_created": 1} for c in raw["communities"]]
    return {**raw, "dataset_id": "live-cht", "synthetic": False, "label": "test live", "history": current_week,
            "communities": [{**c, "responsible_worker": "carelink-demo-cho-1" if c["id"] != "village-c" else "carelink-demo-cho-2"} for c in raw["communities"]]}


def request(rid, actor="coord", staff="carelink-demo-cho-1 carelink-demo-cho-2", vehicles="motorbike-1"):
    return {"_id": rid, "type": "data_record", "form": ci.F["request"], "reported_date": 1,
            "fields": {"patient_id": FACILITY, "actor": actor, "actor_contact": "c-coord", "planning_date": DAY, "season": "dry", "staff_available": staff,
                       "hours_start": "0800", "hours_end": "1400", "vehicles": vehicles, "use_demo_history": "yes", "fairness_weight": 0.5,
                       "guarantee_communities": ""}}


def test_full_cycle_in_memory_is_idempotent(tmp_path):
    resources = tmp_path / "resources.json"
    res = json.loads((CONFIG / "test" / "fixtures" / "planning-resources.json").read_text())
    res["travel_minutes"] = {s: {("carelink-demo-facility" if a == "facility" else a): {b: t for b, t in row.items()} for a, row in synthetic.TRAVEL.items()} for s in ("dry", "rainy")}
    resources.write_text(json.dumps(res))
    cht = FakeCht([request("r1")])
    first = ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())
    assert first["demand"] == "created" and first["proposals"][0][1] == "created"
    pid = first["proposals"][0][0]
    prop = cht.store[pid]
    assert prop["fields"]["requested_by"] == "coord" and prop["fields"]["schedule"]["status"] in ("OPTIMAL", "FEASIBLE")
    text = json.dumps(prop)
    assert "patient_name" not in text and "phone" not in text
    for e in (event("e1", "submit", "coord", pid, 2), event("e2", "review", "super", "e1", 3), event("e3", "approve", "super", "e2", 4)):
        e["fields"]["proposal_id"] = pid
        e["type"] = "data_record"
        cht.store[e["_id"]] = e
    second = ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())
    assert [a[2] for a in second["acks"]] == ["accepted", "accepted", "accepted"]
    assert second["assignments"] and all(s == "created" for _, s in second["assignments"])
    # Each approved day gets one day plan (no household requests exist in this in-memory CHT).
    assert sorted(i for i, _ in second["links"]) == sorted("carelink-oi-dayplan-" + i for i, _ in second["assignments"])
    third = ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())
    assert third == {"demand": None, "proposals": [], "acks": [], "assignments": [], "links": []}, "repeat cycles create nothing new"


def test_server_acknowledgement_precedes_assignment_and_crash_retries_heal(tmp_path):
    resources = tmp_path / 'resources.json'
    res = json.loads((CONFIG / 'test/fixtures/planning-resources.json').read_text())
    res['travel_minutes'] = {s: {('carelink-demo-facility' if a == 'facility' else a): dict(row) for a, row in synthetic.TRAVEL.items()} for s in ('dry', 'rainy')}
    resources.write_text(json.dumps(res))
    cht = FakeCht([request('crash-r1')])
    ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())
    pid = 'carelink-oi-proposal-crash-r1'
    for e in [event('submit-c', 'submit', 'coord', pid, 10), event('review-c', 'review', 'super', 'submit-c', 9), event('approve-c', 'approve', 'super', 'review-c', 8)]:
        e['type'] = 'data_record'
        e['fields']['proposal_id'] = pid
        cht.store[e['_id']] = e
    original = cht.create
    crashed = []
    def fail_assignment(doc):
        if doc['form'] == ci.F['assignment'] and not crashed:
            assert any(d.get('form') == ci.F['ack'] and d['fields']['state_after'] == 'approved' for d in cht.docs())
            crashed.append(True)
            raise RuntimeError('Simulated power loss after durable approval')
        return original(doc)
    cht.create = fail_assignment
    with pytest.raises(RuntimeError, match='power loss'):
        ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())
    result = ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())
    assert result['acks'] == [] and result['assignments']
    assert ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())['assignments'] == []


def test_reconstruction_follows_links_even_when_all_timestamps_tie():
    pid = proposal()['_id']
    events = [event('z-submit', 'submit', 'coord', pid, 3), event('a-review', 'review', 'super', 'z-submit', 2)]
    accepted = run(events)
    acks = [ack(d) for d in accepted]
    for a in acks:
        a['reported_date'] = 1
    out = run(events + [event('decision', 'approve', 'super', 'a-review', 1)], acks)
    assert out[-1]['result'] == 'accepted' and out[-1]['state_after'] == 'approved'


def test_snapshot_identity_changes_only_with_meaningful_inputs_not_export_time():
    a = ci.dataset_for(live_dataset(), True)
    b = copy.deepcopy(a)
    b.exported_at = '2099-01-01T00:00:00Z'
    assert ci.demand_record_id(FACILITY, a, TODAY) == ci.demand_record_id(FACILITY, b, TODAY)
    next(iter(b.current.values()))['pending_followups'] += 1
    assert ci.demand_record_id(FACILITY, a, TODAY) != ci.demand_record_id(FACILITY, b, TODAY)


def test_worker_ignores_a_request_scoped_to_another_facility(tmp_path):
    foreign = request('foreign')
    foreign['fields']['patient_id'] = 'other-facility'
    resources = CONFIG / 'test/fixtures/planning-resources.json'
    cht = FakeCht([foreign])
    result = ci.process_once(cht, FACILITY, resources, today=TODAY, live=live_dataset())
    assert result['proposals'] == []


@pytest.mark.parametrize('bad', [{'fairness_weight': 'nan'}, {'hours_end': '0860'}, {'hours_end': '0700'}, {'season': 'unknown'}])
def test_malformed_request_becomes_an_unapprovable_error_proposal_without_poisoning_queue(bad):
    broken = request('malformed')
    broken['fields'].update(bad)
    cht = FakeCht([broken])
    out = ci.process_once(cht, FACILITY, CONFIG / 'test/fixtures/planning-resources.json', today=TODAY, live=live_dataset())
    assert out['proposals'][0][2] == 'INVALID_INPUT'
    p = cht.store['carelink-oi-proposal-malformed']
    assert p['fields']['explanation']['reasons']
    e = event('submit-invalid', 'submit', 'coord', p['_id'], 2)
    assert ci.adjudicate(p, [e], [])[0]['result'] == 'rejected'


def test_a_second_worker_cannot_book_an_already_booked_vehicle():
    first = proposal(trips=[TRIP])
    existing, _ = ci.assignments_for(first, [])
    second = proposal(trips=[{**TRIP, 'worker': 'cho-2', 'worker_name': 'CHO B'}])
    second['_id'] = 'other-proposal'
    docs, refusal = ci.assignments_for(second, existing)
    assert docs == [] and 'Vehicle' in refusal and 'already assigned' in refusal


def test_district_resources_are_scoped_to_the_requesting_facility():
    from carelink_oi import data_adapter, planning
    district = CONFIG / "planning" / "tolon-district.json"
    facilities = json.loads(district.read_text())["facilities"]
    dataset = data_adapter.parse(live_dataset())
    for f in facilities:
        res = planning.live_resources(dataset, district, day=DAY, facility=f["id"])
        assert {w["id"] for w in res["workers"]} == {s["id"] for s in f["staff"]}
        assert {v["id"] for v in res["vehicles"]} == {v["id"] for v in f["vehicles"]}
        assert set(res["travel_minutes"]["facility"]) == {c["id"] for c in f["communities"]}
    with pytest.raises(ValueError):
        planning.live_resources(dataset, district, day=DAY, facility="another-facility")


def test_engine_accepts_the_node_exporters_dataset_shape():
    """The worker parses whatever lib/oi-export.js writes; a new export field must be whitelisted, or every cycle fails."""
    import subprocess
    from carelink_oi import data_adapter
    script = ("const {exportAggregates}=require('./lib/oi-export');"
              "const docs=[{_id:'c1',type:'contact',contact_type:'carelink_community',name:'Tolon'}];"
              "for (const t of [false,true]) console.log(JSON.stringify(exportAggregates(docs,'" + TODAY + "','x',{includeTestRecords:t}).dataset));")
    out = subprocess.run(["node", "-e", script], cwd=CONFIG, capture_output=True, text=True, check=True).stdout.splitlines()
    for line in out:
        assert data_adapter.parse(json.loads(line)).communities


def test_a_recorded_outreach_day_no_longer_books_the_worker():
    """assignments_for refuses double-booking; process_once passes only days not yet recorded."""
    trips = [{"worker": "w1", "worker_name": "W", "day": "2026-11-02", "vehicle": "v1", "route": ["facility", "c1", "facility"], "served": {"c1": 1}}]
    proposal = {"_id": "p2", "fields": {"demand": [{"community_id": "c1", "name": "C1"}], "schedule": {"trips": trips}, "planner_version": "x", "input_sha256": "h"}}
    booked = [{"_id": "a1", "fields": {"proposal_id": "p1", "worker_id": "w1", "date": "2026-11-02", "vehicle": "v9"}}]
    assert ci.assignments_for(proposal, booked)[1], "an active day blocks the worker"
    assert ci.assignments_for(proposal, [])[1] is None, "once that day is recorded it is left out and the worker is free"
