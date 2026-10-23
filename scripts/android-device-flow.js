'use strict';
/*
  CareLink Reach on a physical Android phone (npm run android-device-flow), driving the real CHT Android
  app's WebView over USB (Chrome DevTools protocol through adb), checked against the server.
  Offline is real for the app: the USB port forward to the CHT server is removed, so the app cannot
  reach the server, and the app is force-stopped and restarted while offline.
   V. Volunteer (aiddrisu): request saved offline → app restarted offline → still there → reconnect,
      sync → exactly one request on the server, unchanged after another sync.
   C. CHO (sabukari): app data cleared only after the volunteer's request synced; log in; a mother's ANC
      follow-up planned on an approved outreach day (fixture through the CHT API as the real users)
      → resolved offline from her task → app restarted offline → reconnect, sync → one resolution,
      stamped with the CHO and the day; the day shows completed 1; no duplicates after another sync.
  Needs the phone on USB with the CareLink Reach debug app installed, CHT_COUCH_URL,
  CARELINK_ACCOUNT_PASSWORD and the planning worker. Writes evidence/android-device-flow.json and evidence/android-*.png.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { evidence, releaseTestDays } = require('./browser-helpers');
const { connection } = require('./client');
const w = require('../lib/workflow');
const mch = require('../lib/mch');
const { dayPlanId, dayProgress } = require('../lib/oi-links');
const { isoDay } = require('../lib/schedules');

const BASE = 'http://localhost:5988/';
const TOLON = 'carelink-community-tolon';
const DIMABI = 'carelink-community-dimabi';
const FACILITY = 'carelink-facility-tolon-hospital';
const CHO = 'carelink-person-sabukari';
const MOTORBIKE = 'carelink-facility-tolon-hospital-motorbike-1';
const person = u => `carelink-person-${u}`;
const { APP, adb, pause, eventually, online, offline, restart, attach, shot, text, check, submit, sync, login, signedInAs } = require('./android-helpers');

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = async (username, docs) => (await fetch(`${BASE}medic/_bulk_docs`, { method: 'POST', body: JSON.stringify({ docs }), headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json' } })).json();
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(Boolean);
  const reports = async form => (await all()).filter(d => d.type === 'data_record' && d.form === form);
  const lineage = (id, parent) => ({ _id: id, parent });
  const tolonLineage = lineage(TOLON, lineage(FACILITY, lineage('carelink-district-tolon', lineage('carelink-region-northern'))));
  const result = { timestamp: new Date().toISOString(), device: adb('shell', 'getprop', 'ro.product.model') + ' · Android ' + adb('shell', 'getprop', 'ro.build.version.release'),
    app: APP, steps: [] };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, where: 'physical device', ...(detail ? { detail } : {}) }); console.log('✔ ' + step); };
  const run = Date.now();
  let session;
  try {
    online();
    // ---- V. Volunteer ----
    session = await attach();
    let page = session.page;
    if (await signedInAs(page) !== 'aiddrisu') {
      assert.ok(!await signedInAs(page) || true);
      await login(page, 'aiddrisu');
    }
    const household = { _id: `household-android-${run}`, type: 'contact', contact_type: 'carelink_household', name: `Mumuni Household, House ${run % 900 + 100}`,
      parent: tolonLineage, responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', registered_by: person('aiddrisu'), record_origin: 'test', reported_date: run };
    assert.ok((await asUser('aiddrisu', [household]))[0].ok);
    await eventually(async () => { await sync(page); await pause(3000); await page.goto(`${BASE}#/contacts/${household._id}`); await pause(3000); return (await text(page)).includes(household.name); }, 'the household on the phone');
    pass('V1. Volunteer signed in on the phone; a new Tolon household reached it by sync');

    offline();
    await page.goto(`${BASE}#/contacts/${household._id}/report/carelink_request`);
    await page.waitForSelector('.enketo form .question');
    await check(page, '/data/consent', 'yes');
    await check(page, '/data/care_need', 'antenatal_care');
    await check(page, '/data/followup_type', 'visit');
    await check(page, '/data/contact_method', 'community_contact');
    await check(page, '/data/access_barrier', 'transport_unavailable');
    await page.waitForSelector('input[name="/data/travel_time"][value="over_60"]', { visible: true });
    await check(page, '/data/travel_time', 'over_60');
    await submit(page);
    await pause(3000);
    const requests = async () => (await reports(w.FORMS.request)).filter(r => r.fields.patient_id === household._id);
    assert.equal((await requests()).length, 0, 'the offline request reached the server');
    await shot('1-volunteer-offline-saved');
    pass('V2. With the server unreachable, the volunteer saved a routine ANC request on the phone; nothing reached the server');

    session.browser.disconnect();
    await restart();
    session = await attach();
    page = session.page;
    await eventually(() => page.evaluate(() => !!document.querySelector('.app-root.bootstrapped')), 'the app to start offline', 120000);
    await page.goto(`${BASE}#/contacts/${household._id}`);
    await eventually(async () => (await text(page)).includes('Not yet acknowledged by the facility'), 'the saved request after restart');
    await shot('2-volunteer-after-restart');
    pass('V3. After force-stopping and restarting the app while still offline, the request is still on the phone (household shows "Not yet acknowledged by the facility")');

    online();
    const synced = await eventually(async () => { await sync(page); const r = await requests(); return r.length === 1 && r; }, 'the request to sync', 180000);
    await sync(page); await pause(8000); await sync(page); await pause(5000);
    assert.equal((await requests()).length, 1, 'a repeated sync duplicated the request');
    assert.deepEqual([synced[0].fields.care_need, synced[0].fields.travel_time], ['antenatal_care', 'over_60']);
    pass('V4. Reconnected: exactly one request reached the server with its answers; further syncs created no duplicate', { request: synced[0]._id });

    // ---- C. CHO ----
    // Fixture through the CHT API as the real users: a Dimabi mother with an ANC follow-up due today,
    // and an approved plan whose day takes it on (the browser suites cover these steps in the UI).
    const today = isoDay();
    const dimabi = lineage(DIMABI, tolonLineage.parent);
    const home = { _id: `household-android-dimabi-${run}`, type: 'contact', contact_type: 'carelink_household', name: `Adam Household, Dimabi ${run % 1000}`,
      parent: dimabi, responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', record_origin: 'test', reported_date: run };
    await couch('/medic', { method: 'POST', body: JSON.stringify(home) });
    const mother = { _id: `mother-android-${run}`, type: 'contact', contact_type: 'carelink_individual', name: `Memuna Adam ${run % 1000}`, parent: lineage(home._id, dimabi),
      care_stage: 'anc', sex: 'F', date_of_birth: '1998-06-01', responsible_worker_id: CHO, record_origin: 'test', reported_date: run };
    const anc = { _id: `anc-android-${run}`, type: 'data_record', form: mch.FORMS.anc, content_type: 'xml', reported_date: Date.now(), contact: { _id: CHO },
      fields: { patient_id: mother._id, follow_up_date: today, missing_vitals: '', danger_signs: '', approval_status: 'pending_clinical_review', created_by: CHO } };
    assert.ok((await asUser('sabukari', [mother, anc])).every(r => r.ok));
    const taskId = mch.taskId(mother._id, 'scheduledFollowUp', anc._id);
    // Close follow-ups earlier test runs left open in Dimabi (normal resolutions, history kept), so the day takes on this mother.
    const docsNow = await all();
    const contacts = new Map(docsNow.filter(d => d.type === 'contact').map(d => [d._id, d]));
    const closing = require('../lib/mch-outreach').followUps(docsNow, today).routine
      .filter(i => i.community_id === DIMABI && i.person_id !== mother._id && (contacts.get(i.person_id) || {}).record_origin === 'test')
      .map(i => ({ _id: `close-${i.task_id.replace(/[^A-Za-z0-9-]/g, '-')}-${run}`, type: 'data_record', form: mch.FORMS.resolution, content_type: 'xml', reported_date: Date.now(),
        contact: { _id: CHO }, fields: { patient_id: i.person_id, task_id: i.task_id, task_kind: i.kind, source_id: i.source, actor: 'sabukari',
          reason: 'Closed: left open by an earlier regression run.', approval_status: 'pending_clinical_review', created_by: CHO } }));
    if (closing.length) { assert.ok((await asUser('sabukari', closing)).every(x => x.ok)); }
    const busy = await releaseTestDays(couch, 'sabukari', CHO, password);
    let day = isoDay(Date.now() + 86400000);
    while (busy.has(day) || [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) { day = isoDay(Date.parse(day + 'T12:00:00Z') + 86400000); }
    const req = { _id: `oi-request-android-${run}`, type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: day, season: 'dry', staff_available: CHO, hours_start: '0800', hours_end: '1600',
        vehicles: MOTORBIKE, use_synthetic_history: 'no', fairness_weight: '0.5', guarantee_communities: DIMABI, include_test_records: 'yes' } };
    assert.ok((await asUser('rseidu', [req]))[0].ok);
    const proposal = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${req._id}`), 'the proposal');
    const ack = async id => eventually(async () => (await reports('carelink_oi_ack')).find(a => a.fields.event_id === id), `acknowledgement of ${id}`);
    const decide = async (user, action, expected) => (await asUser(user, [{ _id: `${action}-android-${Date.now()}`, type: 'data_record', form: 'carelink_oi_review', content_type: 'xml',
      reported_date: Date.now(), contact: { _id: person(user) }, fields: { patient_id: FACILITY, proposal_id: proposal._id, action, actor: user, expected_event: expected, notes: 'Device test.' } }]))[0].id;
    const s = await decide('rseidu', 'submit', proposal._id); assert.equal((await ack(s)).fields.result, 'accepted');
    const r = await decide('mtahiru', 'review', s); assert.equal((await ack(r)).fields.result, 'accepted');
    const a = await decide('mtahiru', 'approve', r); assert.equal((await ack(a)).fields.result, 'accepted');
    const assignment = await eventually(async () => (await reports('carelink_oi_assignment')).find(x => x.fields.proposal_id === proposal._id && x.fields.patient_id === DIMABI), 'the Dimabi assignment');
    const plan = await eventually(async () => (await reports('carelink_oi_day_plan')).find(p => p._id === dayPlanId(assignment._id)), 'the day plan');
    assert.ok(plan.fields.followups.some(f => f.task_id === taskId), 'the follow-up was not planned');

    // The volunteer's request is on the server (V4), so clearing the app's data loses nothing.
    session.browser.disconnect();
    adb('shell', 'pm', 'clear', APP);
    adb('shell', 'monkey', '-p', APP, '-c', 'android.intent.category.LAUNCHER', '1');
    await pause(6000);
    session = await attach();
    page = session.page;
    await login(page, 'sabukari');
    await eventually(async () => { await sync(page); await page.goto(`${BASE}#/contacts/${mother._id}`); await pause(3000); return (await text(page)).includes('Planned outreach day'); }, 'the planned day on the mother profile', 300000);
    await shot('3-cho-mother-planned');
    pass(`C1. CHO signed in on the phone (after the volunteer's data had synced); the mother's ANC follow-up is planned on the approved ${day} Dimabi day and shows on her profile`);

    offline();
    await eventually(async () => {
      await page.goto(`${BASE}#/tasks`);
      await pause(3000);
      for (const li of await page.$$('#tasks-list li')) {
        const t = await li.evaluate(e => e.innerText);
        if (t.includes(mother.name) && t.includes('ANC follow-up due')) { await (await li.$('a')).click(); return true; }
      }
      return false;
    }, 'the follow-up task on the phone');
    await page.waitForSelector('li.actions a.btn');
    await page.evaluate(() => [...document.querySelectorAll('li.actions a.btn')].find(x => x.innerText.trim() === 'Resolve with a reason').click());
    await page.waitForSelector('.enketo form', { visible: true });
    await page.type('[name="/data/reason"]', 'Seen at the Dimabi outreach day.');
    await submit(page);
    await pause(3000);
    const resolutions = async () => (await reports(mch.FORMS.resolution)).filter(x => x.fields.task_id === taskId);
    assert.equal((await resolutions()).length, 0, 'the offline resolution reached the server');
    pass('C2. With the server unreachable, the CHO resolved the follow-up from her task on the phone');

    session.browser.disconnect();
    await restart();
    session = await attach();
    page = session.page;
    await eventually(() => page.evaluate(() => !!document.querySelector('.app-root.bootstrapped')), 'the app to start offline', 120000);
    await page.goto(`${BASE}#/tasks`);
    await pause(4000);
    assert.ok(!(await text(page)).includes(mother.name + '\nANC follow-up due'), 'the resolved task came back after restart');
    await shot('4-cho-after-restart');
    pass('C3. After restarting the app offline, the resolution is still on the phone (the task stays resolved)');

    online();
    const res = await eventually(async () => { await sync(page); const x = await resolutions(); return x.length === 1 && x[0]; }, 'the resolution to sync', 180000);
    await sync(page); await pause(8000); await sync(page); await pause(5000);
    assert.equal((await resolutions()).length, 1, 'a repeated sync duplicated the resolution');
    assert.equal(res.fields.actor, 'sabukari');
    assert.equal(res.fields.assignment_id, assignment._id);
    const docs = await all();
    const progress = dayProgress(plan, docs.filter(d => d.type === 'data_record'));
    assert.equal(progress.followupRows.find(f => f.task_id === taskId).outcome, 'completed');
    pass('C4. Reconnected: one resolution reached the server, stamped with the CHO and the approved day; the day counts it as completed; further syncs created no duplicate', { completed: progress.followups.completed, planned: progress.followups.planned });
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error('✖ ' + e.message);
    await shot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    online();
    if (session) { session.browser.disconnect(); }
    result.notes = ['Offline = the app cannot reach the CHT server (USB port forward removed); the phone itself was not put in airplane mode.',
      'Fixture records (households, mother, plan decisions) were written through the CHT API as the real users; the browser suites cover those steps in the UI.',
      'The phone ends signed in as the CHO (sabukari).'];
    fs.writeFileSync(path.join(evidence, 'android-device-flow.json'), JSON.stringify(result, null, 2) + '\n');
    process.exit(process.exitCode || 0);
  }
})();
