const w = require('./lib/workflow');
const mch = require('./lib/mch');
const { appointmentOpen } = require('./lib/schedules');
const { TEST_ORIGIN } = require('./lib/test-records');
const mo = require('./lib/mch-outreach');
const oi = require('./lib/oi-workflow');
// Open routine maternal/child obligations of a person (task ids), as of today; urgent items are never routine.
const openRoutine = c => mch.projectTasks(c.contact, c.reports).filter(t => mo.OUTREACH_KINDS.includes(t.kind)).map(t => t.id);
const staleOrUnknown = c => {
  const latest = {};
  c.reports.filter(r => r.form === 'carelink_resource_status' && r.record_origin !== TEST_ORIGIN).sort((a, b) => a.reported_date - b.reported_date).forEach(r => { latest[r.fields.resource_id] = r; });
  const limit = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return Object.values(latest).filter(r => r.fields.status === 'unknown' || Date.parse(r.fields.verified_date || 0) < limit).map(r => `${c.contact._id}:${r.fields.resource_id}`);
};
// The chain an event report starts, or null when the report is a later event in a chain.
const root = (list, c, r) => list(c.reports).find(chain => chain.root._id === r._id) || null;
const target = (id, form, predicate) => ({
  id: 'carelink-' + id, type: 'count', icon: 'carelink-outreach', goal: -1,
  translation_key: 'carelink.target.' + id, subtitle_translation_key: 'carelink.scope',
  appliesTo: form ? 'reports' : 'contacts',
  appliesToType: [form || 'carelink_community'],
  date: 'now', idType: form ? 'report' : 'contact',
  // Contacts created by regression tests (lib/test-records.js) are never counted.
  appliesIf: (c, r) => c.contact.record_origin !== TEST_ORIGIN && (!predicate || predicate(c, r)),
});
module.exports = [
  target('communities'),
  target('requests', w.FORMS.request),
  target('reviewed', w.FORMS.request, (c, r) => w.workflow(r, c.reports).state !== 'awaiting_assignment'),
  target('awaiting', w.FORMS.request, (c, r) => w.workflow(r, c.reports).state === 'awaiting_assignment'),
  target('assigned', w.FORMS.request, (c, r) => ['assigned', 'scheduled', 'in_progress'].includes(w.workflow(r, c.reports).state)),
  target('completed', w.FORMS.request, (c, r) => w.workflow(r, c.reports).state === 'completed'),
  target('unresolved', w.FORMS.request, (c, r) => !w.TERMINAL.includes(w.workflow(r, c.reports).state)),
  target('transport', w.FORMS.request, (c, r) => ['transport_unavailable', 'transport_cost'].includes(w.fields(r).access_barrier)),
  // Maternal and child tracking: counts only, as the Python admin report (shared_sync.py:2560-2690).
  // No coverage targets: the Flutter app defines none.
  target('mch-appointments', mch.FORMS.appointment, (c, r) => !!root(mch.appointments, c, r)),
  target('mch-appointments-missed', mch.FORMS.appointment, (c, r) => (root(mch.appointments, c, r) || {}).state === 'missed'),
  target('mch-appointments-scheduled', mch.FORMS.appointment, (c, r) => appointmentOpen((root(mch.appointments, c, r) || {}).state)),
  target('mch-appointment-events', mch.FORMS.appointment),
  ...mch.STAGES.map(stage => target('mch-visits-' + stage, mch.FORMS[stage])),
  target('mch-referrals-open', mch.FORMS.referral, (c, r) => { const chain = root(mch.referrals, c, r); return !!chain && mch.referralOpen(chain); }),
  // Outreach coverage (lib/mch-outreach.js, lib/oi-links.js). Each counts a different unit, so nothing is counted twice:
  // routine obligations (task ids), people awaiting follow-up, planned encounters, completed documented encounters.
  {
    ...target('open-obligations'), appliesToType: ['carelink_individual'],
    // Patients only (ANC/PNC/CWC care stage): staff person records are individuals too and have no obligations.
    appliesIf: c => c.contact.record_origin !== TEST_ORIGIN && mch.isMch(c.contact) && openRoutine(c).length > 0,
    idType: c => openRoutine(c),
  },
  { ...target('people-awaiting'), appliesToType: ['carelink_individual'], appliesIf: c => c.contact.record_origin !== TEST_ORIGIN && mch.isMch(c.contact) && openRoutine(c).length > 0 },
  {
    ...target('planned-encounters', 'carelink_oi_day_plan', (c, r) => !r.fields.includes_test_records),
    // One per household request and one per person the day takes on.
    idType: (c, r) => [...(r.fields.request_ids || []), ...new Set((r.fields.followups || []).map(f => f.person_id))].map(id => `${r._id}:${id}`),
  },
  target('visits-not-completed', w.FORMS.visit, (c, r) => r.fields.status === 'unable_to_complete'),
  { ...target('completed-encounters', w.FORMS.visit, (c, r) => r.fields.status === 'completed'), appliesToType: [w.FORMS.visit, ...mch.VISIT_FORMS],
    appliesIf: (c, r) => c.contact.record_origin !== TEST_ORIGIN && (r.form !== w.FORMS.visit || r.fields.status === 'completed') },
  { ...target('communities-covered'), appliesIf: c => c.reports.some(r => r.form === 'carelink_oi_outreach_day' && r.fields.outcome !== 'not_done' &&
    r.reported_date >= Date.now() - 30 * 24 * 60 * 60 * 1000) },
  target('plans-awaiting-review', 'carelink_oi_proposal', (c, r) => !r.fields.includes_test_records &&
    ['proposed', 'reviewed'].includes(oi.proposalStatus(r, c.reports).state)),
  // Referrals, one per referral chain (its root), so repeated or duplicate events never count twice.
  target('referrals-created', mch.FORMS.referral, (c, r) => !!root(mch.referrals, c, r)),
  target('referrals-awaiting-ack', mch.FORMS.referral, (c, r) => (root(mch.referrals, c, r) || {}).state === 'created'),
  target('referrals-acknowledged', mch.FORMS.referral, (c, r) => { const ch = root(mch.referrals, c, r); return !!ch && ch.history.some(e => e.fields.state === 'acknowledged'); }),
  target('referrals-outcome', mch.FORMS.referral, (c, r) => { const ch = root(mch.referrals, c, r); return !!ch && ch.history.some(e => ['outcome_recorded', 'closed'].includes(e.fields.state)); }),
  // Facility resources whose latest readiness is unknown or older than 7 days (planning will not use them).
  { ...target('resources-need-confirmation'), appliesToType: ['carelink_facility'], appliesIf: c => staleOrUnknown(c).length > 0, idType: c => staleOrUnknown(c) },
];
