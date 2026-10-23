# CareLink Reach — Security, Limitations and Deployment Readiness

**Status: fictional-data development demo. NOT approved for real patients.**

This prototype does **not** claim any of the following:

- Clinical validation
- Emergency response
- Facility acceptance without a recorded acknowledgement
- Diagnostic or triage AI
- Production security readiness

## Verified controls (evidence in `evidence/`)

| Control | Result |
|---|---|
| Replication scoped by place: a community 1 user does not receive community 3 households | Pass |
| Direct read of another community's document | 403 |
| Community contact listing users | 403 |
| CHO A scoped to communities 1–2 only | Pass |
| Supervisor blocked from an independent facility | 403 |
| Community role has no clinical, messaging, task-assignment, export or user-management permission | Pass (unit test) |
| Server accepts each CareLink form only from its authorised roles; coordination records are append-only; app users cannot delete CareLink records | Pass: unit tests, plus live checks on 2026-10-21 (forged community write rejected; coordinator edit rejected) |
| Consent is required before a request can be submitted | Pass |
| No duplicate request after sync retries | Pass |
| Credentials kept out of the project (env vars; random demo passwords in `~/.carelink-reach`, mode 0600; `.env*` gitignored) | By design |

## Known limitations

### Security

- The server-side authority check (`_design/carelink-authority`) enforces **which role** may submit each form. It does not check that a report's `contact` field matches the submitting user, so a coordinator could submit an event naming another coordinator. CHT itself does not record which user wrote a document.
- A record rejected by the server stays on the device that made it and keeps failing to sync. That can only happen when someone bypasses the app interface.
- Not tested: revoking a user, wiping a device after access is removed, browser storage eviction, and shared-device use.
- Local HTTP only. There is no TLS, backup encryption, audit-log review or penetration test.
- `can_skip_password_change` is granted for the demo. Remove it before any pilot.

### Offline

- Tested with Chrome DevTools network emulation, not a physical Android device in airplane mode.
- The first login and asset download were done online.
- Concurrent requests from two devices for the same household are flagged by the workflow as a `conflict` (unit-tested). This has not been tested on two real devices.

### Workflow and UX

- Demo steps 1–7 passed end-to-end on 2026-10-21, in headless Chrome against localhost, not on physical devices.
- **Header colour** needs a core stylesheet patch (`core-patches/`), because CHT 5.3 hard-codes tab colours. Every CHT upgrade means re-applying the patch and rebuilding. A modified CHT is offered to network users under AGPL-3.0.
- There is no configurable home screen. The community user's three actions are in the household action menu.
- Messages are disabled because there is no SMS gateway.
- Referral states "delivery pending" and "delivered" come from CHT sync status, not explicit form values.

### Content

- English only. No translations have been created. Do not add machine translations for clinical content.
- Audio education is disabled. There are no reviewed recordings or speaker permissions.
- Outreach planning (`npm run plan`) is a transparent need score plus a rule-based scheduler. It is not machine learning and makes no clinical decisions. Plans are recommendations a coordinator approves. Weights are pending programme review; travel times and resources are fictional (`docs/engines/CARELINK_OUTREACH_PLANNING.md`). Outreach Intelligence now includes a baseline forecast, experimental model comparisons, CP-SAT planning and an integrated CHT approval workflow; see `docs/architecture/OUTREACH_INTELLIGENCE_ARCHITECTURE.md` and its limitations. The Flutter nutrition retrieval feature is separate and not integrated.
- No ANC, PNC or CWC clinical forms. Clinical protocols need approval from qualified professionals first.

## Before any pilot

1. Ethics, privacy (Ghana Data Protection Act 2012), GHS and institutional approvals.
2. Server-side check that a report's author contact matches the submitting user, through a small API or mediator service.
3. Production deployment on CHT's supported Docker setup, with TLS, backups and monitoring. Either a custom image for the colour patch or no patch.
4. Physical-device offline and sync testing on target Android hardware and networks.
5. Demo steps 4–7 run on physical devices, not just headless Chrome.
6. Reviewed translations and audio, chosen with each community.
7. Usability testing with community contacts and CHOs.
8. A decision on core CSS changes, made with the AGPL implications in mind.
