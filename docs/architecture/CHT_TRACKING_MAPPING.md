Phase 2 is done. The mapping is in [docs/architecture/CHT_TRACKING_MAPPING.md](CHT_TRACKING_MAPPING.md). Nothing is built yet; as the brief asks, I'm stopping here for your review before Phase 3.

**Correction to the Phase 1 spec:** I said CHT already had the Flutter referral flow. It doesn't. The existing `carelink_referral` form only records outreach outcomes. I've fixed the spec and mapped the Flutter referral flow to a new form. I also added the task-resolution record to the spec: it needs a reason and can't be used to clear a referral task.

**How it maps:**
- **Patients:** they stay as the existing household members (`carelink_individual`), with new optional fields: care stage, sex, date of birth, mother link, caregiver name and phone. Optional means existing outreach contacts keep working unchanged.
- **New forms:** pregnancy, delivery, ANC visit, PNC visit and CWC visit, plus appointment, task resolution and MCH referral. The PNC visit shows the newborn version automatically for a child. Every new form is append-only and limited by role on the server. Field names keep the Flutter names so the admin labels and CSV still match.
- **The 7 Flutter task types:**
  - first visit
  - missing assessment
  - recorded concern
  - scheduled follow-up
  - referral follow-up
  - appointment due
  - missed appointment

  Each uses the same due rule as Flutter. Task ids use the same `patientId:kind:source` format, so a resolution can close exactly one task.
- **Patient profile summary:** the stage comes from the latest visit, then pregnancy and delivery details, appointments, open referral, recorded doses and the "next due" date. It uses the same rules as the Flutter profile.
- **Targets:** counts only, matching the Python admin report. No coverage targets.
- **Schedules file (`lib/schedules.js`):** it lists the schedule rules Flutter doesn't have, every one switched off and marked for clinical review.

**Where CHT will behave differently:**
1. **Bad appointment or referral history:** Flutter refuses an invalid appointment or referral entry when it's saved. CHT phones work offline and can't see each other's entries. So an invalid or forked history is shown on the patient as a conflict and creates no task. The existing outreach flow already works this way.
2. **Task order:** CHT always sorts tasks by due date. Flutter's urgent/priority/routine order can't be reproduced without changing CHT itself. I'll show the band as a task priority with Flutter's reason text instead.
3. **Overdue colouring:** CHT colours a task as overdue the day after its due date. This is display only; no new rule is added.
4. **Referral steps:** Flutter's sending, queued and failed steps are dropped because CHT sync does that job.

**Decisions I need. I'll use the default shown if you just say "go":**
1. The facility steps of a referral (acknowledge, arrival, outcome) have no matching CHT role. Default: map them to `carelink_coordinator`.
2. "Overdue" rule. Default: day-based, so a date due today is "due", as the Flutter task list does.
3. A follow-up date stays due until someone resolves it. Default: keep this, as Flutter does.
4. How much of the 84 documentation fields to port. Default: all of them now, in the same sections as Flutter. The alternative is vitals, danger signs, follow-up and vaccines first, with the other fields after.

Shall I start Phase 3 with these defaults?# CHT tracking mapping (Flutter → CareLink Reach)

Phase 2 of the ANC → PNC → CWC port. It maps every item in
`FLUTTER_TRACKING_SPEC.md` (the "spec") onto supported CHT configuration.
Nothing is built yet.

Rules carried through:
- No new clinical logic.
- Every clinical rule is tagged `approval_status: pending_clinical_review`
  with its Flutter source.
- No CHT Core changes.
- The existing outreach flow (`carelink_request` / `coordination` / `visit` /
  `referral`, `lib/workflow.js`) is left untouched.

Column key:
- **Exact**: same rule.
- **Differs**: same intent, CHT mechanism differs (explained).
- **Inactive**: listed in spec §9, not built.

## 1. Contacts (spec §2.1)

Patients become `carelink_individual` persons under a `carelink_household`.
That contact type already exists. The create and edit forms gain
**optional** fields, so existing outreach contacts stay valid.

| Flutter | CHT field on `carelink_individual` | Mapping |
|---|---|---|
| localPatientId | `_id` | Differs (CHT uuid) |
| careId | `external_id` (exists) | Exact |
| name | `name` (exists) | Exact |
| stage (registration) | `care_stage`: `anc` / `pnc` / `cwc` / empty (not in MCH care) | Exact |
| sex | `sex`: `F` / `M` / `not_recorded`; forced to `F` when `care_stage` = anc | Exact |
| dateOfBirth / ageMonths | `date_of_birth` (date) | Exact (ageMonths is derived for display only) |
| motherName, phone | `caregiver_name`, `phone` | Exact |
| motherLocalPatientId | `mother_id`: select-contact `carelink_individual` | Exact |
| motherCareId | `mother_external_id`, calculated from the selected mother | Exact |
| assignedChoId | household `responsible_worker_id` (exists) | Differs (assignment sits on the household, as outreach already does) |

`isChild` = `care_stage == 'cwc'` or `mother_id` set (spec §2.1). Helper:
`lib/mch.js#isChild`.

## 2. Reports (spec §2.2–2.8, §3)

All new forms are app forms on a **person** (`context.person: true`). They
are append-only and listed in `authority/validate_doc_update.js` (ALLOWED and
APPEND_ONLY).

| Form | Flutter source | Context expression | Key fields |
|---|---|---|---|
| `carelink_pregnancy` | PregnancyRecord (§2.2) | adult (not isChild) | `edd` (optional date; never computed from LMP) |
| `carelink_delivery` | DeliveryRecord (§2.3) | adult with ≥1 pregnancy | `pregnancy_id` (choice from the contact summary's pregnancies), `delivery_date`, repeat `child` → `child_id` (select-contact individual) |
| `carelink_anc_visit` | Visit stage anc (§2.4–2.6) | adult | `anc.visit_kind`, the 7 ANC vitals, each with a value or a missing reason; the 3 ANC danger signs; all `anc.*` + shared fields with an answer state; `care.follow_up_date`, `care.follow_up_reason` |
| `carelink_pnc_visit` | Visit stage pnc | adult (maternal) or child (newborn) | `pnc_subject` calculated from isChild; `delivery_id`; maternal: 4 vitals, 3 danger signs, `pnc.*`; newborn: `pnc_newborn.*` only, with no vitals or danger signs (spec §2.4 guard); follow-up date |
| `carelink_cwc_visit` | Visit stage cwc | child | 3 CWC vitals, 2 CWC signs, `cwc.*` (feeding, household, immunisation, development), repeat `vaccine` (vaccine, dose, date, verification, source, provider, facility, batch_lot), follow-up date |
| `carelink_appointment` | AppointmentEvent (§3) | any MCH person | `appointment_id` (new uuid on `scheduled`, carried forward otherwise), `state`, `due_date`, `occurred_at`, `note`, `expected_event` (previous event id) |
| `carelink_task_resolution` | task_resolution (spec §10) | opened from a task action only | `task_id`, `source_id`, `reason` (required) |
| `carelink_mch_referral` | ReferralLifecycle (§6) | any MCH person | `referral_id`, `state`, `note`, `expected_event` |

Field ids keep the Flutter ids (dots → `_`, e.g. `care_follow_up_date`), so
the admin field labels and CSV map one to one.

Danger-sign lists and vital fields are copied from
`App-Code/assets/configuration/default.json` (spec §2.5). The label text is
unchanged.

### Guards Flutter enforces at write time (spec §2.4, §3)

Enketo can enforce some guards with constraints. The rest are checked when
the reports are read, in `lib/mch.js`.

| Guard | CHT mechanism | Mapping |
|---|---|---|
| ANC adult only / CWC child only / PNC subject matches | form `context.expression` | Exact |
| PNC not before the delivery date | XPath constraint against the selected delivery's date (passed in via contact-summary context) | Exact |
| Newborn PNC has no vitals or danger signs | the newborn branch has no such fields | Exact |
| Dose not before date of birth | XPath constraint `date ≥ contact date_of_birth` | Exact |
| Dose not recorded twice (doseKey) | contact-summary `recorded_doses` + constraint | Exact |
| Delivery child ≠ mother, unique | constraint against the mother's id; duplicates flagged by `lib/mch.js` as `invalid` | Differs: an invalid record is shown and generates no tasks, rather than being rejected |
| Appointment: first event must be scheduled; allowed transitions; only reschedule changes the due date; no backdating | `lib/appointments.js` replays events by `expected_event`, like `lib/workflow.js` | Differs: Flutter rejects the write; CHT offline devices cannot see each other's writes, so a bad or branching chain becomes `conflict`: shown on the profile, no due/missed task (the outreach design's existing rule) |

## 3. Appointment lifecycle (spec §3), Exact rules

`lib/appointments.js`:
- `TRANSITIONS` copied from `follow_up.dart:111-130`.
- `isOpen` = scheduled or rescheduled.
- `isDueBy(day)` = `isOpen && due_date ≤ day` (calendar date).
- The state is taken from the last valid event.

## 4. Tasks (spec §4) → `tasks.js`

- All tasks: CHO role only (`isRole('carelink_cho')`).
- `day` = today's date.
- CHT needs an `end` window. A technical value of 3650 days stands in for
  Flutter's "until resolved". It is not clinical.

| Flutter kind | appliesTo | Due date / appliesIf | resolvedIf | Action form | Mapping |
|---|---|---|---|---|---|
| firstVisit | contacts (MCH person) | no visit reports; due = contact `reported_date` | any visit, or resolution | the stage's visit form | Exact |
| missingAssessment | latest visit report | it has missing reasons; due = visit date | a newer visit exists*, or resolution | `carelink_task_resolution` | Exact (*"latest" re-evaluates exactly as Flutter does) |
| recordedConcern | latest visit report | it has danger signs; due = visit date; `priority: high` | newer visit*, or resolution | resolution; referral offered as a second action | Exact |
| scheduledFollowUp | **every** visit with a recorded `care_follow_up_date` | due = that date; shows from the due date (`start: 0`) | a resolution with this task id | stage visit form / resolution | Exact (spec §9.10: persists until resolved) |
| referralFollowUp | each referral chain | current state not closed/cancelled | chain terminal | `carelink_mch_referral` | Exact (no resolution allowed) |
| appointmentDue | each appointment chain | `isDueBy(day)`; due = `due_date` | state not open | `carelink_appointment` | Exact |
| missedAppointment | each appointment chain | state == missed | state changes (rescheduled/cancelled), or resolution | `carelink_appointment` | Exact |

Task id: CHT's `emission._id` is built as `patientId:kind:source` to match
Flutter, so a resolution can name the exact task.

Differences in how tasks are shown, all **Differs**:
- **Overdue colour:** CHT marks a task overdue the day after its due date.
  Flutter has no separate overdue state. This affects display only; no
  status logic is added.
- **Ordering:** Flutter sorts by urgency band, then by days since last
  visit (spec §5). CHT always sorts tasks by due date. The band is carried
  as task `priority` (`high` = urgent, `medium` = priority) with the Flutter
  reason text as the label, so the CHO still sees the band. Exact ordering
  is **not portable** without Core changes.

## 5. Worklist urgency (spec §5)

- Contact summary field `mch_urgency`: urgent / priority / routine.
- Reason text uses the same precedence (`lib/mch.js#urgency`).
- It is shown on the person profile and used for task priority.
- Score ordering: not portable, as above.

## 6. Referral lifecycle (spec §6)

- New `carelink_mch_referral` events with Flutter's `canAppend` table
  (`lib/mch-referral.js`).
- Device transport states (QUEUED_OFFLINE, TRANSMITTED,
  TRANSMISSION_FAILED) are **not ported**. CHT sync replaces them, so the
  chain is created → acknowledged → arrival → outcome → closed, plus
  cancelled and unresolved.
- Roles map: CHO/NURSE → `carelink_cho`, SUPERVISOR → `carelink_supervisor`.
- **Needs decision:** RECEIVING_FACILITY (acknowledge, arrival, outcome) has
  no CHT role. Proposal: `carelink_coordinator` (the facility side of
  outreach). Until confirmed, those three states are open to `carelink_cho`
  and `carelink_coordinator`.
- The existing outreach `carelink_referral` form is unchanged.

## 7. Stage display (spec §7) → contact summary, Exact

- **Stage shown:** the latest MCH visit's stage, else `care_stage`.
- **Cards:**
  - Pregnancy: EDD shown only while no PNC visit exists and the EDD is no
    more than 42 days past (presentation-only rule,
    `patient_profile_screen.dart:78-85`)
  - Delivery: date, children
  - Appointments: state, due date
  - Open referral
  - Recorded doses
- **Next due:** the earliest open appointment, else the latest
  `care_follow_up_date`.
- **Overdue badge:** day-based, following TaskProjector (spec §9.9, pending
  confirmation).
- Context for forms: `pregnancies`, `deliveries`, `open_appointments`,
  `recorded_doses`, `is_child`.

## 8. Targets (spec §8) → `targets.js`

Count targets only (`goal: -1`), mirroring the Python admin report. No
coverage targets.

| Target id | Counts |
|---|---|
| `mch-appointments` | distinct appointment chains |
| `mch-appointments-missed` | chains whose current state is missed |
| `mch-appointments-scheduled` | chains currently scheduled or rescheduled |
| `mch-appointment-events` | appointment events |
| `mch-visits-anc` / `-pnc` / `-cwc` | visit reports per stage |
| `mch-referrals-open` | referral chains not closed or cancelled |

## 9. Other deliverables

- **`lib/schedules.js`:** holds only the follow-up-date and appointment due
  logic above, plus an `INACTIVE` export that lists spec §9 items 1–6 and 8,
  each with `approval_status: pending_clinical_review` and `active: false`.
  No code reads them.
- **Translations:** `translations/messages-en.properties` gets the new task,
  target and form keys.
- **Authority:**
  - ALLOWED:
    - `carelink_cho`: pregnancy, delivery, the 3 visit forms, appointment,
      task_resolution
    - `carelink_cho` and `carelink_coordinator`: `carelink_mch_referral`
  - APPEND_ONLY: all of the above
- **Seed** (`lib/demo-data.js`, fictional):
  - one household
  - mother "Efua Asante (fictional)" with a pregnancy, 2 ANC visits (one
    with a danger sign and a follow-up date), a delivery and a maternal PNC
  - newborn "Kojo Asante (fictional)" with a newborn PNC and a CWC visit
    with 1 recorded dose
  - one missed appointment
- **Tests:**
  - harness tests for each task kind (due today / past / future, resolved,
    conflict)
  - appointment and referral transition tables
  - targets and contact summary
  - authority (role + append-only)
  - the maternal flow script `scripts/mch-flow.js`

## 10. Inactive (spec §9), not built

ANC schedule, PNC schedule, CWC cadence, EPI due/overdue, automatic missed,
pregnancy and PNC exit rules, vital thresholds.

## 11. Decisions needed before or during build

1. **RECEIVING_FACILITY role** (§6): map to `carelink_coordinator`?
2. **Overdue rule** (spec §9.9): day-based, as in TaskProjector? This is
   the default.
3. **Follow-up persistence** (spec §9.10): keep "until resolved"? This is
   the default.
4. **MCH documentation scope:**
   - Port all 84 fields now, the default with Enketo sections mirroring
     `mchSections`.
   - Or port vitals, danger signs, follow-up and vaccines first, and the
     narrative fields after.
