'use strict';
/*
  Approved outreach days → the household requests they take on (npm run oi-worker calls
  scripts/oi-link-requests.js, which uses this module). For each approved assignment the planning
  service writes, once:
  - a day plan (carelink_oi_day_plan, on the community): which open requests that day covers;
  - one link per request (carelink_oi_request_link, on the household): a scheduling event in the
    request's own append-only lifecycle (lib/workflow.js), so the CHO's existing visit task and
    visit form complete the request exactly as a coordinator-scheduled visit would.
  A request is eligible when the facility has accepted it and no pending outreach day holds it.
  Documented maternal and child follow-ups (lib/mch-outreach.js) are eligible too: one link per open
  task id (carelink_oi_followup_link, on the person), for people whose responsible CHO is the day's CHO.
  The day's capacity counts encounters, so a request and a matching follow-up for the same person
  share one place, and one person's several follow-ups take one place.
  Recording the outreach day never closes requests; it only releases the unvisited ones for a later plan.
  Record IDs are stable, so a repeated cycle or a duplicate sync writes nothing new.
*/
const w = require('./workflow');
const mch = require('./mch');
const mchOutreach = require('./mch-outreach');

const FORMS = { assignment: 'carelink_oi_assignment', dayPlan: 'carelink_oi_day_plan', link: w.FORMS.planLink, outreachDay: 'carelink_oi_outreach_day',
  followUpLink: 'carelink_oi_followup_link' };
const ELIGIBLE = ['accepted', 'assigned', 'contact_attempt'];
const fields = w.fields;
const dayPlanId = assignmentId => `carelink-oi-dayplan-${assignmentId}`;
const linkId = (assignmentId, requestId) => `carelink-oi-link-${assignmentId}-${requestId}`;
const followUpLinkId = (assignmentId, taskId) => `carelink-oi-fulink-${assignmentId}-${taskId}`;

function index(docs) {
  // A re-synced copy of the same record must never count twice: one document per _id.
  const live = [...new Map(docs.filter(d => d && !d._deleted).map(d => [d._id, d])).values()];
  const contacts = new Map(live.filter(d => d.type === 'contact').map(d => [d._id, d]));
  const reports = live.filter(d => d.type === 'data_record' && d.fields);
  const byPatient = new Map();
  reports.forEach(r => { const id = fields(r).patient_id; byPatient.set(id, [...(byPatient.get(id) || []), r]); });
  const daysDone = new Set(reports.filter(r => r.form === FORMS.outreachDay).map(r => fields(r).assignment_id));
  return { live, contacts, reports, byPatient, daysDone };
}

// Requests in a community the facility has accepted and no pending outreach day holds, oldest first.
function eligibleRequests(ix, community, reserved = new Set()) {
  const out = [];
  for (const request of ix.reports.filter(r => r.form === w.FORMS.request)) {
    const household = ix.contacts.get(fields(request).patient_id);
    if (!household || !household.parent || household.parent._id !== community || reserved.has(request._id)) { continue; }
    const state = w.workflow(request, ix.byPatient.get(household._id) || []);
    const heldByPlan = state.last.form === FORMS.link;
    // A plan link releases its request once that outreach day has been recorded (explicit release event).
    const released = heldByPlan && state.state === 'scheduled' && ix.daysDone.has(fields(state.last).assignment_id);
    if (state.conflict || !(ELIGIBLE.includes(state.state) || released)) { continue; }
    out.push({ request, household, expected_event: state.last._id, state: state.state });
  }
  return out.sort((a, b) => a.request.reported_date - b.request.reported_date || a.request._id.localeCompare(b.request._id));
}

const record = (id, form, subject, values) => ({ _id: id, type: 'data_record', form, content_type: 'json', reported_date: Date.now(),
  from: 'carelink-oi-service', fields: { patient_id: subject, place_id: subject, ...values } });

/*
  Docs the planning service should write for a facility's approved assignments: day plans for
  assignments without one, then any link missing from a day plan whose request has not moved on.
  The CHO's CHT username (from user-settings) goes on the day plan, so a visit can be verified
  against the server-enforced author (fields.actor) later.
*/
function linkDocs(docs, facility, today = new Date().toISOString().slice(0, 10)) {
  const ix = index(docs);
  const proposals = new Map(ix.reports.filter(r => r.form === 'carelink_oi_proposal' && fields(r).patient_id === facility).map(p => [p._id, p]));
  const assignments = ix.reports.filter(r => r.form === FORMS.assignment && proposals.has(fields(r).proposal_id))
    .sort((a, b) => fields(a).date.localeCompare(fields(b).date) || a._id.localeCompare(b._id));
  const plans = new Map(ix.reports.filter(r => r.form === FORMS.dayPlan).map(p => [fields(p).assignment_id, p]));
  const usernames = new Map(ix.live.filter(d => d.type === 'user-settings' && d.contact_id).map(u => [u.contact_id, u.name]));
  const out = [];
  // Requests already held by an earlier day plan whose day is still pending.
  const pending = [...plans.values()].filter(p => !ix.daysDone.has(fields(p).assignment_id));
  const reserved = new Set(pending.flatMap(p => fields(p).request_ids || []));
  const reservedTasks = new Set(pending.flatMap(p => (fields(p).followups || []).map(f => f.task_id)));
  for (const a of assignments) {
    let plan = plans.get(a._id);
    // Only a day still to come takes on requests; a past or already recorded day never does.
    if (!plan && (fields(a).date < today || ix.daysDone.has(a._id))) { continue; }
    if (!plan) {
      const capacity = Math.max(0, Number(fields(a).items_planned) || 0);
      const community = fields(a).patient_id;
      const requests = eligibleRequests(ix, community, reserved).map(c => ({ ...c, household_id: c.household._id, community_id: community,
        stage: mchOutreach.REQUEST_STAGE[fields(c.request).care_need] || null }));
      // Follow-ups due by the outreach date (their own recorded dates), for this CHO, not held by a pending day.
      const items = mchOutreach.followUps(ix, fields(a).date).routine
        .filter(i => i.community_id === community && i.worker_id === fields(a).worker_id && !reservedTasks.has(i.task_id));
      // Fill the day per visit type when the scheduler planned by type; otherwise by total encounters.
      const byType = fields(a).served_by_type && Object.keys(fields(a).served_by_type).length ? { ...fields(a).served_by_type } : null;
      const ordered = mchOutreach.units(requests, items, ix);
      const selected = byType
        ? ordered.filter(u => { const t = mchOutreach.visitType(u); if ((byType[t] || 0) > 0) { byType[t]--; return true; } return false; })
        : ordered.slice(0, capacity);
      const chosen = selected.filter(u => u.request).map(u => u.request);
      const followups = selected.flatMap(u => u.items);
      chosen.forEach(c => reserved.add(c.request._id));
      followups.forEach(f => reservedTasks.add(f.task_id));
      plan = record(dayPlanId(a._id), FORMS.dayPlan, fields(a).patient_id, {
        assignment_id: a._id, proposal_id: fields(a).proposal_id, worker_id: fields(a).worker_id, worker_name: fields(a).worker_name,
        worker_username: usernames.get(fields(a).worker_id) || '', date: fields(a).date, community_name: fields(a).community_name,
        items_planned: fields(a).items_planned, request_ids: chosen.map(c => c.request._id),
        // Plans built with test records (include_test_records) stay out of operational coverage counts.
        includes_test_records: !!fields(proposals.get(fields(a).proposal_id)).includes_test_records,
        expected_events: Object.fromEntries(chosen.map(c => [c.request._id, c.expected_event])),
        households: Object.fromEntries(chosen.map(c => [c.request._id, c.household.name])),
        followups: followups.map(f => ({ task_id: f.task_id, kind: f.kind, category: f.category, person_id: f.person_id,
          household_id: f.household_id, due_date: f.due_date })),
        people: Object.fromEntries(followups.map(f => [f.person_id, (ix.contacts.get(f.person_id) || {}).name || ''])),
        encounters_planned: selected.length,
      });
      out.push(plan);
    }
    for (const requestId of fields(plan).request_ids || []) {
      const id = linkId(a._id, requestId);
      if (ix.reports.some(r => r._id === id)) { continue; }
      const request = ix.reports.find(r => r._id === requestId);
      if (!request) { continue; }
      // Write the link only onto the event the day plan saw; if the request moved on, it stays as it is.
      const state = w.workflow(request, ix.byPatient.get(fields(request).patient_id) || []);
      if (state.last._id !== fields(plan).expected_events[requestId]) { continue; }
      out.push(record(id, FORMS.link, fields(request).patient_id, {
        request_id: requestId, expected_event: state.last._id, status: 'scheduled', source: 'approved_plan',
        assigned_worker_id: fields(plan).worker_id, assigned_username: fields(plan).worker_username, scheduled_date: fields(plan).date,
        assignment_id: a._id, proposal_id: fields(plan).proposal_id, day_plan_id: plan._id,
        outcome_note: `Planned for the approved outreach day on ${fields(plan).date}.`,
      }));
    }
    for (const f of fields(plan).followups || []) {
      const id = followUpLinkId(a._id, f.task_id);
      if (ix.reports.some(r => r._id === id)) { continue; }
      // Link only an obligation that is still open; a resolved one stays as it is.
      const open = mch.projectTasks({ _id: f.person_id }, ix.byPatient.get(f.person_id) || [], fields(plan).date).some(x => x.id === f.task_id);
      if (!open) { continue; }
      out.push(record(id, FORMS.followUpLink, f.person_id, {
        task_id: f.task_id, kind: f.kind, category: f.category, household_id: f.household_id, due_date: f.due_date || '',
        assigned_worker_id: fields(plan).worker_id, assigned_username: fields(plan).worker_username, scheduled_date: fields(plan).date,
        assignment_id: a._id, proposal_id: fields(plan).proposal_id, day_plan_id: plan._id, source: 'approved_plan',
      }));
    }
  }
  return out;
}

/*
  One planned follow-up's outcome. Completed only with its own recorded resolution by the day's CHO
  (fields.actor, enforced by the server); closed when a later record ended it by the existing rules
  (for example an attended appointment); partly when the person was seen after the link but the
  obligation is still open; open otherwise. Nothing is counted completed just for being planned.
*/
function followUpOutcome(plan, f, reports) {
  const own = reports.filter(r => fields(r).patient_id === f.person_id);
  const link = own.find(r => r._id === followUpLinkId(fields(plan).assignment_id, f.task_id));
  if (!link) { return 'changed'; }
  const resolution = mch.resolvedIds(own).has(f.task_id) &&
    own.filter(r => r.form === mch.FORMS.resolution && fields(r).task_id === f.task_id && fields(r).reason).sort((a, b) => a.reported_date - b.reported_date)[0];
  if (resolution) {
    return fields(plan).worker_username && fields(resolution).actor === fields(plan).worker_username ? 'completed' : 'unverified';
  }
  const stillOpen = mch.projectTasks({ _id: f.person_id }, own, fields(plan).date).some(x => x.id === f.task_id);
  if (!stillOpen) { return 'closed'; }
  const seen = own.some(r => mch.VISIT_FORMS.includes(r.form) && (r.reported_date || 0) > (link.reported_date || 0));
  return seen ? 'partly' : 'open';
}

/*
  Planned versus actual for one day plan, from the records on this device or server. A request
  counts as completed for the day only when the visit followed this day's link and was recorded by
  the assigned CHO (fields.actor is enforced by the server to be the signed-in user).
*/
function dayProgress(plan, reports) {
  const counts = { planned: 0, completed: 0, unable: 0, partly: 0, open: 0, changed: 0, unverified: 0 };
  const rows = [];
  for (const requestId of fields(plan).request_ids || []) {
    counts.planned++;
    const request = reports.find(r => r._id === requestId);
    const own = request ? reports.filter(r => fields(r).patient_id === fields(request).patient_id) : [];
    const state = request ? w.workflow(request, own) : null;
    const link = own.find(r => r._id === linkId(fields(plan).assignment_id, requestId));
    // The latest visit in the chain after this day's link (a partly done visit may be followed by another).
    let visit = null;
    for (let at = link && link._id, next; at && (next = own.find(r => r.form === w.FORMS.visit && fields(r).expected_event === at)); at = next._id) {
      visit = next;
    }
    let outcome = 'open';
    if (!state || !link) {
      outcome = 'changed';
    } else if (visit && fields(plan).worker_username && fields(visit).actor && fields(visit).actor !== fields(plan).worker_username) {
      outcome = 'unverified';
    } else if (visit) {
      outcome = { completed: 'completed', unable_to_complete: 'unable', in_progress: 'partly' }[fields(visit).status] || 'open';
    } else if (state.last._id !== link._id) {  // rescheduled, cancelled or in conflict through another path
      outcome = 'changed';
    }
    counts[outcome]++;
    rows.push({ request_id: requestId, household: (fields(plan).households || {})[requestId] || '', outcome, state: state ? state.state : 'missing' });
  }
  const followups = { planned: 0, completed: 0, closed: 0, partly: 0, open: 0, changed: 0, unverified: 0 };
  const followupRows = (fields(plan).followups || []).map(f => {
    const outcome = followUpOutcome(plan, f, reports);
    followups.planned++;
    followups[outcome]++;
    return { task_id: f.task_id, kind: f.kind, category: f.category, person: (fields(plan).people || {})[f.person_id] || '', outcome };
  });
  return { counts, rows, followups, followupRows };
}

module.exports = { FORMS, ELIGIBLE, dayPlanId, linkId, followUpLinkId, eligibleRequests, linkDocs, dayProgress, followUpOutcome, index };
