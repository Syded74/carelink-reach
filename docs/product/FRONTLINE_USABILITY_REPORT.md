# Frontline usability simplification

**Date:** 22 October 2026.

**Goal:** a CHO opens CareLink, sees what work is due, and records an outcome without needing to understand the AI or the database.

**Constraints kept:**
- CHT Core is not modified, and there is no new application.
- The two engines are unchanged.
- No safety notice was removed.
- No data is discarded: hidden fields are still saved in every record.

**Evidence:** `evidence/usability/`.
- `before-*.png` and `after-*.png`: Chrome, captured by `npm run usability-screens -- before|after`.
- `phone-*.png`: the CareLink Android app on a physical phone, captured by a phone script since replaced by `npm run outreach-phone`.

## 1. Audit findings (before)

| Screen | Problem |
|---|---|
| Report view (all forms) | Every field label was a raw key, e.g. `report.carelink_coordination.patient_id`. No `report.*` translations existed |
| Report view | Internal references (request, previous event, assigned worker id, created by, `meta.instanceID`) and form notices were listed as data |
| Report view | Person, household and community repeated below the header that already shows them |
| CHO task list | One reason ("Recorded danger sign") repeated on every task for the same person, so a concern task and a referral task looked like duplicates |
| CHO task list | Titles were generic: "Scheduled follow-up due", "First visit due", "Confirmed outreach visit" |
| Coordinator task list | 23 tasks, 20 of them "Submit outreach plan for review" for superseded or old test plans |
| Outreach Intelligence tab | The first screen was a forecast table with paragraph-length explanations. The plan was below the demand, coverage and readiness sections |
| Outreach Intelligence tab | The vehicle was shown by its database id; there were 90+ plan buttons |
| Resource readiness | Statuses were long phrases; the readiness table showed resource ids |
| Place labels | "Partner health facilitys", "Communitys" |

## 2. Changes

| Area | Change | Files |
|---|---|---|
| Report labels | 778 plain-language labels, e.g. "Patient reference", "Request status before/after this update", "Clinical review status", "Measurements not taken". They are generated from a reviewed dictionary, otherwise from the form's own question | `lib/report-labels.js`, `scripts/build-report-labels.js`, `translations/messages-en.properties` |
| Hidden fields | 157 internal fields and display-only notes are marked `tag="hidden"`, so CHT 5.3 leaves them out of the report view (`hidden_fields`). They remain in the saved record for tasks, the worker, audit and export | the same script; all `forms/app/*.xml` |
| Assigned worker | The coordination record shows the assigned worker's name, not their id | `forms/app/carelink_coordination.xml` |
| Planning-service records | Plan, acknowledgement, assignment and link reports show a few labelled key fields (date, worker, community, result) | `app_settings/base_settings.json` (generated) |
| Task titles | **ANC / PNC follow-up due**, **Child welfare visit due**, **First ANC/PNC/child welfare visit due**, **Add missing ANC/PNC/child measurements**, **Household visit planned**, **Referral needs follow-up**, **Clinical concern — professional review required**, **Missed appointment — follow up** | `tasks.js`, translations |
| Task status line | Concern tasks: "Urgent · follow referral procedures now". Referral tasks: their real state, e.g. "Waiting for the receiving facility to acknowledge" or "Acknowledged · record arrival or outcome". Other tasks for a person with an open concern: "Urgent concern open for this person". Routine tasks: no repeated reason | `tasks.js` |
| Coordinator tasks | Submit task only for the newest plan of the facility. Test plans leave task lists after a day, as test contacts already did | `tasks.js` |
| Plan view | Summary first: outreach date, health worker, communities, vehicle name, planned visits, not planned, resource line, warnings, approval status, next action. **Why this plan** (reasons, unmet services by type, constraints, resources, what-ifs, fairness, assumptions, provenance) and **Decision history (audit)** are one tap away. Six recent plans are shown; older ones are under "Older plans". Coverage and the forecast are collapsible below | `ui-extensions-src/carelink-outreach-intelligence.js`, `scripts/build-oi-extension.js` |
| Resource readiness | Statuses: **Available**, **Not enough**, **Not available**, **Needs confirmation**. Resources are shown by name. Simulated values are labelled "planning estimate, not confirmed stock". Stored codes are unchanged | `scripts/build-oi-forms.js`, UI extension |
| Place labels | "Partner health facilities", "Communities" | translations |

**Safeguards kept and still visible:**
- the offline and sync notices on forms and the tab;
- the danger-sign notice on every plan;
- urgent concern tasks;
- human approval and server acknowledgement;
- the test-plan banner;
- the provenance and audit trail (under its heading);
- all `validate_doc_update` rules.

## 3. Verified results (this session, after the change)

| Check | Result |
|---|---|
| JS unit tests (`npm test`; includes the new `test/report-labels.test.js`) | **70 / 70** |
| Python engine tests (`pytest`) | **88 / 88** (engines unchanged) |
| Volunteer submits a routine request; offline; duplicate; permissions (`volunteer-flow`) | **14 / 14** |
| Coordinator reviews; supervisor approves offline then online; CHO outreach day; conflicts (`oi-cht-flow`) | **13 / 13** |
| ANC → delivery → PNC → CWC; CHO finds and resolves a follow-up; referral acknowledged; offline CWC (`mch-flow`) | **20 / 20** |
| End-to-end walkthrough | **9 / 9** |
| Coordinator records resource readiness; plans change with stock (`supply-flow`) | **6 / 6** |
| Maternal and child follow-ups through an approved day, offline resolution (`mch-outreach-flow`) | **all 16 numbered steps** (11 recorded checks) |
| CHO records a visit offline; feedback into the next plan (`feedback-flow`) | **all 11 numbered steps** (10 recorded checks) |
| Physical phone (CareLink Android app) | CHO task list, report view and profile; coordinator plan summary, "Why this plan", readiness form and task list. All rendered with the new configuration (`phone-*.png`) |

**Flow fixes:** `oi-cht-flow` and `mch-flow` first failed only because they looked for the old wording ("Recommended schedule", "Appointment recorded as missed"). The scripts were updated to the new labels and both passed on rerun.

**Phone capture:** a capture of the CHO follow-up task included a personal phone notification and was deleted. The phone needs Do Not Disturb on for future captures.

## 4. Outstanding CHT limitations

- **Stored codes are shown as saved.** For XForm reports, CHT 5.3 shows values as saved (`pending_clinical_review`, `cwc`, `missed`, `muac_mm`). Configuration can relabel fields, not values. Plain-language values would need companion display fields on every form or a CHT Core change.
- **Older reports still list internal fields.** `hidden_fields` is written when a report is saved. Records saved before this change still list their internal fields, now with readable labels. They were not rewritten: records are append-only.
- **Empty fields are listed.** CHT lists fields that were left blank (e.g. MUAC when not measured).
- **The patient reference is an ID link.** The report header already names the person.
- **Task card layout is fixed.** It shows contact, title, one status line and due date. A separate "action" column is not configurable; the action is the task title and the buttons inside it.
- **The calendar warning wording comes from the planning engine** ("Friday is usually not set…"). The engines were out of scope.
- **The coordinator view is still busy.** On a phone, the plan summary is the first content, but it sits below the staff and vehicles card.
