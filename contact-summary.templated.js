const w = require('./lib/workflow');
const { summarize } = require('./lib/mch-summary');
const mch = require('./lib/mch');
const requests = reports.filter(r => r.form === w.FORMS.request);
const household = contact.contact_type === 'carelink_household';
// Open requests, newest first. More than one means a possible duplicate (for example two phones offline).
const open = requests.filter(r => !w.TERMINAL.includes(w.workflow(r, reports).state)).sort((a, b) => b.reported_date - a.reported_date);
const words = value => value ? String(value).replace(/_/g, ' ') : 'Not recorded';
const TRAVEL = { under_30: 'Under 30 minutes', '30_to_60': '30 minutes to 1 hour', over_60: 'More than 1 hour', unknown: 'Not known' };
const fields = [
  { label: household ? 'carelink.reference' : 'Reference', value: contact.external_id || contact._id, width: 6 },
  ...(household ? [{ label: 'carelink.worker', value: contact.responsible_worker_name, width: 6 }] : []),
  ...(open.length > 1 ? [{ label: 'Possible duplicate requests', value: `${open.length} open requests for this household. The facility will keep one and close the others.`, width: 12 }] : []),
  ...(household && open.length ? [{ label: 'New requests', value: 'A request is already open, so Request help is not offered. Use Record household contact to add an update.', width: 12 }] : []),
  { label: 'carelink.sync', value: 'Saved on this phone is not the same as received by the facility. Check the sync indicator.', width: 12 },
];
const cards = requests.map(r => {
  const current = w.workflow(r, reports);
  const f = w.fields(current.last);
  const asked = w.fields(r);
  // Only facility records change the state, and they reach this phone only from the server.
  const status = current.conflict ? 'Conflicting facility updates: facility review required'
    : current.state === 'awaiting_assignment' ? 'Not yet acknowledged by the facility' : `Acknowledged by the facility: ${words(current.state)}`;
  const contacted = reports.filter(x => x.form === 'carelink_household_contact' && w.fields(x).request_id === r._id)
    .sort((a, b) => b.reported_date - a.reported_date)[0];
  return { label: 'carelink.request_status', fields: [
    { label: 'Facility status', value: status, width: 6 },
    { label: 'Routine service requested', value: words(asked.care_need), width: 6 },
    { label: 'Reported barrier', value: words(asked.access_barrier), width: 6 },
    ...(asked.travel_time ? [{ label: 'Travel time to facility', value: TRAVEL[asked.travel_time] || words(asked.travel_time), width: 6 }] : []),
    { label: 'Scheduled visit', value: f.scheduled_date ? `${f.scheduled_date}${current.last.form === w.FORMS.planLink ? ' (approved outreach day)' : ''}` : 'No confirmed date recorded', width: 6 },
    { label: 'Purpose', value: words(asked.followup_type), width: 6 },
    ...(contacted ? [{ label: 'Latest household contact', value: `${w.fields(contacted).contact_date}: ${words(w.fields(contacted).outcome)}${w.fields(contacted).note ? ' · ' + w.fields(contacted).note : ''}`, width: 12 }] : []),
    { label: 'carelink.sync', value: 'Facility status changes only when facility records have synced to this device. A schedule or outcome is a recorded event, not a delivery receipt.', width: 12 },
    { label: 'Request reference', value: r._id, width: 12 },
  ] };
});
const schedule = requests.map(r => w.workflow(r, reports)).filter(s => !s.conflict && ['scheduled', 'in_progress'].includes(s.state)).map(s => `${w.fields(s.last).scheduled_date} · ${w.fields(s.last).assigned_worker_id}`);
// Maternal and child tracking adds its profile to people registered for ANC, PNC or CWC.
const tracking = summarize(contact, reports, undefined, typeof lineage === 'undefined' ? [] : lineage);
// Maternal/child follow-ups an approved outreach day has taken on and that are still open (lib/oi-links.js).
const planned = reports.filter(r => r.form === 'carelink_oi_followup_link' && mch.projectTasks(contact, reports, r.fields.scheduled_date).some(t => t.id === r.fields.task_id));
if (planned.length) {
  fields.push({ label: 'Planned outreach day', value: [...new Set(planned.map(r => r.fields.scheduled_date))].sort().join(', ') +
    ` (${planned.length} follow-up${planned.length > 1 ? 's' : ''}: ${planned.map(r => mch.TASK_REASONS[r.fields.kind]).join(', ')})`, width: 12 });
}
module.exports = { context: { carelink: true, carelink_contact_id: contact._id, carelink_facility_id: contact.parent ? contact.parent._id : '', carelink_role: contact.carelink_role || '', open_requests: open.length, latest_open_request_id: open.length ? open[0]._id : '', schedule_note: schedule.join('; ') || 'No confirmed visits recorded on this device.', ...tracking.context }, fields: [...fields, ...tracking.fields], cards: [...cards, ...tracking.cards] };
