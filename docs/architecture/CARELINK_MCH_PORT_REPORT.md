# CareLink maternal & child tracking: Flutter → CareLink Reach (CHT) port report

**Date:** 2026-10-21. **Scope:** port the ANC → PNC → CWC tracking engineering from the CareLink
Flutter app into the CareLink Reach CHT config, with the same data model, schedule rules, status
logic, and definitions of "due", "overdue" and "missed". No new clinical logic.

**Status:** Phases 1–5 are complete on the local CHT 5.3. All 14 steps of the maternal and child flow pass in the real UI, confirmed against the server (§7, updated 2026-10-21 18:30).
This file is Phase 5: one consolidated record.

**Supporting documents:**
- `docs/architecture/FLUTTER_TRACKING_SPEC.md`: the extraction, with file:line references.
- `docs/architecture/CHT_TRACKING_MAPPING.md`: the mapping and build notes.

**Rules followed throughout:**
- The Flutter app, its Python backend and their data were read only.
- No CHT Core changes.
- Fictional data only.
- No credentials in the project: admin credentials were read at run time from the local CouchDB
  container environment into shell variables.
- A backup was taken before deploying.
- Everything clinical is `approval_status: pending_clinical_review`.
- The professional review register stays NOT_AUTHORIZED.

---

## 1. What the Flutter app actually does (headline)

**The Flutter app has no contact schedule.** No code decides when an ANC, PNC or CWC contact, or a
vaccine dose, falls due.

- **Due:** a follow-up date the CHO recorded (`care.follow_up_date`) is on or before today, or an
  open appointment (scheduled or rescheduled) has a due date on or before today.
- **Overdue:** not a separate state. It means "still due and not closed".
- **Missed:** only when someone **records** an appointment as missed. Flutter never infers it from
  elapsed time.
- **EPI:** `epi_schedule.dart` exists but is inactive. `activeOn()` returns null, and no
  definition is bundled or authorized. Doses are recorded only.

So the CHT port carries these rules, and no WHO or Ghana schedule.

## 2. Flutter source of truth (summary of the spec)

| Area | Flutter source | What it is |
|---|---|---|
| Patient | `models/carelink_models.dart:61-91` | stage anc/pnc/cwc, sex (mothers F), DOB, mother link, assigned CHO = registering CHO |
| Child rule | `encrypted_local_store.dart:698-699` | child = stage cwc or has a mother link |
| Pregnancy / Delivery | `domain/family_records.dart` | EDD typed, never computed. Delivery lists existing children: unique, non-empty, not the mother |
| Visit guards | `encrypted_local_store.dart:1210-1262` | ANC adult only, CWC child only. Newborn PNC needs a delivery listing the child. PNC not before delivery. Dose not before DOB |
| Vitals and danger signs | `assets/configuration/default.json` | 7 ANC, 4 PNC, 3 CWC vitals. Danger signs are reported flags, with no thresholds |
| Data-entry ranges | `visit_wizard_screen.dart:100-113` | plausibility checks. Out of range must be confirmed as questionable |
| Documentation | `domain/mch_documentation.dart` | 84 fields, each with 4 answer states (confirmed / reported not verified / unknown / not assessed) |
| Appointments | `domain/follow_up.dart:8-221` | 5 states, transition table, no backdating, only a reschedule changes the date |
| Tasks | `domain/task_projector.dart:20-89` | 7 kinds, id `patientId:kind:source` |
| Task resolution | `application/task_repository.dart:24-52` | append-only, reason required, never for a referral |
| Worklist | `encrypted_local_store.dart:1444-1560` | urgent / priority / routine bands, then the longest-unseen patient first |
| Referrals | `services/referral_lifecycle.dart` | event lifecycle with roles per state |
| Indicators | `shared_sync.py:2560-2690` | counts only: appointments, missed, scheduled, events. No coverage targets |

## 3. What was built in CHT

All paths are relative to `~/Downloads/carelink-reach-config`.

| File | Purpose |
|---|---|
| `lib/mch-fields.js` | Fields, labels, options, sections and notes copied verbatim from Flutter, with source refs. Also vitals, danger signs, data-entry ranges and dose verification states |
| `lib/schedules.js` | The only due rules (follow-up date ≤ today; open appointment due ≤ today; missed = recorded). An `INACTIVE` list of absent rules, all `active: false`, which nothing reads |
| `lib/mch.js` | Chain replay of appointment and referral events (conflict-safe, like `lib/workflow.js`), the 7 task kinds, urgency bands, next due, EDD display rule, delivery validity, dose duplicates |
| `lib/mch-summary.js` | Person profile fields and cards, plus the context the forms read |
| `scripts/build-mch-forms.js` | Generates all MCH XForms and the `carelink_individual` contact forms from `lib/mch-fields.js` (`npm run build-forms`) |
| `forms/app/carelink_{pregnancy,delivery,anc_visit,pnc_visit,cwc_visit,appointment,mch_referral,task_resolution}` | 8 new app forms, all on a person |
| `forms/contact/carelink_individual-{create,edit}.xml` | Optional fields: care stage, sex, DOB, mother, caregiver name, phone, responsible CHO |
| `tasks.js` | MCH tasks added. Outreach tasks unchanged |
| `targets.js` | 9 count-only MCH targets added |
| `contact-summary.templated.js` | Merges the MCH profile for MCH people only |
| `authority/validate_doc_update.js` | Roles for the new forms, all append-only, plus referral roles per state |
| `app_settings/base_settings.json` | New `can_carelink_mch` permission (CHO, coordinator, supervisor). `carelink_cho` gains `can_create_people` |
| `translations/messages-en.properties` | 7 task and 8 target labels |
| `lib/demo-data.js` | Fictional Efua and Kojo Asante family under CHO A |
| `scripts/seed.js` | New seed ids are now added to an existing manifest, so cleanup owns them |
| `scripts/mch-flow.js` | End-to-end UI flow, confirmed against the server (`npm run mch-flow`) |

**Decisions applied (mapping §11):**
1. RECEIVING_FACILITY maps to `carelink_coordinator`.
2. "Overdue" is day-based, as in TaskProjector.
3. A follow-up stays due until it is resolved.
4. All 84 documentation fields are ported.

## 4. Parity table

| # | Flutter behaviour | CHT implementation | Parity |
|---|---|---|---|
| 1 | Patient model and child rule | `carelink_individual` fields; `mch.isChild` | Same |
| 2 | Mothers saved as F | contact form calculates `sex = F` for ANC/PNC | Same |
| 3 | Assigned CHO = registering CHO | `responsible_worker_id = once(user contact)`; tasks only for that CHO | Same |
| 4 | Pregnancy with typed EDD | `carelink_pregnancy` | Same |
| 5 | Delivery links existing children | `carelink_delivery` with a repeat of contact pickers. Child ≠ mother in the form. Duplicates and empties flagged at read time | Differs (flag, not reject) |
| 6 | Pregnancy chosen on delivery and ANC | latest pregnancy with no delivery | Differs |
| 7 | 84 documentation fields, 4 answer states | generated forms; value + "reported, not verified" / "unknown" give the same 4 states | Same |
| 8 | Booking-only history hidden on Return | section relevance on `anc_visit_kind != return` | Same |
| 9 | Vitals; empty = not recorded (`missingReasons`) | `missing_vitals` calculated | Same |
| 10 | Data-entry ranges with questionable confirmation | required confirmation, stored in `quality_issues` | Same |
| 11 | Danger signs per stage; referral offered, not forced | multi-select. Concern task offers "Start a referral" | Same |
| 12 | Newborn PNC on the child, needs a delivery listing the child | opened from the **mother's** profile, child picked, saved against the child | Differs (entry point) |
| 13 | PNC not before delivery; newborn PNC has no maternal vitals or signs | form constraint; newborn branch has none | Same |
| 14 | Dose verification states; undated only if reported/unknown; not before DOB | form constraints | Same |
| 15 | Dose not recorded twice | form warning plus profile flag | Differs (warn, not reject) |
| 16 | Appointment lifecycle and validation | `lib/mch.js` replay. An invalid or branched chain becomes **conflict** (shown, no task) | Differs (offline: flagged, not rejected) |
| 17 | 7 task kinds and their conditions | `tasks.js` + `mch.projectTasks` | Same |
| 18 | Due on or before today, visible until resolved | window `start: 0`, `end: 3650` (technical stand-in for "until resolved"); future dates stay Draft | Same |
| 19 | Task id `patientId:kind:source`; resolution with a reason; never for a referral | `carelink_task_resolution` with Flutter ids (inputs namespaced `carelink_*`, because CHT reserves `task_id` and `source_id`) | Same |
| 20 | Urgency bands and reason precedence | `mch.urgency`; shown on the profile and as task priority | Same |
| 21 | Worklist sort (band, then longest unseen) | CHT always sorts tasks by due date | **Not portable** without Core changes |
| 22 | Overdue display | CHT colours tasks overdue after the due day; display only | Differs (display) |
| 23 | Referral lifecycle and roles | `carelink_mch_referral` + authority per state. Device transport states dropped (CHT sync does that job) | Differs (transport states) |
| 24 | Stage shown = latest visit's stage | `mch.currentStage` | Same |
| 25 | Next due; EDD hidden after PNC or 42 days | `mch.nextDue`, `mch.showEdd` | Same (overdue is day-based, see §6.9) |
| 26 | Indicators are counts only | 9 count targets | Same |
| 27 | Mother's CareID on the child | captured from the selected mother | Same |

## 5. Absent in Flutter, so kept inactive

Each item is listed in `lib/schedules.js` `INACTIVE`.

1. ANC contact schedule (e.g. WHO 8 contacts).
2. PNC contact schedule.
3. CWC / growth-monitoring cadence.
4. EPI due / overdue.
5. Automatic "missed" after a grace period.
6. Pregnancy-end and PNC-exit rules.
7. Vital-sign clinical thresholds (only data-entry ranges exist).

## 6. Needs clinical / product decision

1–7. Activating any of the §5 rules. Each needs clinical approval and a Flutter change first, so
   both apps stay identical.

8. **Facility role:** RECEIVING_FACILITY was mapped to `carelink_coordinator` by default. Confirm.
9. **Overdue rule:**
   - The Flutter profile marks a date due *today* as overdue once the day starts, because it
     compares with `now` (`patient_profile_screen.dart:86`).
   - The task projector is day-based; CHT follows it.
   - Align Flutter one way or the other.
10. **Follow-up persistence:** an old follow-up date stays due until resolved, even after later
    visits. Ported as-is. Confirm it is intended.
11. **Delivery or dose problems:** should CHT block these offline, which would mean stricter forms,
    or keep flagging them as now?
12. **Labels:** all form labels are Flutter's "proposed pending nursing review" wording. Nursing
    review is still outstanding.

## 7. Tests and evidence

| Check | Result |
|---|---|
| `npm run backup` before deploying | ✅ `~/.carelink-reach/backups/2026-10-21T16-59-28-373Z` |
| `npm test` | ✅ 25/25: the 15 existing tests plus 10 in `test/mch.test.js`. Two existing tests were narrowed without losing intent: CHO A is checked for *outreach* tasks; the forms test checks *field names* for clinical-decision fields |
| `npm run compile` | ✅ |
| cht-conf form validation, local and server (`npm run deploy`) | ✅ all 14 app forms and 12 contact forms |
| `npm run deploy-authority` | ✅ |
| `npm run seed` | ✅ 15 new docs, 59 unchanged |
| `npm run verify` | ✅ server healthy; outreach counts unchanged; 0 conflicts |
| `npm run check-access` | ✅ 10/10: the 7 outreach checks plus 3 maternal checks (the mother replicates to CHO A only; a community contact cannot write an ANC visit; a coordinator may acknowledge a referral but not create one) |
| Seed projection (`lib/mch`) | ✅ mother: follow-up due, referral open, missed appointment. Child: missing assessment; the future appointment is not due. Matches TaskProjector |
| Real CHT rules engine, CHO A | ✅ the same 4 Ready tasks. The future appointment is emitted as Draft (not shown) |
| `npm run mch-flow` (real UI, server-confirmed) | ✅ **14/14 steps pass** (below) |

**`mch-flow` steps proven on the real UI and server** (evidence: `evidence/mch-flow.json` and
`evidence/mch-*.png`):

1. The CHO registers a mother for ANC. Sex F and the assigned CHO are stored.
2. A "First visit due" task appears.
3. A pregnancy is recorded with the EDD as typed.
4. ANC booking:
   - An out-of-range weight is blocked until it is confirmed as questionable.
   - Missing vitals, the danger sign and the follow-up date are derived.
5. Concern, missing-assessment and follow-up tasks appear, and the first-visit task resolves.
6. A referral is started from the concern task.
7. The follow-up task is resolved with a reason and leaves the list.
8. The newborn is registered with the mother link, and the delivery lists the child.
9. Newborn PNC is saved against the child, linked to the mother and delivery, with no maternal
   vitals recorded as missing.
10. A CWC visit is saved with one recorded dose. No schedule or due date is shown.
11. An appointment due today raises a task; recording it as missed raises the missed-appointment
    task.
12. The mother's profile shows the stage, urgency band, next due, the responsible CHO's name, and
    the pregnancy, delivery and referral cards.
13. The coordinator records the facility acknowledgement of the referral.
14. The supervisor's targets list the maternal and child counts.

**Fixed while finishing the flow (18:00–18:30):**
- **Form bug, newborn PNC:** `missing_vitals` listed the mother's four vitals on every newborn PNC.
  That raised a wrong "Complete missing assessment" task for the baby, against spec §2.4.
  `scripts/build-mch-forms.js` now gates `missing_vitals` and `quality_issues` on the same
  condition as the vitals group. Only `carelink_pnc_visit` changed.
- **Profile display:**
  - People showed "Household reference" with their own id, and an empty "Responsible health
    worker". Those fields now appear on households only, and people show "Reference".
  - "Responsible CHO" showed a raw id. It now shows the name, from the household in the lineage.
  - The sync line repeated itself. It is now labelled "Sync status" and avoids the word
    "delivery", which reads as childbirth in a maternal app.
- **Test automation, not product:**
  - The contact picker is chosen the way a user does.
  - Repeat rows are added before they are filled.
  - Radios inside repeats are matched by `data-name`.
  - Each radio click is confirmed to stick.
  - Each run first removes the previous run's fictional mother and child. Their names differed
    only by run number, so CHT's duplicate check rightly blocked re-runs.
- **Environment:** CHT and CouchDB had stopped at 17:04 (colima was down). They were restarted
  with the same settings as before. No data was lost.

**Fictional records left on local CHT:** the latest flow's mother, child and their records. They
are in the seed manifest, so `npm run cleanup` removes them. The next `mch-flow` run also replaces
them.

## 8. Final report

**Implemented and tested**
- Data model, forms, data-entry ranges, answer states and visit guards (server-validated forms).
- The 7 task kinds and resolution: real UI for all 7, plus unit tests for each kind, chain
  conflicts, transition tables and urgency precedence.
- The full ANC → delivery → PNC → CWC flow, end to end in the real UI (14/14).
- Server-side roles for every MCH form and every referral state, in unit tests and live checks.
- Urgency bands, next due, the EDD display rule, targets and authority roles.
- Deployment with backup; existing outreach flow intact.

**Ported but differs:**
- newborn PNC entry point (§4.12)
- pregnancy auto-selected (§4.6)
- flag instead of reject for delivery, dose and appointment-chain problems (§4.5, 4.15, 4.16)
- overdue colouring (§4.22)
- referral transport states dropped (§4.23)

**Not portable:** the worklist sort order, without CHT Core changes (§4.21).

**Needs clinical/product decision:** §6.

**Next steps**
1. Get decisions on §6.8–6.12.
2. Get nursing review of the labels (the Flutter labels are still "proposed").
3. ~~Feed overdue maternal and child items into the outreach need score and scheduling engine.~~
   Done: see `docs/engines/CARELINK_OUTREACH_PLANNING.md` (`npm run plan`).
4. Test on a physical Android device (cht-android) against an HTTPS server.
5. When repeating the demo: `npm run cleanup && npm run seed`.
