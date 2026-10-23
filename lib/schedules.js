'use strict';
/*
  Due/overdue/missed rules ported from the CareLink Flutter app. The Flutter app has no contact
  schedule: "due" only ever comes from a date a health worker recorded, and "missed" only from a
  recorded appointment event. See docs/architecture/FLUTTER_TRACKING_SPEC.md §1, §3, §4.
*/
const APPROVAL = { approval_status: 'pending_clinical_review', release_authorized: false };

// Calendar day as YYYY-MM-DD in the device's local time (task_projector.dart: day = today, time stripped).
function isoDay(value = Date.now()) {
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value);

// task_projector.dart:51-62: a recorded follow-up date is due once it is on or before today.
// "Overdue" is not a separate state: it stays due until the task is resolved.
const followUpDue = (followUpDate, today) => validDay(followUpDate) && followUpDate <= today;

// follow_up.dart:190-196: open = scheduled or rescheduled; due = open and due date on or before today.
const OPEN_APPOINTMENT_STATES = ['scheduled', 'rescheduled'];
const appointmentOpen = state => OPEN_APPOINTMENT_STATES.includes(state);
const appointmentDue = (state, dueDate, today) => appointmentOpen(state) && validDay(dueDate) && dueDate <= today;
// follow_up.dart / task_projector.dart:77-84: missed is a recorded state, never inferred from time.
const appointmentMissed = state => state === 'missed';

/*
  Rules the Flutter app does NOT implement. Listed so reviewers can see what is deliberately
  absent. Nothing reads this list; adding a rule requires clinical approval and a Flutter change
  first (spec §9).
*/
const INACTIVE = [
  { id: 'anc_contact_schedule', reason: 'No ANC contact schedule in Flutter (spec §9.1).' },
  { id: 'pnc_contact_schedule', reason: 'No PNC contact schedule in Flutter (spec §9.2).' },
  { id: 'cwc_visit_cadence', reason: 'No CWC / growth-monitoring cadence in Flutter (spec §9.3).' },
  { id: 'epi_due_overdue', reason: 'epi_schedule.dart is deferred: activeOn() returns null (spec §2.8, §9.4).' },
  { id: 'automatic_missed', reason: 'Flutter never marks an appointment missed from elapsed time (spec §9.5).' },
  { id: 'pregnancy_pnc_exit', reason: 'No pregnancy-end or PNC-exit rule in Flutter (spec §9.6).' },
  { id: 'vital_sign_thresholds', reason: 'No clinical thresholds in Flutter; only data-entry ranges (spec §9.8).' },
].map(rule => ({ ...rule, ...APPROVAL, active: false }));

module.exports = { APPROVAL, isoDay, validDay, followUpDue, OPEN_APPOINTMENT_STATES, appointmentOpen, appointmentDue,
  appointmentMissed, INACTIVE };
