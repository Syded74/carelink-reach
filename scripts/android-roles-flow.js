'use strict';
/*
  Coordinator, supervisor and volunteer on the physical Android phone (npm run android-roles-flow),
  complementing android-device-flow.js (volunteer and CHO offline work). For each role, after the
  previous role's data has synced, the app's data is cleared and the role signs in. Offline = the app
  cannot reach the CHT server (USB port forward removed), with an app restart before reconnecting.
   R1. Coordinator: sees the Outreach Intelligence tab; accepts a household request offline; restart;
       sync → exactly one coordination event on the server.
   R2. Supervisor: sees the tab; reviews a submitted plan offline; restart; the tab shows the decision as
       pending; sync → one review event, accepted by the server.
   R3. Volunteer: no planning tab; the phone's own database holds request links but no assignments,
       day plans, outreach-day records or follow-up links (purge.js), while CHT still has them.
  Needs the phone on USB with the CareLink Reach app, CHT_COUCH_URL, CARELINK_ACCOUNT_PASSWORD and the
  planning worker. Writes evidence/android-roles-flow.json and evidence/android-role-*.png.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { evidence, releaseTestDays } = require('./browser-helpers');
const { connection } = require('./client');
const w = require('../lib/workflow');
const { isoDay } = require('../lib/schedules');
const { APP, BASE, adb, pause, eventually, online, offline, restart, attach, shot, text, check, submit, sync, login } = require('./android-helpers');

const TOLON = 'carelink-community-tolon';
const FACILITY = 'carelink-facility-tolon-hospital';
const CHO = 'carelink-person-sabukari';
const MOTORBIKE = 'carelink-facility-tolon-hospital-motorbike-1';
const person = u => `carelink-person-${u}`;
const SERVICE_ONLY = ['carelink_oi_assignment', 'carelink_oi_day_plan', 'carelink_oi_outreach_day', 'carelink_oi_followup_link'];

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = async (username, docs) => (await fetch(`${BASE}medic/_bulk_docs`, { method: 'POST', body: JSON.stringify({ docs }), headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json' } })).json();
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(Boolean);
  const reports = async form => (await all()).filter(d => d.type === 'data_record' && d.form === form);
  const lineage = (id, parent) => ({ _id: id, parent });
  const tolon = lineage(TOLON, lineage(FACILITY, lineage('carelink-district-tolon', lineage('carelink-region-northern'))));
  const result = { timestamp: new Date().toISOString(), device: adb('shell', 'getprop', 'ro.product.model') + ' · Android ' + adb('shell', 'getprop', 'ro.build.version.release'), steps: [] };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, where: 'physical device', ...(detail ? { detail } : {}) }); console.log('✔ ' + step); };
  const run = Date.now();
  // Forms present in the phone's own CHT database.
  const localForms = page => page.evaluate(async () => {
    const docs = (await window.CHTCore.DB.get().allDocs({ include_docs: true })).rows.map(r => r.doc);
    return docs.filter(d => d.type === 'data_record').reduce((m, d) => ({ ...m, [d.form]: (m[d.form] || 0) + 1 }), {});
  });
  const hasTab = page => page.evaluate(() => [...document.querySelectorAll('.header .tabs a, mm-header a, .mm-navigation-menu a')].some(a => a.innerText.includes('Outreach Intelligence')));
  // Clear the app only once nothing is waiting to sync: a fresh sign-in as the next role.
  async function signIn(session, username) {
    if (session) { session.browser.disconnect(); }
    adb('shell', 'pm', 'clear', APP);
    adb('shell', 'monkey', '-p', APP, '-c', 'android.intent.category.LAUNCHER', '1');
    await pause(10000);
    // A freshly cleared app may swap its WebView page while starting; attach again and retry once.
    for (let attempt = 0; ; attempt++) {
      const next = await attach();
      try { await login(next.page, username); return next; } catch (e) {
        next.browser.disconnect();
        if (attempt) { throw e; }
        await pause(8000);
      }
    }
  }
  async function restarted(session) {
    session.browser.disconnect();
    await restart();
    const next = await attach();
    await eventually(() => next.page.evaluate(() => !!document.querySelector('.app-root.bootstrapped')), 'the app to start offline', 120000);
    return next;
  }
  let session;
  try {
    online();
    // Fixtures through the CHT API as the real users: a Tolon request awaiting review, and a plan submitted for review.
    const household = { _id: `household-roles-${run}`, type: 'contact', contact_type: 'carelink_household', name: `Ziblim Household, House ${run % 900 + 100}`,
      parent: tolon, responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', registered_by: person('aiddrisu'), record_origin: 'test', reported_date: run };
    const request = { _id: `request-roles-${run}`, type: 'data_record', form: w.FORMS.request, content_type: 'xml', reported_date: Date.now(), contact: { _id: person('aiddrisu') },
      fields: { patient_id: household._id, household_name: household.name, community_name: 'Tolon', created_by: person('aiddrisu'), consent: 'yes', care_need: 'family_planning',
        followup_type: 'visit', contact_method: 'community_contact', access_barrier: 'distance', travel_time: '30_to_60' } };
    assert.ok((await asUser('aiddrisu', [household, request])).every(r => r.ok));
    const busy = await releaseTestDays(couch, 'sabukari', CHO, password);
    let day = isoDay(Date.now() + 40 * 86400000);
    while (busy.has(day) || [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) { day = isoDay(Date.parse(day + 'T12:00:00Z') + 86400000); }
    const planRequest = { _id: `oi-request-roles-${run}`, type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: day, season: 'dry', staff_available: CHO, hours_start: '0800', hours_end: '1600',
        vehicles: MOTORBIKE, use_synthetic_history: 'no', fairness_weight: '0.5', guarantee_communities: '', include_test_records: 'yes' } };
    assert.ok((await asUser('rseidu', [planRequest]))[0].ok);
    const proposal = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${planRequest._id}`), 'the proposal');
    const submitEvent = (await asUser('rseidu', [{ _id: `submit-roles-${run}`, type: 'data_record', form: 'carelink_oi_review', content_type: 'xml', reported_date: Date.now(),
      contact: { _id: person('rseidu') }, fields: { patient_id: FACILITY, proposal_id: proposal._id, action: 'submit', actor: 'rseidu', expected_event: proposal._id } }]))[0];
    await eventually(async () => (await reports('carelink_oi_ack')).find(a => a.fields.event_id === submitEvent.id && a.fields.result === 'accepted'), 'submission accepted');

    // R1. Coordinator.
    session = await signIn(session, 'rseidu');
    let page = session.page;
    assert.ok(await eventually(() => hasTab(page), 'the Outreach Intelligence tab'), 'coordinator has no planning tab');
    await eventually(async () => {
      await sync(page); await page.goto(`${BASE}#/tasks`); await pause(3000);
      for (const li of await page.$$('#tasks-list li')) {
        const t = await li.evaluate(e => e.innerText);
        if (t.includes(household.name) && t.includes('Review outreach request')) { await (await li.$('a')).click(); return true; }
      }
      return false;
    }, 'the review task on the coordinator phone', 300000);
    await page.waitForSelector('.enketo form', { visible: true });
    offline();
    await check(page, '/data/status', 'accepted');
    await page.type('[name="/data/outcome_note"]', 'Received at the facility; will be planned.');
    await submit(page);
    const coordination = async () => (await reports(w.FORMS.coordination)).filter(r => r.fields.request_id === request._id);
    await pause(3000);
    assert.equal((await coordination()).length, 0, 'offline decision reached the server');
    session = await restarted(session);
    page = session.page;
    online();
    await eventually(async () => { await sync(page); return (await coordination()).length === 1; }, 'the coordination event to sync', 180000);
    await sync(page); await pause(8000);
    assert.equal((await coordination()).length, 1);
    await shot('role-1-coordinator');
    pass('R1. Coordinator on the phone: Outreach Intelligence tab present; accepted a household request offline; after an app restart and sync, exactly one coordination event on the server');

    // R2. Supervisor.
    session = await signIn(session, 'mtahiru');
    page = session.page;
    assert.ok(await eventually(() => hasTab(page), 'the Outreach Intelligence tab'), 'supervisor has no planning tab');
    await eventually(async () => {
      await sync(page); await page.goto(`${BASE}#/tasks`); await pause(3000);
      for (const li of await page.$$('#tasks-list li')) {
        const t = await li.evaluate(e => e.innerText + ' ' + (e.getAttribute('data-record-id') || ''));
        if (t.includes('Review outreach plan') && t.includes(proposal._id)) { await (await li.$('a')).click(); return true; }
      }
      return false;
    }, 'the plan review task on the supervisor phone', 300000);
    await page.waitForSelector('.enketo form', { visible: true });
    offline();
    await submit(page);
    const reviews = async () => (await reports('carelink_oi_review')).filter(e => e.fields.proposal_id === proposal._id && e.fields.action === 'review');
    await pause(3000);
    assert.equal((await reviews()).length, 0, 'offline review reached the server');
    session = await restarted(session);
    page = session.page;
    await page.goto(`${BASE}#/ui-extensions/carelink-outreach-intelligence`);
    await pause(4000);
    online();
    const review = await eventually(async () => { await sync(page); const r = await reviews(); return r.length === 1 && r[0]; }, 'the review to sync', 180000);
    assert.equal(review.fields.actor, 'mtahiru');
    const reviewAck = await eventually(async () => (await reports('carelink_oi_ack')).find(a => a.fields.event_id === review._id), 'the server decision');
    assert.equal(reviewAck.fields.result, 'accepted');
    await shot('role-2-supervisor');
    pass('R2. Supervisor on the phone: tab present; reviewed a submitted plan offline; after an app restart and sync, one review event, accepted by the server (state reviewed)');

    // R3. Volunteer: what is actually on the phone.
    session = await signIn(session, 'aiddrisu');
    page = session.page;
    await pause(5000);
    assert.ok(!(await hasTab(page)), 'volunteer sees the planning tab');
    const forms = await localForms(page);
    const leaked = SERVICE_ONLY.filter(f => forms[f]);
    assert.deepEqual(leaked, [], 'service-only planning records on the volunteer phone: ' + JSON.stringify(forms));
    assert.ok((forms.carelink_request || 0) > 0);
    const onServer = (await all()).filter(d => SERVICE_ONLY.includes(d.form)).length;
    await shot('role-3-volunteer');
    pass(`R3. Volunteer on the phone: no planning tab; the phone's database holds ${forms.carelink_request} requests and ${forms.carelink_oi_request_link || 0} request links but no assignments, day plans, outreach-day records or follow-up links (CHT keeps all ${onServer} on the server)`, { forms_on_phone: forms });
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error('✖ ' + e.message);
    await shot('role-failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    online();
    if (session) { session.browser.disconnect(); }
    result.notes = ['Offline = the app cannot reach the CHT server (USB port forward removed); not airplane mode.',
      'Fixtures were written through the CHT API as the real users. The phone ends signed in as the volunteer (aiddrisu).'];
    fs.writeFileSync(path.join(evidence, 'android-roles-flow.json'), JSON.stringify(result, null, 2) + '\n');
    process.exit(process.exitCode || 0);
  }
})();
