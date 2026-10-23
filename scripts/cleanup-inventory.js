'use strict';
/*
  Read-only cleanup preview (npm run cleanup-inventory). Changes nothing.
  Classifies every record in the medic database as:
   - generated: provably from an automated run (record_origin 'test', a test plan, or a record about a test contact,
     or a plan record that belongs to a test plan);
   - uncertain: looks generated (id pattern) but carries no marker — preserved, never proposed for removal;
   - operational: everything else, including configuration, places, user contacts and records without markers.
  Names are never used as evidence of test origin. Writes evidence/cleanup-inventory.json.
*/
const fs = require('node:fs');
const path = require('node:path');
const { connection } = require('./client');
const { evidence } = require('./browser-helpers');

const PLAN_FORMS = ['carelink_oi_proposal', 'carelink_oi_review', 'carelink_oi_ack', 'carelink_oi_assignment', 'carelink_oi_day_plan',
  'carelink_oi_request_link', 'carelink_oi_followup_link', 'carelink_oi_outreach_day'];
const LOOKS_GENERATED = /^(mother|child|household)-(supply|walk|android|feedback|mch|outreach)?-?\d{10,}|^(appt|anc|cwc|pnc)-supply-|^readiness-|^release-|^oi-request-(test|supply|walk)-/;

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const docs = (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(d => d && !d._id.startsWith('_design/'));
  const byId = new Map(docs.map(d => [d._id, d]));
  const contacts = docs.filter(d => d.type === 'contact' || d.type === 'person' || d.type === 'clinic');
  const testContacts = new Set(contacts.filter(c => c.record_origin === 'test').map(c => c._id));
  // Contacts under a test household are generated too.
  contacts.forEach(c => { for (let p = c.parent; p; p = p.parent) { if (testContacts.has(p._id)) { testContacts.add(c._id); break; } } });
  const reports = docs.filter(d => d.type === 'data_record');
  const about = r => r.fields && (r.fields.patient_id || r.fields.patient_uuid || r.fields.place_id);
  const testPlans = new Set(reports.filter(r => r.form === 'carelink_oi_proposal' && r.fields.includes_test_records).map(r => r._id));
  const testRequests = new Set(reports.filter(r => r.form === 'carelink_oi_request' && r.fields.include_test_records === 'yes').map(r => r._id));
  const testAssignments = new Set(reports.filter(r => r.form === 'carelink_oi_assignment' && testPlans.has(r.fields.proposal_id)).map(r => r._id));
  const generatedReport = r => r.record_origin === 'test' || testContacts.has(about(r)) || testPlans.has(r._id) || testRequests.has(r._id) ||
    (r.fields && (testPlans.has(r.fields.proposal_id) || testAssignments.has(r.fields.assignment_id)));

  const out = { generated: {}, uncertain: {}, operational: {}, tasks: { generated: 0, other: 0 }, dependencies: {} };
  const add = (bucket, key) => { out[bucket][key] = (out[bucket][key] || 0) + 1; };
  for (const d of docs) {
    if (d.type === 'task') {
      const owner = d.owner || (d.emission && d.emission.contact && d.emission.contact._id);
      const requester = d.requester || (d.emission && d.emission.forId);
      out.tasks[testContacts.has(owner) || testContacts.has(requester) ? 'generated' : 'other'] += 1;
      continue;
    }
    const key = d.type === 'data_record' ? `report:${d.form}` : d.type === 'contact' ? `contact:${d.contact_type}` : d.type || '(config)';
    const generated = d.type === 'data_record' ? generatedReport(d) : testContacts.has(d._id);
    if (generated) { add('generated', key); } else if (LOOKS_GENERATED.test(d._id)) { add('uncertain', key); } else { add('operational', key); }
  }
  // Dependencies: generated records that other (non-generated) records point at would leave dangling references.
  const generatedIds = new Set(docs.filter(d => (d.type === 'data_record' && generatedReport(d)) || testContacts.has(d._id)).map(d => d._id));
  const dangling = reports.filter(r => !generatedIds.has(r._id) && r.fields && ['patient_id', 'request_id', 'proposal_id', 'assignment_id', 'referral_id']
    .some(k => generatedIds.has(r.fields[k])));
  out.dependencies = {
    generated_total: generatedIds.size,
    operational_records_referencing_generated: dangling.length,
    operational_records_referencing_generated_by_form: dangling.reduce((m, r) => ({ ...m, [r.form]: (m[r.form] || 0) + 1 }), {}),
    contacts_with_children: [...testContacts].filter(id => contacts.some(c => c.parent && c.parent._id === id)).length,
  };
  out.summary = {
    total_documents: docs.length,
    generated: Object.values(out.generated).reduce((a, b) => a + b, 0),
    uncertain_preserved: Object.values(out.uncertain).reduce((a, b) => a + b, 0),
    operational: Object.values(out.operational).reduce((a, b) => a + b, 0),
    task_documents: out.tasks,
    note: 'Read-only preview. Nothing was changed. Uncertain records are preserved. Operational indicators already exclude generated records (lib/test-records.js), so removing them would not change those counts; it would remove test tasks and test plans from task lists and the planning tab.',
  };
  out.timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(evidence, 'cleanup-inventory.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.summary, null, 1));
  console.log('generated by type:', JSON.stringify(out.generated));
  console.log('uncertain (preserved):', JSON.stringify(out.uncertain));
  console.log('dependencies:', JSON.stringify(out.dependencies));
})().catch(e => { console.error(e.message); process.exit(1); });
