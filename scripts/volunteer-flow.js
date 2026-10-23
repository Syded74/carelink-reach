'use strict';
/*
  Community volunteer flow through the real CHT interface (npm run volunteer-flow), checked against the server:
  the volunteer (aiddrisu, Tolon) registers a household and requests routine care; a second phone of the same
  volunteer submits a duplicate offline; the volunteer records a household contact offline, reloads and syncs;
  the facility coordinator (rseidu) receives both requests, closes the duplicate and accepts the other; the
  volunteer then sees the facility-confirmed status. Finally the volunteer's access is checked through the
  CHT API: own community only, no clinical reports, no writes outside households and their own forms.
  People and households are made up for the prototype and marked record_origin 'test' (lib/test-records.js). Needs CHT_COUCH_URL and CARELINK_ACCOUNT_PASSWORD.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, login, text, evidence, markTestRecords, submitHousehold } = require('./browser-helpers');
const { connection } = require('./client');
const w = require('../lib/workflow');

const BASE = 'http://localhost:5988';
const TOLON = 'carelink-community-tolon';
const GBURIMANI = 'carelink-community-gburimani';
const CHO = 'carelink-person-sabukari';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, what, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const r = await fn(); if (r) { return r; } await pause(1000); }
  throw Error('Timed out waiting for ' + what);
}
const today = () => new Date().toISOString().slice(0, 10);
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `volunteer-${name}.png`), fullPage: true });
const click = (page, name, value) => page.click(`input[name="${name}"][value="${value}"]`);
async function submit(page) {
  await page.click('.form-footer .submit');
  await page.waitForFunction(() => !document.querySelector('.enketo form') || document.querySelector('.invalid-constraint, .invalid-required'), { timeout: 30000 });
  const invalid = await page.$('.invalid-constraint, .invalid-required');
  if (invalid) { throw Error('Form rejected: ' + await invalid.evaluate(e => e.closest('.question')?.innerText)); }
}
async function sync(page) {
  await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
}
async function openForm(page, contact, form) {
  await page.goto(`${BASE}/#/contacts/${contact}/report/${form}`);
  await page.waitForSelector('.enketo form .question', { timeout: 45000 });
}
async function profile(page, contact, expected, what) {
  return eventually(async () => {
    await page.goto(`${BASE}/#/contacts/${contact}`);
    await pause(2500);
    const t = await text(page);
    return expected.every(x => t.includes(x)) && t;
  }, what, 90000);
}
// Actions the fast-action button offers on a contact page. With one action CHT runs it directly,
// so that action is named from the page it opens.
async function offeredForms(page, pane = '.right-pane') {
  const triggers = await page.$$(`${pane} .fast-action-trigger`);
  for (const trigger of triggers) {
    const button = await trigger.$('button');
    if (!button || !await button.evaluate(b => !!b.offsetParent)) { continue; }
    const single = await trigger.evaluate(e => e.getAttribute('test-id') === 'one-action-no-menu');
    const before = page.url();
    await button.click();
    await pause(1500);
    if (single) {
      const title = await page.evaluate(() => document.querySelector('.enketo h3, .enketo #form-title, .form-title')?.innerText || location.hash);
      await page.goto(before);
      await pause(1500);
      return [title.trim()];
    }
    const names = await page.$$eval('.fast-action-item-label', ls => ls.map(l => l.innerText.trim()));
    await page.keyboard.press('Escape');
    await pause(500);
    return [...new Set(names)];
  }
  return [];
}

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = (username, route, options = {}) => fetch(BASE + route, { ...options, headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json', ...options.headers } });
  const serverDocs = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc);
  const result = { timestamp: new Date().toISOString(), steps: [] };
  const step = (name, details = {}) => { result.steps.push({ step: name, passed: true, ...details }); console.log('✔ ' + name); };
  const browser = await launch();
  try {
    // 1. Volunteer sees their tabs and can add a household in their own community.
    const { page: phoneA } = await login(browser, 'aiddrisu');
    const tabs = await phoneA.evaluate(() => [...document.querySelectorAll('.tabs a, mm-header a')].map(a => a.innerText.trim()).filter(Boolean));
    step('1. Volunteer signs in; tabs shown', { tabs: [...new Set(tabs)] });
    await phoneA.goto(`${BASE}/#/contacts/${TOLON}`);
    await pause(3000);
    // On Tolon's page the add actions sit in the place's own pane.
    const tolonOffers = await offeredForms(phoneA);
    assert.ok(tolonOffers.some(x => /household/i.test(x)), 'No add-household action on Tolon: ' + JSON.stringify(tolonOffers));
    assert.ok(!tolonOffers.some(x => /individual|community|facility/i.test(x)), 'Volunteer is offered more than households: ' + JSON.stringify(tolonOffers));
    step('2. Tolon offers only "New household" to the volunteer', { offered: tolonOffers });

    // A family not yet registered in Tolon, so CHT's duplicate-contact check does not stop the new household.
    const families = ['Alhassan', 'Mahamudu', 'Issahaku', 'Wumbei', 'Abdulai', 'Sulemana', 'Fuseini', 'Dawuda', 'Yakubu', 'Iddrisu',
      'Salifu', 'Tahiru', 'Haruna', 'Osman', 'Zakaria', 'Inusah', 'Musah', 'Baba', 'Seidu', 'Abukari', 'Mohammed', 'Awal', 'Yahaya', 'Bawa'];
    const taken = (await serverDocs()).filter(d => d.contact_type === 'carelink_household').map(d => d.name.split(' ')[0]);
    // Single family names first, then two-family names once a day of runs has used them all.
    const family = [...families, ...families.flatMap(a => families.filter(b => b !== a).map(b => `${a}-${b}`))].find(f => !taken.includes(f));
    assert.ok(family, 'Every test family name is already registered in Tolon.');
    const houseNumber = Date.now() % 900 + 100;
    const name = `${family} Household, House ${houseNumber}`;
    await phoneA.goto(`${BASE}/#/contacts/${TOLON}/add/carelink_household`);
    await phoneA.waitForSelector('[name="/data/carelink_household/name"]');
    await phoneA.type('[name="/data/carelink_household/name"]', name);
    await phoneA.type('[name="/data/carelink_household/external_id"]', `TLN-${houseNumber}-${Date.now().toString().slice(-4)}`);
    await shot(phoneA, '1-add-household');
    await submitHousehold(phoneA, name);
    const household = await eventually(async () => (await serverDocs()).find(d => d.type === 'contact' && d.name === name), 'household on server');
    assert.equal(household.parent._id, TOLON);
    assert.equal(household.responsible_worker_id, CHO);
    assert.equal(household.responsible_worker_name, 'Salamatu Abukari');
    assert.equal(household.registered_by, 'carelink-person-aiddrisu');
    await markTestRecords(couch, [household._id]);
    step('3. Household registered in Tolon, linked to CHO Salamatu Abukari and to the volunteer who registered it (on server)', { household: household._id });

    // Registering the same household again is caught by CHT's duplicate-contact check before saving.
    await phoneA.goto(`${BASE}/#/contacts/${TOLON}/add/carelink_household`);
    await phoneA.waitForSelector('[name="/data/carelink_household/name"]');
    await phoneA.type('[name="/data/carelink_household/name"]', name);
    await phoneA.click('.form-footer .submit');
    await eventually(async () => (await text(phoneA)).includes('Possible duplicate contacts found'), 'duplicate household warning', 30000);
    await shot(phoneA, '1b-duplicate-household');
    assert.equal((await serverDocs()).filter(d => d.contact_type === 'carelink_household' && d.name === name).length, 1);
    step('3b. Registering the same household again shows "Possible duplicate contacts found" and saves nothing');
    // Leave the unsaved form by reloading the app, as a user closing it would.
    await phoneA.goto('about:blank');
    await phoneA.goto(`${BASE}/#/contacts/${TOLON}`, { waitUntil: 'networkidle2' });
    await phoneA.waitForFunction(() => !!document.querySelector('.app-root.bootstrapped'), { timeout: 45000 });

    // A second phone of the same volunteer has the household but goes offline before the first request.
    const { page: phoneB } = await login(browser, 'aiddrisu');
    await profile(phoneB, household._id, [name], 'household on second phone');
    await phoneB.setOfflineMode(true);

    // 2. Request routine care online.
    await profile(phoneA, household._id, [name], 'household on first phone');
    const householdOffers = await offeredForms(phoneA);
    assert.ok(householdOffers.includes('Request help'), 'Request help not offered: ' + JSON.stringify(householdOffers));
    assert.ok(!householdOffers.some(x => /antenatal|postnatal|pregnan|delivery|child welfare|referral|visit outcome/i.test(x)), 'Clinical form offered: ' + JSON.stringify(householdOffers));
    step('4. Household offers Request help and no clinical forms', { offered: householdOffers });
    await openForm(phoneA, household._id, 'carelink_request');
    await click(phoneA, '/data/consent', 'yes');
    await click(phoneA, '/data/care_need', 'antenatal_care');
    await click(phoneA, '/data/followup_type', 'visit');
    await click(phoneA, '/data/contact_method', 'community_contact');
    await click(phoneA, '/data/access_barrier', 'transport_unavailable');
    await phoneA.waitForSelector('input[name="/data/travel_time"][value="over_60"]', { visible: true });
    await click(phoneA, '/data/travel_time', 'over_60');
    await shot(phoneA, '2-request');
    await submit(phoneA);
    const requests = async () => (await serverDocs()).filter(d => d.form === w.FORMS.request && d.fields.patient_id === household._id);
    const first = await eventually(async () => (await requests())[0], 'request on server');
    assert.deepEqual([first.fields.care_need, first.fields.access_barrier, first.fields.travel_time, first.fields.contact_method], ['antenatal_care', 'transport_unavailable', 'over_60', 'community_contact']);
    await profile(phoneA, household._id, ['Not yet acknowledged by the facility', 'antenatal care', 'More than 1 hour'], 'pending status on volunteer phone');
    const afterRequest = await offeredForms(phoneA);
    assert.ok(!afterRequest.includes('Request help') && afterRequest.includes('Record household contact'), 'Duplicate guard missing: ' + JSON.stringify(afterRequest));
    step('5. Request for antenatal care with transport barrier and >1 hour travel reached the server; profile shows "Not yet acknowledged"; Request help replaced by Record household contact', { request: first._id, offered: afterRequest });

    // 3. The offline phone does not know about it and submits a second request: a duplicate.
    await openForm(phoneB, household._id, 'carelink_request');
    await click(phoneB, '/data/consent', 'yes');
    await click(phoneB, '/data/care_need', 'antenatal_care');
    await click(phoneB, '/data/followup_type', 'visit');
    await click(phoneB, '/data/contact_method', 'community_contact');
    await click(phoneB, '/data/access_barrier', 'distance');
    await phoneB.waitForSelector('input[name="/data/travel_time"][value="over_60"]', { visible: true });
    await click(phoneB, '/data/travel_time', 'over_60');
    await submit(phoneB);
    await pause(3000);
    assert.equal((await requests()).length, 1, 'An offline request reached the server');
    await phoneB.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await profile(phoneB, household._id, ['Not yet acknowledged by the facility', 'distance'], 'offline request after reload');
    step('6. Second phone saved a request while offline; it survives an offline reload and is not on the server yet');
    await phoneB.setOfflineMode(false);
    await sync(phoneB);
    await eventually(async () => (await requests()).length === 2, 'offline request to sync');
    await eventually(async () => { await sync(phoneA); return (await profile(phoneA, household._id, ['Possible duplicate requests'], 'duplicate warning')); }, 'duplicate warning', 90000);
    await shot(phoneA, '3-duplicate-warning');
    step('7. After sync both requests are on the server and the volunteer sees "Possible duplicate requests"');

    // 4. Non-clinical household contact, offline then synchronized.
    await phoneA.setOfflineMode(true);
    await openForm(phoneA, household._id, 'carelink_household_contact');
    await click(phoneA, '/data/outcome', 'reached_no_update');
    await phoneA.type('[name="/data/note"]', 'Household prefers a morning visit.');
    await submit(phoneA);
    const contacts = async () => (await serverDocs()).filter(d => d.form === 'carelink_household_contact' && d.fields.patient_id === household._id);
    await phoneA.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await profile(phoneA, household._id, ['Latest household contact', 'Household prefers a morning visit'], 'offline contact after reload');
    assert.equal((await contacts()).length, 0);
    await phoneA.setOfflineMode(false);
    await sync(phoneA);
    const contact = await eventually(async () => (await contacts())[0], 'household contact on server');
    assert.equal(contact.fields.outcome, 'reached_no_update');
    assert.equal(contact.fields.contact_date, today());
    assert.ok((await requests()).some(r => r._id === contact.fields.request_id), 'Contact is not linked to an open request');
    step('8. Household contact recorded offline, kept after reload, then synchronized and linked to the open request');

    // 5. Facility coordinator receives both requests and acts on them.
    const { page: coordinator } = await login(browser, 'rseidu');
    const reviewTasks = async () => {
      await coordinator.goto(`${BASE}/#/tasks`);
      await pause(3000);
      const items = await coordinator.$$('#tasks-list li');
      const mine = [];
      for (const li of items) { const t = await li.evaluate(e => e.innerText); if (t.includes(name) && t.includes('Review outreach request')) { mine.push(li); } }
      return mine;
    };
    await eventually(async () => (await reviewTasks()).length === 2, 'two review tasks for the coordinator', 90000);
    await shot(coordinator, '4-coordinator-tasks');
    step('9. Coordinator received both requests as "Review outreach request" tasks');
    await profile(coordinator, household._id, ['Possible duplicate requests', 'Latest household contact'], 'duplicate warning for the coordinator');
    const decide = async (status, note) => {
      const [task] = await reviewTasks();
      await (await task.$('a')).click();
      await coordinator.waitForSelector('.enketo form, .task-action, .actions .btn');
      if (!await coordinator.$('.enketo form')) { await coordinator.click('.task-action, .actions .btn'); await coordinator.waitForSelector('.enketo form'); }
      await click(coordinator, '/data/status', status);
      await coordinator.type('[name="/data/outcome_note"]', note);
      await submit(coordinator);
    };
    const states = async () => { const docs = await serverDocs(); return (await requests()).map(r => w.workflow(r, docs).state).sort(); };
    await decide('cancelled', 'Duplicate request from a second phone; the other request is kept.');
    await eventually(async () => (await states()).join() === 'awaiting_assignment,cancelled', 'duplicate to be closed');
    await decide('accepted', 'Facility received the request; a CHO will be assigned.');
    await eventually(async () => (await states()).join() === 'accepted,cancelled', 'request to be accepted');
    step('10. Coordinator closed the duplicate and accepted the request (append-only events on server)');

    // 6. Volunteer sees the verified status from the facility.
    await sync(phoneA);
    const finalText = await profile(phoneA, household._id, ['Acknowledged by the facility: accepted', 'Acknowledged by the facility: cancelled'], 'facility status on volunteer phone');
    assert.ok(!finalText.includes('Possible duplicate requests'));
    await shot(phoneA, '5-verified-status');
    step('11. Volunteer sees "Acknowledged by the facility: accepted" and the duplicate as cancelled; the warning is gone');

    // 7. Scope and clinical restrictions, checked through the CHT API as the volunteer.
    const cho = (route, body) => asUser('sabukari', route, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    const stamp = Date.now();
    const lineage = (id, parent) => ({ _id: id, parent });
    const tolonLineage = lineage(TOLON, lineage('carelink-facility-tolon-hospital', lineage('carelink-district-tolon', lineage('carelink-region-northern'))));
    const gburimaniLineage = { ...tolonLineage, _id: GBURIMANI };
    const otherHousehold = { _id: `scope-household-${stamp}`, type: 'contact', contact_type: 'carelink_household', name: 'Dawuda Household, Gburimani', record_origin: 'test', parent: gburimaniLineage, reported_date: stamp };
    const person = { _id: `scope-person-${stamp}`, type: 'contact', contact_type: 'carelink_individual', name: 'Fatima Alhassan', record_origin: 'test', parent: lineage(household._id, tolonLineage), care_stage: 'anc', reported_date: stamp };
    const pregnancy = { _id: `scope-pregnancy-${stamp}`, type: 'data_record', form: 'carelink_pregnancy', content_type: 'xml', reported_date: stamp,
      contact: lineage(CHO, tolonLineage), fields: { patient_id: person._id, patient_uuid: person._id } };
    const created = await cho('/medic/_bulk_docs', { docs: [otherHousehold, person, pregnancy] });
    assert.ok(created.every(r => r.ok), 'CHO could not create the scope fixtures: ' + JSON.stringify(created));
    const ids = await eventually(async () => {
      const r = await (await asUser('aiddrisu', '/api/v1/replication/get-ids')).json();
      const list = (r.doc_ids_revs || []).map(x => x.id);
      return list.includes(person._id) && list;
    }, 'replication list');
    assert.ok(ids.includes(household._id) && ids.includes(first._id) && ids.includes(contact._id));
    assert.ok(!ids.includes(otherHousehold._id), 'Volunteer replicates another community');
    assert.ok(!ids.includes(pregnancy._id), 'Volunteer replicates a clinical (pregnancy) report');
    const otherRead = await asUser('aiddrisu', `/medic/${otherHousehold._id}`);
    assert.ok([403, 404].includes(otherRead.status), 'Volunteer read another community household: ' + otherRead.status);
    const pregnancyRead = await asUser('aiddrisu', `/medic/${pregnancy._id}`);
    assert.ok([403, 404].includes(pregnancyRead.status), 'Volunteer read a clinical report: ' + pregnancyRead.status);
    step('12. Volunteer replicates Tolon households, requests and contacts; not other communities or clinical reports (read attempts return ' + `${otherRead.status}/${pregnancyRead.status})`);

    const attempts = {
      'ANC visit': { _id: `scope-anc-${stamp}`, type: 'data_record', form: 'carelink_anc_visit', reported_date: stamp, contact: lineage('carelink-person-aiddrisu', tolonLineage), fields: { patient_id: person._id } },
      'Referral': { _id: `scope-ref-${stamp}`, type: 'data_record', form: 'carelink_mch_referral', reported_date: stamp, contact: lineage('carelink-person-aiddrisu', tolonLineage), fields: { patient_id: person._id, state: 'created' } },
      'Coordination decision': { _id: `scope-coord-${stamp}`, type: 'data_record', form: 'carelink_coordination', reported_date: stamp, contact: lineage('carelink-person-aiddrisu', tolonLineage), fields: { patient_id: household._id, request_id: first._id, status: 'completed' } },
      'Individual': { _id: `scope-ind-${stamp}`, type: 'contact', contact_type: 'carelink_individual', name: 'x', parent: lineage(household._id, tolonLineage), reported_date: stamp },
      'Community': { _id: `scope-com-${stamp}`, type: 'contact', contact_type: 'carelink_community', name: 'x', parent: tolonLineage.parent, reported_date: stamp },
    };
    const refused = {};
    for (const [label, doc] of Object.entries(attempts)) {
      const r = await (await asUser('aiddrisu', '/medic/_bulk_docs', { method: 'POST', body: JSON.stringify({ docs: [doc] }) })).json();
      const stored = (await couch('/medic/_all_docs', { method: 'POST', body: JSON.stringify({ keys: [doc._id] }) })).rows[0];
      assert.ok(!stored.value || stored.value.deleted, `${label} written by the volunteer`);
      refused[label] = Array.isArray(r) ? (r[0].reason || r[0].error) : (r.reason || r.error);
    }
    step('13. Server refused volunteer writes of ANC, referral, coordination decisions, individuals and communities', { refused });
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error('✖ ' + e.message);
    const pages = (await Promise.all(browser.browserContexts().map(c => c.pages()))).flat();
    await Promise.all(pages.map((p, i) => p.screenshot({ path: path.join(evidence, `volunteer-failure-${i + 1}.png`), fullPage: true }).catch(() => {})));
    process.exitCode = 1;
  } finally {
    result.limits = ['Chrome DevTools network emulation, not a physical Android airplane-mode test.', 'Initial login and first synchronization were online.'];
    fs.writeFileSync(path.join(evidence, 'volunteer-flow.json'), JSON.stringify(result, null, 2) + '\n');
    await browser.close();
  }
})();
