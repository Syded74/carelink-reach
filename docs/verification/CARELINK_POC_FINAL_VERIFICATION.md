# CareLink Reach proof of concept: final verification

**Date:** 22 October 2026.

**System:** CHT 5.3 (unmodified Core), served locally. CareLink Reach configuration from this project. The planning worker runs with its service account.

**Phone:** CHT Android 1.8.0 debug build, brand `carelink_reach_local`, on a Redmi 23076RN8DY with Android 15.

**Data:** all people, households and plans are generated. Records created by tests carry `record_origin: 'test'`.

Before this work, CHT was backed up to `~/.carelink-reach/backups/2026-10-22T06-23-39-846Z`.

## 1. Physical Android device versus browser emulation

`npm run android-device-flow` drives the real CHT Android app's WebView on the phone over USB, using the Chrome DevTools protocol through adb.

"Offline" means the app cannot reach the CHT server: the USB port forward is removed. The phone was not put in airplane mode.

| Step | Physical phone | Browser emulation (Chrome) |
|---|---|---|
| Volunteer signs in; a new household arrives by sync | **Passed** (V1) | Passed (volunteer flow) |
| Volunteer saves a routine request while offline; nothing reaches the server | **Passed** (V2) | Passed (volunteer flow 6, feedback flow) |
| Request survives an app restart while offline (force-stop, relaunch) | **Passed** (V3) | Passed as a page reload (not an app restart) |
| Reconnect and sync: exactly one request on the server; further syncs add nothing | **Passed** (V4) | Passed |
| CHO sees a maternal follow-up planned on an approved outreach day | **Passed** (C1) | Passed (MCH outreach flow 9) |
| CHO resolves the follow-up from her task while offline | **Passed** (C2) | Passed (MCH outreach flow 10–11) |
| Resolution survives an app restart while offline | **Passed** (C3) | Passed as a page reload |
| Sync: one resolution, stamped with the CHO and the outreach day; the day counts it completed; no duplicate after further syncs | **Passed** (C4) | Passed |
| Coordinator and supervisor planning and approval | Not run on the phone | Passed (planning, feedback and MCH outreach flows) |
| Maternal and child forms (ANC, delivery, PNC, CWC, appointment, referral) | Not run on the phone | Passed (MCH flow, 19 steps) |

**Fixtures for the device test** were written through the CHT API as the real users (volunteer, CHO, coordinator, supervisor), so roles and server rules applied:

- the households and the mother;
- the ANC record;
- the plan request and decisions.

Evidence: `evidence/android-device-flow.json` and `evidence/android-1…4-*.png` (real phone screenshots). The phone ends signed in as the CHO.

## 2. Scheduling improvements (Engine 2, OR-Tools CP-SAT)

**Visit types.** Documented workload reaches the scheduler as encounters per type: household request, ANC, PNC and CWC (`encounters_*` in the export). The model chooses items per worker, day, community and type.

**Configurable minutes per type.** These are in `planning/tolon-district.json` `service_minutes_by_visit_type`: request 20, ANC 30, PNC 30, CWC 25. They are operational time-on-site assumptions pending programme review, not clinical requirements.

**Qualifications.** Staff have `qualifications` (currently every CHO is qualified for all four types). A worker can serve only the types they are qualified for; this is enforced in the model.

**Explainable unmet work.** The summary gives covered against documented work per type. Each community explains why work was left. Work with no available qualified worker is named as such.

Example from today's run: "Covers 14 of 22 documented routine items with 1 trip(s); 8 remain unmet. By visit type: ANC follow-up 7 of 14, child welfare follow-up 6 of 7, household request 1 of 1."

**Approved days are filled per type** with what the scheduler planned (`served_by_type` on each assignment). Demand without a type breakdown is handled exactly as before.

**Guaranteed minimum.** A plan request can set an optional `guarantee_min_items` (1–50, default 1) for guaranteed communities.

No appointment schedules, thresholds or clinical rules were added.

## 3. Operational cleanup

**Planning-only records are hidden from volunteers.** The CHT purge rule (`purge.js`) keeps the following off volunteers' phones:

- assignments;
- day plans;
- outreach-day records;
- follow-up links.

The server keeps them. Request links stay, because they are part of the volunteer's request status.

**Understandable labels.** Planning records now have titles in report lists ("Outreach day plan", "Request planned for an outreach day", "Follow-up planned for an outreach day", "Approved outreach assignment" and others). These are form definitions in app settings with translations; all fields still display.

**Automated test records are isolated.** One day after a test run:

- the purge rule removes reports about its test-marked contacts from every phone;
- tasks for those contacts stop showing.

A running test still works. Operational demand, forecasts and indicators already exclude test records at all times. Contacts themselves cannot be purged by CHT, so old test households remain visible in People.

**Audit history preserved.** Nothing was deleted. Purging affects only phones, and leftover test work is closed through normal append-only events with a stated reason.

The purge runs every 30 minutes (`text_expression: 'every 30 minutes'`). See section 5 for its verification.

## 4. Regression results (22 October 2026, real CHT application in Chrome unless stated)

| Suite | Result |
|---|---|
| `npm test` (JS unit and rules) | 61/61 |
| `npm run oi-test` (Python engines and worker) | 76/76 |
| `npm run volunteer-flow` | 14/14 |
| `npm run mch-flow` | 19/19 |
| `npm run oi-cht-flow` | 13/13 recorded steps |
| `npm run feedback-flow` | 10/10 recorded steps (spec steps 1–11) |
| `npm run mch-outreach-flow` | 11/11 recorded steps (spec steps 1–16) |
| `npm run android-device-flow` (**physical phone**) | 8/8 |

**First-run failures on the test side, fixed without weakening any assertion:**

- The volunteer and feedback flows ran out of unused household family names for CHT's duplicate check. They now use two-family names when needed.
- The MCH outreach flow assumed a Dimabi capacity that the realistic per-type visit times no longer gave. It now closes leftover test follow-ups through normal resolutions and requires two Dimabi visits through the new `guarantee_min_items`.

## 5. Purge verification

CHT Sentinel ran the configured purge at 07:00:00 ("Running purging") and created one purge database per role group.

After the run, the CHT replication list (`/api/v1/replication/get-ids`) contained these planning records:

| User | Planning records they replicate |
|---|---|
| `aiddrisu` (volunteer) | 23 request links only: no assignments, day plans, outreach-day records or follow-up links |
| `sabukari` (CHO) | 35 assignments, 35 day plans, 47 follow-up links, 12 outreach-day records, 23 request links |

The server keeps every record; the CHO list above shows they are all still there.

All test records were created today, so none was old enough yet for the one-day test-record rule. That rule is covered by `test/purge.test.js` and applied the same way in `tasks.js`.

## 6. Remaining limitations

- **Device coverage.** The phone test covered volunteer and CHO offline work. Coordinator and supervisor work was verified in Chrome only.
- **Offline on the phone** was a lost server connection, not airplane mode, and the first login needed the network.
- **Contacts** cannot be purged, so old test households stay listed.
- **Minutes per visit type and qualifications** are configuration pending programme review.
- **Test-only plans.** Plans that include test records are requested through the CHT API and labelled "Test plan" in the tab.
- **Clinical content** remains `pending_clinical_review`.
