'use strict';
/*
  Outreach Intelligence inside the real CHT application, end to end (npm run oi-cht-flow), at Tolon District
  Hospital: coordinator rseidu requests and submits a plan, supervisor mtahiru reviews and approves it, the
  server writes assignments, CHO sabukari receives and records the planned outreach day. Then the facility
  request flow: the volunteer's accepted request is assigned and scheduled, the CHO's visit completes it.
  Requires CHT, the planning service (npm run oi-worker -- --watch 5) and CARELINK_ACCOUNT_PASSWORD.
  Every step is confirmed against the server. Writes evidence/oi-cht-flow.json and evidence/oi-cht-*.png.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, login, text, evidence, releaseTestDays } = require('./browser-helpers');
const { connection } = require('./client');
const w = require('../lib/workflow');
const { isoDay } = require('../lib/schedules');

const BASE = 'http://localhost:5988/';
const TAB = `${BASE}#/ui-extensions/carelink-outreach-intelligence`;
const FACILITY = 'carelink-facility-tolon-hospital';
const CHO = 'carelink-person-sabukari';
const MOTORBIKE = 'carelink-facility-tolon-hospital-motorbike-1';
const person = username => `carelink-person-${username}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, timeout = 90000, what = 'condition') {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const v = await fn(); if (v) { return v; } await pause(1500); }
  throw Error(`Timed out waiting for ${what}`);
}
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `oi-cht-${name}.png`), fullPage: true });
const tabText = page => page.evaluate(() => document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || '');
const check = async (page, name, value) => {
  const sel = `input[name="${name}"][value="${value}"], input[data-name="${name}"][value="${value}"]`;
  for (let i = 0; i < 5; i++) {
    await page.$eval(sel, e => e.scrollIntoView({ block: 'center' }));
    await page.click(sel);
    await pause(500);
    if (await page.$eval(sel, e => e.checked)) { return; }
  }
  throw Error(`Could not select ${value} for ${name}`);
};
const setValue = (page, name, value) => page.evaluate((n, v) => { window.$(`[name="${n}"]`).val(v).trigger('change'); }, name, value);
async function submitForm(page) {
  await page.waitForSelector('.enketo form', {visible:true});
  await page.click('.form-footer .submit');
  await page.waitForFunction(() =>
    document.body.innerText.includes('Report submitted') ||
    ![...document.querySelectorAll('.enketo form')].some(f => f.getBoundingClientRect().height > 0) ||
    [...document.querySelectorAll('.invalid-constraint, .invalid-required')].some(e => e.getBoundingClientRect().height > 0),
  { timeout: 30000 });
  const invalid = await page.$('.enketo form .invalid-constraint, .enketo form .invalid-required');
  if (invalid) { throw Error('Form rejected: ' + await invalid.evaluate(e => e.closest('.question')?.innerText)); }
}
async function sync(page) {
  await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
  await pause(3000);
}
async function openTab(page, expected) {
  await page.goto(TAB);
  await page.waitForSelector('cht-carelink-outreach-intelligence');
  return eventually(async () => { const t = await tabText(page); return expected.every(x => t.includes(x)) && t; }, 60000, `tab to show ${expected.join(', ')}`);
}
async function openPlan(page, proposalId, expected) {
  await openTab(page, ['Community demand']);
  await eventually(async () => {
    // The proposal is written on the server after the device's last push, so pull before looking for it.
    await sync(page);
    await page.goto(TAB);
    await page.waitForSelector('cht-carelink-outreach-intelligence');
    await pause(1500);
    return page.evaluate(pid => {
      const el = document.querySelector('cht-carelink-outreach-intelligence');
      const b = [...el.shadowRoot.querySelectorAll('button[data-proposal-id]')].find(b => b.dataset.proposalId === pid);
      if (!b) { return false; }
      b.click();return true;
    }, proposalId);
  }, 120000, 'the requested proposal to reach this device');
  return eventually(async () => {
    // Server acknowledgements are written after the device's last push, so pull again while waiting.
    await sync(page);
    const value = await page.evaluate(pid => {
      const root = document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot;
      return [...(root?.querySelectorAll('[data-plan-id]') || [])].find(e => e.dataset.planId === pid)?.textContent || '';
    }, proposalId);
    return expected.every(x => value.includes(x)) && value;
  }, 60000, 'the selected proposal state: ' + expected.join(', '));
}

async function openTask(page, title, proposalId) {
  return eventually(async () => {
    await sync(page);
    await page.goto(`${BASE}#/tasks`);
    await page.waitForSelector('#tasks-list', { timeout: 30000 });
    await pause(1500);
    for (const li of await page.$$('#tasks-list li')) {
      if ((await li.evaluate(e => e.innerText)).includes(title) && (!proposalId || (await li.evaluate(e => e.getAttribute('data-record-id'))).includes(proposalId))) {
        await (await li.$('a')).click();
        await page.waitForSelector('.enketo form', {visible:true});
        if (proposalId) {
          await page.waitForFunction((pid, desiredStep) => {
            const form = document.querySelector('.enketo form');
            // Enketo calculated hidden fields live in its XML model; their HTML
            // input.value can remain empty. Read, never mutate, the real form model.
            const model = window.CHTCore?.debugFormModel?.();
            if (!model || !form || form.getBoundingClientRect().height <= 0) { return false; }
            const xml = new DOMParser().parseFromString(model, 'text/xml');
            const field = name => [...xml.documentElement.children].find(n => n.localName === name)?.textContent;
            return field('proposal_id') === pid && field('step') === desiredStep;
          }, {timeout:60000}, proposalId, title.startsWith('Submit') ? 'submit' : title.startsWith('Review') ? 'review' : 'decide');
        }
        return true;
      }
    }
    return false;
  }, 120000, `task "${title}"`);
}

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(d => d && d.type === 'data_record');
  const byForm = async form => (await all()).filter(d => d.form === form);
  const ackFor = async (eventId, result) => eventually(async () => {
    const a = (await byForm('carelink_oi_ack')).find(x => x.fields.event_id === eventId);
    return a && (!result || a.fields.result === result) && a;
  }, 90000, `server acknowledgement of ${eventId}`);
  const result = { timestamp: new Date().toISOString(), steps: [] };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, ...(detail ? { detail } : {}) }); console.log('✔', step); };
  const browser = await launch();
  // Repeat safely without deleting old plans or colliding with their confirmed assignments.
  const occupied = await releaseTestDays(couch, 'sabukari', CHO, process.env.CARELINK_ACCOUNT_PASSWORD);
  let day = isoDay(Date.now() + 86400000);
  while (occupied.has(day) || [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) {
    day = isoDay(Date.parse(day + 'T12:00:00Z') + 86400000);
  }
  const before = new Set((await byForm('carelink_oi_request')).map(d => d._id));
  try {
    // 1–3 Coordinator signs in to CareLink, opens the tab and reviews demand.
    const { page: coord } = await login(browser, 'rseidu');
    assert.match(await coord.evaluate(() => document.querySelector('.header')?.innerText || document.body.innerText), /Outreach Intelligence/);
    const demand = await openTab(coord, ['Community demand', 'Tolon', 'Gburimani', 'Dimabi', 'Available offline', 'Tolon District Hospital']);
    assert.match(demand, /Weeks reported/);
    await shot(coord, '1-demand');
    pass('1–3. Coordinator signed in to CareLink, opened the Outreach Intelligence tab and reviewed demand for Tolon, Gburimani and Dimabi');

    // 4. Generate a real optimised schedule (request form → server optimiser → proposal).
    await coord.evaluate(() => [...document.querySelector('cht-carelink-outreach-intelligence').shadowRoot.querySelectorAll('button')].find(b => b.textContent === 'Generate outreach plan').click());
    await coord.waitForSelector('.enketo form');
    await setValue(coord, '/data/planning_date', day);
    await check(coord, '/data/season', 'dry');
    await check(coord, '/data/staff_available_f1', CHO);
    await check(coord, '/data/hours_start', '0800');
    await check(coord, '/data/hours_end', '1400');
    await check(coord, '/data/vehicles_f1', MOTORBIKE);
    await check(coord, '/data/use_synthetic_history', 'yes');
    await coord.type('[name="/data/fairness_weight"]', '0.5');
    await shot(coord, '2-request');
    await submitForm(coord);
    await sync(coord);
    const request = await eventually(async () => (await byForm('carelink_oi_request')).find(r => !before.has(r._id)), 60000, 'the request on the server');
    assert.equal(request.fields.actor, 'rseidu');
    const uiProposal = await eventually(async () => (await byForm('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${request._id}`), 90000, 'the proposal');
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(uiProposal.fields.schedule.status));
    assert.equal(uiProposal.fields.schedule.solver, 'OR-Tools CP-SAT');
    assert.equal(uiProposal.fields.includes_test_records, false, 'a plan requested through the form never counts test records');
    await openPlan(coord, uiProposal._id, ['Outreach plan · ', 'Planned visits', 'Draft', 'Fairness and underserved communities', 'All planning limits']);
    await shot(coord, '3-schedule');
    pass('4. The server optimiser (OR-Tools CP-SAT) produced the plan from operational records and delivered it back into CareLink', {
      served: uiProposal.fields.schedule.served, summary: uiProposal.fields.explanation.summary });

    const asUser = async (user, doc) => {
      const r = await fetch(`${BASE}medic/_bulk_docs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${user}:${process.env.CARELINK_ACCOUNT_PASSWORD}`).toString('base64') }, body: JSON.stringify({ docs: [doc] }) });
      return (await r.json())[0];
    };
    // 4b. Operational demand leaves this suite's test households out, so the rest of the flow follows a plan
    // requested through the CHT API as the coordinator and labelled as a test plan (include_test_records).
    const testRequest = await asUser('rseidu', { _id: `oi-request-test-${Date.now()}`, type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(),
      contact: { _id: person('rseidu') }, fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: day, season: 'dry', staff_available: CHO,
        hours_start: '0800', hours_end: '1400', vehicles: MOTORBIKE, use_synthetic_history: 'yes', fairness_weight: '0.5', guarantee_communities: '', include_test_records: 'yes' } });
    const proposal = await eventually(async () => (await byForm('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${testRequest.id}`), 90000, 'the test-plan proposal');
    assert.ok(proposal.fields.schedule.trips.length, 'the test plan has no trips');
    await openPlan(coord, proposal._id, ['Test plan', 'Draft']);
    pass('4b. A labelled test plan (including this suite\'s households) was generated for the rest of the flow and shown as "Test plan" in the tab');

    // 5. Submit the plan (task → form → server acknowledgement).
    await openTask(coord, 'Submit outreach plan for review', proposal._id);
    await submitForm(coord);
    await sync(coord);
    const submit = await eventually(async () => (await byForm('carelink_oi_review')).find(e => e.fields.proposal_id === proposal._id && e.fields.action === 'submit'), 60000, 'submit event');
    assert.equal((await ackFor(submit._id)).fields.result, 'accepted');
    assert.ok(!(await openPlan(coord, proposal._id, ['Awaiting review'])).includes('Review this plan'), 'the coordinator is not offered the review of their own plan');
    pass('5. Coordinator submitted the plan; the server accepted it (state: proposed)');

    // 6–7. Supervisor signs in to the same application, reviews, then approves while offline.
    const { page: sup } = await login(browser, 'mtahiru');
    await openTask(sup, 'Review outreach plan', proposal._id);
    await submitForm(sup);
    await sync(sup);
    const review = await eventually(async () => (await byForm('carelink_oi_review')).find(e => e.fields.proposal_id === proposal._id && e.fields.action === 'review'), 60000, 'review event');
    assert.equal((await ackFor(review._id)).fields.result, 'accepted');
    await openTask(sup, 'Approve or reject outreach plan', proposal._id);
    await sup.setOfflineMode(true);
    await check(sup, '/data/decision', 'approve');
    await sup.type('[name="/data/notes"]', 'Approved: CHO and motorbike confirmed for the day.');
    await submitForm(sup);
    const offline = await openPlan(sup, proposal._id, ['waiting to sync', 'Awaiting approval']);
    // The status and confirmation lines, not free-text notes (the supervisor's note may itself say "Approved").
    assert.ok(!offline.includes('Approved. The assigned CHO') && offline.includes('Awaiting approval'), 'an offline approval is never shown as accepted');
    assert.ok(!(await byForm('carelink_oi_review')).some(e => e.fields.proposal_id === proposal._id && e.fields.action === 'approve'), 'not on the server yet');
    await shot(sup, '4-approved-offline-pending');
    pass('6–7. Supervisor reviewed, then approved while offline: shown as "waiting to sync", still "Awaiting approval", not on the server');

    await sup.setOfflineMode(false);
    await sync(sup);
    const approve = await eventually(async () => (await byForm('carelink_oi_review')).find(e => e.fields.proposal_id === proposal._id && e.fields.action === 'approve'), 60000, 'approve event');
    assert.equal(approve.fields.actor, 'mtahiru');
    assert.equal((await ackFor(approve._id)).fields.result, 'accepted');
    await sync(sup);
    await openPlan(sup, proposal._id, ['Approved. The assigned CHO']);
    await shot(sup, '5-approved-on-server');
    pass('8. After synchronisation the server validated the approval; the tab now shows "Approved"');

    // 8b. Recorded securely: only the service account can write acknowledgements; authors cannot be forged.
    const forgedAck = await asUser('mtahiru', { type: 'data_record', form: 'carelink_oi_ack', reported_date: Date.now(), contact: { _id: person('mtahiru') }, fields: { patient_id: FACILITY, proposal_id: proposal._id, result: 'accepted' } });
    assert.equal(forgedAck.error, 'forbidden');
    const forgedActor = await asUser('mtahiru', { type: 'data_record', form: 'carelink_oi_review', reported_date: Date.now(), contact: { _id: person('mtahiru') }, fields: { patient_id: FACILITY, proposal_id: proposal._id, action: 'approve', actor: 'kboateng', expected_event: approve._id } });
    assert.equal(forgedActor.error, 'forbidden');
    pass('8b. A supervisor cannot write a server acknowledgement or a decision in someone else\'s name (rejected by CouchDB)');

    // 9. The authorised CHO receives the corresponding task.
    const assignments = await eventually(async () => { const a = (await byForm('carelink_oi_assignment')).filter(x => x.fields.proposal_id === proposal._id); return a.length && a; }, 60000, 'assignments');
    const workers = new Set(assignments.map(a => a.fields.worker_id));
    assert.deepEqual([...workers], [CHO]);
    const user = 'sabukari';
    const mine = assignments;
    const { page: cho } = await login(browser, user);
    await cho.goto(`${BASE}#/tasks`);
    const tasks = await eventually(async () => { await sync(cho); await cho.goto(`${BASE}#/tasks`); await pause(2000); const ids = await cho.evaluate(() => [...document.querySelectorAll('#tasks-list li')].map(li=>li.getAttribute('data-record-id')||'')); const t = await cho.evaluate(() => document.body.innerText); return mine.every(a => ids.filter(id=>id.startsWith(a._id + '~')).length === 1) && t.includes('Planned outreach day') && t; }, 90000, 'the CHO task');
    assert.ok(!(await cho.evaluate(() => document.body.innerText)).includes('Outreach Intelligence'), 'CHOs do not see the planning tab');
    await shot(cho, '6-cho-task');
    pass(`9. ${user} received ${mine.length} "Planned outreach day" task(s) from the approved plan; the planning tab is hidden from CHOs`, { communities: mine.map(a => a.fields.community_name) });

    // Conflicts, separation of duties and confirmed assignments (second plan, same day, via the CHT API as each user).
    const req2 = await asUser('rseidu', { type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: day, season: 'dry', staff_available: CHO,
        hours_start: '0800', hours_end: '1400', vehicles: MOTORBIKE, use_synthetic_history: 'yes', fairness_weight: '0.5', guarantee_communities: '', include_test_records: 'yes' } });
    const proposal2 = await eventually(async () => (await byForm('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${req2.id}`), 90000, 'second proposal');
    const kept = mine.every(a => proposal2.fields.schedule.trips.some(t => t.worker === a.fields.worker_id && (t.served[a.fields.patient_id] || 0) >= 1));
    assert.ok(kept, 'the already-approved assignments are fixed inputs of the new plan');
    const ev = (user, action, expected, extra = {}) => asUser(user, { type: 'data_record', form: 'carelink_oi_review', content_type: 'xml', reported_date: Date.now(), contact: { _id: person(user) },
      fields: { patient_id: FACILITY, proposal_id: proposal2._id, action, actor: user, expected_event: expected, ...extra } });
    const s2 = await ev('rseidu', 'submit', proposal2._id);
    await ackFor(s2.id, 'accepted');
    // Two review decisions on the same step at once (for example from two devices): neither may win silently.
    const [r1, r2] = await Promise.all([ev('mtahiru', 'review', s2.id), ev('mtahiru', 'review', s2.id)]);
    assert.equal((await ackFor(r1.id)).fields.result, 'conflict');
    assert.equal((await ackFor(r2.id)).fields.result, 'conflict');
    const own = await ev('rseidu', 'review', s2.id);
    assert.equal(own.error, 'forbidden', 'coordinators cannot submit review decisions to the server');
    pass('10a. Two review decisions on the same step at once: both marked "conflict", neither applied; the coordinator reviewing their own plan is rejected; approved assignments stay fixed in the next plan');

    // 10. First VERIFY the approval reached this device, then go offline.
    await eventually(async () => {
      await sync(coord);
      await coord.goto(TAB);
      await coord.waitForSelector('cht-carelink-outreach-intelligence');
      return coord.evaluate(async pid => {
        const e = document.querySelector('cht-carelink-outreach-intelligence');
        return (await e.reports(['carelink_oi_ack'])).some(a => a.fields.proposal_id === pid && a.fields.state_after === 'approved' && a.fields.result === 'accepted');
      }, proposal._id);
    }, 90000, 'the accepted approval to synchronize to the coordinator device');
    await coord.setOfflineMode(true);
    await coord.reload({ waitUntil: 'domcontentloaded' });
    await coord.waitForSelector('.app-root.bootstrapped', { timeout: 60000 });
    await openTab(coord, ['Available offline', 'Outreach plan · ']);
    await coord.evaluate(pid => {
      const e = document.querySelector('cht-carelink-outreach-intelligence');
      const button = [...e.shadowRoot.querySelectorAll('button[data-proposal-id]')].find(b => b.dataset.proposalId === pid);
      if (!button) { throw Error('The approved proposal is not cached offline'); }
      button.click();
    }, proposal._id);
    await coord.waitForFunction(pid => {
      const section = document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.querySelector('[data-plan-id="' + pid + '"]');
      return section && section.textContent.includes('Approved. The assigned CHO');
    }, {timeout:60000}, proposal._id);
    const off = await tabText(coord);
    assert.ok(off.includes('Tolon'));
    await shot(coord, '7-offline');
    pass('10. With the network off and the app reloaded, the coordinator still reads the demand, the approved plan and its audit trail');
    await coord.setOfflineMode(false);
    result.proposal = proposal._id;

    // 11. The CHO records the planned outreach day from the task; the record names the assignment and the task resolves.
    const dayTask = mine[0];
    await eventually(async () => {
      await sync(cho);
      await cho.goto(`${BASE}#/tasks`);
      await pause(2000);
      for (const li of await cho.$$('#tasks-list li')) {
        if ((await li.evaluate(e => e.getAttribute('data-record-id') || '')).startsWith(dayTask._id + '~')) { await (await li.$('a')).click(); return true; }
      }
      return false;
    }, 90000, 'the planned outreach day task');
    await cho.waitForSelector('.enketo form', { visible: true });
    await check(cho, '/data/outcome', 'done');
    await submitForm(cho);
    await sync(cho);
    const outreachDay = await eventually(async () => (await byForm('carelink_oi_outreach_day')).find(r => r.fields.assignment_id === dayTask._id), 60000, 'the outreach-day record');
    assert.equal(outreachDay.fields.proposal_id, proposal._id);
    await eventually(async () => { await cho.goto(`${BASE}#/tasks`); await pause(2000); return !(await cho.evaluate(id => [...document.querySelectorAll('#tasks-list li')].some(li => (li.getAttribute('data-record-id') || '').startsWith(id + '~')), dayTask._id)); }, 60000, 'the outreach-day task to resolve');
    pass('11. CHO recorded the planned outreach day as done; the record links the assignment and approved plan, and the task resolved');

    // 12. Further planning cycles never duplicate assignments.
    await pause(20000);
    const finalAssignments = await byForm('carelink_oi_assignment');
    assert.equal(finalAssignments.filter(a => a.fields.proposal_id === proposal._id).length, mine.length);
    // Only days not yet recorded book a worker; a recorded (released) day may be planned again.
    const recordedDays = new Set((await byForm('carelink_oi_outreach_day')).map(r => r.fields.assignment_id));
    const slots = finalAssignments.filter(a => !recordedDays.has(a._id)).map(a => `${a.fields.worker_id}|${a.fields.date}|${a.fields.patient_id}`);
    assert.equal(new Set(slots).size, slots.length, 'a worker is assigned twice to the same community and day');
    pass(`12. After further worker cycles the plan still has ${mine.length} assignment(s) and no worker/day/community is assigned twice`);

    // 13. Request flow: the volunteer's accepted request is either taken on by an approved outreach day or
    // assigned and scheduled by the coordinator; either way the CHO's visit completes it.
    const docs = (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc);
    const open = r => { const s = w.workflow(r, docs); return s.state === 'accepted' || (s.state === 'scheduled' && s.last.form === w.FORMS.planLink); };
    const household = docs.filter(d => d.contact_type === 'carelink_household' && d.parent && d.parent._id === 'carelink-community-tolon')
      .sort((a, b) => b.reported_date - a.reported_date)
      .find(h => docs.some(r => r.form === w.FORMS.request && r.fields.patient_id === h._id && open(r)));
    assert.ok(household, 'Run npm run volunteer-flow first: no accepted Tolon request found.');
    const helpRequest = docs.find(r => r.form === w.FORMS.request && r.fields.patient_id === household._id && open(r));
    const byPlan = w.workflow(helpRequest, docs).state === 'scheduled';
    const state = async () => { const all = (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc); return w.workflow(helpRequest, all); };
    const householdTask = async (page, title) => eventually(async () => {
      await sync(page);
      await page.goto(`${BASE}#/tasks`);
      await pause(2000);
      for (const li of await page.$$('#tasks-list li')) {
        const t = await li.evaluate(e => e.innerText);
        if (t.includes(household.name) && t.includes(title)) { await (await li.$('a')).click(); await page.waitForSelector('.enketo form', { visible: true }); return true; }
      }
      return false;
    }, 90000, `task "${title}" for ${household.name}`);
    for (const [status, note] of byPlan ? [] : [['assigned', 'Assigned to the Tolon CHO.'], ['scheduled', 'Visit confirmed with the household for today.']]) {
      await householdTask(coord, 'Review outreach request');
      await check(coord, '/data/status', status);
      await coord.waitForSelector(`input[name="/data/assigned_worker_id"][value="${CHO}"]`, { visible: true });
      await check(coord, '/data/assigned_worker_id', CHO);
      if (status === 'scheduled') { await setValue(coord, '/data/scheduled_date', isoDay()); }
      await coord.type('[name="/data/outcome_note"]', note);
      await submitForm(coord);
      await sync(coord);
      await eventually(async () => (await state()).state === status, 60000, `request ${status}`);
    }
    await householdTask(cho, 'Household visit planned');
    await setValue(cho, '/data/visit_date', isoDay());
    await check(cho, '/data/visit_type', 'outreach_contact');
    await check(cho, '/data/status', 'completed');
    await check(cho, '/data/followup_required', 'no');
    await check(cho, '/data/referral_recorded', 'no');
    await cho.type('[name="/data/outcome_note"]', 'Household visited; antenatal booking arranged at the facility.');
    await submitForm(cho);
    await sync(cho);
    const done = await eventually(async () => { const s = await state(); return s.state === 'completed' && s; }, 60000, 'request completed');
    assert.equal(done.last.form, w.FORMS.visit);
    assert.equal(done.last.fields.request_id, helpRequest._id);
    assert.equal(done.last.fields.patient_id, household._id);
    const { page: volunteer } = await login(browser, 'aiddrisu');
    await eventually(async () => { await sync(volunteer); await volunteer.goto(`${BASE}#/contacts/${household._id}`); await pause(2500); return (await text(volunteer)).includes('Acknowledged by the facility: completed'); }, 90000, 'completed status on the volunteer phone');
    await shot(volunteer, '8-volunteer-completed');
    pass(`13. ${byPlan ? 'The approved outreach day scheduled' : 'The coordinator assigned and scheduled'} the volunteer's request; the CHO's visit completed it against the same household and request; the volunteer sees "completed"`, { household: household.name });
  } catch (e) {
    result.error = e.message;
    process.exitCode = 1;
    result.stack = e.stack;
    result.browser = [];
    for (const context of browser.browserContexts()) {
      for (const page of await context.pages()) {
        if (!page.url().startsWith(BASE)) { continue; }
        result.browser.push({url:page.url(),text:await page.evaluate(()=>document.body.innerText.slice(-1800)).catch(()=>null)});
        await page.screenshot({path:path.join(evidence,`oi-cht-failure-${result.browser.length}.png`),fullPage:true}).catch(()=>{});
      }
    }
    console.error('✖', e.message, e.stack.split('\n').find(l=>l.includes('oi-cht-flow.js:')));
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(evidence, 'oi-cht-flow.json'), JSON.stringify(result, null, 2) + '\n');
  }
})();
