# CareLink Reach — Outreach Intelligence

Fictional-data prototype that answers two questions for a partner facility:

1. **Where may routine outreach be needed?** Community demand estimation (`carelink_oi/forecast.py`).
2. **How can limited staff and transport reach those communities?** Google OR-Tools CP-SAT scheduling (`carelink_oi/optimizer.py`).

Plans are recommendations. A coordinator generates one, and a *different* coordinator or supervisor reviews and approves or rejects it.

Docs: `../docs/engines/` (forecasting model card, scheduling optimizer, supply-aware scheduling, model evaluation) and `../docs/architecture/OUTREACH_INTELLIGENCE_ARCHITECTURE.md`.

## Install (once)

```sh
cd outreach-intelligence
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # ortools 9.12.4544, scikit-learn 1.6.1, numpy 2.2.4, scipy 1.15.2, pytest 8.3.5
```

Python 3.12 was used. There are no other services: it uses the Python standard library HTTP server.

## Run

```sh
# 1. (optional) export the live CHT snapshot as community-level counts. Needs CHT admin access; read-only.
cd ..   # project root
CHT_COUCH_URL='http://ADMIN:PASSWORD@localhost:5984' npm run oi-export   # → ~/.carelink-reach/outreach-intelligence/live-cht.json

# 2. start the web prototype (localhost only)
cd outreach-intelligence
.venv/bin/python -m carelink_oi.server        # → http://127.0.0.1:8090
```

**Sign in** with a CHT **facility coordinator** or **supervisor** account, for example the demo users `carelink_coordinator` and `carelink_supervisor`. Their passwords are in `~/.carelink-reach/demo-credentials.json`. Sign-in is checked against CHT (CouchDB `/_session`, override with `CHT_SESSION_URL`). Other roles are refused.

## Test and demo

```sh
.venv/bin/python -m pytest -q          # 89 unit + integration tests
.venv/bin/python demo.py               # all scenarios through the real solver → ../evidence/outreach-intelligence-demo.md
npm test                               # CHT config tests, including the privacy test of the exporter
```

State (proposals and the append-only `audit.jsonl`) lives in `~/.carelink-reach/outreach-intelligence/`. Override it with `CARELINK_STATE_DIR`.
