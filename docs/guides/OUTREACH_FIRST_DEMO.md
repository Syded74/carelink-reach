# CareLink Reach — outreach-first demonstration

**Predict the need. Plan the outreach. Track the outcome.**

**Data:** all people, households and plans in this demonstration are **generated**. Community names (Tolon, Dimabi, Gburimani) are used only as geographic labels. Past forecasting weeks are simulated, and the screen says so. Resource quantities are planning estimates unless confirmed through the Resource readiness form.

## Accounts

| Role | Username | Home screen |
|---|---|---|
| Community volunteer | `aiddrisu` | People → household → **Request help**; the household profile shows each request's status ("My requests") |
| CHO | `sabukari` | **Tasks** (their "My Outreach"): *Planned outreach day*, *Household visit planned*, *ANC follow-up due*, … |
| Coordinator | `rseidu` | **Outreach Intelligence** tab → **Community Outreach** (Needs · Resources · Plan · Progress) |
| Supervisor | `mtahiru` | Same tab, opening on **Plan**, with plans waiting for their decision; decisions are recorded from Tasks |

Passwords come from `CARELINK_ACCOUNT_PASSWORD` (`npm run setup-accounts`). They are not stored in the repository.

## Scenes

**Weekly schedule:** plan for the facility's outreach day. The plan request shows "This facility's next scheduled outreach day is …" (Tuesday at the demonstration facility). Another weekday is allowed, but carries a calendar warning. Unfinished work appears under **Progress → Follow-ups needing attention** and stays on the CHO's tasks (Wednesday: home visits). See [CHPS weekly field workflow](../product/CHPS_WEEKLY_FIELD_WORKFLOW.md).


| # | Scene | What to do | What to point out |
|---|---|---|---|
| 1 | Community need | Volunteer: household → *Request help* (routine ANC, transport barrier) | Saved through CHT. To show offline: remove the USB port forward (`adb reverse --remove tcp:5988`); the request stays on the phone and syncs later |
| 2 | Demand forecast | Coordinator: tab → **Needs** | Documented visits waiting (records) vs "Expected routine outreach needs" (Engine 1) vs reporting gaps. The forecast comes from recent recorded demand; past weeks here are simulated |
| 3 | Resource check | **Resources** → *Check outreach resources* | Workers, motorbikes, and each supply, equipment item and fuel: Available / Not enough / Not available / Needs confirmation. Simulated values are labelled planning estimates |
| 4 | Generate plan | Coordinator: Tasks → *Review outreach request* → accept; tab → **Plan** → *Generate outreach plan* | Plan card: date, CHO, communities, motorbike, planned visits split by ANC / PNC / CWC / requests, visits we could not plan, "What's limiting this plan?" |
| 5 | Resource what-if | *Update resource readiness* → CWC supplies **Needs confirmation** → generate; then **Available, 1 pack** → generate; then **10 packs** → generate | 0 CWC visits → 1 → more. ANC is unaffected. "Child welfare outreach supplies need confirmation before these visits can be scheduled." Automated as `npm run supply-flow` |
| 6 | Approval | Coordinator: *Submit for review* (task). Supervisor: *Review*, then *Approve* (tasks) | The coordinator cannot approve their own plan; the server rejects it. Statuses: Draft → Awaiting review → Awaiting approval → Approved |
| 7 | CHO receives work | CHO: Tasks | *Planned outreach day* "Tolon · N visit(s) planned", plus *Household visit planned* and the follow-up tasks it covers |
| 8 | Record outcome | CHO: complete one household visit; resolve one ANC follow-up; leave another open | Each outcome is its own record, stamped with the CHO's username. Recording the outreach day closes nothing |
| 9 | Progress | Coordinator: tab → **Progress** | Visits assigned, completed and documented, still outstanding; by community and by health worker; reasons for unfinished work |
| 10 | Feedback | Generate the next plan | Documented demand reflects the recorded changes. Engine 1's history counts recorded weekly demand; a completed visit does not change past weeks |

Automated equivalents, each writing `evidence/<name>.json`:
- `walkthrough-flow`: scenes 1, 4 and 6–10;
- `supply-flow`: scene 5;
- `mch-outreach-flow`: maternal and child follow-ups through an approved day;
- `feedback-flow`: scenes 8–10.

## Clean demonstration environment

### Inventory (read-only)

`npm run cleanup-inventory` writes `evidence/cleanup-inventory.json`. It changes nothing.

Classification:
- **Generated:**
  - `record_origin: 'test'` contacts and everything under them;
  - reports about those contacts;
  - plans with `includes_test_records` and all their reviews, acknowledgements, assignments, day plans and links;
  - test readiness records.
- **Uncertain:** looks generated but has no marker. Always preserved.
- **Operational:** everything else.

Names are never used as evidence.

Result on 22 October 2026 (2,886 documents):

| Class | Documents |
|---|---|
| Generated | 2,096 (113 households, 92 individuals, 91 test plans and their 263 decisions, 263 server acknowledgements, 97 assignments, 97 day plans, 329 links, …) |
| Uncertain (preserved) | 0 |
| Operational (kept) | 216 (configuration, places, user contacts, 20 unflagged plans and their records) |
| Task documents | 333 for generated contacts, 241 other |

**Dependencies:**
- 0 operational records reference a generated record.
- 50 generated households have generated members, and are removed together with them.

**Expected effect of removal:**
- **Operational indicators:** no change, because generated records are already excluded (`lib/test-records.js`).
- **Task lists and the planning tab:** test tasks, test plans and test outreach days disappear.
- **Phones:** removal replicates to phones as deletions.

### Deletion gate

**Nothing has been deleted.** Removing records needs explicit approval from the project owner. The earlier request to clear all households and individuals was blocked by a permission check and was **not** executed.

**Preferred option:** a separate clean CHT instance for the demonstration, rather than deleting from this one.

### Backup and restore

- **Back up:** `npm run backup` writes `~/.carelink-reach/backups/<timestamp>/{medic,_users}.json` (owner-only permissions). A full copy was also taken before the clearing request: `~/.carelink-reach/backups/medic-before-clear-20261022-195733.json`.
- **Restore:** if a deletion was made, post the backed-up documents (without `_rev`) to `/medic/_bulk_docs` with an admin account. On a fresh instance, restore into an empty `medic` database, then run `npm run deploy` and `npm run setup-accounts`.

### Proposed demonstration scenario (not yet created)

**People and places:**
- one facility (Tolon District Hospital);
- two communities (Tolon, Dimabi);
- one volunteer, one CHO, one coordinator and one supervisor;
- one motorbike and a small fuel amount.

**Records:**
- a few ANC, PNC and CWC follow-ups;
- one household request;
- CWC supplies set to "Needs confirmation";
- one proposed plan and one approved plan;
- a few documented outcomes and one outstanding visit.

**Creation:** with the existing flows on the clean instance (`walkthrough-flow`, then `supply-flow`), so every record is marked generated.

This is **planned, not done**: it needs the clean instance, or approval to clear this one.
