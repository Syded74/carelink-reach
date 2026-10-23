'use strict';
/*
  Maternal and child tracking (ANC → PNC → CWC) ported from the CareLink Flutter app.
  Records are append-only reports; every state below is derived from them, never stored.
  Source references point at clink/App-Code/lib. See docs/architecture/CHT_TRACKING_MAPPING.md.
*/
const s = require('./schedules');

const FORMS = {
  pregnancy: 'carelink_pregnancy', delivery: 'carelink_delivery',
  anc: 'carelink_anc_visit', pnc: 'carelink_pnc_visit', cwc: 'carelink_cwc_visit',
  appointment: 'carelink_appointment', referral: 'carelink_mch_referral', resolution: 'carelink_task_resolution',
};
const VISIT_FORMS = [FORMS.anc, FORMS.pnc, FORMS.cwc];
const STAGES = ['anc', 'pnc', 'cwc'];
const fields = doc => doc && doc.fields || {};
// One document per _id: a re-synced copy of the same record is never a second event.
const live = reports => [...new Map((reports || []).filter(r => r && !r._deleted).map(r => [r._id, r])).values()];
const byForm = (reports, form) => live(reports).filter(r => (Array.isArray(form) ? form : [form]).includes(r.form));
const chronological = list => [...list].sort((a, b) => (a.reported_date || 0) - (b.reported_date || 0));
const words = value => String(value || '').split(/\s+/).filter(Boolean);

// encrypted_local_store.dart:698-699: a child is registered for CWC or linked to a mother.
const isMch = contact => !!contact && contact.contact_type === 'carelink_individual' && STAGES.includes(contact.care_stage);
const isChild = contact => !!contact && (contact.care_stage === 'cwc' || !!contact.mother_id);

const visits = reports => chronological(byForm(reports, VISIT_FORMS));
const visitStage = visit => fields(visit).stage || STAGES.find(stage => visit.form === FORMS[stage]);
const latestVisit = reports => visits(reports).slice(-1)[0] || null;
const pregnancies = reports => chronological(byForm(reports, FORMS.pregnancy));
const deliveries = reports => chronological(byForm(reports, FORMS.delivery));

/*
  Append-only event chains, replayed the way lib/workflow.js replays outreach events: each event
  names the event it follows. A branch (two offline devices extending the same event) or a
  disallowed transition makes the chain a conflict: it is shown but issues no task.
*/
function replay(root, events, { idField, allowed, check }) {
  const chain = events.filter(e => fields(e)[idField] === fields(root)[idField] && e._id !== root._id);
  let last = root;
  const history = [root];
  const used = new Set([root._id]);
  while (true) {
    const next = chain.filter(e => fields(e).expected_event === last._id && !used.has(e._id));
    if (!next.length) {
      const orphaned = chain.filter(e => !used.has(e._id));
      return { id: fields(root)[idField], root, last, history, state: fields(last).state, conflict: false, orphaned };
    }
    if (next.length > 1) {
      return { id: fields(root)[idField], root, last, history, state: 'conflict', conflict: true, conflicting: next.map(e => e._id) };
    }
    const event = next[0];
    const problem = !(allowed[fields(last).state] || []).includes(fields(event).state) ? 'transition' : check && check(last, event);
    if (problem) {
      return { id: fields(root)[idField], root, last, history, state: 'conflict', conflict: true, invalid: event._id, problem };
    }
    history.push(event);
    used.add(event._id);
    last = event;
  }
}

// follow_up.dart:111-130.
const APPOINTMENT_TRANSITIONS = {
  scheduled: ['attended', 'missed', 'rescheduled', 'cancelled'],
  missed: ['rescheduled', 'cancelled'],
  rescheduled: ['attended', 'missed', 'rescheduled', 'cancelled'],
  attended: [],
  cancelled: [],
};
// follow_up.dart:155-166: no backdating; only a reschedule changes the due date, and it must.
function appointmentCheck(previous, next) {
  if ((next.reported_date || 0) < (previous.reported_date || 0)) { return 'backdated'; }
  const changed = fields(next).due_date !== fields(previous).due_date;
  if (fields(next).state === 'rescheduled' ? !changed : changed) { return 'due_date'; }
  if (!s.validDay(fields(next).due_date)) { return 'due_date'; }
  return null;
}
function appointments(reports) {
  const events = byForm(reports, FORMS.appointment);
  return chronological(events.filter(e => !fields(e).expected_event && fields(e).state === 'scheduled' && s.validDay(fields(e).due_date)))
    .map(root => {
      const chain = replay(root, events, { idField: 'appointment_id', allowed: APPOINTMENT_TRANSITIONS, check: appointmentCheck });
      return { ...chain, due_date: fields(chain.last).due_date };
    });
}

/*
  referral_lifecycle.dart:51-79. QUEUED_OFFLINE, TRANSMITTED and TRANSMISSION_FAILED are device
  transport states that CHT synchronization replaces, so a created referral moves straight to the
  states Flutter allows after transmission.
*/
const REFERRAL_TRANSITIONS = {
  created: ['acknowledged', 'arrival_confirmed', 'cancelled', 'unresolved'],
  acknowledged: ['arrival_confirmed', 'cancelled', 'unresolved'],
  arrival_confirmed: ['outcome_recorded', 'unresolved'],
  outcome_recorded: ['closed'],
  unresolved: [],
  closed: [],
  cancelled: [],
};
const REFERRAL_TERMINAL = ['closed', 'cancelled'];
// referral_lifecycle.dart:80-92. RECEIVING_FACILITY → carelink_coordinator (mapping decision 1).
const REFERRAL_ROLES = {
  created: ['carelink_cho'],
  acknowledged: ['carelink_coordinator'],
  arrival_confirmed: ['carelink_cho', 'carelink_coordinator'],
  outcome_recorded: ['carelink_cho', 'carelink_coordinator'],
  closed: ['carelink_cho', 'carelink_supervisor'],
  cancelled: ['carelink_cho', 'carelink_supervisor'],
  unresolved: ['carelink_cho', 'carelink_supervisor'],
};
function referrals(reports) {
  const events = byForm(reports, FORMS.referral);
  return chronological(events.filter(e => !fields(e).expected_event && fields(e).state === 'created'))
    .map(root => replay(root, events, { idField: 'referral_id', allowed: REFERRAL_TRANSITIONS }));
}
const referralOpen = chain => !chain.conflict && !REFERRAL_TERMINAL.includes(chain.state);

// task_projector.dart:27: tasks are identified as patientId:kind:source.
const taskId = (patientId, kind, source) => `${patientId}:${kind}:${source}`;
// task_repository.dart:24-52: an append-only resolution with a reason; never for a referral.
const resolvedIds = reports => new Set(byForm(reports, FORMS.resolution)
  .filter(r => fields(r).reason && !String(fields(r).task_id).includes(':referralFollowUp:'))
  .map(r => fields(r).task_id));

const TASK_REASONS = {
  firstVisit: 'First visit due',
  missingAssessment: 'Complete missing assessment',
  recordedConcern: 'Recorded concern needs CHO review',
  scheduledFollowUp: 'Follow-up due',
  referralFollowUp: 'Referral awaiting outcome or follow-up',
  appointmentDue: 'Appointment due',
  missedAppointment: 'Appointment recorded as missed',
};

// task_projector.dart:20-89, kind for kind.
function projectTasks(contact, reports, today = s.isoDay()) {
  const resolved = resolvedIds(reports);
  const tasks = [];
  const add = (kind, source, extra = {}) => {
    const id = taskId(contact._id, kind, source);
    if (!resolved.has(id)) { tasks.push({ id, kind, source, reason: TASK_REASONS[kind], ...extra }); }
  };
  const ordered = visits(reports);
  if (!ordered.length) { add('firstVisit', 'registration'); }
  const latest = ordered[ordered.length - 1];
  if (latest && words(fields(latest).missing_vitals).length) { add('missingAssessment', latest._id); }
  if (latest && words(fields(latest).danger_signs).length) { add('recordedConcern', latest._id); }
  ordered.forEach(visit => {
    const due = fields(visit).follow_up_date;
    if (s.followUpDue(due, today)) { add('scheduledFollowUp', visit._id, { due_date: due }); }
  });
  referrals(reports).filter(referralOpen).forEach(chain => add('referralFollowUp', chain.id));
  appointments(reports).filter(a => !a.conflict).forEach(a => {
    if (s.appointmentDue(a.state, a.due_date, today)) { add('appointmentDue', a.id, { due_date: a.due_date }); }
    if (s.appointmentMissed(a.state)) { add('missedAppointment', a.id, { due_date: a.due_date }); }
  });
  return tasks;
}

// encrypted_local_store.dart:1489-1512: urgency band and the reason shown, in Flutter's precedence.
function urgency(contact, reports, today = s.isoDay()) {
  const kinds = new Set(projectTasks(contact, reports, today).map(t => t.kind));
  const level = kinds.has('recordedConcern') ? 'urgent'
    : ['referralFollowUp', 'missingAssessment', 'scheduledFollowUp', 'appointmentDue', 'missedAppointment'].some(k => kinds.has(k)) ? 'priority'
      : 'routine';
  const reason = kinds.has('recordedConcern') ? 'Recorded danger sign'
    : kinds.has('referralFollowUp') ? 'Referral awaiting follow-up'
      : kinds.has('missingAssessment') ? 'Complete missing assessment'
        : kinds.has('missedAppointment') ? 'Appointment recorded as missed'
          : kinds.has('appointmentDue') ? 'Appointment due'
            : kinds.has('scheduledFollowUp') ? 'Scheduled follow-up due'
              : !visits(reports).length ? 'First visit due' : 'Routine follow-up';
  return { level, reason };
}

// patient_profile_screen.dart:329-335: earliest open appointment, else the latest visit's follow-up date.
function nextDue(reports) {
  const open = appointments(reports).filter(a => !a.conflict && s.appointmentOpen(a.state))
    .map(a => a.due_date).sort();
  if (open.length) { return open[0]; }
  const latest = latestVisit(reports);
  return latest && s.validDay(fields(latest).follow_up_date) ? fields(latest).follow_up_date : null;
}

// Stage shown = latest visit's stage, else the registration stage (patient_profile_screen.dart header).
const currentStage = (contact, reports) => (latestVisit(reports) && visitStage(latestVisit(reports))) || contact.care_stage;

// patient_profile_screen.dart:78-85 (presentation only): hide the EDD once a PNC visit exists or
// once it is more than 42 days past.
function showEdd(edd, reports, today = s.isoDay()) {
  if (!s.validDay(edd) || visits(reports).some(v => visitStage(v) === 'pnc')) { return false; }
  const limit = new Date(Date.parse(today + 'T00:00:00Z') - 42 * 86400000).toISOString().slice(0, 10);
  return edd > limit;
}

// family_records.dart:83-91: children unique, non-empty, never the mother.
function deliveryValid(delivery) {
  const children = words(fields(delivery).child_ids);
  return s.validDay(fields(delivery).delivery_date) && children.length > 0 &&
    new Set(children).size === children.length && !children.includes(fields(delivery).patient_id);
}
// A pregnancy with no delivery recorded against it.
const openPregnancy = reports => {
  const delivered = new Set(deliveries(reports).map(d => fields(d).pregnancy_id));
  return pregnancies(reports).filter(p => !delivered.has(fields(p).pregnancy_id)).slice(-1)[0] || null;
};

// administered_vaccine.dart:44-46: the same dose is not recorded twice for one child.
const doseKey = dose => `${String(dose.vaccine || '').trim().toLowerCase()}|${String(dose.dose || '').trim().toLowerCase()}`;
function recordedDoses(reports) {
  const doses = [];
  visits(reports).filter(v => visitStage(v) === 'cwc').forEach(v => {
    const given = fields(v).vaccines && fields(v).vaccines.dose;
    (Array.isArray(given) ? given : given ? [given] : []).forEach(dose => doses.push({ ...dose, visit_id: v._id }));
  });
  const seen = new Set();
  return doses.map(dose => {
    const duplicate = seen.has(doseKey(dose));
    seen.add(doseKey(dose));
    return { ...dose, duplicate };
  });
}

module.exports = { FORMS, VISIT_FORMS, STAGES, fields, words, isMch, isChild, visits, visitStage, latestVisit, pregnancies,
  deliveries, replay, APPOINTMENT_TRANSITIONS, appointments, REFERRAL_TRANSITIONS, REFERRAL_TERMINAL, REFERRAL_ROLES,
  referrals, referralOpen, taskId, resolvedIds, TASK_REASONS, projectTasks, urgency, nextDue, currentStage, showEdd,
  deliveryValid, openPregnancy, doseKey, recordedDoses };
