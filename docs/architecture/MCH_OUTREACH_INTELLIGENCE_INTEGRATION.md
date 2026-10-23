# Maternal and child follow-ups in Outreach Intelligence

A documented maternal or child routine follow-up becomes eligible outreach work. It counts towards community demand, can be taken on by an approved and resource-feasible outreach day, reaches the authorised CHO as a CHT task, and is closed only by a recorded resolution. That completion changes later planning inputs once, however often it is synchronised.

There is no third engine. Engine 1 (forecast and explanations) and Engine 2 (OR-Tools CP-SAT scheduling) receive more precise documented workload. Everything else is CHT records, tasks and server rules.

## Existing components reused

| Component | Role in this integration |
|---|---|
| `lib/mch.js` `projectTasks`, `taskId`, `resolvedIds` | The only source of maternal and child obligations, with their existing task ids (`person:kind:source`) and resolution rule. |
| `lib/schedules.js` | "Due" comes only from a date a health worker recorded. No schedule is added. |
| `tasks.js` maternal and child tasks | The CHO's existing tasks. *Resolve with a reason* now carries the linked outreach day. |
| `lib/workflow.js`, `lib/oi-links.js` | Approved day → household requests, extended to follow-ups. |
| `lib/oi-export.js` | The aggregate export to Engine 1, extended with per-source counts. |
| `outreach-intelligence/carelink_oi` planner, optimiser, worker | Unchanged algorithms. Workload input is now encounters; source counts are passed through. |
| `authority/validate_doc_update.js` | Server-side roles, append-only records and author stamping. |

## How a follow-up becomes outreach work (`lib/mch-outreach.js`)

**Eligible kinds** (projected as of the outreach date, from recorded data only):

- `firstVisit`
- `scheduledFollowUp` (the visit's recorded follow-up date)
- `appointmentDue` (a recorded appointment date)
- `missedAppointment` (a recorded "missed" event)
- `missingAssessment`

**Never routine:** `recordedConcern` (danger signs) and `referralFollowUp`. They stay on their urgent and referral pathways and are reported only as `urgent_items_excluded`.

**What each projected item carries:** task id, person, household, community, responsible CHO, kind, category (maternal or child), stage, source record, recorded due date if any, and the person's last record time.

**Counting rules (no double counting):**

| Measure | Rule |
|---|---|
| Open obligation | One open task id. A re-synced duplicate record is ignored; projection keeps one document per `_id`. |
| Unique person / unique household | Counted once each. |
| Encounter (estimated service workload) | One per person with open obligations, plus one per open household request. A request merges with a household member's encounter when it asks for that person's service stage (antenatal ↔ ANC, postnatal ↔ PNC, child welfare ↔ CWC). |
| Completed encounter or obligation | Only an obligation with its own recorded resolution is completed. One visit does not resolve a person's other tasks. |

## Engine 1: aggregate data

Each community row in `current` (counts only; no names or record ids):

- `pending_followups`: documented workload in encounters;
- `open_requests`, `open_maternal_followups`, `open_child_followups`;
- `unique_people`, `unique_households`;
- `urgent_items_excluded`, `last_visit`.

The weekly `history` adds `followups_resolved`: routine follow-ups closed by a resolution, each task id counted once.

Records created by tests stay out unless a plan request explicitly opts in with `include_test_records` (labelled as a test plan).

The forecasting target (weekly recorded workload) and the default baseline model are unchanged. No new model is claimed to be better. The coordinator tab shows "Documented work from …" next to the forecast, kept separate from it.

## Engine 2: scheduling

The optimiser's demand per community is the documented encounter count. It plans as before, within:

- staff, vehicles, hours and travel times;
- confirmed assignments and fairness weights;
- guarantees;
- the horizon.

What it cannot fit stays visible as unmet work in the plan.

Assignments are written only after the server has accepted the supervisor's approval (unchanged).

## Approved plans → CHT tasks (`lib/oi-links.js`)

On approval, the planning service writes one **day plan** for each approved day that is still to come. It takes up to the day's planned encounters, oldest first:

- accepted household requests;
- open obligations of people whose responsible CHO is the day's CHO, due by that day.

Nothing held by another pending day is taken. The day plan lists `request_ids` and `followups` separately.

For each follow-up the service writes a **follow-up link**:

- form `carelink_oi_followup_link`, on the person;
- stable id `carelink-oi-fulink-<assignment>-<task id>`;
- carrying the task id, kind, category, CHO, username, date and day plan.

It is written only while the obligation is still open. Links are service-only, append-only and idempotent.

What the CHO sees:

- the obligation's existing CHT task;
- the planned day on the person's profile;
- every planned household and person on the *Planned outreach day* form.

## Recording outcomes

- **Resolving:** the CHO uses the task's *Resolve with a reason* action. The resolution stamps `actor` (server-enforced to be the signed-in user) and `assignment_id`. Appointment events also stamp `actor`.
- **Day progress** (Outreach Intelligence tab, per day). Each obligation is one of:
  - completed: resolved by the day's CHO;
  - closed by a later record: for example, an attended appointment;
  - partly: the person was seen, but the obligation is still open;
  - still open;
  - unverified: resolved by someone else.
- **Nothing counts as completed for being planned.** Recording the outreach day closes nothing; it releases unfinished obligations for a later plan without touching their history.
- **Re-sending a resolution** is refused by the server (append-only). A second resolution of the same task still counts once.

## Server rules added

| Record | Rule |
|---|---|
| `carelink_oi_followup_link` | Planning service only; append-only. |
| `carelink_task_resolution`, `carelink_appointment` | `actor` must equal the signed-in user, in addition to the existing CHO-only and append-only rules. |

## Tests (run 2026-10-22, all against the real CHT 5.3 application)

| Command | Result | Covers |
|---|---|---|
| `npm run mch-outreach-flow` | 11 recorded steps passed (spec steps 1–16) | Generated mother and child in Dimabi; ANC follow-up recorded through the CHT form; four obligations projected with stable task ids and counted once; independent approval (the coordinator's own approval refused; two simultaneous approvals refused as a conflict; no assignment before acceptance); day plan links exactly those four; CHO task and profile; resolution offline → reload → sync, stamped with username and day; only that obligation closed; tab shows planned 4 · completed 1 · still open 3; workload and history updated; a new plan sees the change and cannot re-plan held obligations; a replay is refused and changes nothing; the volunteer gets 403 on Dimabi records; recording the day closes nothing |
| `npm test` | 58/58 | Includes `test/mch-outreach.test.js` (projection, identity stability, urgent exclusion, no double counting and duplicate-sync dedupe, capacity, never another CHO's patient, no double planning, release, recorded-resolution-only completion, partial and unverified outcomes, replay) and a built-bundle load test for the tab |
| `npm run oi-test` | 73/73 | Python planner and worker, including the exporter dataset shape |
| `npm run volunteer-flow` | 14/14 | Unchanged volunteer workflow |
| `npm run mch-flow` | 19/19 | Unchanged CHO maternal and child workflow (resolutions and appointments now stamp the author) |
| `npm run oi-cht-flow` | 13 recorded steps passed | Planning, approval, CHO assignment and request completion |
| `npm run feedback-flow` | 10 recorded steps passed (spec steps 1–11) | Household requests through approved days and forecasting inputs |

Run `npm run mch-outreach-flow` after the planning worker is running (`npm run oi-worker -- --watch 5`), with `CHT_COUCH_URL` and `CARELINK_ACCOUNT_PASSWORD` set.

**Two integration failures this work found and fixed:**
- The Outreach Intelligence tab bundle was missing the libraries that `oi-links` now needs, so the tab failed to load for coordinators for about 10 minutes after deployment. A test now loads the built bundle.
- A re-synced duplicate of a visit record counted its follow-up twice. Projection now keeps one document per `_id`.

## Limitations

- CHO qualifications are not differentiated. Every CHO is treated as able to do every routine maternal or child follow-up.
- Capacity is counted in encounters with a single service time. Time per obligation kind is not modelled.
- An obligation becomes eligible only once its recorded date falls on or before the outreach date. Earlier visits are not suggested.
- `missingAssessment` follows the latest visit. A new visit ends the old one; that shows as "closed by a later record".
- Danger signs and referral follow-ups are excluded from routine planning by design.
- All clinical forms and rules remain `pending_clinical_review`. No schedule, threshold, diagnosis or risk score was added.
- Generated people only.
