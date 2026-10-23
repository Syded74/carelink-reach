# CareLink Reach — Demo Guide

> Say this out loud at the start: **"Everything here is invented demonstration data. This is not a clinical system."**

Scenario: a fictional caregiver in **Household 04, Baobab Grove**. The community is served by the fictional *Hope Partner Facility*, which is not nearby.

Demo accounts are `carelink_contact_1`, `carelink_coordinator`, `carelink_cho_a`/`_b` and `carelink_supervisor`. Their passwords are in `~/.carelink-reach`.

| # | Step | How | Evidence | Status |
|---|---|---|---|---|
| 1 | Community contact creates a request | Log in as `carelink_contact_1` → Communities & Households → Household 04 → **+** → *Request help*. Choosing consent "No" blocks submission. | `evidence/request-form.png` | **Tested** (automated) |
| 2 | Request stays local while offline | DevTools → Network → Offline, then submit. The card shows *awaiting assignment*. The server has no copy. Reload while offline: the request is still there. | `request-saved-offline.png`, `request-offline-reload.png`, `offline-test.json` | **Tested** with Chrome network emulation. Not tested on a physical phone in airplane mode. |
| 3 | Connectivity returns and the request is delivered | Go back online and open the menu to sync. Exactly one request appears on the server, and retries create no duplicate. | `offline-test.json` | **Tested** |
| 4 | Coordinator reviews | Log in as `carelink_coordinator` → My Outreach → *Review outreach request* (Household 04). Record **Accept**, then **Assign** (CHO A), then **Confirm outreach date**: three separate records. | `coordinator-outreach-tasks.png`, `coordinator-review-form.png`, `demo-flow.json` | **Tested** (automated, 2026-10-21) |
| 5 | CHO receives an outreach task | Log in as `carelink_cho_a` → My Outreach → *Confirmed outreach visit*. CHO B never sees it. | `cho-visit-form.png`, `demo-flow.json` | **Tested** (automated, 2026-10-21) |
| 6 | CHO documents the visit | Fill in *Document outreach outcome*. The request becomes **completed** only when this visit record reaches the server. | `demo-flow.json` | **Tested** (automated, 2026-10-21) |
| 7 | Supervisor views indicators | Log in as `carelink_supervisor` → Outreach Indicators | `supervisor-indicators.png`, `server-verification.json` | **Tested** (automated, 2026-10-21) |

All seven steps passed on 2026-10-21 (`evidence/offline-test.json`, `evidence/demo-flow.json`). The server holds the full chain for the Household 04 request: accepted → assigned (CHO A) → scheduled → visit completed. The supervisor's indicators match the server counts. Both runs used headless Chrome on this computer, not a physical phone.

## Fictional data (server snapshot after the demo run)

Seed only: 3 communities · 10 households · 8 requests · 5 ever assigned (2 still active) · 3 completed visits · 3 awaiting review · 5 unresolved · 2 transport barriers · 0 conflicts.

After the demo run, which adds the Household 04 request through to a completed visit: 9 requests · 6 ever assigned (2 still active) · 4 completed visits · 3 awaiting review · 5 unresolved · 2 transport barriers · 0 conflicts.

Plus 1 region, 1 district, 1 facility, 2 CHOs, 1 coordinator, 1 supervisor and 3 community contacts.

## Talking points

- "Saved" and "delivered" are shown as different things. The sync indicator is the source of truth.
- A completed task is not proof of care. Only a documented visit outcome closes a request.
- If two coordinators assign the same request offline, the system flags a conflict. It does not guess.
- Barriers are community-reported context, not risk scores.

## Outreach Intelligence continuation

Use the integrated CHT tab and worker described in [Outreach Intelligence architecture](../architecture/OUTREACH_INTELLIGENCE_ARCHITECTURE.md) and [demo guide](../guides/OUTREACH_INTELLIGENCE_DEMO.md). The separate developer website is retained only for regression work. Model evaluation and deployment limits are documented alongside them.
