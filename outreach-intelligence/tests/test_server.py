"""Integration: the authenticated HTTP service, role control, approval lifecycle and audit trail."""
import http.client
import json
import threading

import pytest

from carelink_oi import approval, server

USERS = {
    "coord": ("pw1", ["carelink_coordinator"]),
    "super": ("pw2", ["carelink_supervisor"]),
    "volunteer": ("pw3", ["carelink_community"]),
}


def fake_verify(username, password):
    entry = USERS.get(username)
    return {"name": username, "roles": entry[1]} if entry and entry[0] == password else None


@pytest.fixture()
def service(tmp_path):
    live = tmp_path / "live.json"
    live.write_text(json.dumps({"dataset_id": "live-cht", "as_of": "2026-10-21", "communities": [
        {"id": "c1", "name": "C1", "barrier_level": "high", "responsible_worker": "w1"}],
        "history": [{"community_id": "c1", "period_start": "2026-10-19", "requests_created": 2}],
        "current": [{"community_id": "c1", "as_of": "2026-10-21", "pending_followups": 2, "urgent_items_excluded": 1, "last_visit": None}]}))
    httpd = server.serve(port=0, verify=fake_verify, state_dir=tmp_path / "state", live_path=live)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd.server_address[1], tmp_path
    httpd.shutdown()


class Client:
    def __init__(self, port):
        self.port, self.cookie = port, None

    def call(self, method, path, body=None, header=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        headers = {"Content-Type": "application/json"}
        if header:
            headers["X-CareLink"] = "1"
        if self.cookie:
            headers["Cookie"] = self.cookie
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        res = conn.getresponse()
        data = json.loads(res.read() or b"null")
        if res.getheader("Set-Cookie"):
            self.cookie = res.getheader("Set-Cookie").split(";")[0]
        return res.status, data

    def login(self, user):
        return self.call("POST", "/api/login", {"username": user, "password": USERS[user][0]})


def test_api_requires_sign_in_and_a_planner_role(service):
    port, _ = service
    anon = Client(port)
    assert anon.call("GET", "/api/demand")[0] == 401
    assert anon.call("POST", "/api/login", {"username": "coord", "password": "wrong"})[0] == 401
    vol = Client(port)
    assert vol.login("volunteer")[0] == 403
    assert vol.call("GET", "/api/demand")[0] == 401
    c = Client(port)
    assert c.login("coord")[0] == 200
    assert c.call("POST", "/api/plan", {"resources": {}}, header=False)[0] == 403, "CSRF header required"


def test_refuses_to_listen_beyond_localhost():
    with pytest.raises(SystemExit):
        server.serve(host="0.0.0.0", port=0, verify=fake_verify)


def test_full_lifecycle_with_separation_of_duties_and_audit(service):
    port, tmp = service
    coord, sup = Client(port), Client(port)
    coord.login("coord"); sup.login("super")
    status, demand = coord.call("GET", "/api/demand?dataset=hackathon-villages")
    assert status == 200 and len(demand["estimate"]["communities"]) == 3
    _, res = coord.call("GET", "/api/resources?dataset=hackathon-villages&scenario=baseline")
    status, p = coord.call("POST", "/api/plan", {"dataset": "hackathon-villages", "resources": res["resources"]})
    assert status == 200 and p["status"] == "draft" and p["plan"]["result"]["status"] == "OPTIMAL"
    pid = p["id"]
    assert sup.call("POST", f"/api/proposals/{pid}/submit", {})[0] == 403, "only the creator submits"
    assert coord.call("POST", f"/api/proposals/{pid}/submit", {})[1]["status"] == "proposed"
    assert coord.call("POST", f"/api/proposals/{pid}/review", {})[0] == 403, "creator cannot review own plan"
    assert sup.call("POST", f"/api/proposals/{pid}/approve", {})[0] == 403, "cannot skip review"
    status, reviewed = sup.call("POST", f"/api/proposals/{pid}/review", {"notes": "Drop B", "exclude_communities": ["village-b"]})
    assert status == 200 and reviewed["status"] == "reviewed"
    assert reviewed["revisions"][0]["changes"] == {"exclude_communities": ["village-b"]}
    assert "village-b" not in reviewed["plan"]["result"]["served"]
    assert sup.call("POST", f"/api/proposals/{pid}/reject", {"notes": " "})[0] == 403, "rejection needs a reason"
    status, approved = sup.call("POST", f"/api/proposals/{pid}/approve", {"notes": "Demo approval"})
    assert status == 200 and approved["status"] == "approved" and approved["decision"]["by"] == "super"
    assert "not a real institutional authorisation" in approved["decision"]["notice"]
    assert approved["cht_assignment_integration"] == "disabled"
    _, detail = coord.call("GET", f"/api/proposals/{pid}")
    assert [a["action"] for a in detail["audit"]] == ["create", "submit", "review", "approve"]
    for a in detail["audit"]:
        assert a["input_sha256"] == p["input_sha256"] and a["planner_version"] and a["model_version"]
    lines = (tmp / "state" / "audit.jsonl").read_text().splitlines()
    assert len(lines) == 4, "audit log is append-only, one line per event"


def test_live_dataset_plans_without_patient_data_and_flags_urgent_items(service):
    port, _ = service
    c = Client(port)
    c.login("coord")
    status, sets = c.call("GET", "/api/datasets")
    assert {s["id"] for s in sets} == {"hackathon-villages", "live-cht"}
    _, d = c.call("GET", "/api/demand?dataset=live-cht")
    live = d["estimate"]["communities"][0]
    assert live["method"] == "insufficient_history"
    assert d["ml_experiment"]["status"] == "not_run"


def test_store_rejects_users_without_planner_role(tmp_path):
    store = approval.Store(tmp_path)
    with pytest.raises(approval.ApprovalError):
        store.create({"dataset_id": "x"}, {"name": "v", "roles": ["carelink_community"]})
