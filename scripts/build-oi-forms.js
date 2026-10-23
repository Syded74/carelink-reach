'use strict';
/*
  Generates the Outreach Intelligence forms (npm run build-oi-forms) from planning/tolon-district.json,
  so the staff and vehicle choices always match what the planning service plans with. Each facility
  gets its own staff, vehicle and community questions, shown only when the form is opened on that facility.
  - carelink_oi_request: a coordinator or supervisor asks the server to generate a plan (facility profile).
  - carelink_oi_review: submit / review / approve / reject, opened only from a plan task.
  - carelink_oi_outreach_day: the assigned CHO records how the planned outreach day went.
  Every request and decision stamps the author's CHT username (fields.actor); the server rejects any
  record whose actor is not the signed-in user (authority/validate_doc_update.js).
*/
const fs = require('node:fs');
const path = require('node:path');
const district = require('../planning/tolon-district.json');

const OUT = path.join(__dirname, '..', 'forms', 'app');
const NOTICE = 'CareLink Reach. Saving does not confirm delivery: the plan status changes only when the server acknowledges it. Danger signs follow referral procedures and never wait for a plan.';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function xform(id, title, { inputs, fields, binds, body }) {
  return `<?xml version="1.0"?>
<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:odk="http://www.opendatakit.org/xforms"><h:head><h:title>${esc(title)}</h:title><model odk:xforms-version="1.0.0"><instance><data id="${id}" version="2026-10-22"><inputs><source>user</source><source_id/><contact><_id/><name/></contact><user><contact_id/><name/></user>${inputs.map(i => `<${i}/>`).join('')}</inputs><patient_id/><actor/><actor_contact/>${fields.map(f => `<${f}/>`).join('')}<notice/><meta><instanceID/></meta></data></instance>
<bind nodeset="/data/patient_id" type="string" required="true()" calculate="/data/inputs/contact/_id"/>
<bind nodeset="/data/actor" type="string" required="true()" calculate="/data/inputs/user/name"/>
<bind nodeset="/data/actor_contact" type="string" calculate="/data/inputs/user/contact_id"/>
<bind nodeset="/data/notice" readonly="true()"/>
${binds.join('\n')}
<bind nodeset="/data/meta/instanceID" type="string" readonly="true()" jr:preload="uid"/></model></h:head><h:body><input ref="/data/notice"><label>${esc(NOTICE)}</label></input>${body.join('')}</h:body></h:html>
`;
}
const items = list => list.map(([value, label]) => `<item><label>${esc(label)}</label><value>${esc(value)}</value></item>`).join('');
const select = (ref, label, list, hint = '') => `<select ref="/data/${ref}"><label>${esc(label)}</label>${hint ? `<hint>${esc(hint)}</hint>` : ''}${items(list)}</select>`;
const select1 = (ref, label, list, hint = '') => `<select1 ref="/data/${ref}"><label>${esc(label)}</label>${hint ? `<hint>${esc(hint)}</hint>` : ''}${items(list)}</select1>`;
const input = (ref, label, hint = '') => `<input ref="/data/${ref}"><label>${esc(label)}</label>${hint ? `<hint>${esc(hint)}</hint>` : ''}</input>`;
const hours = Array.from({ length: 13 }, (_, i) => `${String(6 + i).padStart(2, '0')}:00`).map(h => [h.replace(':', ''), h]);
// One question per facility for each choice list; the combined field is what the planner reads.
const perFacility = (field, label, choices, { required = false, hint = '' } = {}) => {
  // Facilities with nothing to choose from get no question.
  const asked = district.facilities.map((f, i) => ({ f, ref: `${field}_f${i + 1}`, list: choices(f) })).filter(q => q.list.length);
  const refs = asked.map(q => `/data/${q.ref}`);
  return {
    fields: [...asked.map(q => q.ref), field],
    binds: [...asked.map(q => `<bind nodeset="/data/${q.ref}" type="string" relevant="/data/inputs/contact/_id = '${q.f.id}'"${required ? ' required="true()"' : ''}/>`),
      `<bind nodeset="/data/${field}" type="string" calculate="normalize-space(${refs.length > 1 ? `concat(${refs.join(", ' ', ")})` : refs[0]})"${required ? ' required="true()"' : ''}/>`],
    body: asked.map(q => select(q.ref, label, q.list, hint)),
  };
};
const staffQ = perFacility('staff_available', 'Health workers available that day', f => f.staff.map(s => [s.id, `${s.name} (${s.role})`]), { required: true });
const vehicleQ = perFacility('vehicles', 'Vehicles available that day', f => f.vehicles.map(v => [v.id, v.name]), { hint: 'Every trip needs a vehicle. Leave all unticked if none is available.' });
const guaranteeQ = perFacility('guarantee_communities', 'Guarantee a visit to (optional, hard constraint)', f => f.communities.map(c => [c.id, c.name]));

// Show the facility's next configured outreach day (planning/tolon-district.json outreach_calendar), today included,
// and note when the chosen date falls on another weekday. Shown, never forced: any date can be chosen and the plan
// explains a day outside the weekly schedule. (A setvalue default cannot be used: CHT opens forms with the facility
// already in the instance, so odk-instance-first-load never fires.) Day 0 (1970-01-01) was a Thursday.
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const weekday = "((floor(decimal-date-time(today()) + 0.5) + 4) mod 7)";
const outreachDays = district.facilities
  .map(f => ({ f, day: WEEKDAYS.indexOf(Object.entries((f.outreach_calendar || {}).days || {}).find(([, a]) => a === 'outreach')?.[0]) }))
  .filter(x => x.day >= 0);
const dateFor = day => `format-date(date(floor(decimal-date-time(today()) + 0.5) + ((${day} - ${weekday} + 7) mod 7)), '%Y-%m-%d')`;
// CHT fills in the facility after the form's first-load event, so the last fallback is the most common outreach day.
const commonDay = outreachDays.map(x => x.day).sort((a, b) => outreachDays.filter(x => x.day === b).length - outreachDays.filter(x => x.day === a).length)[0];
const nextOutreach = outreachDays.reduce((otherwise, { f, day }) => `if(/data/inputs/contact/_id = '${f.id}', ${dateFor(day)}, ${otherwise})`,
  commonDay === undefined ? "''" : dateFor(commonDay));
const outreachWeekday = outreachDays.reduce((otherwise, { f, day }) => `if(/data/inputs/contact/_id = '${f.id}', ${day}, ${otherwise})`, '-1');
const weekdayOf = ref => `((floor(decimal-date-time(${ref}) + 0.5) + 4) mod 7)`;

const forms = {
  carelink_oi_request: xform('carelink_oi_request', 'Generate outreach plan', {
    inputs: [],
    fields: ['suggested_date', 'outreach_weekday', 'suggested_note', 'planning_date', 'off_schedule_note', 'season', ...staffQ.fields, 'hours_start', 'hours_end', ...vehicleQ.fields, 'use_synthetic_history', 'fairness_weight', ...guaranteeQ.fields],
    binds: [
      '<bind nodeset="/data/planning_date" type="date" required="true()" constraint=". &gt;= today()" jr:constraintMsg="Choose today or a later date."/>',
      `<bind nodeset="/data/suggested_date" type="string" calculate="${esc(nextOutreach)}"/>`,
      `<bind nodeset="/data/outreach_weekday" type="string" calculate="${esc(outreachWeekday)}"/>`,
      '<bind nodeset="/data/suggested_note" readonly="true()" relevant="/data/suggested_date != \'\'"/>',
      `<bind nodeset="/data/off_schedule_note" readonly="true()" relevant="${esc(`/data/planning_date != '' and /data/outreach_weekday >= 0 and ${weekdayOf('/data/planning_date')} != /data/outreach_weekday`)}"/>`,
      '<bind nodeset="/data/season" type="string" required="true()"/>',
      ...staffQ.binds,
      '<bind nodeset="/data/hours_start" type="string" required="true()"/>',
      '<bind nodeset="/data/hours_end" type="string" required="true()" constraint="number(.) &gt; number(/data/hours_start)" jr:constraintMsg="The working day must end after it starts."/>',
      ...vehicleQ.binds,
      '<bind nodeset="/data/use_synthetic_history" type="string" required="true()"/>',
      '<bind nodeset="/data/fairness_weight" type="decimal" required="true()" constraint=". &gt;= 0 and . &lt;= 1" jr:constraintMsg="Use a value from 0 to 1."/>',
      ...guaranteeQ.binds,
    ],
    body: [
      '<input ref="/data/suggested_note"><label>This facility\'s next scheduled outreach day is <output value="/data/suggested_date"/>.</label></input>',
      input('planning_date', 'Outreach date', 'Usually the scheduled outreach day above. You can choose another date.'),
      '<input ref="/data/off_schedule_note"><label>This date is not the facility\'s usual outreach day. You can continue; the plan will show a calendar warning.</label></input>',
      select1('season', 'Travel times to use', [['dry', 'Dry season'], ['rainy', 'Rainy season']], 'Estimated travel times from planning/tolon-district.json; confirm them with the facility.'),
      ...staffQ.body,
      select1('hours_start', 'Working day starts', hours),
      select1('hours_end', 'Working day ends', hours),
      ...vehicleQ.body,
      select1('use_synthetic_history', 'Forecast history', [['no', 'Live CHT counts only'], ['yes', 'Live CHT counts + simulated past weeks (for testing the forecast)']]),
      input('fairness_weight', 'Fairness weight (0–1)', 'Raises the priority of communities with transport barriers or few reported weeks. Low reporting can mean poor access, not low need.'),
      ...guaranteeQ.body,
    ],
  }),
  carelink_oi_review: xform('carelink_oi_review', 'Outreach plan decision', {
    inputs: ['proposal_id', 'expected_event', 'current_state', 'step', 'requested_by', 'summary'],
    fields: ['proposal_id', 'expected_event', 'state_seen', 'step', 'decision', 'action', 'notes'],
    binds: [
      '<bind nodeset="/data/proposal_id" type="string" required="true()" calculate="/data/inputs/proposal_id" constraint=". != \'\'" jr:constraintMsg="Open this form from your Outreach Intelligence task."/>',
      '<bind nodeset="/data/expected_event" type="string" required="true()" calculate="/data/inputs/expected_event"/>',
      '<bind nodeset="/data/state_seen" type="string" calculate="/data/inputs/current_state"/>',
      '<bind nodeset="/data/step" type="string" calculate="/data/inputs/step"/>',
      '<bind nodeset="/data/decision" type="string" relevant="/data/inputs/step = \'decide\'" required="true()"/>',
      '<bind nodeset="/data/action" type="string" required="true()" calculate="if(/data/inputs/step = \'decide\', /data/decision, /data/inputs/step)"/>',
      '<bind nodeset="/data/notes" type="string" required="/data/decision = \'reject\'" jr:requiredMsg="Give the reason for rejecting." constraint="string-length(.) &lt;= 400"/>',
    ],
    body: [
      '<input ref="/data/inputs/summary"><label>Plan: <output value="/data/inputs/summary"/></label></input>',
      select1('decision', 'Your decision', [['approve', 'Approve this plan'], ['reject', 'Reject this plan']]),
      input('notes', 'Notes', 'Required when rejecting. Saved with the audit trail.'),
    ],
  }).replace('<bind nodeset="/data/notice" readonly="true()"/>', '<bind nodeset="/data/notice" readonly="true()"/>\n<bind nodeset="/data/inputs/summary" readonly="true()"/>'),
  carelink_oi_outreach_day: xform('carelink_oi_outreach_day', 'Record the outreach day', {
    inputs: ['assignment_id', 'proposal_id', 'planned_date', 'items_planned', 'route', 'requests_planned'],
    fields: ['assignment_id', 'proposal_id', 'outcome', 'reason'],
    binds: [
      '<bind nodeset="/data/assignment_id" type="string" required="true()" calculate="/data/inputs/assignment_id"/>',
      '<bind nodeset="/data/proposal_id" type="string" calculate="/data/inputs/proposal_id"/>',
      '<bind nodeset="/data/outcome" type="string" required="true()"/>',
      '<bind nodeset="/data/reason" type="string" relevant="/data/outcome != \'done\'" required="true()" constraint="string-length(.) &lt;= 240"/>',
    ],
    body: [
      '<input ref="/data/inputs/route"><label>Planned for <output value="/data/inputs/planned_date"/>: <output value="/data/inputs/route"/> (<output value="/data/inputs/items_planned"/> routine items)</label></input>',
      '<input ref="/data/inputs/requests_planned"><label>Household requests planned for this day: <output value="/data/inputs/requests_planned"/>. Record each household visit from its own task; this record does not close any request.</label></input>',
      select1('outcome', 'How did the outreach day go?', [['done', 'Outreach done as planned'], ['partly', 'Partly done'], ['not_done', 'Not done']]),
      input('reason', 'What prevented it?', 'Operational reason only, no clinical details.'),
    ],
  }).replace('<bind nodeset="/data/notice" readonly="true()"/>', '<bind nodeset="/data/notice" readonly="true()"/>\n<bind nodeset="/data/inputs/route" readonly="true()"/>\n<bind nodeset="/data/inputs/requests_planned" readonly="true()"/>'),
  // Facility-level readiness of supplies, equipment and fuel, confirmed by staff (outreach-intelligence/carelink_oi/readiness.py).
  carelink_resource_status: xform('carelink_resource_status', 'Resource readiness', {
    inputs: [],
    fields: ['resource_id', 'status', 'quantity', 'reserved', 'verified_date', 'note'],
    binds: [
      '<bind nodeset="/data/resource_id" type="string" required="true()"/>',
      '<bind nodeset="/data/status" type="string" required="true()"/>',
      '<bind nodeset="/data/quantity" type="decimal" relevant="selected(\'confirmed insufficient\', /data/status)" required="true()" constraint=". &gt;= 0" jr:constraintMsg="Enter a quantity of 0 or more."/>',
      '<bind nodeset="/data/reserved" type="decimal" relevant="selected(\'confirmed insufficient\', /data/status)" constraint=". &gt;= 0 and . &lt;= /data/quantity" jr:constraintMsg="Reserved cannot exceed the quantity."/>',
      '<bind nodeset="/data/verified_date" type="date" required="true()" jr:preload="date" jr:preloadParams="today" constraint=". &lt;= today()" jr:constraintMsg="The check cannot be in the future."/>',
      '<bind nodeset="/data/note" type="string" constraint="string-length(.) &lt;= 240"/>',
    ],
    body: [
      select1('resource_id', 'Resource', district.facilities[0].resources.map(r => [r.id, `${r.name} (${r.unit})`]), 'Planning resources configured for the facility. Vaccine stock is recorded here but is not tied to any visit type without reviewed clinical configuration.'),
      select1('status', 'Status', [['confirmed', 'Available'], ['insufficient', 'Not enough'], ['unavailable', 'Not available'], ['unknown', 'Needs confirmation (could not check)']], 'Needs confirmation is never treated as available.'),
      input('quantity', 'Quantity on hand', 'In the unit shown with the resource.'),
      input('reserved', 'Already reserved for other work (optional)'),
      input('verified_date', 'Date checked'),
      input('note', 'Note (optional)'),
    ],
  }),
};
const facilityStaff = "contact.contact_type === 'carelink_facility' && (user.carelink_role === 'carelink_coordinator' || user.carelink_role === 'carelink_supervisor')";
const properties = {
  carelink_oi_request: { title: 'Generate outreach plan', icon: 'carelink-followup', context: { person: false, place: true, expression: facilityStaff, permission: 'can_carelink_oi' } },
  // Decisions and outreach-day records open only from their tasks, which carry the exact plan.
  carelink_oi_review: { title: 'Outreach plan decision', icon: 'carelink-followup', context: { person: false, place: false, expression: 'false', permission: 'can_carelink_oi' } },
  carelink_oi_outreach_day: { title: 'Record the outreach day', icon: 'carelink-outreach', context: { person: false, place: false, expression: 'false', permission: 'can_carelink_visit' } },
  carelink_resource_status: { title: 'Resource readiness', icon: 'carelink-followup', context: { person: false, place: true, expression: facilityStaff, permission: 'can_carelink_oi' } },
};
for (const [id, xml] of Object.entries(forms)) {
  fs.writeFileSync(path.join(OUT, `${id}.xml`), xml);
  fs.writeFileSync(path.join(OUT, `${id}.properties.json`), JSON.stringify(properties[id], null, 2) + '\n');
}
console.log(`Wrote ${Object.keys(forms).length} Outreach Intelligence forms`);
