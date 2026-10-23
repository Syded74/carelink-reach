'use strict';
/*
  Supply-aware planning in the real CHT application (npm run supply-flow), checked against the server:
   1. generated Tolon children with child welfare appointments due, and a mother with an ANC follow-up;
   2. the coordinator records "Child welfare outreach supplies: unknown" through the Resource readiness form;
   3. a plan schedules no child welfare visit and says the supplies need confirmation; ANC proceeds;
   4. with 1 pack confirmed, at most one child welfare visit is planned and the limit is named;
   5. with 10 packs confirmed, more are planned; the plan's resource allocation is recorded, not deducted;
   6. approval rules still hold: the coordinator cannot approve; the supervisor approves independently.
  Readiness records written here are marked record_origin 'test' and count only for test plans.
  Needs CHT_COUCH_URL, CARELINK_ACCOUNT_PASSWORD and the planning worker. Writes evidence/supply-flow.json.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, login, evidence, releaseTestDays } = require('./browser-helpers');
const { connection } = require('./client');
const mch = require('../lib/mch');
const { isoDay } = require('../lib/schedules');

const BASE = 'http://localhost:5988/';
const TOLON = 'carelink-community-tolon';
const FACILITY = 'carelink-facility-tolon-hospital';
const CHO = 'carelink-person-sabukari';
const MOTORBIKE = 'carelink-facility-tolon-hospital-motorbike-1';
const SUPPLY = 'cwc-outreach-supplies';
const person = u => `carelink-person-${u}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, what, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const v = await fn(); if (v) { return v; } await pause(1500); }
  throw Error('Timed out waiting for ' + what);
}

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = async (username, docs) => (await fetch(`${BASE}medic/_bulk_docs`, { method: 'POST', body: JSON.stringify({ docs }), headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json' } })).json();
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(Boolean);
  const reports = async form => (await all()).filter(d => d.type === 'data_record' && d.form === form);
  const markTest = async ids => {
    const docs = (await couch('/medic/_all_docs?include_docs=true', { method: 'POST', body: JSON.stringify({ keys: ids }) })).rows.map(r => ({ ...r.doc, record_origin: 'test' }));
    await couch('/medic/_bulk_docs', { method: 'POST', body: JSON.stringify({ docs }) });
  };
  const today = isoDay();
  const run = Date.now();
  const tolon = { _id: TOLON, parent: { _id: FACILITY, parent: { _id: 'carelink-district-tolon', parent: { _id: 'carelink-region-northern' } } } };
  const result = { timestamp: new Date().toISOString(), steps: [] };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, ...(detail ? { detail } : {}) }); console.log('✔ ' + step); };
  const browser = await launch();
  try {
    // 1. Generated demand: three children with CWC appointments due today, one mother with an ANC follow-up due.
    const home = { _id: `household-supply-${run}`, type: 'contact', contact_type: 'carelink_household', name: `Iddi Household, House ${run % 900 + 100}`, parent: tolon,
      responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', record_origin: 'test', reported_date: run };
    const lineage = { _id: home._id, parent: tolon };
    const people = [], docs = [];
    for (let i = 0; i < 3; i++) {
      const child = { _id: `child-supply-${run}-${i}`, type: 'contact', contact_type: 'carelink_individual', name: `Child ${i + 1} Iddi ${run % 1000}`, parent: lineage,
        care_stage: 'cwc', sex: i % 2 ? 'F' : 'M', date_of_birth: isoDay(run - (200 + i * 30) * 86400000), responsible_worker_id: CHO, record_origin: 'test', reported_date: run };
      people.push(child);
      docs.push({ _id: `appt-supply-${run}-${i}`, type: 'data_record', form: mch.FORMS.appointment, content_type: 'xml', reported_date: Date.now(), contact: { _id: CHO },
        fields: { patient_id: child._id, appointment_id: `appt-supply-${run}-${i}`, state: 'scheduled', due_date: today, actor: 'sabukari', approval_status: 'pending_clinical_review' } });
      // A first visit recorded, so the child's one open obligation is the appointment.
      docs.push({ _id: `cwc-supply-${run}-${i}`, type: 'data_record', form: mch.FORMS.cwc, content_type: 'xml', reported_date: Date.now() - 86400000, contact: { _id: CHO },
        fields: { patient_id: child._id, missing_vitals: '', danger_signs: '', approval_status: 'pending_clinical_review' } });
    }
    const mother = { _id: `mother-supply-${run}`, type: 'contact', contact_type: 'carelink_individual', name: `Ayishetu Iddi ${run % 1000}`, parent: lineage, care_stage: 'anc', sex: 'F',
      date_of_birth: '1999-01-05', responsible_worker_id: CHO, record_origin: 'test', reported_date: run };
    docs.push({ _id: `anc-supply-${run}`, type: 'data_record', form: mch.FORMS.anc, content_type: 'xml', reported_date: Date.now(), contact: { _id: CHO },
      fields: { patient_id: mother._id, follow_up_date: today, missing_vitals: '', danger_signs: '', approval_status: 'pending_clinical_review' } });
    assert.ok((await asUser('aiddrisu', [home]))[0].ok);
    assert.ok((await asUser('sabukari', [...people, mother, ...docs])).every(r => r.ok));
    pass('1. Generated Tolon demand: three children with child welfare appointments due today and one mother with an ANC follow-up');

    // 2. The coordinator records the CWC supplies as unknown through the CHT form.
    const { page: coord } = await login(browser, 'rseidu');
    await coord.goto(`${BASE}#/contacts/${FACILITY}/report/carelink_resource_status`);
    await coord.waitForSelector('.enketo form .question');
    await coord.click(`input[name="/data/resource_id"][value="${SUPPLY}"]`);
    await coord.click('input[name="/data/status"][value="unknown"]');
    await coord.click('.form-footer .submit');
    await coord.waitForFunction(() => !document.querySelector('.enketo form'), { timeout: 30000 });
    const unknownRec = await eventually(async () => (await reports('carelink_resource_status')).filter(r => r.fields.resource_id === SUPPLY && r.fields.actor === 'rseidu')
      .sort((a, b) => b.reported_date - a.reported_date).find(r => r.reported_date > run), 'the readiness record on the server');
    assert.equal(unknownRec.fields.status, 'unknown');
    await markTest([unknownRec._id]);
    pass('2. Coordinator recorded "Child welfare outreach supplies: unknown" with the Resource readiness form; the server stamped her as author');

    const busy = await releaseTestDays(couch, 'sabukari', CHO, password);
    let day = isoDay(Date.now() + 2 * 86400000);
    while (busy.has(day) || [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) { day = isoDay(Date.parse(day + 'T12:00:00Z') + 86400000); }
    const plan = async n => {
      const req = { _id: `oi-request-supply-${n}-${run}`, type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('rseidu') },
        fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: day, season: 'dry', staff_available: CHO, hours_start: '0800', hours_end: '1600',
          vehicles: MOTORBIKE, use_synthetic_history: 'no', fairness_weight: '0.5', guarantee_communities: TOLON, include_test_records: 'yes' } };
      assert.ok((await asUser('rseidu', [req]))[0].ok);
      return eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${req._id}`), `proposal ${n}`);
    };
    const servedType = (p, vt) => p.fields.schedule.trips.reduce((n, t) => n + ((t.served_by_type || {})[TOLON] || {})[vt] || 0, 0);
    const readiness = async (status, quantity) => {
      const r = await asUser('rseidu', [{ _id: `readiness-${status}-${quantity}-${Date.now()}`, type: 'data_record', form: 'carelink_resource_status', content_type: 'xml', reported_date: Date.now(),
        record_origin: 'test', contact: { _id: person('rseidu') }, fields: { patient_id: FACILITY, actor: 'rseidu', resource_id: SUPPLY, status, quantity, reserved: 0, verified_date: today } }]);
      assert.ok(r[0].ok, JSON.stringify(r));
    };

    // 3. Unknown supplies: no child welfare visit planned; confirmation requested; ANC unaffected.
    const p1 = await plan(1);
    assert.equal(servedType(p1, 'cwc'), 0);
    assert.ok(servedType(p1, 'anc') >= 1, 'ANC should proceed independently');
    assert.ok(p1.fields.explanation.needs_confirmation.some(x => x.includes('Child welfare outreach supplies')));
    assert.ok((p1.fields.unserved_by_type[TOLON] || {}).cwc >= 3);
    pass('3. With the supplies unknown, the plan schedules no child welfare visit, asks for confirmation, and still plans the ANC follow-up', { explanation: p1.fields.explanation.needs_confirmation });

    // 4. One pack confirmed.
    await readiness('confirmed', 1);
    const p2 = await plan(2);
    assert.equal(servedType(p2, 'cwc'), 1);
    assert.equal(p2.fields.resource_plan[SUPPLY].planned, 1);
    assert.ok(Object.values(p2.fields.explanation.communities).some(x => x.includes('limited by Child welfare outreach supplies')));
    pass('4. With 1 pack confirmed, exactly one child welfare visit is planned and the plan names the limiting supply', { resource_plan: p2.fields.resource_plan[SUPPLY] });

    // 5. Ten packs confirmed.
    await readiness('confirmed', 10);
    const p3 = await plan(3);
    assert.ok(servedType(p3, 'cwc') > servedType(p2, 'cwc'));
    const stockAfter = (await reports('carelink_resource_status')).filter(r => r.fields.resource_id === SUPPLY).sort((a, b) => b.reported_date - a.reported_date)[0];
    assert.equal(Number(stockAfter.fields.quantity), 10, 'approving or planning never deducts recorded stock');
    pass(`5. With 10 packs confirmed, ${servedType(p3, 'cwc')} child welfare visits are planned; the plan records an allocation and the recorded stock is unchanged`);

    // 6. Approval rules still hold.
    const ack = async id => eventually(async () => (await reports('carelink_oi_ack')).find(a => a.fields.event_id === id), `acknowledgement of ${id}`);
    const decide = async (user, action, expected) => (await asUser(user, [{ _id: `${action}-supply-${Date.now()}`, type: 'data_record', form: 'carelink_oi_review', content_type: 'xml',
      reported_date: Date.now(), contact: { _id: person(user) }, fields: { patient_id: FACILITY, proposal_id: p3._id, action, actor: user, expected_event: expected, notes: 'Supply check.' } }]))[0];
    const s = await decide('rseidu', 'submit', p3._id); assert.equal((await ack(s.id)).fields.result, 'accepted');
    const r = await decide('mtahiru', 'review', s.id); assert.equal((await ack(r.id)).fields.result, 'accepted');
    const self = await decide('rseidu', 'approve', r.id);
    assert.ok(self.error || (await ack(self.id)).fields.result !== 'accepted', 'the coordinator approved their own plan');
    const a = await decide('mtahiru', 'approve', r.id); assert.equal((await ack(a.id)).fields.result, 'accepted');
    const assignment = await eventually(async () => (await reports('carelink_oi_assignment')).find(x => x.fields.proposal_id === p3._id && x.fields.patient_id === TOLON), 'the assignment');
    assert.ok((assignment.fields.served_by_type || {}).cwc >= 1);
    pass('6. The coordinator could not approve her own plan; the supervisor approved it and the CHO assignment carries the planned visit types');
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error('✖ ' + e.message);
    const pages = (await Promise.all(browser.browserContexts().map(c => c.pages()))).flat();
    await Promise.all(pages.map((p, i) => p.screenshot({ path: path.join(evidence, `supply-failure-${i + 1}.png`), fullPage: true }).catch(() => {})));
    process.exitCode = 1;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(evidence, 'supply-flow.json'), JSON.stringify(result, null, 2) + '\n');
  }
})();
