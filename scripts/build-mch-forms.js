'use strict';
/*
  Generates the ANC → PNC → CWC XForms from lib/mch-fields.js so the 84 Flutter documentation fields,
  vitals, danger signs and data-entry ranges cannot drift from the source of truth.
  Run: node scripts/build-mch-forms.js (writes forms/app/carelink_*.xml and .properties.json).
*/
const fs = require('node:fs');
const path = require('node:path');
const F = require('../lib/mch-fields');
const district = require('../planning/tolon-district.json');

const VERSION = '2026-10-21';
const OUT = path.join(__dirname, '..', 'forms', 'app');
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CTX = name => `instance('contact-summary')/context/${name}`;
const TODAY = "format-date(today(), '%Y-%m-%d')";

// Minimal XForm tree: {name, children} groups/repeats and leaf questions.
const q = (name, opts = {}) => ({ name, ...opts });
const group = (name, opts, children) => ({ name, group: true, ...opts, children });
const repeat = (name, opts, children) => ({ name, repeat: true, ...opts, children });
const calc = (name, calculate, type = 'string') => q(name, { calculate, type });
const note = (name, label, relevant, rawLabel = false) => q(name, { control: 'note', label, relevant, rawLabel, type: 'string', readonly: true });

function render(node, parent, out) {
  const ref = `${parent}/${node.name}`;
  if (node.group || node.repeat) {
    out.instance.push(node.repeat ? `<${node.name} jr:template="">` : `<${node.name}>`);
    const body = { instance: out.instance, binds: out.binds, body: [] };
    node.children.forEach(child => render(child, ref, body));
    out.instance.push(`</${node.name}>`);
    if (node.relevant) { out.binds.push(`<bind nodeset="${ref}" relevant="${esc(node.relevant)}"/>`); }
    if (body.body.length || node.label) {
      const label = node.label ? `<label>${esc(node.label)}</label>` : '';
      const appearance = node.appearance ? ` appearance="${node.appearance}"` : '';
      out.body.push(node.repeat
        ? `<group ref="${ref}">${label}<repeat nodeset="${ref}">${body.body.join('')}</repeat></group>`
        : `<group ref="${ref}"${appearance}>${label}${body.body.join('')}</group>`);
    }
    return;
  }
  out.instance.push(node.value !== undefined ? `<${node.name}>${esc(node.value)}</${node.name}>` : `<${node.name}/>`);
  const attrs = [`nodeset="${ref}"`, `type="${node.type || 'string'}"`];
  for (const key of ['required', 'relevant', 'constraint', 'calculate', 'readonly']) {
    if (node[key] !== undefined) { attrs.push(`${key}="${esc(node[key] === true ? 'true()' : node[key])}"`); }
  }
  if (node.msg) { attrs.push(`jr:constraintMsg="${esc(node.msg)}"`); }
  if (node.preload) { attrs.push(`jr:preload="${node.preload}"`); }
  out.binds.push(`<bind ${attrs.join(' ')}/>`);
  if (node.calculate !== undefined || !node.label) { return; }
  const label = `<label>${node.rawLabel ? node.label : esc(node.label)}</label>${node.hint ? `<hint>${esc(node.hint)}</hint>` : ''}`;
  const appearance = node.appearance ? ` appearance="${node.appearance}"` : '';
  if (node.options) {
    const items = node.options.map(([value, text]) => `<item><label>${esc(text)}</label><value>${value}</value></item>`).join('');
    out.body.push(`<${node.multiple ? 'select' : 'select1'} ref="${ref}"${appearance}>${label}${items}</${node.multiple ? 'select' : 'select1'}>`);
  } else {
    out.body.push(`<input ref="${ref}"${appearance}>${label}</input>`);
  }
}

function xform(id, title, children, { summary = true } = {}) {
  const out = { instance: [], binds: [], body: [] };
  children.forEach(child => render(child, '/data', out));
  const instance = out.instance.join('');
  return `<?xml version="1.0"?>\n<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:odk="http://www.opendatakit.org/xforms"><h:head><h:title>${esc(title)}</h:title><model odk:xforms-version="1.0.0"><instance><data id="${id}" version="${VERSION}">${instance}<meta><instanceID/></meta></data></instance>${summary ? '<instance id="contact-summary"/>' : ''}${out.binds.join('')}<bind nodeset="/data/meta/instanceID" type="string" readonly="true()" jr:preload="uid"/></model></h:head><h:body>${out.body.join('')}</h:body></h:html>\n`;
}

const INPUT_CONTACT = ['_id', 'name', 'external_id', 'care_stage', 'sex', 'date_of_birth', 'mother_id', 'responsible_worker_id'];
function inputs(extra = []) {
  return group('inputs', { relevant: '0' }, [
    q('source', { value: 'user' }), q('source_id'), ...extra.map(name => q(name)),
    group('contact', {}, [...INPUT_CONTACT.map(name => q(name)), group('parent', {}, [q('_id')])]),
    group('user', {}, [q('contact_id'), q('name')]),
  ]);
}
const common = (patient = '/data/inputs/contact/_id') => [
  calc('patient_id', patient), calc('patient_name', '/data/inputs/contact/name'),
  calc('created_by', '/data/inputs/user/contact_id'),
  q('approval_status', { value: F.APPROVAL.approval_status }),
];
const NOTICE = 'CareLink Reach. Saving does not confirm delivery: check the CHT sync indicator. Records only what you observed or did; CareLink adds no schedule, classification or threshold.';

// Value-first documentation answer with an explicit state (mch_documentation.dart:10-23):
// a value is Confirmed unless marked "reported, not verified"; no value is Not assessed unless marked Unknown.
function answer(field, relevant) {
  const name = F.fieldName(field.id);
  const ref = `../${name}`;
  const value = q(name, { label: field.label, relevant,
    ...(field.options ? { options: field.options.map(o => [F.slug(o), o]) } : {}),
    ...(field.date ? { type: 'date' } : {}),
    ...(field.numeric ? { type: 'decimal', constraint: '. >= 0', msg: `${field.label}: enter a finite, non-negative number.` } : {}),
    ...(field.time ? { constraint: "regex(., '^([01][0-9]|2[0-3]):[0-5][0-9]$')", msg: `${field.label}: enter a 24-hour time as HH:MM.` } : {}),
  });
  return [
    value,
    q(`${name}_unverified`, { label: 'Reported, not verified', relevant: `${ref} != ''`, options: [['yes', 'Reported, not verified']], multiple: true, appearance: 'minimal' }),
    q(`${name}_unknown`, { label: 'Unknown', relevant: `${ref} = ''`, options: [['yes', 'Unknown (not the same as absent)']], multiple: true, appearance: 'minimal' }),
    calc(`${name}_state`, `if(${ref} != '', if(selected(../${name}_unverified, 'yes'), 'unverified', 'recorded'), if(selected(../${name}_unknown, 'yes'), 'unknown', 'notAssessed'))`),
  ];
}
function sections(fields, relevantFor = () => undefined) {
  const order = [];
  const grouped = {};
  fields.forEach(field => {
    if (!grouped[field.section]) { grouped[field.section] = []; order.push(field.section); }
    if (!grouped[field.section].some(f => f.id === field.id)) { grouped[field.section].push(field); }
  });
  return order.map(section => {
    const list = grouped[section];
    const bookingOnly = list.every(f => f.bookingOnly);
    const relevant = [relevantFor(section), bookingOnly ? "/data/documentation/visit_identification/anc_visit_kind != 'return'" : null]
      .filter(Boolean).join(' and ') || undefined;
    return group(F.slug(section), { label: section, appearance: 'field-list', relevant }, [
      note(`${F.slug(section)}_note`, F.SECTION_NOTES[section] || section),
      ...list.flatMap(field => answer(field)),
    ]);
  });
}
function vitals(stage, relevant) {
  return group('vitals', { label: 'Measurements', appearance: 'field-list', relevant }, F.VITALS[stage].flatMap(([code, label, unit]) => {
    const [low, high, exclusive] = F.DATA_ENTRY_RANGES[code] || [0, Infinity, true];
    const ref = `../${code}`;
    const out = `${ref} != '' and (${ref} ${exclusive ? '<=' : '<'} ${low}${high === Infinity ? '' : ` or ${ref} > ${high}`})`;
    return [
      q(code, { label: `${label} (${unit})`, hint: 'Leave empty if not measured at this visit.', type: 'decimal', constraint: '. >= 0',
        msg: 'Enter a valid number or leave it empty (not recorded).' }),
      q(`${code}_questionable`, { label: `${label} is outside the data-entry check range. Recheck it, or confirm it as questionable.`,
        relevant: out, required: true, options: [['confirmed', 'I rechecked: record it as questionable']], multiple: true }),
    ];
  }));
}
// `relevant` matches the vitals group: a newborn PNC has no maternal vitals, so none are "missing" (spec §2.4)
function vitalCalcs(stage, prefix, relevant) {
  const codes = F.VITALS[stage].map(([code]) => code);
  const when = expr => relevant ? `if(${relevant}, ${expr}, '')` : expr;
  return [
    calc('missing_vitals', when(`normalize-space(concat(${codes.map(c => `if(${prefix}/${c} = '', '${c} ', '')`).join(', ')}))`)),
    calc('quality_issues', when(`normalize-space(concat(${codes.map(c => `if(selected(${prefix}/${c}_questionable, 'confirmed'), '${c} ', '')`).join(', ')}))`)),
  ];
}
function signs(stage, relevant) {
  return group('signs', { label: 'Danger signs', appearance: 'field-list', relevant }, [
    q('danger_signs', { label: 'Danger signs reported or observed today', hint: 'Select only what was reported or observed.',
      options: F.DANGER_SIGNS[stage].map(sign => [F.slug(sign), sign]), multiple: true }),
    // Wording agreed with the team's nurse: care first, the record second. The referral workflow itself is unchanged.
    note('referral_offer', `**${stage === 'anc' ? 'Possible maternal danger sign' : 'Possible danger sign'}.** Urgent assessment may be required. Follow the facility's emergency referral protocol. Do not delay care to complete this form. If safe and appropriate, save the visit to record the concern. Then use Start a referral from the urgent task.`,
      "../danger_signs != ''"),
  ]);
}
const followUp = calc('follow_up_date', "if(/data/documentation/counselling_and_plan/care_follow_up_date_state = 'recorded', /data/documentation/counselling_and_plan/care_follow_up_date, '')");

function visitForm(stage) {
  const id = `carelink_${stage}_visit`;
  const title = { anc: 'ANC visit', pnc: 'PNC visit', cwc: 'Child welfare visit' }[stage];
  const head = [inputs(), ...(stage === 'pnc' ? common("if(/data/pnc_subject = 'newborn', /data/newborn/_id, /data/inputs/contact/_id)") : common()),
    q('stage', { value: stage }), calc('visit_date', TODAY), note('notice', NOTICE)];
  if (stage === 'anc') {
    head.push(calc('pregnancy_id', CTX('open_pregnancy_id')));
  }
  if (stage === 'pnc') {
    head.push(
      q('pnc_subject', { label: 'Who is this PNC visit for?', required: true,
        options: [['maternal', 'The mother'], ['newborn', 'A newborn from the recorded delivery']],
        constraint: `(. = 'maternal' or ${CTX('delivery_child_ids')} != '') and (${CTX('latest_delivery_date')} = '' or date(${CTX('latest_delivery_date')}) <= today())`,
        msg: 'PNC needs a recorded delivery that is not after today; a newborn PNC needs the delivery and its children.' }),
      group('newborn', { relevant: "/data/pnc_subject = 'newborn'" }, [
        q('_id', { label: 'Newborn', required: true, appearance: 'select-contact type-carelink_individual',
          constraint: `contains(concat(' ', ${CTX('delivery_child_ids')}, ' '), concat(' ', ., ' '))`,
          msg: 'Choose a child listed on the recorded delivery.' }),
        q('name'),
      ]),
      calc('mother_id', "if(/data/pnc_subject = 'newborn', /data/inputs/contact/_id, '')"),
      calc('delivery_id', CTX('latest_delivery_id')),
      calc('delivery_date', CTX('latest_delivery_date')),
    );
  }
  const maternal = stage === 'pnc' ? "/data/pnc_subject = 'maternal'" : undefined;
  const body = [vitals(stage, maternal), ...vitalCalcs(stage, '/data/vitals', maternal), signs(stage, maternal), calc('danger_signs', '/data/signs/danger_signs')];
  let documentation;
  if (stage === 'pnc') {
    const maternalFields = F.documentationFields('pnc', 'maternal');
    const newbornFields = F.documentationFields('pnc', 'newborn');
    const all = [...newbornFields.filter(f => f.section === 'Newborn assessment'), ...maternalFields];
    documentation = sections(all, section => section === 'Newborn assessment' ? "/data/pnc_subject = 'newborn'"
      : ['Delivery summary', 'Maternal assessment only'].includes(section) ? "/data/pnc_subject = 'maternal'" : undefined);
  } else {
    documentation = sections(F.documentationFields(stage));
  }
  body.push(group('documentation', {}, documentation), followUp);
  if (stage === 'cwc') {
    body.push(group('vaccines', { label: 'Vaccines given or documented today' }, [
      note('vaccines_note', 'Record doses actually given or documented. No schedule or due date is shown.'),
      repeat('dose', { label: 'Dose' }, [
        q('vaccine', { label: 'Vaccine', required: true }),
        q('dose', { label: 'Dose', required: true }),
        q('verification', { label: 'How is this dose known?', required: true, options: Object.entries(F.DOSE_VERIFICATION) }),
        q('date', { label: 'Date given', type: 'date',
          required: `not(selected('${F.UNDATED_DOSE_STATES.join(' ')}', ../verification))`,
          constraint: `/data/inputs/contact/date_of_birth = '' or date(.) >= date(/data/inputs/contact/date_of_birth)`,
          msg: 'Administered dose cannot predate the child birth date.' }),
        q('source', { label: 'Source (card, facility record, caregiver)', required: true }),
        q('provider', { label: 'Provider (optional)' }),
        q('facility', { label: 'Facility (optional)' }),
        q('batch_lot', { label: 'Batch / lot (optional)' }),
        q('dose_key', { calculate: "concat(';', translate(normalize-space(../vaccine), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '|', translate(normalize-space(../dose), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), ';')" }),
        note('duplicate_warning', 'This vaccine and dose are already recorded for this child. Do not record it twice.',
          `contains(${CTX('recorded_dose_keys')}, ../dose_key)`),
      ]),
    ]));
  }
  return { id, title, xml: xform(id, title, [...head, ...body]) };
}

function pregnancyForm() {
  return { id: 'carelink_pregnancy', title: 'Record pregnancy', xml: xform('carelink_pregnancy', 'Record pregnancy', [
    inputs(), ...common(), note('notice', NOTICE), calc('pregnancy_id', 'once(uuid())'),
    q('edd', { label: 'EDD, if recorded (YYYY-MM-DD)', type: 'date', hint: 'Copy the EDD as recorded. CareLink does not calculate it.' }),
  ]) };
}
function deliveryForm() {
  return { id: 'carelink_delivery', title: 'Record delivery', xml: xform('carelink_delivery', 'Record delivery', [
    inputs(), ...common(), note('notice', NOTICE), calc('delivery_id', 'once(uuid())'),
    calc('pregnancy_id', CTX('open_pregnancy_id')),
    q('delivery_date', { label: 'Delivery date', type: 'date', required: true,
      constraint: `${CTX('open_pregnancy_id')} != ''`, msg: 'Record the pregnancy before the delivery.' }),
    note('children_note', 'Register each newborn first (Add individual, care stage CWC, mother selected), then link them here.'),
    group('children', { label: 'Children from this delivery' }, [
      repeat('child', { label: 'Child' }, [
        q('_id', { label: 'Child', required: true, appearance: 'select-contact type-carelink_individual',
          constraint: '. != /data/inputs/contact/_id', msg: 'A child cannot be the mother.' }),
        q('name'),
      ]),
    ]),
    calc('child_ids', "join(' ', /data/children/child/_id)"),
  ]) };
}

// Chained append-only event forms: launched from a task (inputs) or from the profile (contact summary).
function chainForm({ id, title, idField, states, transitions, extraNew = [], extraUpdate = [], stateCalc }) {
  // Task inputs win; otherwise the open record from the contact summary (open_<kind>_id/_event/_state/_due).
  const kind = idField.replace('_id', '');
  const suffix = { [idField]: 'id', expected_event: 'event', current_state: 'state', due_date: 'due' };
  const pick = name => `if(/data/inputs/${idField} != '', /data/inputs/${name}, ${CTX(`open_${kind}_${suffix[name]}`)})`;
  const allowed = Object.entries(transitions).filter(([, next]) => next.length)
    .map(([from, next]) => `(/data/existing_state = '${from}' and selected('${next.join(' ')}', .))`).join(' or ');
  return xform(id, title, [
    inputs([idField, 'expected_event', 'current_state', 'due_date']), ...common(), note('notice', NOTICE),
    calc('existing_id', pick(idField)), calc('existing_event', pick('expected_event')),
    calc('existing_state', pick('current_state')), calc('existing_due', pick('due_date')),
    q('mode', { label: 'What are you recording?', required: true,
      options: [['new', `Start a new ${title.toLowerCase()}`], ['update', `Update the open ${title.toLowerCase()}`]],
      constraint: ". = 'new' or /data/existing_id != ''", msg: 'There is no open record to update.' }),
    note('current', 'Current state: <output value="/data/existing_state"/>', "/data/mode = 'update'", true),
    ...extraNew,
    q('next_state', { label: 'What happened?', relevant: "/data/mode = 'update'", required: true,
      options: states, constraint: allowed || 'false()', msg: 'This change is not allowed from the current state.' }),
    ...extraUpdate,
    calc('new_id', 'once(uuid())'),
    calc(idField, `if(/data/mode = 'new', /data/new_id, /data/existing_id)`),
    calc('expected_event', "if(/data/mode = 'new', '', /data/existing_event)"),
    calc('state', stateCalc),
    q('note', { label: 'Note (optional)' }),
  ]);
}
function appointmentForm() {
  const xml = chainForm({
    id: 'carelink_appointment', title: 'Appointment', idField: 'appointment_id',
    states: [['attended', 'Attended'], ['missed', 'Missed (recorded by you)'], ['rescheduled', 'Rescheduled'], ['cancelled', 'Cancelled']],
    transitions: require('../lib/mch').APPOINTMENT_TRANSITIONS,
    stateCalc: "if(/data/mode = 'new', 'scheduled', /data/next_state)",
    extraUpdate: [
      q('new_due', { label: 'Appointment date', type: 'date', required: true,
        relevant: "/data/mode = 'new' or /data/next_state = 'rescheduled'",
        constraint: "/data/mode = 'new' or . != /data/existing_due", msg: 'A reschedule must change the date.' }),
      calc('due_date', "if(/data/mode = 'new' or /data/next_state = 'rescheduled', /data/new_due, /data/existing_due)"),
      // The signed-in author, enforced by the server, so an attended appointment can be verified against an outreach day.
      calc('actor', '/data/inputs/user/name'),
    ],
  });
  return { id: 'carelink_appointment', title: 'Appointment', xml };
}
function referralForm() {
  const M = require('../lib/mch');
  const labels = { acknowledged: 'Acknowledged by the receiving facility', arrival_confirmed: 'Arrival confirmed',
    outcome_recorded: 'Outcome recorded', closed: 'Closed', cancelled: 'Cancelled', unresolved: 'Marked unresolved' };
  const xml = chainForm({
    id: 'carelink_mch_referral', title: 'Referral', idField: 'referral_id',
    states: Object.entries(labels), transitions: M.REFERRAL_TRANSITIONS,
    stateCalc: "if(/data/mode = 'new', 'created', /data/next_state)",
    extraNew: [
      q('reason', { label: 'Reason for referral', relevant: "/data/mode = 'new'", required: true }),
      // Receiving facility from the facility directory (planning/tolon-district.json); every entry is unverified.
      q('receiving_facility_id', { label: 'Receiving facility', relevant: "/data/mode = 'new'", required: true,
        options: district.facilities.map(f => [f.id, `${f.name} (${f.directory.verification_status} directory entry)`]) }),
      calc('receiving_facility_name', "jr:choice-name(/data/receiving_facility_id, '/data/receiving_facility_id')"),
      note('routing_notice', 'Saving this referral does not alert the receiving facility: it reaches them only after synchronization, and only staff of the facility that serves this person can see it in CHT. Urgent cases follow the established referral and transport procedures now, including direct communication.', "/data/mode = 'new'"),
    ],
    // The signed-in author of every referral event, enforced by the server.
    extraUpdate: [calc('actor', '/data/inputs/user/name')],
  });
  return { id: 'carelink_mch_referral', title: 'Referral', xml };
}
function resolutionForm() {
  return { id: 'carelink_task_resolution', title: 'Resolve task', xml: xform('carelink_task_resolution', 'Resolve task', [
    inputs(['carelink_task_id', 'task_kind', 'carelink_source_id', 'assignment_id']), ...common(), note('notice', NOTICE),
    calc('task_id', '/data/inputs/carelink_task_id'), calc('task_kind', '/data/inputs/task_kind'), calc('source_id', '/data/inputs/carelink_source_id'),
    // Server-enforced author and, when the task was planned for an approved outreach day, that day.
    calc('actor', '/data/inputs/user/name'), calc('assignment_id', '/data/inputs/assignment_id'),
    note('task_missing', 'Open this from a task.', "/data/task_id = ''"),
    q('reason', { label: 'Why is this task resolved?', required: true, constraint: "/data/task_id != '' and string-length(normalize-space(.)) > 0",
      msg: 'A resolution reason is required.' }),
  ]) };
}

const CHO = "user.carelink_role === 'carelink_cho'";
const MCH = "contact.contact_type === 'carelink_individual' && summary.mch";
const PROPS = {
  carelink_pregnancy: { icon: 'carelink-request', expression: `${MCH} && !summary.is_child && ${CHO}` },
  carelink_delivery: { icon: 'carelink-request', expression: `${MCH} && !summary.is_child && !!summary.open_pregnancy_id && ${CHO}` },
  carelink_anc_visit: { icon: 'carelink-outreach', expression: `${MCH} && !summary.is_child && ${CHO}` },
  carelink_pnc_visit: { icon: 'carelink-outreach', expression: `${MCH} && !summary.is_child && ${CHO}` },
  carelink_cwc_visit: { icon: 'carelink-outreach', expression: `${MCH} && summary.is_child && ${CHO}` },
  carelink_appointment: { icon: 'carelink-outreach', expression: `${MCH} && ${CHO}` },
  carelink_mch_referral: { icon: 'carelink-outreach', expression: `${MCH} && ['carelink_cho', 'carelink_coordinator', 'carelink_supervisor'].includes(user.carelink_role)` },
  carelink_task_resolution: { icon: 'carelink-request', expression: 'false' },
};

const forms = [pregnancyForm(), deliveryForm(), ...['anc', 'pnc', 'cwc'].map(visitForm), appointmentForm(), referralForm(), resolutionForm()];
for (const form of forms) {
  fs.writeFileSync(path.join(OUT, form.id + '.xml'), form.xml);
  fs.writeFileSync(path.join(OUT, form.id + '.properties.json'), JSON.stringify({
    title: form.title, icon: PROPS[form.id].icon,
    context: { person: true, place: false, expression: PROPS[form.id].expression, permission: 'can_carelink_mch' },
  }, null, 2) + '\n');
}

/*
  carelink_individual contact forms. The MCH fields are optional, so existing outreach contacts
  (caregivers, community contacts, staff) stay valid. Patient model: models/carelink_models.dart:61-91.
*/
function individualForm(mode) {
  const person = '/data/carelink_individual';
  const MCH_STAGE = `${person}/care_stage = 'anc' or ${person}/care_stage = 'pnc'`;
  return xform(`contact:carelink_individual:${mode}`, mode === 'create' ? 'Add individual' : 'Edit individual', [
    group('inputs', { relevant: '0' }, [group('user', {}, [q('contact_id')])]),
    group('carelink_individual', {}, [
      q('name', { label: 'Individual name', required: true }),
      q('external_id', { label: 'Reference (avoid duplicate records)' }),
      q('parent'), q('type', { value: 'contact' }), q('contact_type', { value: 'carelink_individual' }),
      q('care_stage', { label: 'Maternal and child care (optional)', hint: 'Leave empty for people who are not in ANC, PNC or child welfare care.',
        options: [['anc', 'Pregnant woman (ANC)'], ['pnc', 'Mother after delivery (PNC)'], ['cwc', 'Child (child welfare)']] }),
      q('sex_choice', { label: 'Sex', relevant: `not(${MCH_STAGE})`, options: [['F', 'Girl / female'], ['M', 'Boy / male'], ['not_recorded', 'Not recorded']] }),
      // add_patient_screen.dart: mothers are saved as F.
      calc('sex', `if(${MCH_STAGE}, 'F', ${person}/sex_choice)`),
      q('date_of_birth', { label: 'Date of birth', type: 'date', relevant: `${person}/care_stage != ''` }),
      group('mother', { relevant: `${person}/care_stage = 'cwc'` }, [
        q('_id', { label: 'Mother (if registered)', appearance: 'select-contact type-carelink_individual' }),
        q('name'), q('external_id'),
      ]),
      calc('mother_id', `${person}/mother/_id`),
      calc('mother_external_id', `${person}/mother/external_id`),
      q('caregiver_name', { label: 'Mother or caregiver name', relevant: `${person}/care_stage = 'cwc'` }),
      q('phone', { label: 'Phone (optional)', relevant: `${person}/care_stage != ''` }),
      // assignedChoId: the CHO who registers the person (add_patient_screen.dart:87-92). Kept on edit.
      mode === 'create' ? calc('responsible_worker_id', 'once(/data/inputs/user/contact_id)') : q('responsible_worker_id'),
    ]),
  ], { summary: false });
}
const CONTACT_OUT = path.join(__dirname, '..', 'forms', 'contact');
for (const mode of ['create', 'edit']) {
  fs.writeFileSync(path.join(CONTACT_OUT, `carelink_individual-${mode}.xml`), individualForm(mode));
}
console.log(`Wrote ${forms.length} MCH app forms and the carelink_individual contact forms`);
