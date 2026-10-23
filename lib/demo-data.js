'use strict';
function generate(now = Date.now()) {
  const docs = [];
  const index = new Map();
  const make = (id, type, name, parent, extra = {}) => {
    const doc = { _id: 'carelink-demo-' + id, type: 'contact', contact_type: 'carelink_' + type, name: 'DEMO · ' + name,
      external_id: 'CL-DEMO-' + id.toUpperCase(), reported_date: now, demo: true, ...extra };
    if (parent) { doc.parent = minify(index.get(parent)); }
    docs.push(doc); index.set(id, doc); return doc;
  };
  function minify(doc) { return doc && { _id: doc._id, parent: doc.parent }; }
  make('region', 'region', 'Northern Example Region');
  make('district', 'district', 'Nawuni Example District', 'region');
  make('facility', 'facility', 'Hope Partner Facility', 'district');
  ['Baobab Grove', 'Shea Valley', 'River Plain'].forEach((name, i) => make('community-' + (i + 1), 'community', name, 'facility'));
  const households = [];
  for (let i = 1; i <= 10; i++) {
    const community = i <= 4 ? 1 : i <= 7 ? 2 : 3;
    const worker = community === 3 ? 2 : 1;
    const contact = community;
    const doc = make('household-' + i, 'household', 'Household ' + String(i).padStart(2, '0'), 'community-' + community, {
      responsible_worker_id: 'carelink-demo-cho-' + worker, responsible_worker_name: 'DEMO CHO ' + (worker === 1 ? 'A' : 'B'),
      community_contact_id: 'carelink-demo-contact-' + contact, partner_facility_id: 'carelink-demo-facility',
    });
    households.push(doc);
    make('person-' + i, 'individual', 'Caregiver ' + String(i).padStart(2, '0'), 'household-' + i, { role: 'caregiver' });
  }
  const contacts = [1,2,3].map(i => make('contact-' + i, 'individual', 'Community Contact ' + i, 'community-' + i, { carelink_role: 'carelink_community' }));
  make('cho-1', 'individual', 'CHO A', 'community-1', { carelink_role: 'carelink_cho' });
  make('cho-2', 'individual', 'CHO B', 'community-3', { carelink_role: 'carelink_cho' });
  make('coordinator', 'individual', 'Facility Coordinator', 'facility', { carelink_role: 'carelink_coordinator' });
  make('supervisor', 'individual', 'Facility Supervisor', 'facility', { carelink_role: 'carelink_supervisor' });
  // A second fictional reviewer, so concurrent plan reviews (conflicts) can be demonstrated.
  make('supervisor-2', 'individual', 'Facility Supervisor 2', 'facility', { carelink_role: 'carelink_supervisor' });
  const report = (id, form, household, submitter, fields, offset = 0) => {
    const doc = { _id: 'carelink-demo-' + id, type: 'data_record', form, content_type: 'xml', reported_date: now + offset,
      contact: minify(index.get(submitter)), from: 'carelink-demo', demo: true,
      fields: { patient_id: household._id, household_name: household.name, community_name: index.get('community-' + (household.parent._id.endsWith('1') ? 1 : household.parent._id.endsWith('2') ? 2 : 3)).name,
        demo: 'true', created_by: index.get(submitter)._id, ...fields } };
    docs.push(doc); return doc;
  };
  [1,2,5,8,9,3,6,10].forEach((h, i) => {
    const household = households[h - 1];
    const submitter = household.community_contact_id.replace('carelink-demo-', '');
    const request = report('request-' + (i + 1), 'carelink_request', household, submitter, {
      consent: 'yes', followup_type: i % 2 ? 'followup' : 'visit', contact_method: 'community_contact',
      access_barrier: i === 0 ? 'transport_unavailable' : i === 1 ? 'transport_cost' : 'none',
    });
    if (i < 5) {
      let previous = request._id;
      ['accepted','assigned','scheduled'].forEach((status, n) => {
        const doc = report(`coordination-${i + 1}-${status}`, 'carelink_coordination', household, 'coordinator', {
          request_id: request._id, expected_event: previous, current_status: n === 0 ? 'awaiting_assignment' : n === 1 ? 'accepted' : 'assigned',
          status, assigned_worker_id: household.responsible_worker_id, scheduled_date: new Date(now + (i < 3 ? 0 : 86400000)).toISOString().slice(0,10), outcome_note: 'Fictional coordination event for demonstration.',
        }, n + 1);
        previous = doc._id;
      });
      if (i < 3) {
        report('visit-' + (i + 1), 'carelink_visit', household, household.responsible_worker_id.replace('carelink-demo-', ''), {
          request_id: request._id, expected_event: previous, current_status: 'scheduled', status: 'completed',
          assigned_worker_id: household.responsible_worker_id, visit_date: new Date(now).toISOString().slice(0,10), visit_type: 'outreach_contact',
          followup_required: 'no', referral_recorded: 'no', outcome_note: 'Fictional visit occurred; no clinical assessment or real care claimed.',
        }, 4);
      }
    }
  });
  mchFamily({ now, make, minify, index, docs });
  const users = [
    ...contacts.map((c,i) => ({ username: 'carelink_contact_' + (i+1), roles: ['carelink_community'], place: 'carelink-demo-community-' + (i+1), contact: c._id })),
    { username: 'carelink_cho_a', roles: ['carelink_cho'], place: ['carelink-demo-community-1','carelink-demo-community-2'], contact: 'carelink-demo-cho-1' },
    { username: 'carelink_cho_b', roles: ['carelink_cho'], place: 'carelink-demo-community-3', contact: 'carelink-demo-cho-2' },
    ...['coordinator','supervisor'].map(role => ({ username: 'carelink_' + role, roles: ['carelink_' + role], place: 'carelink-demo-facility', contact: 'carelink-demo-' + role })),
    { username: 'carelink_supervisor_2', roles: ['carelink_supervisor'], place: 'carelink-demo-facility', contact: 'carelink-demo-supervisor-2' },
    { username: 'carelink_admin', roles: ['carelink_admin'], place: 'carelink-demo-facility' },
  ];
  return { docs, users };
}
/*
  One fictional family through ANC → delivery → PNC → CWC, assigned to CHO A. Between them the records
  raise every Flutter task kind: a resolved and an open follow-up, an open referral, a missed
  appointment, a future appointment (not yet due) and a missing assessment on the child's latest visit.
*/
function mchFamily({ now, make, minify, index, docs }) {
  const DAY = 86400000;
  const day = offset => new Date(now + offset * DAY).toISOString().slice(0, 10);
  const cho = 'carelink-demo-cho-1';
  const mother = make('mch-mother', 'individual', 'Efua Asante (fictional)', 'household-1', {
    care_stage: 'anc', sex: 'F', date_of_birth: '1999-04-12', responsible_worker_id: cho, phone: '000 000 0000',
  });
  const child = make('mch-child', 'individual', 'Kojo Asante (fictional)', 'household-1', {
    care_stage: 'cwc', sex: 'M', date_of_birth: day(-21), responsible_worker_id: cho, mother_id: mother._id,
    mother: { _id: mother._id, name: mother.name, external_id: mother.external_id }, mother_external_id: mother.external_id,
    caregiver_name: mother.name,
  });
  const report = (id, form, subject, offset, fields, submitter = 'cho-1') => {
    const doc = { _id: 'carelink-demo-' + id, type: 'data_record', form, content_type: 'xml', reported_date: now + offset * DAY,
      contact: minify(index.get(submitter)), from: 'carelink-demo', demo: true,
      fields: { patient_id: subject._id, patient_name: subject.name, created_by: index.get(submitter)._id, demo: 'true',
        approval_status: 'pending_clinical_review', ...fields } };
    docs.push(doc);
    return doc;
  };
  const visit = (id, stage, subject, offset, fields) => report(id, 'carelink_' + stage + '_visit', subject, offset,
    { stage, visit_date: day(offset), missing_vitals: '', quality_issues: '', danger_signs: '', follow_up_date: '', ...fields });

  report('mch-pregnancy', 'carelink_pregnancy', mother, -200, { pregnancy_id: 'demo-pregnancy-1', edd: day(-20) });
  visit('mch-anc-1', 'anc', mother, -150, { pregnancy_id: 'demo-pregnancy-1', follow_up_date: day(-120),
    vitals: { systolic_bp: 112, diastolic_bp: 72, weight_kg: 61.5 } });
  report('mch-resolution-1', 'carelink_task_resolution', mother, -119, { task_id: `${mother._id}:scheduledFollowUp:carelink-demo-mch-anc-1`,
    task_kind: 'scheduledFollowUp', source_id: 'carelink-demo-mch-anc-1', reason: 'Fictional: follow-up visit completed at the facility.' });
  visit('mch-anc-2', 'anc', mother, -60, { pregnancy_id: 'demo-pregnancy-1', follow_up_date: day(-30),
    missing_vitals: 'haemoglobin_g_dL', danger_signs: 'bleeding_reported' });
  const referral = report('mch-referral-1', 'carelink_mch_referral', mother, -60, { referral_id: 'demo-referral-1', expected_event: '',
    state: 'created', reason: 'Fictional: bleeding reported at ANC visit.' });
  report('mch-referral-2', 'carelink_mch_referral', mother, -59, { referral_id: 'demo-referral-1', expected_event: referral._id,
    state: 'acknowledged' }, 'coordinator');
  report('mch-delivery', 'carelink_delivery', mother, -21, { delivery_id: 'demo-delivery-1', pregnancy_id: 'demo-pregnancy-1',
    delivery_date: day(-21), child_ids: child._id });
  visit('mch-pnc-mother', 'pnc', mother, -20, { pnc_subject: 'maternal', delivery_id: 'demo-delivery-1', delivery_date: day(-21) });
  visit('mch-pnc-newborn', 'pnc', child, -19, { pnc_subject: 'newborn', mother_id: mother._id, delivery_id: 'demo-delivery-1',
    delivery_date: day(-21) });
  const missed = report('mch-appointment-1', 'carelink_appointment', mother, -10, { appointment_id: 'demo-appointment-1',
    expected_event: '', state: 'scheduled', due_date: day(-3) });
  report('mch-appointment-1-missed', 'carelink_appointment', mother, -2, { appointment_id: 'demo-appointment-1',
    expected_event: missed._id, state: 'missed', due_date: day(-3) });
  report('mch-appointment-2', 'carelink_appointment', child, -1, { appointment_id: 'demo-appointment-2', expected_event: '',
    state: 'scheduled', due_date: day(7) });
  visit('mch-cwc-1', 'cwc', child, -1, { missing_vitals: 'muac_mm', vitals: { weight_kg: 3.9, length_height_cm: 53 },
    vaccines: { dose: [{ vaccine: 'BCG', dose: '1', date: day(-21), verification: 'verified', source: 'Fictional child health record' }] } });
}

module.exports = { generate };
