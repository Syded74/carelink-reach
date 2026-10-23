'use strict';
/*
  Outreach Intelligence plan workflow, as seen on a device (tasks.js and the CHT tab).

  The planning service on the server is the only authority on whether a decision counts: it
  validates every carelink_oi_review event (role, separation of duties, order, conflicts) and
  writes a carelink_oi_ack. This module never accepts anything itself. It only reads those
  acknowledgements, so a decision saved offline is shown as pending until the server's
  acknowledgement arrives back on the device.
*/
const FORMS = {
  request: 'carelink_oi_request', review: 'carelink_oi_review', outreachDay: 'carelink_oi_outreach_day',
  demand: 'carelink_oi_demand', proposal: 'carelink_oi_proposal', ack: 'carelink_oi_ack', assignment: 'carelink_oi_assignment',
};
// draft → proposed → reviewed → approved | rejected (keep in step with carelink_oi/cht_integration.py)
const ACTIONS = { submit: ['draft', 'proposed'], review: ['proposed', 'reviewed'], approve: ['reviewed', 'approved'], reject: ['reviewed', 'rejected'] };
const f = doc => (doc && doc.fields) || {};
const byTime = (a, b) => (a.reported_date || 0) - (b.reported_date || 0);

function proposalStatus(proposal, reports) {
  const acks = reports.filter(r => r.form === FORMS.ack && f(r).proposal_id === proposal._id).sort(byTime);
  const events = reports.filter(r => r.form === FORMS.review && f(r).proposal_id === proposal._id).sort(byTime);
  const acked = new Map(acks.map(a => [f(a).event_id, a]));
  let state = 'draft';
  let lastEvent = proposal._id;
  let reviewer = null;
  let reviewerContact = null;
  const accepted = acks.filter(a => f(a).result === 'accepted');
  const eventById = new Map(events.map(e => [e._id, e]));
  while (true) {
    const next = accepted.filter(a => (f(a).previous_event || f(eventById.get(f(a).event_id)).expected_event) === lastEvent);
    if (!next.length) { break; }
    if (next.length !== 1) { state = 'conflict'; break; }
    const a = next[0];
    state = f(a).state_after;
    lastEvent = f(a).event_id;
    accepted.splice(accepted.indexOf(a), 1);
    if (f(a).action === 'review') { reviewer = f(a).actor; reviewerContact = f(a).actor_contact; }
  }
  const history = events.map(e => {
    const ack = acked.get(e._id);
    return { id: e._id, action: f(e).action, actor: f(e).actor, at: e.reported_date, notes: f(e).notes,
      server: ack ? f(ack).result : 'pending', reason: ack ? f(ack).reason : null };
  });
  return {
    canProceed: !f(proposal).schedule || ['OPTIMAL', 'FEASIBLE'].includes(f(proposal).schedule.status),
    state, lastEvent, reviewer, reviewerContact, requestedBy: f(proposal).requested_by, requestedByContact: f(proposal).requested_by_contact,
    approvedOnServer: state === 'approved', pending: history.filter(h => h.server === 'pending'), history,
  };
}

// Which action, if any, this user may take next. The server re-checks all of it.
function nextActionFor(status, userContactId, role) {
  if (status.pending.length || status.canProceed === false) { return null; }
  if (status.state === 'draft') { return userContactId === status.requestedByContact ? 'submit' : null; }
  if (status.state === 'proposed') { return role === 'carelink_supervisor' && userContactId !== status.requestedByContact ? 'review' : null; }
  if (status.state === 'reviewed') { return role === 'carelink_supervisor' && userContactId === status.reviewerContact ? 'decide' : null; }
  return null;
}

// Whether a plan still belongs on someone's to-do list: a draft is superseded by any newer plan of the same
// facility, and a test plan leaves to-do lists a day after its run. Used by tasks.js and the planning tab alike.
function actionable(proposal, reports, action, now = Date.now()) {
  if (proposal.fields.includes_test_records && proposal.reported_date < now - 24 * 60 * 60 * 1000) { return false; }
  return action !== 'submit' || !reports.some(r => r.form === FORMS.proposal && r.reported_date > proposal.reported_date &&
    (r.fields.place_id || r.fields.patient_id) === (proposal.fields.place_id || proposal.fields.patient_id));
}

module.exports = { FORMS, ACTIONS, proposalStatus, nextActionFor, actionable };
