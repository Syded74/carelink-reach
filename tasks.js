const w = require('./lib/workflow');
const mch = require('./lib/mch');
const { isoDay, validDay, appointmentOpen } = require('./lib/schedules');
const isRole = role => typeof user !== 'undefined' && user && user.carelink_role === role;
// Contacts an automated test created leave task lists a day after their run (same rule as purge.js).
const staleTest = c => !!c.contact && c.contact.record_origin === 'test' && (c.contact.reported_date || 0) < Date.now() - 24 * 60 * 60 * 1000;
const reference = c => c.contact && `${c.contact.name} · ${c.contact.parent && c.contact.parent.name || 'Community'}`;
function content(data, c, request) {
  const current = w.workflow(request, c.reports);
  Object.assign(data, {
    request_id: request._id,
    expected_event: current.last._id,
    current_status: current.state,
    purpose: w.fields(request).followup_type,
    barrier: w.fields(request).access_barrier,
    contact_method: w.fields(request).contact_method,
    responsible_worker_id: c.contact.responsible_worker_id,
  });
}
module.exports = [
  {
    name: 'carelink-review', icon: 'carelink-request', title: 'carelink.task.review',
    appliesTo: 'reports', appliesToType: [w.FORMS.request], contactLabel: reference,
    appliesIf: (c, r) => isRole('carelink_coordinator') && !staleTest(c) && !w.workflow(r, c.reports).conflict,
    resolvedIf: (c, r) => w.TERMINAL.includes(w.workflow(r, c.reports).state),
    actions: [{ form: w.FORMS.coordination, label: 'Review or update request', modifyContent: content }],
    events: [{ id: 'review', days: 0, start: 0, end: 365 }],
  },
  {
    name: 'carelink-visit', icon: 'carelink-outreach', title: 'carelink.task.visit',
    // Scheduled by the coordinator or by an approved outreach day; a partly done visit keeps the task open.
    appliesTo: 'reports', appliesToType: [w.FORMS.coordination, w.FORMS.planLink, w.FORMS.visit], contactLabel: reference,
    appliesIf: (c, r) => isRole('carelink_cho') && !staleTest(c) && w.fields(r).assigned_worker_id === user._id &&
      ['scheduled', 'in_progress'].includes(w.fields(r).status) && !!w.latestFor(c, r),
    resolvedIf: (c, r) => !w.latestFor(c, r),
    actions: [{ form: w.FORMS.visit, label: 'Document outreach outcome', modifyContent: (data, c, r) => {
      const request = w.requests(c).find(q => q._id === w.fields(r).request_id);
      content(data, c, request);
      data.assigned_worker_id = w.fields(r).assigned_worker_id;
      data.scheduled_date = w.fields(r).scheduled_date;
      data.assignment_id = w.fields(r).assignment_id || '';
      data.proposal_id = w.fields(r).proposal_id || '';
    } }],
    // Confirmed and approved-plan visits show up to 30 days ahead, so CHOs see approved plans early.
    events: [{ id: 'outreach', start: 30, end: 365, dueDate: (event, c, r) => new Date(w.fields(r).scheduled_date || r.reported_date) }],
  },
  ...mchTasks(),
  ...outreachIntelligenceTasks(),
];

/*
  Maternal and child care tasks: the seven TaskProjector kinds (task_projector.dart:20-89), for the
  CHO the person is assigned to (assignedChoId). Each is visible from its due day (start: 0) and
  stays until resolved; end: 3650 is a technical window standing in for "until resolved", not a
  clinical rule. Task ids follow Flutter (patientId:kind:source) so a resolution closes one task.
*/
function mchTasks() {
  const f = mch.fields;
  const day = text => { const [y, m, d] = text.split('-').map(Number); return new Date(y, m - 1, d); };
  const mine = c => isRole('carelink_cho') && !staleTest(c) && mch.isMch(c.contact) && c.contact.responsible_worker_id === user._id;
  const resolved = (c, kind, source) => mch.resolvedIds(c.reports).has(mch.taskId(c.contact._id, kind, source));
  const window = (id, dueDate) => [{ id, start: 0, end: 3650, dueDate }];
  // Task status line (CHT priority). Only urgent work is flagged, once per task, so routine tasks for the
  // same person do not repeat the same reason and look like duplicates (encrypted_local_store.dart:1489-1497 band).
  const priority = c => mch.urgency(c.contact, c.reports, isoDay()).level === 'urgent' ? { level: 'high', label: 'Urgent concern open for this person' } : undefined;
  const concernPriority = { level: 'high', label: 'Urgent · follow referral procedures now' };
  const REFERRAL_STATUS = { created: 'Waiting for the receiving facility to acknowledge', acknowledged: 'Acknowledged · record arrival or outcome',
    arrival_confirmed: 'Arrived · record the outcome', outcome_recorded: 'Outcome recorded · close the referral', unresolved: 'Marked unresolved' };
  const resolve = (kind, source) => ({ form: mch.FORMS.resolution, label: 'Resolve with a reason', modifyContent: (data, c, r) => {
    const from = source(c, r);
    // CHT reserves inputs/task_id and inputs/source_id for its own task.
    const id = mch.taskId(c.contact._id, kind, from);
    // The approved outreach day this follow-up was planned for, if any (lib/oi-links.js).
    const link = c.reports.filter(x => x.form === 'carelink_oi_followup_link' && x.fields.task_id === id).sort((a, b) => b.reported_date - a.reported_date)[0];
    Object.assign(data, { carelink_task_id: id, task_kind: kind, carelink_source_id: from, assignment_id: link ? link.fields.assignment_id : '' });
  } });
  const stageForm = stage => ({ form: mch.FORMS[stage], label: 'Record a visit' });
  const isLatest = (c, r) => { const latest = mch.latestVisit(c.reports); return !!latest && latest._id === r._id; };
  const chain = (list, c, r) => list(c.reports).find(x => x.root._id === r._id);
  const tasks = [];

  ['anc', 'pnc', 'cwc'].forEach(stage => {
    tasks.push({
      name: `carelink-mch-first-visit-${stage}`, icon: 'carelink-outreach', title: `carelink.task.mch.first_visit.${stage}`,
      appliesTo: 'contacts', appliesToType: ['carelink_individual'], priority,
      appliesIf: c => mine(c) && c.contact.care_stage === stage && !mch.visits(c.reports).length && !resolved(c, 'firstVisit', 'registration'),
      resolvedIf: c => mch.visits(c.reports).length > 0 || resolved(c, 'firstVisit', 'registration'),
      actions: [stageForm(stage), resolve('firstVisit', () => 'registration')],
      events: window('first-visit', (event, c) => new Date(c.contact.reported_date || Date.now())),
    });
    const visitForm = mch.FORMS[stage];
    tasks.push({
      name: `carelink-mch-missing-assessment-${stage}`, icon: 'carelink-outreach', title: `carelink.task.mch.missing_assessment.${stage}`,
      appliesTo: 'reports', appliesToType: [visitForm], priority,
      appliesIf: (c, r) => mine(c) && isLatest(c, r) && mch.words(f(r).missing_vitals).length > 0,
      resolvedIf: (c, r) => resolved(c, 'missingAssessment', r._id),
      actions: [resolve('missingAssessment', (c, r) => r._id), stageForm(stage)],
      events: window('missing-assessment', (event, c, r) => new Date(r.reported_date)),
    }, {
      name: `carelink-mch-recorded-concern-${stage}`, icon: 'carelink-request', title: 'carelink.task.mch.recorded_concern',
      appliesTo: 'reports', appliesToType: [visitForm], priority: concernPriority,
      appliesIf: (c, r) => mine(c) && isLatest(c, r) && mch.words(f(r).danger_signs).length > 0,
      resolvedIf: (c, r) => resolved(c, 'recordedConcern', r._id),
      // danger_sign_prompt.dart: a referral is offered, never required.
      actions: [resolve('recordedConcern', (c, r) => r._id), { form: mch.FORMS.referral, label: 'Start a referral' }],
      events: window('recorded-concern', (event, c, r) => new Date(r.reported_date)),
    }, {
      name: `carelink-mch-follow-up-${stage}`, icon: 'carelink-outreach', title: `carelink.task.mch.follow_up.${stage}`,
      appliesTo: 'reports', appliesToType: [visitForm], priority,
      appliesIf: (c, r) => mine(c) && validDay(f(r).follow_up_date),
      resolvedIf: (c, r) => resolved(c, 'scheduledFollowUp', r._id),
      actions: [stageForm(stage), resolve('scheduledFollowUp', (c, r) => r._id)],
      events: window('follow-up', (event, c, r) => day(f(r).follow_up_date)),
    });
  });

  tasks.push({
    name: 'carelink-mch-referral', icon: 'carelink-request', title: 'carelink.task.mch.referral',
    appliesTo: 'reports', appliesToType: [mch.FORMS.referral],
    priority: (c, r) => { const ch = chain(mch.referrals, c, r); return { level: 'high', label: (ch && REFERRAL_STATUS[ch.state]) || 'Referral open' }; },
    appliesIf: (c, r) => mine(c) && !!chain(mch.referrals, c, r) && !chain(mch.referrals, c, r).conflict,
    resolvedIf: (c, r) => !mch.referralOpen(chain(mch.referrals, c, r)),
    // task_repository.dart:33-37: a referral task is never resolved by hand.
    actions: [{ form: mch.FORMS.referral, label: 'Record referral progress', modifyContent: (data, c, r) => {
      const ch = chain(mch.referrals, c, r);
      Object.assign(data, { referral_id: ch.id, expected_event: ch.last._id, current_state: ch.state });
    } }],
    events: window('referral', (event, c, r) => new Date(r.reported_date)),
  });

  // The receiving facility's coordinator acknowledges a new referral (an acknowledgement, not proof of attendance).
  tasks.push({
    name: 'carelink-mch-referral-ack', icon: 'carelink-request', title: 'carelink.task.mch.referral_ack',
    appliesTo: 'reports', appliesToType: [mch.FORMS.referral],
    appliesIf: (c, r) => isRole('carelink_coordinator') && !staleTest(c) && !!chain(mch.referrals, c, r) && chain(mch.referrals, c, r).state === 'created' &&
      (!f(r).receiving_facility_id || f(r).receiving_facility_id === (user.parent && user.parent._id)),
    resolvedIf: (c, r) => !chain(mch.referrals, c, r) || chain(mch.referrals, c, r).state !== 'created',
    actions: [{ form: mch.FORMS.referral, label: 'Acknowledge or update the referral', modifyContent: (data, c, r) => {
      const ch = chain(mch.referrals, c, r);
      Object.assign(data, { referral_id: ch.id, expected_event: ch.last._id, current_state: ch.state });
    } }],
    events: window('referral-ack', (event, c, r) => new Date(r.reported_date)),
  });

  const appointmentAction = { form: mch.FORMS.appointment, label: 'Update appointment', modifyContent: (data, c, r) => {
    const a = chain(mch.appointments, c, r);
    Object.assign(data, { appointment_id: a.id, expected_event: a.last._id, current_state: a.state, due_date: a.due_date });
  } };
  tasks.push({
    name: 'carelink-mch-appointment-due', icon: 'carelink-outreach', title: 'carelink.task.mch.appointment_due',
    appliesTo: 'reports', appliesToType: [mch.FORMS.appointment], priority,
    appliesIf: (c, r) => mine(c) && !!chain(mch.appointments, c, r) && !chain(mch.appointments, c, r).conflict,
    resolvedIf: (c, r) => !appointmentOpen(chain(mch.appointments, c, r).state) ||
      resolved(c, 'appointmentDue', chain(mch.appointments, c, r).id),
    actions: [appointmentAction, resolve('appointmentDue', (c, r) => chain(mch.appointments, c, r).id)],
    events: window('appointment-due', (event, c, r) => day(chain(mch.appointments, c, r).due_date)),
  }, {
    name: 'carelink-mch-missed-appointment', icon: 'carelink-request', title: 'carelink.task.mch.missed_appointment',
    appliesTo: 'reports', appliesToType: [mch.FORMS.appointment], priority,
    appliesIf: (c, r) => mine(c) && !!chain(mch.appointments, c, r) && chain(mch.appointments, c, r).state === 'missed',
    resolvedIf: (c, r) => resolved(c, 'missedAppointment', chain(mch.appointments, c, r).id),
    actions: [appointmentAction, resolve('missedAppointment', (c, r) => chain(mch.appointments, c, r).id)],
    events: window('missed-appointment', (event, c, r) => {
      const missed = chain(mch.appointments, c, r).history.filter(e => f(e).state === 'missed').slice(-1)[0];
      return new Date(missed.reported_date);
    }),
  });
  return tasks;
}

/*
  Outreach Intelligence plans (lib/oi-workflow.js). Facility staff get one task per step they may
  take; the server's acknowledgement, not the device, decides when a step counts. The assigned CHO
  gets a planned outreach day only after the server has confirmed the approval and written the
  assignment record, so a draft or an offline approval never reaches a CHO.
*/
function outreachIntelligenceTasks() {
  const oi = require('./lib/oi-workflow');
  const staff = () => isRole('carelink_coordinator') || isRole('carelink_supervisor');
  const status = (c, r) => oi.proposalStatus(r, c.reports);
  const step = (c, r) => staff() ? oi.nextActionFor(status(c, r), user._id, user.carelink_role) : null;
  const review = action => ({
    form: oi.FORMS.review, label: action === 'submit' ? 'Submit for review' : action === 'review' ? 'Review plan' : 'Approve or reject',
    modifyContent: (data, c, r) => {
      const s = status(c, r);
      Object.assign(data, { proposal_id: r._id, expected_event: s.lastEvent, current_state: s.state, step: action,
        requested_by: s.requestedBy, summary: `Outreach date: ${r.fields.planning_date}. ${(r.fields.explanation || {}).summary || ''}` });
    },
  });
  const planTask = (action, title) => ({
    name: `carelink-oi-${action}`, icon: 'carelink-followup', title,
    contactLabel: (c, r) => `${c.contact.name} · ${r.fields.planning_date}`,
    appliesTo: 'reports', appliesToType: [oi.FORMS.proposal],
    appliesIf: (c, r) => step(c, r) === action && oi.actionable(r, c.reports, action),
    resolvedIf: (c, r) => step(c, r) !== action,
    actions: [review(action)],
    events: [{ id: action, days: 0, start: 0, end: 30 }],
  });
  return [
    planTask('submit', 'carelink.task.oi.submit'),
    planTask('review', 'carelink.task.oi.review'),
    planTask('decide', 'carelink.task.oi.decide'),
    {
      name: 'carelink-oi-outreach-day', icon: 'carelink-outreach', title: 'carelink.task.oi.outreach_day',
      appliesTo: 'reports', appliesToType: [oi.FORMS.assignment],
      // Integrated outreach: the services this day takes on (planned counts; each visit is still recorded on its own).
      contactLabel: (c, r) => {
        const t = r.fields.served_by_type || {};
        const parts = [['anc', 'ANC'], ['pnc', 'PNC'], ['cwc', 'CWC'], ['request', 'Requests']].filter(([k]) => t[k]).map(([k, l]) => `${l} ${t[k]}`);
        return `${r.fields.community_name} · ${r.fields.items_planned} visit(s)${parts.length ? ': ' + parts.join(' · ') : ''}`;
      },
      appliesIf: (c, r) => isRole('carelink_cho') && r.fields.worker_id === user._id,
      resolvedIf: (c, r) => c.reports.some(x => x.form === oi.FORMS.outreachDay && x.fields.assignment_id === r._id),
      actions: [{ form: oi.FORMS.outreachDay, label: 'Record the outreach day', modifyContent: (data, c, r) => {
        Object.assign(data, { assignment_id: r._id, proposal_id: r.fields.proposal_id, planned_date: r.fields.date,
          items_planned: r.fields.items_planned, route: r.fields.route_text });
        // The household requests this approved day takes on (lib/oi-links.js); visits are recorded per household.
        const plan = c.reports.find(x => x.form === 'carelink_oi_day_plan' && x.fields.assignment_id === r._id);
        const households = plan ? Object.values(plan.fields.households || {}) : [];
        const people = plan ? Object.values(plan.fields.people || {}) : [];
        const followups = plan ? (plan.fields.followups || []).length : 0;
        data.requests_planned = [households.length ? `requests: ${households.join(', ')}` : '',
          people.length ? `maternal and child follow-ups (${followups}): ${people.join(', ')}` : ''].filter(Boolean).join('; ') || 'No household requests or follow-ups linked yet';
      } }],
      events: [{ id: 'outreach-day', start: 30, end: 30, dueDate: (event, c, r) => {
        const [y, m, d] = r.fields.date.split('-').map(Number);
        return new Date(y, m - 1, d);
      } }],
    },
  ];
}
