"""CareLink Reach — Outreach Intelligence: local authenticated web prototype.

Developer regression only: .venv/bin/python -m carelink_oi.server --developer-ui   →  http://127.0.0.1:8090
Sign-in uses the CHT users and roles (CouchDB /_session); only facility coordinators and
supervisors can enter. It listens on 127.0.0.1 only and must not be exposed publicly.
"""
from __future__ import annotations

import copy
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import approval, data_adapter, forecast, planning, synthetic

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
STATE = Path(os.environ.get("CARELINK_STATE_DIR", Path.home() / ".carelink-reach")) / "outreach-intelligence"
CONFIG = ROOT.parent.parent
SESSION_TTL = 8 * 3600
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}


def cht_verifier(session_url: str):
    """Checks a username/password with CHT (CouchDB /_session) and returns the user's roles."""
    def verify(username: str, password: str) -> dict | None:
        body = json.dumps({"name": username, "password": password}).encode()
        req = urllib.request.Request(session_url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                data = json.loads(res.read())
                return {"name": data["name"], "roles": data.get("roles", [])} if data.get("ok") else None
        except urllib.error.HTTPError:
            return None
    return verify


class App:
    def __init__(self, verify, state_dir: Path = STATE, live_path: Path | None = None, resources_file: Path | None = None):
        self.verify = verify
        self.sessions: dict[str, dict] = {}
        self.store = approval.Store(state_dir)
        self.live_path = live_path or state_dir / "live-cht.json"
        self.resources_file = resources_file or CONFIG / "test" / "fixtures" / "planning-resources.json"
        self._cache: dict[str, tuple] = {}

    def datasets(self) -> dict[str, data_adapter.Dataset]:
        out = {"hackathon-villages": self._cached("hackathon-villages", None, lambda: data_adapter.parse(synthetic.hackathon_dataset()))}
        if self.live_path.exists():
            mtime = self.live_path.stat().st_mtime
            out["live-cht"] = self._cached("live-cht", mtime, lambda: data_adapter.load(self.live_path))
        return out

    def _cached(self, key, version, make):
        if key not in self._cache or self._cache[key][0] != version:
            self._cache[key] = (version, make())
        return self._cache[key][1]

    def demand(self, dataset_id: str) -> dict:
        ds = self.datasets()[dataset_id]
        key = f"demand:{dataset_id}:{ds.sha256}"
        if key not in self._cache:
            self._cache[key] = (None, {"estimate": forecast.estimate(ds), "ml_experiment": forecast.ml_experiment(ds),
                                       "dataset": {"id": ds.dataset_id, "label": ds.label, "synthetic": ds.synthetic, "as_of": ds.as_of,
                                                   "exported_at": ds.exported_at, "source": ds.source, "notes": ds.notes,
                                                   "duplicates_removed": ds.duplicates_removed, "sha256": ds.sha256}})
        return self._cache[key][1]

    def default_resources(self, dataset_id: str, scenario: str = "baseline", season: str = "dry") -> dict:
        if dataset_id == "hackathon-villages":
            return planning.hackathon_resources(scenario)
        return planning.live_resources(self.datasets()[dataset_id], self.resources_file, season=season)


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "CareLinkOI/0.1"

        def log_message(self, fmt, *args):  # keep request logs free of bodies and credentials
            pass

        def _send(self, status: int, body: bytes, ctype: str = "application/json", extra: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data, extra=None):
            self._send(status, json.dumps(data).encode(), extra=extra)

        def _user(self) -> dict | None:
            jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            token = jar["oi_session"].value if "oi_session" in jar else None
            session = app.sessions.get(token or "")
            if not session or session["expires"] < time.time():
                return None
            return session["user"]

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                raise ValueError("Request too large")
            return json.loads(self.rfile.read(length) or b"{}")

        def do_GET(self):
            url = urlparse(self.path)
            if url.path in STATIC:
                name, ctype = STATIC[url.path]
                return self._send(200, (WEB / name).read_bytes(), ctype)
            if not url.path.startswith("/api/"):
                return self._json(404, {"error": "Not found"})
            user = self._user()
            if url.path == "/api/me":
                return self._json(200, {"signed_in": bool(user), **(user or {})})
            if not user:
                return self._json(401, {"error": "Sign in with a CareLink coordinator or supervisor account."})
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if url.path == "/api/datasets":
                    return self._json(200, [{"id": d.dataset_id, "label": d.label, "synthetic": d.synthetic, "as_of": d.as_of}
                                            for d in app.datasets().values()])
                if url.path == "/api/demand":
                    return self._json(200, app.demand(q.get("dataset", "hackathon-villages")))
                if url.path == "/api/resources":
                    return self._json(200, {"resources": app.default_resources(q.get("dataset", "hackathon-villages"), q.get("scenario", "baseline"), q.get("season", "dry")),
                                            "scenarios": [{"id": s, "label": synthetic.scenario(s)["label"]} for s in synthetic.SCENARIOS]})
                if url.path == "/api/proposals":
                    return self._json(200, [_summary(p) for p in app.store.list()])
                if url.path.startswith("/api/proposals/"):
                    pid = url.path.split("/")[3]
                    return self._json(200, {**app.store.get(pid), "audit": app.store.audit(pid)})
            except KeyError:
                return self._json(404, {"error": "Not found"})
            except approval.ApprovalError as e:
                return self._json(400, {"error": str(e)})
            return self._json(404, {"error": "Not found"})

        def do_POST(self):
            url = urlparse(self.path)
            # CSRF guard: browsers cannot add this header cross-site without a CORS preflight we never allow.
            if self.headers.get("X-CareLink") != "1" or "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._json(403, {"error": "Missing request header"})
            try:
                body = self._body()
            except (ValueError, json.JSONDecodeError):
                return self._json(400, {"error": "Invalid request"})
            if url.path == "/api/login":
                user = app.verify(str(body.get("username", "")), str(body.get("password", "")))
                if not user:
                    return self._json(401, {"error": "Sign-in failed."})
                if not set(user["roles"]) & approval.PLANNER_ROLES:
                    return self._json(403, {"error": "This account is not a facility coordinator or supervisor."})
                token = secrets.token_urlsafe(32)
                app.sessions[token] = {"user": user, "expires": time.time() + SESSION_TTL}
                return self._json(200, user, {"Set-Cookie": f"oi_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}"})
            user = self._user()
            if not user:
                return self._json(401, {"error": "Sign in first."})
            try:
                if url.path == "/api/logout":
                    jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
                    app.sessions.pop(jar["oi_session"].value if "oi_session" in jar else "", None)
                    return self._json(200, {"ok": True}, {"Set-Cookie": "oi_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"})
                if url.path == "/api/plan":
                    ds = app.datasets()[body.get("dataset", "hackathon-villages")]
                    plan = planning.build(ds, body["resources"], body.get("policy"))
                    return self._json(200, app.store.create(plan, user))
                if url.path.startswith("/api/proposals/"):
                    _, _, _, pid, action = url.path.split("/")
                    revised, changes = None, None
                    if action == "review" and body.get("exclude_communities"):
                        current = app.store.get(pid)
                        changes = {"exclude_communities": body["exclude_communities"]}
                        resources = copy.deepcopy(current["plan"]["resources"])
                        resources["communities"] = [d["community_id"] for d in current["plan"]["demand"] if d["community_id"] not in body["exclude_communities"]]
                        revised = planning.build(app.datasets()[current["plan"]["dataset_id"]], resources, current["plan"]["policy"])
                    return self._json(200, app.store.act(pid, action, user, notes=str(body.get("notes", "")), changes=changes, revised_plan=revised))
            except approval.ApprovalError as e:
                return self._json(403, {"error": str(e)})
            except (KeyError, ValueError) as e:
                return self._json(400, {"error": f"Invalid request: {e}"})
            return self._json(404, {"error": "Not found"})

    return Handler


def _summary(p: dict) -> dict:
    r = p["plan"]["result"]
    return {"id": p["id"], "status": p["status"], "created_at": p["created_at"], "created_by": p["created_by"],
            "dataset_id": p["plan"]["dataset_id"], "label": p["plan"]["resources"].get("label"), "solver_status": r["status"],
            "served": sum(r.get("served", {}).values()), "pending": sum(r.get("pending", {}).values())}


def serve(host: str = "127.0.0.1", port: int = 8090, verify=None, **kwargs) -> ThreadingHTTPServer:
    if host not in ("127.0.0.1", "localhost"):
        raise SystemExit("Refusing to listen beyond localhost: this prototype must not be exposed publicly.")
    app = App(verify or cht_verifier(os.environ.get("CHT_SESSION_URL", "http://localhost:5984/_session")), **kwargs)
    return ThreadingHTTPServer((host, port), make_handler(app))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Optional legacy developer interface; normal users use the CHT Outreach Intelligence tab.")
    parser.add_argument("--developer-ui", action="store_true", help="explicitly start the separate local regression UI")
    args = parser.parse_args()
    if not args.developer_ui:
        parser.error("Use the Outreach Intelligence tab in CHT. The separate website is retired from the normal workflow; --developer-ui is for optional regression use only.")
    port = int(os.environ.get("OI_PORT", "8090"))
    httpd = serve(port=port)
    print(f"CareLink Reach — Outreach Intelligence on http://127.0.0.1:{port} (Ctrl+C to stop)")
    httpd.serve_forever()
