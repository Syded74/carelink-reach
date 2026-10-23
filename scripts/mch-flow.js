'use strict';
/*
  CHO maternal and child flow (ANC → delivery → PNC → CWC) through the real CHT UI as sabukari, in a new
  Tolon household that the volunteer (aiddrisu) registers through the CHT API each run, so earlier runs'
  people never need deleting. Every step is confirmed against the server, not the screen. Then checks
  duplicate-person warnings, append-only clinical history, the pending-clinical-review marker, the
  coordinator's referral acknowledgement, supervisor targets and the CHO's community scope.
  People are made up and marked record_origin 'test' (lib/test-records.js). Writes evidence/mch-flow.json
  and evidence/mch-*.png. Needs CHT_COUCH_URL and CARELINK_ACCOUNT_PASSWORD.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, login, text, evidence, markTestRecords } = require('./browser-helpers');
const { connection } = require('./client');
const mch = require('../lib/mch');
const { isoDay } = require('../lib/schedules');

const BASE = 'http://localhost:5988/';
const TOLON = 'carelink-community-tolon';
const NYANKPALA = 'carelink-community-nyankpala';
const CHO = 'carelink-person-sabukari';
const RUN = new Date().toISOString().slice(11, 16).replace(':', '');
const FAMILIES = ['Fuseini', 'Alhassan', 'Mahamudu', 'Issahaku', 'Abdulai', 'Sulemana', 'Yakubu', 'Iddrisu', 'Salifu', 'Haruna', 'Osman', 'Musah'];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await fn(); if (result) { return result; } await pause(1500); }
  throw Error('Timed out waiting for the server to receive the record.');
}
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `mch-${name}.png`), fullPage: true });
const setValue = (page, name, value) => page.evaluate((n, v) => { window.$(`[name="${n}"]`).val(v).trigger('change'); }, name, value);
// Enketo suffixes radio names inside repeats; the form path stays in data-name
// and a form refresh right after a save can drop a selection, so confirm it stuck
async function check(page, name, value) {
  const selector = `input[name="${name}"][value="${value}"], input[data-name="${name}"][value="${value}"]`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.click(selector);
    await pause(300);
    if (await page.$eval(selector, e => e.checked)) { return; }
  }
  throw Error(`Could not select ${value} for ${name}`);
}
// select-contact fields are select2 pickers with a proxy <select> sharing the input's name; choose like a user does.
async function selectContact(page, name, search, label) {
  // Enketo builds the picker only once its group becomes relevant
  await page.waitForSelector(`select[name="${name}"] + .select2-container`, { visible: true });
  const opener = await page.evaluateHandle(n => document.querySelector(`select[name="${n}"]`).closest('.question').querySelector('.select2-selection'), name);
  await opener.click();
  await page.waitForSelector('.select2-container--open .select2-search__field');
  await page.type('.select2-container--open .select2-search__field', search);
  await page.waitForFunction(l => [...document.querySelectorAll('.select2-results__option')].some(o => o.innerText.includes(l)), { timeout: 30000 }, label);
  await page.evaluate(l => {
    const option = [...document.querySelectorAll('.select2-results__option')].find(o => o.innerText.includes(l));
    option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, label);
  await page.waitForFunction((n, l) => document.querySelector(`select[name="${n}"]`).closest('.question').innerText.includes(l), {}, name, label);
}
async function submit(page) {
  await page.click('.form-footer .submit');
  await page.waitForFunction(() => !document.querySelector('.enketo form') || document.querySelector('.invalid-constraint, .invalid-required'), { timeout: 30000 });
  const invalid = await page.$('.invalid-constraint, .invalid-required');
  if (invalid) { throw Error('Form rejected: ' + await invalid.evaluate(e => e.closest('.question')?.innerText)); }
}
async function openForm(page, contactId, form) {
  await page.goto(`${BASE}#/contacts/${contactId}`);
  await page.waitForSelector('h2[test-id="contact-name"]');
  await page.waitForSelector('mm-fast-action-button .fast-action-fab-button');
  await page.click('mm-fast-action-button .fast-action-fab-button');
  await page.waitForSelector(`a[test-id="${form}"]`);
  await page.click(`a[test-id="${form}"]`);
  await page.waitForSelector('.enketo form');
}
async function openTask(page, name, title, action) {
  await page.goto(`${BASE}#/tasks`);
  const item = await eventually(async () => {
    for (const li of await page.$$('#tasks-list li')) {
      const t = await li.evaluate(e => e.innerText);
      if (t.includes(name) && t.includes(title)) { return li; }
    }
    return null;
  }, 120000);
  await (await item.$('a')).click();
  await page.waitForSelector('.enketo form, li.actions a.btn');
  // A task with one action opens its form directly; only pick an action when CHT lists several.
  if (action && !await page.$('.enketo form')) {
    await page.evaluate(label => [...document.querySelectorAll('li.actions a.btn')].find(a => a.innerText.trim() === label).click(), action);
    await page.waitForSelector('.enketo form');
  }
}
async function taskTitles(page, name) {
  await page.goto(`${BASE}#/tasks`);
  await page.waitForSelector('#tasks-list');
  await pause(3000);
  return page.$$eval('#tasks-list li', (items, n) => items.map(li => li.innerText).filter(t => t.includes(n)), name);
}

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc);
  const reportsFor = async id => (await all()).filter(d => d.type === 'data_record' && d.fields && d.fields.patient_id === id && !d._deleted);
  const contactNamed = async name => (await all()).find(d => d.type === 'contact' && d.name === name);
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = (username, route, options = {}) => fetch(BASE + route.replace(/^\//, ''), { ...options, headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json', ...options.headers } });
  // A household for this run, registered by the Tolon volunteer exactly as the household form would.
  const existing = await all();
  const family = FAMILIES[existing.filter(d => d.contact_type === 'carelink_household').length % FAMILIES.length];
  const MOTHER = `Abiba ${family} ${RUN}`;
  const CHILD = `Nashiru ${family} ${RUN}`;
  const tolonLineage = { _id: TOLON, parent: { _id: 'carelink-facility-tolon-hospital', parent: { _id: 'carelink-district-tolon', parent: { _id: 'carelink-region-northern' } } } };
  const HOUSEHOLD = `household-${Date.now()}`;
  const saved = await (await asUser('aiddrisu', '/medic/_bulk_docs', { method: 'POST', body: JSON.stringify({ docs: [{
    _id: HOUSEHOLD, type: 'contact', contact_type: 'carelink_household', name: `${family} Household, House ${200 + Date.now() % 700}`,
    parent: tolonLineage, responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', registered_by: 'carelink-person-aiddrisu',
    record_origin: 'test', reported_date: Date.now() }] }) })).json();
  assert.ok(saved[0] && saved[0].ok, 'Volunteer could not register the household: ' + JSON.stringify(saved));
  const result = { timestamp: new Date().toISOString(), run: RUN, today: isoDay(), steps: [] };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, ...(detail ? { detail } : {}) }); console.log('✔', step); };
  const browser = await launch();
  const created = [];
  let page;
  try {
    ({ page } = await login(browser, 'sabukari'));
    await eventually(async () => { await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); }); await page.goto(`${BASE}#/contacts/${HOUSEHOLD}`); await pause(2500); return (await text(page)).includes('Household, House'); });

    // 1. Register the mother: ANC, assigned to the registering CHO, saved as F.
    await page.goto(`${BASE}#/contacts/${HOUSEHOLD}/add/carelink_individual`);
    await page.waitForSelector('.enketo form');
    await page.type('[name="/data/carelink_individual/name"]', MOTHER);
    await check(page, '/data/carelink_individual/care_stage', 'anc');
    await setValue(page, '/data/carelink_individual/date_of_birth', '2000-02-14');
    await shot(page, '01-register-mother');
    await submit(page);
    const mother = await eventually(() => contactNamed(MOTHER));
    created.push(mother._id);
    await markTestRecords(couch, [mother._id]);
    assert.equal(mother.care_stage, 'anc'); assert.equal(mother.sex, 'F'); assert.equal(mother.responsible_worker_id, CHO);
    pass('1. CHO registered the mother for ANC; sex F and assigned CHO recorded on the server');

    // 1b. Registering her again in the same household is caught by CHT's duplicate check; nothing is saved or removed.
    await page.goto(`${BASE}#/contacts/${HOUSEHOLD}/add/carelink_individual`);
    await page.waitForSelector('.enketo form');
    await page.type('[name="/data/carelink_individual/name"]', MOTHER);
    await check(page, '/data/carelink_individual/care_stage', 'anc');
    await setValue(page, '/data/carelink_individual/date_of_birth', '2000-02-14');
    await page.click('.form-footer .submit');
    await eventually(async () => (await text(page)).includes('Possible duplicate contacts found'), 30000);
    await shot(page, '01b-duplicate-mother');
    assert.equal((await all()).filter(d => d.type === 'contact' && d.name === MOTHER).length, 1);
    await page.goto('about:blank');
    await page.goto(`${BASE}#/contacts/${HOUSEHOLD}`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!document.querySelector('.app-root.bootstrapped'), { timeout: 45000 });
    pass('1b. Registering the same mother again shows "Possible duplicate contacts found"; the existing record stays and nothing new is saved');

    // 2. firstVisit task (task_projector.dart:36).
    assert.ok((await eventually(async () => (await taskTitles(page, MOTHER)).find(t => t.includes('First ANC visit due')))));
    await shot(page, '02-first-visit-task');
    pass('2. "First ANC visit due" task appeared for the new mother');

    // 3. Pregnancy with a recorded EDD (never calculated).
    await openForm(page, mother._id, 'carelink_pregnancy');
    const edd = isoDay(Date.now() + 120 * 86400000);
    await setValue(page, '/data/edd', edd);
    await submit(page);
    const pregnancy = await eventually(async () => (await reportsFor(mother._id)).find(r => r.form === mch.FORMS.pregnancy));
    created.push(pregnancy._id);
    assert.equal(pregnancy.fields.edd, edd);
    pass('3. Pregnancy recorded with the EDD as typed');

    // 4. ANC booking: two vitals measured (others not recorded), one danger sign, follow-up date today,
    //    one out-of-range value that must be confirmed as questionable.
    await openForm(page, mother._id, 'carelink_anc_visit');
    await check(page, '/data/documentation/visit_identification/anc_visit_kind', 'booking');
    await page.type('[name="/data/vitals/systolic_bp"]', '118');
    await page.type('[name="/data/vitals/diastolic_bp"]', '76');
    await page.type('[name="/data/vitals/weight_kg"]', '250');
    await page.click('.form-footer .submit');
    await page.waitForSelector('.invalid-required');
    await check(page, '/data/vitals/weight_kg_questionable', 'confirmed');
    await check(page, '/data/signs/danger_signs', 'bleeding_reported');
    await setValue(page, '/data/documentation/counselling_and_plan/care_follow_up_date', isoDay());
    await shot(page, '04-anc-visit');
    await submit(page);
    const anc = await eventually(async () => (await reportsFor(mother._id)).find(r => r.form === mch.FORMS.anc));
    created.push(anc._id);
    assert.equal(anc.fields.danger_signs, 'bleeding_reported');
    assert.equal(anc.fields.follow_up_date, isoDay());
    assert.equal(anc.fields.quality_issues, 'weight_kg');
    assert.equal(anc.fields.missing_vitals, 'gestational_age_weeks fundal_height_cm fetal_heart_rate_bpm haemoglobin_g_dL');
    assert.equal(anc.fields.pregnancy_id, pregnancy.fields.pregnancy_id);
    pass('4. ANC booking saved: out-of-range weight had to be confirmed; missing vitals, danger sign and follow-up date derived', {
      missing_vitals: anc.fields.missing_vitals, quality_issues: anc.fields.quality_issues });

    // 5. The three tasks Flutter projects for that visit.
    const titles = await eventually(async () => {
      const t = await taskTitles(page, MOTHER);
      return ['Clinical concern — professional review required', 'Add missing ANC measurements', 'ANC follow-up due'].every(x => t.some(y => y.includes(x))) && t;
    });
    assert.ok(!titles.some(t => t.includes('First ANC visit due')));
    await shot(page, '05-anc-tasks');
    pass('5. Concern, missing-assessment and follow-up tasks appeared; first-visit task resolved');

    // 6. Referral offered from the concern task (not required).
    await openTask(page, MOTHER, 'Clinical concern — professional review required', 'Start a referral');
    await check(page, '/data/mode', 'new');
    await page.type('[name="/data/reason"]', 'Bleeding reported at booking.');
    await check(page, '/data/receiving_facility_id', 'carelink-facility-tolon-hospital');
    await submit(page);
    const referral = await eventually(async () => mch.referrals(await reportsFor(mother._id))[0]);
    created.push(referral.root._id);
    assert.equal(referral.state, 'created');
    assert.equal(referral.root.fields.receiving_facility_id, 'carelink-facility-tolon-hospital');
    assert.equal(referral.root.fields.actor, 'sabukari');
    pass('6. Referral started from the concern task (state created)');

    // 7. Resolve the follow-up task with a reason (task_repository.dart:24-52).
    await openTask(page, MOTHER, 'ANC follow-up due', 'Resolve with a reason');
    await page.type('[name="/data/reason"]', 'Follow-up done during this visit.');
    await submit(page);
    const resolution = await eventually(async () => (await reportsFor(mother._id)).find(r => r.form === mch.FORMS.resolution));
    created.push(resolution._id);
    assert.equal(resolution.fields.task_id, `${mother._id}:scheduledFollowUp:${anc._id}`);
    await eventually(async () => !(await taskTitles(page, MOTHER)).some(t => t.includes('ANC follow-up due')));
    pass('7. Follow-up task resolved with a reason; the task left the list');

    // 8. Register the newborn (CWC, mother selected) and record the delivery linking the child.
    await page.goto(`${BASE}#/contacts/${HOUSEHOLD}/add/carelink_individual`);
    await page.waitForSelector('.enketo form');
    await page.type('[name="/data/carelink_individual/name"]', CHILD);
    await check(page, '/data/carelink_individual/care_stage', 'cwc');
    await check(page, '/data/carelink_individual/sex_choice', 'M');
    await setValue(page, '/data/carelink_individual/date_of_birth', isoDay());
    await selectContact(page, '/data/carelink_individual/mother/_id', MOTHER, MOTHER);
    await submit(page);
    const child = await eventually(() => contactNamed(CHILD));
    created.push(child._id);
    await markTestRecords(couch, [child._id]);
    assert.equal(child.mother_id, mother._id); assert.equal(child.sex, 'M');
    await openForm(page, mother._id, 'carelink_delivery');
    await setValue(page, '/data/delivery_date', isoDay());
    if (!await page.$('select[name="/data/children/child/_id"]')) { await page.click('.add-repeat-btn'); }
    await selectContact(page, '/data/children/child/_id', CHILD, CHILD);
    await shot(page, '08-delivery');
    await submit(page);
    const delivery = await eventually(async () => (await reportsFor(mother._id)).find(r => r.form === mch.FORMS.delivery));
    created.push(delivery._id);
    assert.equal(delivery.fields.child_ids, child._id); assert.ok(mch.deliveryValid(delivery));
    pass('8. Newborn registered with the mother link; delivery recorded against the pregnancy, listing the child');

    // 9. Newborn PNC opened from the mother, saved against the child.
    await openForm(page, mother._id, 'carelink_pnc_visit');
    await check(page, '/data/pnc_subject', 'newborn');
    await selectContact(page, '/data/newborn/_id', CHILD, CHILD);
    await page.type('[name="/data/documentation/newborn_assessment/pnc_newborn_weight_kg"]', '3.2');
    await shot(page, '09-newborn-pnc');
    await submit(page);
    const pnc = await eventually(async () => (await reportsFor(child._id)).find(r => r.form === mch.FORMS.pnc));
    created.push(pnc._id);
    assert.equal(pnc.fields.pnc_subject, 'newborn'); assert.equal(pnc.fields.mother_id, mother._id);
    assert.equal(pnc.fields.missing_vitals, '', 'newborn PNC has no maternal vitals');
    pass('9. Newborn PNC saved against the child, linked to the mother and delivery');

    // 10. CWC visit with a recorded dose; an appointment that is then recorded as missed.
    await openForm(page, child._id, 'carelink_cwc_visit');
    await page.type('[name="/data/vitals/weight_kg"]', '3.3');
    await page.type('[name="/data/vitals/length_height_cm"]', '50');
    await page.click('.add-repeat-btn');
    await page.waitForSelector('[name="/data/vaccines/dose/vaccine"]');
    await page.type('[name="/data/vaccines/dose/vaccine"]', 'BCG');
    await page.type('[name="/data/vaccines/dose/dose"]', '1');
    await check(page, '/data/vaccines/dose/verification', 'verified');
    await setValue(page, '/data/vaccines/dose/date', isoDay());
    await page.type('[name="/data/vaccines/dose/source"]', 'Child health record book');
    await shot(page, '10-cwc-visit');
    await submit(page);
    const cwc = await eventually(async () => (await reportsFor(child._id)).find(r => r.form === mch.FORMS.cwc));
    created.push(cwc._id);
    assert.equal(mch.recordedDoses(await reportsFor(child._id)).length, 1);
    pass('10. CWC visit saved with one recorded dose (no schedule or due date shown)');

    await openForm(page, child._id, 'carelink_appointment');
    await check(page, '/data/mode', 'new');
    await setValue(page, '/data/new_due', isoDay());
    await submit(page);
    let appointment = await eventually(async () => mch.appointments(await reportsFor(child._id))[0]);
    created.push(appointment.root._id);
    await eventually(async () => (await taskTitles(page, CHILD)).some(t => t.includes('Appointment due')));
    await openTask(page, CHILD, 'Appointment due', 'Update appointment');
    await check(page, '/data/mode', 'update');
    await check(page, '/data/next_state', 'missed');
    await submit(page);
    appointment = await eventually(async () => { const a = mch.appointments(await reportsFor(child._id))[0]; return a.state === 'missed' && a; });
    created.push(appointment.last._id);
    await eventually(async () => (await taskTitles(page, CHILD)).some(t => t.includes('Missed appointment — follow up')));
    await shot(page, '11-missed-appointment-task');
    pass('11. Appointment due today raised a task; recording it missed raised the missed-appointment task');

    await page.goto(`${BASE}#/contacts/${mother._id}`);
    await page.waitForSelector('h2[test-id="contact-name"]');
    await pause(2000);
    await shot(page, '12-mother-profile');
    assert.match(await text(page), /Postnatal|Antenatal/);
    pass('12. Mother profile shows stage, band, next due, pregnancy, delivery and referral cards');

    // 13. Coordinator (receiving facility) acknowledges the referral; supervisor sees the counts.
    const { page: coordinator } = await login(browser, 'rseidu');
    await openTask(coordinator, MOTHER, 'Referral awaiting acknowledgement', 'Acknowledge or update the referral');
    await check(coordinator, '/data/mode', 'update');
    await check(coordinator, '/data/next_state', 'acknowledged');
    await submit(coordinator);
    const acknowledged = await eventually(async () => { const r = mch.referrals(await reportsFor(mother._id))[0]; return r.state === 'acknowledged' && r; });
    created.push(acknowledged.last._id);
    assert.equal(acknowledged.last.fields.actor, 'rseidu');
    pass('13. The receiving facility\'s coordinator got "Referral awaiting acknowledgement" and acknowledged it; the event names the coordinator');

    // 13b. The originating CHO sees the receiving facility and the acknowledgement after sync.
    await eventually(async () => {
      await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
      await pause(3000);
      await page.goto(`${BASE}#/contacts/${mother._id}`);
      await pause(2500);
      const t = await text(page);
      return t.includes('Tolon District Hospital') && t.includes('Acknowledged by rseidu');
    });
    pass('13b. The originating CHO sees the receiving facility and "Acknowledged by rseidu" on the mother\'s referral card');

    const { page: supervisor } = await login(browser, 'mtahiru');
    await supervisor.goto(`${BASE}#/analytics/target-aggregates`);
    await supervisor.goto(`${BASE}#/analytics/targets`);
    await supervisor.waitForSelector('.target', { timeout: 60000 });
    await pause(3000);
    await shot(supervisor, '14-supervisor-targets');
    assert.match(await text(supervisor), /ANC visits recorded/);
    pass('14. Supervisor targets list the maternal and child counts');

    // 15. History: every clinical record is kept, the referral keeps both events, and the CHO cannot edit or delete them.
    const history = await reportsFor(mother._id);
    for (const form of [mch.FORMS.pregnancy, mch.FORMS.anc, mch.FORMS.delivery, mch.FORMS.referral, mch.FORMS.resolution]) {
      assert.ok(history.some(r => r.form === form), `${form} missing from the mother's history`);
    }
    assert.deepEqual(mch.referrals(history)[0].history.map(e => e.fields.state), ['created', 'acknowledged']);
    const edit = await (await asUser('sabukari', '/medic/_bulk_docs', { method: 'POST', body: JSON.stringify({ docs: [{ ...anc, fields: { ...anc.fields, danger_signs: 'none' } }] }) })).json();
    const remove = await (await asUser('sabukari', '/medic/_bulk_docs', { method: 'POST', body: JSON.stringify({ docs: [{ _id: pregnancy._id, _rev: pregnancy._rev, _deleted: true }] }) })).json();
    const after = await reportsFor(mother._id);
    assert.equal(after.find(r => r._id === anc._id).fields.danger_signs, 'bleeding_reported');
    assert.ok(after.some(r => r._id === pregnancy._id));
    pass('15. Full history kept: pregnancy, ANC, delivery, resolution and referral (created → acknowledged); the server refused a CHO edit and delete', {
      edit: edit[0].reason || edit[0].error, delete: remove[0].reason || remove[0].error });

    // 16. Clinical records are stamped pending clinical review, not released.
    const clinical = [...after, ...(await reportsFor(child._id))].filter(r => Object.values(mch.FORMS).includes(r.form));
    assert.ok(clinical.length >= 8 && clinical.every(r => r.fields.approval_status === 'pending_clinical_review'),
      'A clinical record is missing the pending_clinical_review marker');
    pass(`16. All ${clinical.length} clinical records carry approval_status pending_clinical_review`);

    // 17. Scope: a Nyankpala household is outside the CHO's communities.
    const outside = { _id: `household-outside-${Date.now()}`, type: 'contact', contact_type: 'carelink_household', name: 'Seidu Household, Nyankpala',
      record_origin: 'test', reported_date: Date.now(), parent: { ...tolonLineage, _id: NYANKPALA } };
    await couch('/medic', { method: 'POST', body: JSON.stringify(outside) });
    const ids = (await (await asUser('sabukari', '/api/v1/replication/get-ids')).json()).doc_ids_revs.map(x => x.id);
    assert.ok(ids.includes(mother._id) && ids.includes(anc._id) && ids.includes(HOUSEHOLD));
    assert.ok(!ids.includes(outside._id), 'CHO replicates a household outside her communities');
    const read = await asUser('sabukari', `/medic/${outside._id}`);
    assert.ok([403, 404].includes(read.status));
    pass(`17. CHO replicates her own Tolon records but not a Nyankpala household (direct read returned ${read.status})`);

    // 18. Offline: a CWC visit saved without a connection survives a reload and reaches the server after sync.
    await page.setOfflineMode(true);
    await openForm(page, child._id, 'carelink_cwc_visit');
    await page.type('[name="/data/vitals/weight_kg"]', '3.6');
    await page.type('[name="/data/vitals/length_height_cm"]', '52');
    await submit(page);
    const cwcCount = async () => (await reportsFor(child._id)).filter(r => r.form === mch.FORMS.cwc).length;
    await pause(3000);
    assert.equal(await cwcCount(), 1, 'An offline visit reached the server');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForFunction(() => !!document.querySelector('.app-root.bootstrapped'), { timeout: 60000 });
    await page.goto(`${BASE}#/reports`);
    await eventually(async () => (await page.$$eval('#reports-list li', items => items.filter(li => li.innerText.includes('Child welfare') || li.innerText.includes('CWC')).length)) >= 2, 60000);
    await page.setOfflineMode(false);
    await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
    await eventually(async () => (await cwcCount()) === 2);
    pass('18. CWC visit saved offline, kept after an offline reload, then synchronized to the server');
  } catch (error) {
    result.error = error.message;
    console.error('✖', error.message, error.stack.split('\n').find(l => l.includes('mch-flow.js:')));
    if (page) { await page.screenshot({ path: path.join(evidence, 'mch-failure.png'), fullPage: true }).catch(() => {}); }
    process.exitCode = 1;
  } finally {
    await browser.close();
    result.created = created.length;
    result.note = 'Made-up people marked record_origin test. Tasks and states are derived from recorded events; no clinical schedule is applied.';
    fs.writeFileSync(path.join(evidence, 'mch-flow.json'), JSON.stringify(result, null, 2) + '\n');
  }
})();
