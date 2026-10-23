# Flutter tracking spec (source of truth for the CHT port)

Phase 1 of the ANC → PNC → CWC port. Read-only extraction from the CareLink
Flutter app; nothing in the Flutter app, its backend or its data was changed.

- Flutter app: `clink/App-Code/lib` (paths below are relative to it)
- Python backend: `clink/src/clink_ml/carelink`
- Every clinical item: `approval_status: pending_clinical_review`
- Data in examples: fictional only

Status key:
- **Implemented**: code enforces or computes it.
- **Hard-coded**: a fixed value in code or config.
- **Recording only**: captured and stored, but never used for a decision.
- **Deferred**: infrastructure exists and is intentionally inactive.
- **Absent**: not in the Flutter app.

## 1. Headline finding

The Flutter app has **no contact schedule**. It never computes when an ANC,
PNC or CWC contact, or a vaccine dose, falls due.

"Due", "overdue" and "missed" come from only two sources:

1. A follow-up date the CHO typed (`care.follow_up_date`).
2. Appointment events the CHO recorded. "Missed" is an explicit recorded
   state, not something inferred from elapsed time.

So the CHT port must **not** ship WHO 8-contact ANC timing, PNC day-1/3/7/42
contacts, or EPI due/overdue rules. They are listed in §9 as decisions.

## 2. Data model

### 2.1 Patient (`models/carelink_models.dart:61-91`), Implemented

| Field | Notes |
|---|---|
| localPatientId, careId | identity |
| stage | `CareStage { anc, pnc, cwc }` (`:6`), the registration stage |
| assignedChoId, name, sex, community | sex is `F`/`M`/not recorded; mothers are saved as `F` |
| dateOfBirth?, ageMonths? | |
| motherName?, phone? | caregiver contact |
| motherCareId?, motherLocalPatientId? | child → mother link (schema v2) |

A patient is a **child** when `stage == cwc` or `motherLocalPatientId != null`
(`data/local/encrypted_local_store.dart:698-699`, `:1231-1232`).

### 2.2 PregnancyRecord (`domain/family_records.dart:4-43`), Implemented

- Fields: `id`, `patientId` (mother), `recordedBy`, `recordedAt`, `edd?`
  (a calendar date).
- Header comment (`:3`): "Recorded identities/events only; no pregnancy
  dating or outcome inference."
- The EDD is typed by the CHO and never computed from LMP.

### 2.3 DeliveryRecord (`domain/family_records.dart:45-92`), Implemented

- Fields: `id`, `pregnancyId`, `patientId` (mother), `childIds[]`, `date`,
  `recordedBy`, `recordedAt`.
- Validation (`:83-91`):
  - the date is a real calendar date
  - child ids are non-empty, unique and not the mother's id
- Created manually from the "Pregnancy and delivery" screen
  (`views/patients/family_records_screen.dart:85-115`).

### 2.4 Visit (`models/carelink_models.dart:100-171`), Implemented

- Fields:
  - visitId, patientId, visitedAt
  - stage, pncSubject (`maternal` or `newborn`)
  - pregnancyId?, deliveryId?
  - values (numeric vitals) and units
  - fieldSources, missingReasons, assessmentStates, qualityIssues
  - dangerSigns (set), documentation (MCH answers)
  - administeredVaccines, choId, deviceId
- Pathway guards (`encrypted_local_store.dart:1210-1262`):
  - ANC is only for an adult subject; CWC only for a child.
  - PNC maternal is for the mother; PNC newborn is for a child listed in the
    delivery's `childIds`.
  - PNC links to a delivery belonging to that mother and pregnancy.
  - PNC cannot be dated before the delivery date.
  - Newborn PNC must use `pnc_newborn.*` fields, with no maternal vitals and
    no danger signs.
  - An administered dose cannot predate the child's date of birth.

### 2.5 Stage vitals and danger signs (`App-Code/assets/configuration/default.json`), Hard-coded config

| Stage | Numeric fields | Danger-sign options |
|---|---|---|
| anc | gestational_age_weeks, fundal_height_cm, fetal_heart_rate_bpm, haemoglobin_g_dL, systolic_bp, diastolic_bp, weight_kg | Convulsions reported · Bleeding reported · Other concern reported |
| pnc (maternal) | temperature_c, systolic_bp, diastolic_bp, weight_kg | Convulsions reported · Bleeding reported · Other concern reported |
| pnc (newborn) | none: `pnc_newborn.*` documentation only (`views/visit/visit_wizard_screen.dart:60-64`) | none |
| cwc | weight_kg, length_height_cm, muac_mm | Caregiver reports feeding difficulty · Other concern reported |

- The config is `version: carelink-config-2`, `zoneId: UNCONFIGURED`.
- Danger signs are **CHO-reported flags**. No vital-sign threshold anywhere
  turns a value into a danger sign.

### 2.6 MCH documentation (`domain/mch_documentation.dart`), Recording only

- Each answer has a state: recorded / not assessed / not applicable / etc.
- Sections come from `mchSections(stage, pncSubject, visitKind)` (`:675-702`).
- `anc.visit_kind = Return` hides the booking-only history (`:683`).
- Field ids:
  - `anc.*` (`:218-349`): visit_kind (Booking/Return), pregnancy_reference,
    obstetric_history, edd, edd_method, lmp_date, lmp_source, gravida, para,
    previous_complications, allergies, current_medication, reported_symptoms,
    gestational_age_source, bp_time, bp_method, fetal_movement,
    investigations, interventions, professional_assessment,
    professional_action
  - `pnc.*` (`:360-428`): delivery_reference, delivery_date,
    delivery_place_mode, maternal_recovery,
    maternal_breastfeeding_support, timing_since_delivery, complications,
    bleeding, uterine_recovery, wound_perineum, breastfeeding_concerns,
    maternal_wellbeing, treatment_given
  - `pnc_newborn.*` (`:160-204`): weight_kg, temperature_c, feeding, cord,
    jaundice, concerns, measurement_time, breathing, activity, actions
  - `cwc.*` (`:436-560`):
    - measurement_position, measurement_time, caregiver_concerns,
      illness_history, clinician_observations
    - `feeding.*`: breastfeeding, exclusive_breastfeeding,
      complementary_start_date, meals_per_day, food_groups,
      breastfeeds_per_day, difficulty, allergy_status, allergies,
      counselling_given, caregiver_understanding
    - `household.*`: foods, constraints, affordability, seasonal,
      preparation_hygiene
    - `immunisation.records`
    - `development.notes`, `development.milestones_observed`
  - shared (`:105-152`): `shared.investigation_*`, `care.counselling`,
    `care.caregiver_plan`, `care.barriers`, **`care.follow_up_date`**,
    `care.follow_up_reason`
- Only `care.follow_up_date` drives tracking (§4). Every other field is
  recording only.

### 2.7 AdministeredVaccine (`domain/administered_vaccine.dart`), Recording only

- Fields: vaccine, dose, date, source, verification?, provider?, facility?,
  batchLot?
- Verification states (`:5-10`): verified, unverified, reported, unknown.
  Only `reported` and `unknown` may be undated (`:14`).
- `doseKey` (vaccine|dose, lower-cased) prevents recording the same dose
  twice.
- Header comment (`:3-4`): "Recording only: no state implies a schedule
  decision, a due date or complete immunization."

### 2.8 EPI schedule (`domain/epi_schedule.dart`), Deferred

- Versioned definitions (`draftUnreviewed` / `reviewedWithConditions` /
  `releaseAuthorized`) with doses whose recommended age is free text and
  "never parsed" (`:30`).
- `activeOn()` returns null in this build: "no definition is bundled or
  authorized" (`:152-153`).
- Header (`:3-7`): it "never decides that a dose is due, overdue or
  complete".

## 3. Appointment lifecycle (`domain/follow_up.dart`), Implemented

- States (`:8`): `scheduled, attended, missed, rescheduled, cancelled`.
- Allowed transitions (`:111-130`):

| From | To |
|---|---|
| (none) | scheduled (the first event must be `scheduled`) |
| scheduled | attended, missed, rescheduled, cancelled |
| missed | rescheduled, cancelled |
| rescheduled | attended, missed, rescheduled, cancelled |
| attended | terminal |
| cancelled | terminal |

- Validation (`:135-170`):
  - an event may not be dated before prior events ("must not be
    backdated", `:158`)
  - only `rescheduled` may change `dueDate`, and it must change it
    (`:161-166`)
- `isOpen` = scheduled or rescheduled (`:190`).
- `isDueBy(day)` = `isOpen` and `dueDate ≤ day`, compared as a calendar date
  (`:194-196`).
- Projection (`:199-221`):
  - events are sorted by `occurredAt`
  - all events must share an appointmentId and patientId
  - the current state and dueDate come from the last event
- Missed is **recorded by a person**. No timer moves an appointment to
  `missed`.

## 4. Care tasks (`domain/task_projector.dart:20-89`), Implemented

- Task id: `patientId:kind:source`.
- A task is shown unless its id is in the `resolved` set (`:28-30`).
- `day` = today with the time stripped.

| kind | Condition | source | Line |
|---|---|---|---|
| `firstVisit` | patient has no visits | `registration` | `:36` |
| `missingAssessment` | the latest visit has any `missingReasons` | latest visitId | `:39-41` |
| `recordedConcern` | the latest visit has any `dangerSigns` | latest visitId | `:42-48` |
| `scheduledFollowUp` | **any** visit whose `care.follow_up_date` is in state `recorded`, parses as a date, and is ≤ `day` | that visitId | `:51-62` |
| `referralFollowUp` | a referral whose current state is not `closed` or `cancelled` | referralId | `:63-68` |
| `appointmentDue` | `appointment.isDueBy(day)` | appointmentId | `:69-76` |
| `missedAppointment` | appointment state == `missed` | appointmentId | `:77-84` |

Notes:
- `scheduledFollowUp` scans every visit, not only the latest one. A later
  visit does not clear an earlier date. It is cleared only by the task id
  being resolved.
- `appointmentDue` stays raised after the due date until an event closes or
  reschedules the appointment. "Overdue" is not a separate state; it is
  "due and still open".

## 5. Today worklist ranking (`data/local/encrypted_local_store.dart:1444-1560`), Implemented

- Urgency (`:1489-1497`):
  - `urgent`: a `recordedConcern` task exists.
  - `priority`: referral pending, missing assessment, `scheduledFollowUp`,
    `appointmentDue` or `missedAppointment`.
  - `routine`: everything else.
- Reason text, in order of precedence (`:1498-1512`):
  - recorded danger sign
  - Referral awaiting follow-up
  - …missing assessment
  - Appointment recorded as missed
  - Appointment due
  - Scheduled follow-up due
  - First visit due
  - Routine follow-up
- Score (`:1513-1519`):
  - base: urgent 0, priority 10000, routine 20000
  - plus `9999 − daysSinceLastVisit`, or 0 when there is no visit
  - sorted ascending, so within a band the longest-unseen patient comes
    first
- Flag (`:1530-1542`):
  - `layer1` "Recorded danger sign"
  - otherwise `highBand` "Follow-up required" when a referral is pending, an
    assessment is missing or a follow-up is due

## 6. Referral lifecycle (`services/referral_lifecycle.dart`), Implemented

- States and events (`:6-17`): REFERRAL_CREATED, QUEUED_OFFLINE,
  TRANSMITTED, TRANSMISSION_FAILED, ACKNOWLEDGED, ARRIVAL_CONFIRMED,
  OUTCOME_RECORDED, CLOSED, CANCELLED, MARKED_UNRESOLVED.
- Allowed appends (`:51-79`):
  - created: only from nothing
  - queued: from created or failed
  - transmitted or failed: from queued
  - acknowledged: from transmitted
  - arrival: from transmitted or acknowledged
  - outcome: from arrival
  - closed: from outcome
  - cancelled: from created, queued, failed, transmitted or acknowledged
  - unresolved: from transmitted, acknowledged, arrival or failed
- Terminal states: `closed`, `cancelled` (`:48-49`).
- Roles per state (`:80-90`):
  - acknowledgement is by RECEIVING_FACILITY only
  - transmission is by SYNC_SERVICE only
- Correction (Phase 2): the existing CHT `carelink_referral` form is an
  outreach evidence form (acknowledged / followup_scheduled /
  followup_completed / recorded / unknown). It does **not** implement this
  lifecycle. See `CHT_TRACKING_MAPPING.md` §6.

## 7. ANC → PNC → CWC transitions

| Step | What the Flutter app does | Status |
|---|---|---|
| Register a mother | `Patient.stage = anc`, sex F | Implemented |
| Record a pregnancy | manual PregnancyRecord, optional typed EDD | Implemented |
| ANC visit | Booking or Return (`anc.visit_kind`) | Implemented, recording only |
| Delivery | manual DeliveryRecord linking existing child patients | Implemented |
| Mother → PNC | **No automatic stage change.** The CHO picks the PNC pathway for the next visit. The displayed stage = the latest visit's stage. | Implemented as UI derivation |
| Newborn PNC | child must be in `delivery.childIds` | Implemented |
| Child → CWC | child registered with `stage = cwc` (or a mother link) | Implemented |
| Close pregnancy / end of PNC window | **Absent** | Absent |

Presentation-only rule, hard-coded (`views/patients/patient_profile_screen.dart:78-85`):
- The profile hides the EDD once any PNC visit exists, or once the EDD is
  more than 42 days in the past.
- This affects display only. Nothing is scheduled from it.

The profile shows "Next due" (`patient_profile_screen.dart:329-335`):
- the earliest open appointment's due date, otherwise the latest visit's
  `care.follow_up_date`
- "overdue" = that date is before *now* (`:86`)

## 8. Targets and indicators

Flutter mobile: none.

Python admin reports (`shared_sync.py:2560-2690`) count:
- distinct appointments
- currently missed (latest state `missed`)
- currently scheduled
- append-only appointment events

They also include referral and visit counts. Note at `:2681`: "State is
derived from the latest accepted append-only event". There are no coverage
targets such as "% with 4+ ANC" or "% fully immunised".

## 9. Needs clinical/product decision (keep inactive in CHT)

1. **ANC contact schedule** (e.g. WHO 8 contacts, Ghana 4+/8): absent.
2. **PNC contact schedule** (e.g. day 1, 3, 7–14, 6 weeks): absent.
3. **CWC / growth-monitoring cadence**: absent.
4. **EPI due/overdue**: deferred (`epi_schedule.dart`); no authorized
   definition exists.
5. **Automatic missed**: Flutter never marks an appointment missed from
   elapsed time. A grace period would be new logic.
6. **Pregnancy end and PNC exit rules** (when ANC tasks stop, when PNC ends):
   absent.
7. **Danger-sign → referral**: Flutter prompts a referral when a sign is
   recorded (`views/referral/danger_sign_prompt.dart`) but does not force
   one. CHT should match this: offer, not require.
8. **Vital-sign thresholds** (BP, temperature, MUAC, Hb): none in Flutter.
9. **Inconsistency, for product to decide:**
   - The profile "overdue" (`patient_profile_screen.dart:86`) compares with
     `DateTime.now()`, so a date due *today* shows as overdue after midnight
     of that day.
   - The task projector treats a date due today as "due", not "overdue".
   - The CHT port will follow TaskProjector (day-based) unless told
     otherwise.
10. **`scheduledFollowUp` persistence** (§4 note): an old follow-up date stays
    due until it is explicitly resolved. This is ported as-is; confirm it is
    intended.

## 10. What the CHT port can carry with confidence

- The data model in §2, the appointment lifecycle in §3, the 7 task kinds in
  §4, the urgency bands in §5 and the referral lifecycle in §6.
- Task resolution (`application/task_repository.dart:24-52`):
  - an immutable `task_resolution` record (`taskId`, `patientId`,
    `sourceId`, `actorId`, `deviceId`, `reason`, `recordedAt`)
  - a reason is required
  - not allowed for `referralFollowUp`; that is cleared only by a referral
    outcome or cancellation (`:33-37`)
- Every "due" comes from a CHO-recorded date. Every "missed" comes from a
  recorded event.
