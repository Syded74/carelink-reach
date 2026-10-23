'use strict';

const FORMS = { request: 'carelink_request', coordination: 'carelink_coordination', visit: 'carelink_visit', referral: 'carelink_referral',
  // Written by the planning service when an approved outreach day takes on this request (lib/oi-links.js).
  planLink: 'carelink_oi_request_link' };
const TERMINAL = ['completed', 'unable_to_complete', 'cancelled'];
const TRANSITIONS = {
  awaiting_assignment: ['accepted', 'cancelled'],
  accepted: ['assigned', 'contact_attempt', 'cancelled'],
  contact_attempt: ['assigned', 'contact_attempt', 'cancelled'],
  assigned: ['scheduled', 'contact_attempt', 'cancelled'],
  scheduled: ['in_progress', 'completed', 'unable_to_complete', 'cancelled'],
  in_progress: ['completed', 'unable_to_complete', 'cancelled'],
};
const fields = doc => doc && doc.fields || {};
const requestId = doc => doc.form === FORMS.request ? doc._id : fields(doc).request_id;
// An approved outreach day schedules a request the facility has accepted, or one an earlier day released.
const PLAN_FROM = ['accepted', 'assigned', 'contact_attempt', 'scheduled'];
const allowed = (state, event) => fields(event).source === 'approved_plan' && event.form === FORMS.planLink
  ? PLAN_FROM.includes(state) && fields(event).status === 'scheduled'
  : event.form !== FORMS.planLink && (TRANSITIONS[state] || []).includes(fields(event).status);

// Records are append-only coordination events. A branch blocks downstream tasks;
// concurrent assignments never silently resolve by timestamp or last-write-wins.
function workflow(request, reports) {
  // One document per _id: a re-synced copy of the same event is never a second branch.
  const events = [...new Map(reports.filter(r => r.form === FORMS.coordination || r.form === FORMS.visit || r.form === FORMS.planLink)
    .filter(r => fields(r).request_id === request._id && !r._deleted).map(r => [r._id, r])).values()];
  let state = 'awaiting_assignment';
  let last = request;
  const used = new Set();
  while (true) {
    const next = events.filter(r => fields(r).expected_event === last._id && !used.has(r._id));
    if (!next.length) {
      return { state, last, orphaned: events.filter(e => !used.has(e._id)), conflict: false };
    }
    if (next.length > 1) {
      return { state: 'conflict', last, conflict: true, conflicting: next.map(r => r._id) };
    }
    const event = next[0];
    const nextState = fields(event).status;
    if (!allowed(state, event)) {
      return { state: 'conflict', last, conflict: true, invalid: event._id };
    }
    state = nextState;
    last = event;
    used.add(event._id);
  }
}
function requests(contact) {
  return (contact.reports || []).filter(r => r.form === FORMS.request && !r._deleted);
}
function unresolved(contact) {
  return requests(contact).filter(r => !TERMINAL.includes(workflow(r, contact.reports).state));
}
function latestFor(contact, event) {
  const request = requests(contact).find(r => r._id === fields(event).request_id);
  if (!request) { return null; }
  const result = workflow(request, contact.reports);
  return !result.conflict && result.last._id === event._id ? result : null;
}
module.exports = { FORMS, TERMINAL, TRANSITIONS, PLAN_FROM, fields, requestId, workflow, requests, unresolved, latestFor };
