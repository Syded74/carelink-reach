"""Outreach Intelligence inside CHT: the server-side planning service.

CHT is the single application and the single source of truth. This worker signs in to the CHT API
as a dedicated online service account (role carelink_oi_service) and only reads and writes records
there; the authority design doc confines that account to plan records. People never talk to it
directly: their requests and decisions are CHT forms that reach it through normal synchronisation.

Each cycle (idempotent; safe to repeat or run after a crash):
1. Demand snapshot  → carelink_oi_demand      (_id carelink-oi-demand-<facility>-<date>)
2. Plan requests    → carelink_oi_proposal    (_id carelink-oi-proposal-<request id>)
3. Decisions        → carelink_oi_ack         (_id carelink-oi-ack-<event id>)  accepted | rejected | conflict
4. Server approval  → carelink_oi_assignment  (_id carelink-oi-assignment-<proposal>-<day>-<community>)
5. Approved days    → carelink_oi_day_plan + carelink_oi_request_link (lib/oi-links.js): which open
                      household requests each approved day takes on, as events in each request's lifecycle

This module is the only authority on decisions: role (also enforced by CouchDB), separation of
duties, order of steps, and concurrent edits. The device only displays its acknowledgements.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import math
import re
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import FORECAST_VERSION, PLANNER_VERSION, data_adapter, forecast, model_comparison, planning, synthetic

CONFIG_ROOT = Path(__file__).resolve().parents[2]
F = {"request": "carelink_oi_request", "review": "carelink_oi_review", "demand": "carelink_oi_demand",
     "proposal": "carelink_oi_proposal", "ack": "carelink_oi_ack", "assignment": "carelink_oi_assignment"}
ACTIONS = {"submit": ("draft", "proposed"), "review": ("proposed", "reviewed"),
           "approve": ("reviewed", "approved"), "reject": ("reviewed", "rejected")}


class ChtClient:
    """Minimal CHT API client using the service account (never an admin)."""

    def __init__(self, base_url: str, username: str, password: str):
        self.base = base_url.rstrip("/")
        self.username = username
        self.auth = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
        self.password = password

    def _call(self, method: str, path: str, body=None):
        req = urllib.request.Request(self.base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": self.auth, "Content-Type": "application/json", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read())

    def docs(self) -> list[dict]:
        return [r["doc"] for r in self._call("GET", "/medic/_all_docs?include_docs=true")["rows"] if r.get("doc")]

    def create(self, doc: dict) -> str:
        """PUT with a stable _id: 'created', or 'exists' when an earlier run already wrote it."""
        try:
            self._call("PUT", "/medic/" + urllib.parse.quote(doc["_id"], safe=""), doc)
            return "created"
        except urllib.error.HTTPError as e:
            if e.code == 409:
                return "exists"
            raise

    def couch_url(self) -> str:
        parts = urllib.parse.urlsplit(self.base)
        cred = f"{urllib.parse.quote(self.username, safe='')}:{urllib.parse.quote(self.password, safe='')}"
        return f"{parts.scheme}://{cred}@{parts.netloc}"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _record(_id: str, form: str, subject: str, fields: dict) -> dict:
    return {"_id": _id, "type": "data_record", "form": form, "content_type": "json", "reported_date": _now_ms(),
            "from": "carelink-oi-service", "fields": {"patient_id": subject, "place_id": subject, **fields}}


def export_live(client: ChtClient, facility: str, include_test_records: bool = False) -> dict:
    """Community-level counts, using the same tested Node code as the CHT tasks (lib/oi-export.js).

    Records created by regression tests are left out unless a plan request is itself marked as a test
    (include_test_records); the facility demand snapshot never includes them.
    """
    with tempfile.TemporaryDirectory() as state:
        env = {**os.environ, "CHT_COUCH_URL": client.couch_url(), "CARELINK_STATE_DIR": state, "CARELINK_FACILITY_ID": facility,
               "CARELINK_INCLUDE_TEST_RECORDS": "1" if include_test_records else ""}
        subprocess.run(["node", str(CONFIG_ROOT / "scripts" / "export-oi-aggregates.js")], cwd=CONFIG_ROOT, env=env,
                       check=True, capture_output=True, timeout=120)
        return json.loads((Path(state) / "outreach-intelligence" / "live-cht.json").read_text())


def link_requests(docs: list[dict], facility: str) -> list[dict]:
    """Day plans and request links still to write for this facility, from the tested Node code (lib/oi-links.js)."""
    out = subprocess.run(["node", str(CONFIG_ROOT / "scripts" / "oi-link-requests.js")], cwd=CONFIG_ROOT,
                         env={**os.environ, "CARELINK_FACILITY_ID": facility}, input=json.dumps(docs),
                         check=True, capture_output=True, timeout=120, text=True)
    return json.loads(out.stdout or "[]")


def dataset_for(live: dict, demo_history: bool) -> data_adapter.Dataset:
    return data_adapter.parse(synthetic.with_demo_history(live) if demo_history else live)


def demand_rows(estimate: dict) -> list[dict]:
    rows = []
    for d, c in zip(planning.demand_from(estimate), estimate["communities"]):
        rows.append({**d, "method": c["method"], "explanation": c["explanation"], "warnings": c["warnings"], "reporting_quality": c["reporting_quality"], "volunteer_reporting_coverage": c["volunteer_reporting_coverage"]})
    return rows


# ---- 1. demand snapshot -----------------------------------------------------------------------

def demand_record_id(facility: str, dataset: data_adapter.Dataset, day: str) -> str:
    # Append new snapshots only when meaningful inputs or the model version change.
    # exported_at is deliberately excluded so a watch cycle cannot manufacture snapshots.
    semantic = {"communities": dataset.communities, "history": dataset.history, "current": dataset.current,
                "as_of": dataset.as_of, "model_version": FORECAST_VERSION}
    digest = hashlib.sha256(json.dumps(semantic, sort_keys=True).encode()).hexdigest()[:16]
    return f"carelink-oi-demand-{facility}-{day}-{digest}"


def demand_doc(facility: str, dataset: data_adapter.Dataset, day: str) -> dict:
    estimate = forecast.estimate(dataset)
    comparison = model_comparison.compare(dataset, with_ml=False)
    return _record(demand_record_id(facility, dataset, day), F["demand"], facility, {
        "as_of": dataset.as_of, "dataset_label": dataset.label, "synthetic_history": dataset.synthetic,
        "model_version": FORECAST_VERSION, "demand": demand_rows(estimate),
        "model_decision": comparison.get("decision", {"reason": comparison.get("reason", "")}),
    })


# ---- 2. plan requests → proposals ---------------------------------------------------------------

def resources_for(request: dict, dataset: data_adapter.Dataset, resources_file: Path, readiness_records: list[dict] | None = None) -> tuple[dict, dict]:
    f = request["fields"]
    day = f["planning_date"]
    if dt.date.fromisoformat(day).isoformat() != day:
        raise ValueError("Planning date must be an ISO date.")
    if f.get("season", "dry") not in ("dry", "rainy"):
        raise ValueError("Unknown travel season.")
    fairness = float(f.get("fairness_weight", 0.5))
    if not math.isfinite(fairness) or not 0 <= fairness <= 1:
        raise ValueError("Fairness weight must be a finite number from 0 to 1.")
    for key in ("hours_start", "hours_end"):
        value = str(f[key])
        if not re.fullmatch(r"(?:[01][0-9]|2[0-3])[0-5][0-9]", value):
            raise ValueError("Working hours must be valid four-digit times.")
    if int(f["hours_end"]) <= int(f["hours_start"]):
        raise ValueError("The working day must end after it starts.")
    res = planning.live_resources(dataset, resources_file, day=day, season=f.get("season", "dry"), facility=f.get("patient_id"),
                                  readiness_records=readiness_records, include_test_records=f.get("include_test_records") == "yes")
    staff = set(str(f.get("staff_available", "")).split())
    vehicles = set(str(f.get("vehicles", "")).split())
    if staff - {w["id"] for w in res["workers"]}:
        raise ValueError("An unavailable or unknown staff identifier was supplied.")
    if vehicles - {v["id"] for v in res["vehicles"]}:
        raise ValueError("An unknown transport resource was supplied.")
    hh = lambda v: f"{str(v)[:2]}:{str(v)[2:]}" if len(str(v)) == 4 else str(v)
    res["workers"] = [{**w, "available_days": [day], "hours": {"start": hh(f["hours_start"]), "end": hh(f["hours_end"])}}
                      for w in res["workers"] if w["id"] in staff]
    res["vehicles"] = [{**v, "available_days": [day]} for v in res["vehicles"] if v["id"] in vehicles]
    res["confirmed_assignments"] = [{"worker": a["worker"], "day": a["day"], "community": a["community"], "min_followups": int(a.get("min_followups", 1))}
                                    for a in dataset.confirmed if a["day"] == day]
    res["label"] = f"Request {request['_id'][:8]} for {day}"
    guaranteed = str(f.get("guarantee_communities", "")).split()
    # Optional: how many documented items each guaranteed community must get (default 1).
    minimum = int(f.get("guarantee_min_items") or 1)
    if not 1 <= minimum <= 50:
        raise ValueError("The guaranteed minimum must be between 1 and 50 items.")
    policy = {"fairness_weight": fairness,
              "min_coverage": {"enabled": bool(guaranteed), "communities": guaranteed, "min_followups": minimum}}
    # Transparent, configurable fairness rules from the facility configuration (planning/tolon-district.json).
    rules = json.loads(Path(resources_file).read_text()).get("fairness_rules") or {}
    if rules.get("underserved_components"):
        policy["underserved_components"] = {k: float(v) for k, v in rules["underserved_components"].items()}
    for key in ("outreach_grace_days", "outreach_full_gap_days", "unserved_planned_cap"):
        if key in rules:
            policy[key] = int(rules[key])
    return res, policy


def proposal_doc(request: dict, facility: str, dataset: data_adapter.Dataset, resources_file: Path, readiness_records: list[dict] | None = None) -> dict:
    res, policy = resources_for(request, dataset, resources_file, readiness_records)
    worker_ids = {w["id"] for w in res["workers"]}
    missing = [a for a in res["confirmed_assignments"] if a["worker"] not in worker_ids]
    if missing:
        raise ValueError("Confirmed outreach exists for a worker excluded from this request. Include the booked worker to preserve commitments, or choose another date.")
    plan = planning.build(dataset, res, policy)
    r, x = plan["result"], plan["explanation"]
    names = {d["community_id"]: d["name"] for d in plan["demand"]}
    snapshot = {"dataset_sha256": dataset.sha256, "resources": res, "policy": plan["policy"], "demand": plan["demand"]}
    fairness = [{"community_id": d["community_id"], "name": d["name"], "covered": r.get("served", {}).get(d["community_id"], 0),
                 "unmet": r.get("unserved", {}).get(d["community_id"], d["pending"]), "data_coverage": d["data_coverage"],
                 "barrier_level": d["barrier_level"], "weight": r.get("priorities", {}).get(d["community_id"], {}).get("weight"),
                 "guaranteed": d["community_id"] in policy["min_coverage"]["communities"],
                 # Coverage indicators and the parts of the underserved index they produced.
                 "days_since_outreach": d.get("days_since_outreach"), "unserved_planned": d.get("unserved_planned", 0),
                 "visits_completed_4w": d.get("visits_completed_4w", 0),
                 "underserved_parts": {k: r.get("priorities", {}).get(d["community_id"], {}).get(k) for k in ("barrier", "coverage_gap", "outreach_gap", "unserved_planned")}}
                for d in plan["demand"]]
    alternatives = [f"{'; '.join(t['worker_name'] + ': ' + ' → '.join('Facility' if s == 'facility' else names.get(s, s) for s in t['route']) for t in a['trips'])} — {a['difference']}"
                    for a in plan["alternatives"]]
    f = request["fields"]
    return _record(f"carelink-oi-proposal-{request['_id']}", F["proposal"], facility, {
        "request_id": request["_id"], "requested_by": f["actor"], "requested_by_contact": f.get("actor_contact", ""),
        "planning_date": f["planning_date"], "season": f.get("season", "dry"), "dataset_label": dataset.label,
        "synthetic_history": dataset.synthetic, "planner_version": PLANNER_VERSION, "model_version": FORECAST_VERSION,
        "input_sha256": hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest(),
        "demand": demand_rows(forecast.estimate(dataset)), "fairness": fairness, "alternatives": alternatives,
        "schedule": {"status": r["status"], "solver": r["solver"], "trips": r.get("trips", []), "served": r.get("served", {}),
                     "unserved": r.get("unserved", {}), "pending": r.get("pending", {})},
        "explanation": {"summary": x["summary"], "communities": x.get("communities", {}), "binding": x.get("binding", []),
                        "what_if": x.get("what_if", []), "reasons": x.get("reasons", []),
                        "resources": x.get("resources", []), "needs_confirmation": x.get("needs_confirmation", [])},
        # Planned allocation of supplies, equipment and fuel (not a deduction from stock).
        "resource_plan": r.get("resource_usage", {}),
        "unserved_by_type": r.get("unserved_by_type", {}),
        "urgent_note": plan["urgent_note"], "notice": "Recommendation only. Approval records a planning decision, not a clinical authorisation.",
    })


# ---- 3. decisions → acknowledgements (the authority) ---------------------------------------------

def adjudicate(proposal: dict, events: list[dict], acks: list[dict]) -> list[dict]:
    """Returns new decisions as dicts {event, result, reason, state_before, state_after}. Pure."""
    key = lambda d: (d.get("reported_date", 0), d["_id"])
    acked = {a["fields"]["event_id"] for a in acks}
    state, last, reviewer = "draft", proposal["_id"], None
    event_map = {e["_id"]: e for e in events}
    accepted = [a for a in acks if a["fields"]["result"] == "accepted"]
    # Follow predecessors, never client clocks or tied server timestamps.
    while True:
        following = [a for a in accepted if a["fields"].get("previous_event", event_map.get(a["fields"]["event_id"], {}).get("fields", {}).get("expected_event")) == last]
        if not following:
            break
        if len(following) != 1:
            raise ValueError("Conflicting accepted server acknowledgements require operator review.")
        a = following[0]
        state, last = a["fields"]["state_after"], a["fields"]["event_id"]
        accepted.remove(a)
        if a["fields"]["action"] == "review":
            reviewer = a["fields"]["actor"]
    known = {proposal["_id"], *acked}
    pending = sorted((e for e in events if e["_id"] not in acked), key=key)
    decisions = []
    while True:
        here = [e for e in pending if e["fields"].get("expected_event") == last]
        if len(here) > 1:  # two people acted on the same step at once (e.g. both offline): apply neither
            for e in here:
                decisions.append({"event": e, "result": "conflict", "state_before": state, "state_after": state,
                                  "reason": f"{len(here)} decisions were made on the same plan step at the same time, so none was applied. Open the task again and decide once."})
                pending.remove(e)
            continue
        if not here:
            break
        e = here[0]
        pending.remove(e)
        ok, reason = _valid(e, state, proposal, reviewer)
        after = ACTIONS[e["fields"]["action"]][1] if ok else state
        decisions.append({"event": e, "result": "accepted" if ok else "rejected", "reason": reason, "state_before": state, "state_after": after})
        if ok:
            state, last = after, e["_id"]
            if e["fields"]["action"] == "review":
                reviewer = e["fields"]["actor"]
    for e in pending:  # acted on an older version of the plan
        if e["fields"].get("expected_event") in known | {d["event"]["_id"] for d in decisions}:
            decisions.append({"event": e, "result": "rejected", "state_before": state, "state_after": state,
                              "reason": "The plan changed after this decision was made (stale). Open the task again."})
    return decisions


def _valid(e: dict, state: str, proposal: dict, reviewer: str | None) -> tuple[bool, str]:
    f = e["fields"]
    action, actor = f.get("action"), f.get("actor")
    requester = proposal["fields"]["requested_by"]
    if action not in ACTIONS:
        return False, f"Unknown action {action!r}."
    if ACTIONS[action][0] != state:
        return False, f"Cannot {action} a plan that is {state}."
    if action == "submit" and actor != requester:
        return False, "Only the person who requested the plan can submit it."
    if action != "submit" and actor == requester:
        return False, "Separation of duties: the person who requested a plan cannot review, approve or reject it."
    if action in ("approve", "reject") and actor != reviewer:
        return False, "The person who reviewed the plan must record the decision."
    if action == "reject" and not str(f.get("notes", "")).strip():
        return False, "A rejection needs a reason."
    if action in ("submit", "review", "approve") and proposal["fields"]["schedule"]["status"] not in ("OPTIMAL", "FEASIBLE"):
        return False, "An infeasible plan cannot go forward. Generate a new plan with different resources."
    return True, "Accepted by the server."


# ---- 4. approved plan → CHO assignments -------------------------------------------------------------

def assignments_for(proposal: dict, existing: list[dict]) -> tuple[list[dict], str | None]:
    """Assignment records for an approved plan. Refuses to double-book a worker already assigned by another approved plan."""
    pid = proposal["_id"]
    names = {d["community_id"]: d["name"] for d in proposal["fields"]["demand"]}
    taken = {(a["fields"]["worker_id"], a["fields"]["date"]): a["fields"]["proposal_id"] for a in existing if a["fields"]["proposal_id"] != pid}
    taken_vehicles = {(a["fields"]["vehicle"], a["fields"]["date"]): a["fields"]["proposal_id"]
                      for a in existing if a["fields"]["proposal_id"] != pid and a["fields"].get("vehicle")}
    out = []
    for t in proposal["fields"]["schedule"]["trips"]:
        if (t["vehicle"], t["day"]) in taken_vehicles:
            return [], f"Vehicle {t['vehicle']} is already assigned on {t['day']} by another approved plan; nothing was overwritten. Generate a new plan."
        if (t["worker"], t["day"]) in taken:
            return [], f"{t['worker_name']} is already assigned on {t['day']} by another approved plan; nothing was overwritten. Generate a new plan."
        route = " → ".join("Facility" if s == "facility" else names.get(s, s) for s in t["route"])
        for community, items in t["served"].items():
            out.append(_record(f"carelink-oi-assignment-{pid}-{t['day']}-{community}", F["assignment"], community, {
                "proposal_id": pid, "worker_id": t["worker"], "worker_name": t["worker_name"], "date": t["day"], "vehicle": t["vehicle"],
                "community_name": names.get(community, community), "items_planned": items, "route_text": route,
                "served_by_type": (t.get("served_by_type") or {}).get(community, {}),
                "planner_version": proposal["fields"]["planner_version"], "input_sha256": proposal["fields"]["input_sha256"]}))
    return out, None


def ack_doc(proposal: dict, d: dict, facility: str) -> dict:
    e = d["event"]
    return _record(f"carelink-oi-ack-{e['_id']}", F["ack"], facility, {
        "proposal_id": proposal["_id"], "event_id": e["_id"], "action": e["fields"].get("action"), "actor": e["fields"].get("actor"),
        "actor_contact": e["fields"].get("actor_contact", ""), "result": d["result"], "reason": d["reason"],
        "state_before": d["state_before"], "state_after": d["state_after"], "previous_event": e["fields"].get("expected_event"), "input_sha256": proposal["fields"]["input_sha256"],
        "planner_version": PLANNER_VERSION})


# ---- the cycle -----------------------------------------------------------------------------------

def process_once(client: ChtClient, facility: str, resources_file: Path, today: str | None = None, live: dict | None = None) -> dict:
    today = today or dt.date.today().isoformat()
    docs = client.docs()
    ids = {d["_id"] for d in docs}
    reports = [d for d in docs if d.get("type") == "data_record" and isinstance(d.get("fields"), dict)]
    of = lambda form: [r for r in reports if r.get("form") == form and
                       (form == F["assignment"] or r["fields"].get("patient_id") == facility)]
    summary = {"demand": None, "proposals": [], "acks": [], "assignments": [], "links": []}

    def active_assignments():
        # A day the CHO has recorded (carelink_oi_outreach_day) is over: it no longer books her or the vehicle.
        recorded = {r["fields"].get("assignment_id") for r in reports if r.get("form") == "carelink_oi_outreach_day"}
        return [a for a in of(F["assignment"]) if a["_id"] not in recorded]
    live_cache = {}

    def data(demo: bool, include_test_records: bool = False):
        key = "test" if include_test_records else "live"
        if key not in live_cache:
            live_cache[key] = live or export_live(client, facility, include_test_records)
        return dataset_for(live_cache[key], demo)

    demand_id = demand_record_id(facility, data(True), today)
    if demand_id not in ids:
        summary["demand"] = client.create(demand_doc(facility, data(True), today))
    for request in of(F["request"]):
        pid = f"carelink-oi-proposal-{request['_id']}"
        if pid not in ids:
            try:
                f = request["fields"]
                test_run = f.get("include_test_records") == "yes"
                # Resource readiness staff confirmed in CHT for this facility (carelink_resource_status).
                ready = [r for r in reports if r.get("form") == "carelink_resource_status" and r["fields"].get("patient_id") == facility]
                doc = proposal_doc(request, facility, data(f.get("use_synthetic_history", f.get("use_demo_history")) == "yes", test_run), resources_file, ready)
                doc["fields"]["includes_test_records"] = test_run
            except (ValueError, KeyError, TypeError) as error:
                # A malformed request must not poison the queue or block other reviews.
                f = request["fields"]
                doc = _record(pid, F["proposal"], facility, {
                    "request_id": request["_id"], "requested_by": f.get("actor"), "requested_by_contact": f.get("actor_contact"),
                    "planning_date": f.get("planning_date", "unknown"), "planner_version": PLANNER_VERSION, "model_version": FORECAST_VERSION,
                    "schedule": {"status": "INVALID_INPUT", "solver": "OR-Tools CP-SAT", "trips": [], "served": {}},
                    "explanation": {"summary": "No plan generated: correct the request inputs and submit a new request.", "reasons": [str(error)[:240]]},
                    "demand": [], "fairness": [], "input_sha256": hashlib.sha256(json.dumps(f, sort_keys=True).encode()).hexdigest()})
            summary["proposals"].append((pid, client.create(doc), doc["fields"]["schedule"]["status"]))
            reports.append(doc)
    for proposal in of(F["proposal"]):
        events = [e for e in of(F["review"]) if e["fields"].get("proposal_id") == proposal["_id"]]
        acks = [a for a in of(F["ack"]) if a["fields"].get("proposal_id") == proposal["_id"]]
        for d in adjudicate(proposal, events, acks):
            if d["result"] == "accepted" and d["event"]["fields"]["action"] == "approve":
                _, refusal = assignments_for(proposal, active_assignments())
                if refusal:
                    d = {**d, "result": "rejected", "reason": refusal, "state_after": d["state_before"]}
            ack = ack_doc(proposal, d, facility)
            summary["acks"].append((d["event"]["_id"], client.create(ack), d["result"]))
            reports.append(ack)
        # An approval acknowledgement must be durable BEFORE tasks can be issued.
        # Repeat on every cycle so a crash after approval or during assignment writes heals.
        approved = any(a["fields"].get("proposal_id") == proposal["_id"] and a["fields"].get("result") == "accepted"
                       and a["fields"].get("state_after") == "approved" for a in of(F["ack"]))
        if approved:
            docs_out, refusal = assignments_for(proposal, active_assignments())
            # An already-assigned plan whose recorded day was later reused is not an error.
            if refusal and any(a["fields"].get("proposal_id") == proposal["_id"] for a in of(F["assignment"])):
                refusal, docs_out = None, []
            if refusal:
                summary.setdefault("assignment_errors", []).append({"proposal": proposal["_id"], "reason": refusal})
            for assignment in docs_out:
                if assignment["_id"] in ids:
                    continue
                summary["assignments"].append((assignment["_id"], client.create(assignment)))
                ids.add(assignment["_id"])
                reports.append(assignment)  # reserves worker/day against other proposals in this cycle
    # 5. Link approved days to household requests (stable IDs: a repeated cycle writes nothing new).
    if any(a["fields"].get("proposal_id") in {p["_id"] for p in of(F["proposal"])} for a in of(F["assignment"])):
        summary["links"] = [(doc["_id"], client.create(doc)) for doc in link_requests(client.docs(), facility)]
    return summary


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="CareLink Outreach Intelligence planning service for CHT")
    parser.add_argument("--watch", type=int, default=0, help="repeat every N seconds (0 = run once)")
    parser.add_argument("--credentials", default=str(Path(os.environ.get("CARELINK_STATE_DIR", Path.home() / ".carelink-reach")) / "oi-service.json"))
    args = parser.parse_args()
    cred = json.loads(Path(args.credentials).read_text())
    client = ChtClient(cred["url"], cred["username"], cred["password"])
    resources = CONFIG_ROOT / "planning" / "tolon-district.json"
    facilities = [f["id"] for f in json.loads(resources.read_text())["facilities"]]
    # One worker serves every facility in the district, one facility after another, including
    # one-shot invocations. OS advisory locking prevents duplicate local worker processes;
    # multi-host leadership needs a deployment-level singleton (not a second approval database).
    import fcntl
    lock_path = Path(args.credentials).parent / "oi-worker.lock"
    lock_file = lock_path.open("a")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("An Outreach Intelligence worker is already running.")
    while True:
        for facility in facilities:
            at = dt.datetime.now().isoformat(timespec="seconds")
            try:
                print(json.dumps({"at": at, "facility": facility, **process_once(client, facility, resources)}), flush=True)
            except Exception as e:  # keep serving; the next cycle retries idempotently
                print(json.dumps({"at": at, "facility": facility, "error": str(e)}), flush=True)
        if not args.watch:
            break
        time.sleep(args.watch)


if __name__ == "__main__":
    main()
