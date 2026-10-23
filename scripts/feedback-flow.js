'use strict';
/*
  The outreach feedback loop through the real CHT application (npm run feedback-flow), checked against
  the server at every step:
   1. the Tolon volunteer requests routine care for two households (one through the UI);
   2. the coordinator receives and accepts both;
   3. the planning engine creates a plan (a labelled test plan, so these test households may count);
   4. the supervisor reviews and approves it independently: two simultaneous approvals are both refused
      as a conflict, then an approval saved offline counts only after it syncs;
   5. the approved outreach day takes on both open requests; a second plan for another day cannot take them;
   6. the CHO completes one household's visit, offline, then syncs;
   7. that request is completed through its own lifecycle; 8. the other stays open;
   9. the day shows planned 2, completed 1, still open 1 (the outreach-day record closes nothing);
  10. the change reaches the next forecasting input (before/after feature snapshots);
  11. re-sending the same visit changes nothing.
  Households are marked record_origin 'test' and stay out of operational counts throughout.
  Needs CHT_COUCH_URL, CARELINK_ACCOUNT_PASSWORD and the planning worker (npm run oi-worker -- --watch 5).
  Writes evidence/feedback-flow.json, evidence/feedback-snapshots.json and evidence/feedback-*.png.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launch, login, text, evidence, markTestRecords, releaseTestDays, submitHousehold } = require('./browser-helpers');
const { connection } = require('./client');
const w = require('../lib/workflow');
const { exportAggregates, scopeToFacility } = require('../lib/oi-export');
const { dayPlanId, linkId } = require('../lib/oi-links');
const { isoDay } = require('../lib/schedules');

const BASE = 'http://localhost:5988/';
const TAB = `${BASE}#/ui-extensions/carelink-outreach-intelligence`;
const FACILITY = 'carelink-facility-tolon-hospital';
const TOLON = 'carelink-community-tolon';
const CHO = 'carelink-person-sabukari';
const MOTORBIKE = 'carelink-facility-tolon-hospital-motorbike-1';
const person = username => `carelink-person-${username}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, what, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const v = await fn(); if (v) { return v; } await pause(1500); }
  throw Error('Timed out waiting for ' + what);
}
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `feedback-${name}.png`), fullPage: true });
async function check(page, name, value) {
  const sel = `input[name="${name}"][value="${value}"], input[data-name="${name}"][value="${value}"]`;
  // Scroll the option clear of CHT's sync toast before clicking it.
  for (let i = 0; i < 3; i++) { await page.$eval(sel, e => e.scrollIntoView({ block: 'center' })); await page.click(sel); await pause(300); if (await page.$eval(sel, e => e.checked)) { return; } }
  throw Error(`Could not select ${value} for ${name}`);
}
const setValue = (page, name, value) => page.evaluate((n, v) => { window.$(`[name="${n}"]`).val(v).trigger('change'); }, name, value);
async function submit(page) {
  await page.click('.form-footer .submit');
  await page.waitForFunction(() => !document.querySelector('.enketo form') || document.querySelector('.invalid-constraint, .invalid-required'), { timeout: 30000 });
  const invalid = await page.$('.invalid-constraint, .invalid-required');
  if (invalid) { throw Error('Form rejected: ' + await invalid.evaluate(e => e.closest('.question')?.innerText)); }
}
async function sync(page) {
  await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
  await pause(2500);
}
// Opens the first task whose text has every given string (and, for plan tasks, the given proposal in its form).
async function openTask(page, expected, proposalId) {
  await eventually(async () => {
    await sync(page);
    await page.goto(`${BASE}#/tasks`);
    await page.waitForSelector('#tasks-list', { timeout: 30000 });
    await pause(1500);
    for (const li of await page.$$('#tasks-list li')) {
      const t = await li.evaluate(e => e.innerText + ' ' + (e.getAttribute('data-record-id') || ''));
      if (expected.every(x => t.includes(x))) { await (await li.$('a')).click(); return true; }
    }
    return false;
  }, `task ${expected.join(' / ')}`, 120000);
  await page.waitForSelector('.enketo form', { visible: true });
  if (proposalId) {
    await page.waitForFunction(pid => {
      const model = window.CHTCore?.debugFormModel?.();
      if (!model) { return false; }
      const xml = new DOMParser().parseFromString(model, 'text/xml');
      return [...xml.documentElement.children].find(n => n.localName === 'proposal_id')?.textContent === pid;
    }, { timeout: 60000 }, proposalId);
  }
}
const tabText = page => page.evaluate(() => document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || '');

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = async (username, docs) => (await fetch(`${BASE}medic/_bulk_docs`, { method: 'POST', body: JSON.stringify({ docs }), headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json' } })).json();
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(Boolean);
  const reports = async form => (await all()).filter(d => d.type === 'data_record' && d.form === form);
  const stateOf = async request => { const docs = await all(); return w.workflow(request, docs.filter(d => d.fields && d.fields.patient_id === request.fields.patient_id)); };
  const today = isoDay();
  const tolonLineage = { _id: TOLON, parent: { _id: FACILITY, parent: { _id: 'carelink-district-tolon', parent: { _id: 'carelink-region-northern' } } } };
  const result = { timestamp: new Date().toISOString(), steps: [] };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, ...(detail ? { detail } : {}) }); console.log('✔ ' + step); };
  const snapshots = {};
  // Forecasting inputs for Tolon, with and without this run's test households, and the forecaster's view of them.
  const snapshot = async name => {
    const scoped = scopeToFacility(await all(), FACILITY);
    const withTests = exportAggregates(scoped, today, 'snapshot', { includeTestRecords: true }).dataset;
    const operational = exportAggregates(scoped, today, 'snapshot').dataset;
    const file = path.join(evidence, `feedback-dataset-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(withTests));
    const forecastView = JSON.parse(execFileSync(path.join(__dirname, '..', 'outreach-intelligence', '.venv', 'bin', 'python'),
      ['-W', 'ignore', '-m', 'carelink_oi.features', file, '--simulated'], { cwd: path.join(__dirname, '..', 'outreach-intelligence') }).toString());
    const tolon = d => ({ pending_now: d.current.find(c => c.community_id === TOLON).pending_followups,
      requests_this_week: d.history.filter(r => r.community_id === TOLON && r.period_start === d.history.map(x => x.period_start).sort().pop()).reduce((n, r) => n + r.requests_created, 0),
      visits_completed_this_week: d.history.filter(r => r.community_id === TOLON).reduce((n, r) => n + r.visits_completed, 0) });
    snapshots[name] = { with_test_records: tolon(withTests), operational: tolon(operational), forecaster_with_test_records: forecastView.communities.Tolon,
      semantic: JSON.stringify([withTests.history, withTests.current]) };
    return snapshots[name];
  };
  const browser = await launch();
  try {
    // Earlier runs may have left open requests on test households in Tolon; close them through the lifecycle
    // so this run's two requests are the only open ones (oldest-first selection would otherwise take older ones).
    const before = await all();
    const testHouses = new Set(before.filter(d => d.contact_type === 'carelink_household' && d.record_origin === 'test' && d.parent && d.parent._id === TOLON).map(d => d._id));
    const leftovers = before.filter(d => d.form === w.FORMS.request && testHouses.has(d.fields.patient_id)).map(r => [r, w.workflow(r, before.filter(d => d.fields && d.fields.patient_id === r.fields.patient_id))])
      .filter(([, s]) => !s.conflict && !w.TERMINAL.includes(s.state));
    if (leftovers.length) {
      const closed = await asUser('rseidu', leftovers.map(([r, s]) => ({ _id: `close-${r._id}-${Date.now()}`, type: 'data_record', form: w.FORMS.coordination, content_type: 'xml',
        reported_date: Date.now(), contact: { _id: person('rseidu') }, fields: { patient_id: r.fields.patient_id, request_id: r._id, expected_event: s.last._id, status: 'cancelled',
          outcome_note: 'Closed: left open by an earlier regression run.' } })));
      assert.ok(closed.every(x => x.ok), JSON.stringify(closed));
    }
    result.closed_leftover_test_requests = leftovers.length;
    await snapshot('0-before');

    // 1. Volunteer: household A and its request through the UI; household B and its request through the CHT API as the same user.
    const families = ['Abdulai', 'Sulemana', 'Fuseini', 'Dawuda', 'Yakubu', 'Iddrisu', 'Salifu', 'Tahiru', 'Haruna', 'Osman', 'Zakaria', 'Inusah', 'Musah', 'Baba', 'Awal', 'Yahaya', 'Bawa', 'Mumuni', 'Adam', 'Ziblim'];
    const taken = new Set(before.filter(d => d.contact_type === 'carelink_household').map(d => d.name.split(' ')[0]));
    // Single family names first, then two-family names once earlier runs have used them all.
    const [famA, famB] = [...families, ...families.flatMap(a => families.filter(b => b !== a).map(b => `${a}-${b}`))].filter(f => !taken.has(f));
    assert.ok(famA && famB, 'No unused family names left for this run');
    const house = Date.now() % 800 + 100;
    const nameA = `${famA} Household, House ${house}`;
    const nameB = `${famB} Household, House ${house + 1}`;
    const { page: volunteer } = await login(browser, 'aiddrisu');
    await volunteer.goto(`${BASE}#/contacts/${TOLON}/add/carelink_household`);
    await volunteer.waitForSelector('[name="/data/carelink_household/name"]');
    await volunteer.type('[name="/data/carelink_household/name"]', nameA);
    await submitHousehold(volunteer, nameA);
    const householdA = await eventually(async () => (await all()).find(d => d.contact_type === 'carelink_household' && d.name === nameA), 'household A on server');
    await markTestRecords(couch, [householdA._id]);
    await volunteer.goto(`${BASE}#/contacts/${householdA._id}/report/carelink_request`);
    await volunteer.waitForSelector('.enketo form .question');
    await check(volunteer, '/data/consent', 'yes');
    await check(volunteer, '/data/care_need', 'child_welfare');
    await check(volunteer, '/data/followup_type', 'visit');
    await check(volunteer, '/data/contact_method', 'community_contact');
    await check(volunteer, '/data/access_barrier', 'distance');
    await check(volunteer, '/data/travel_time', 'over_60');
    await submit(volunteer);
    const householdB = { _id: `household-${Date.now()}`, type: 'contact', contact_type: 'carelink_household', name: nameB, parent: tolonLineage,
      responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', registered_by: person('aiddrisu'), record_origin: 'test', reported_date: Date.now() };
    const requestBDoc = { _id: `request-${Date.now()}`, type: 'data_record', form: w.FORMS.request, content_type: 'xml', reported_date: Date.now(), contact: { _id: person('aiddrisu') },
      fields: { patient_id: householdB._id, household_name: nameB, community_name: 'Tolon', created_by: person('aiddrisu'), consent: 'yes', care_need: 'antenatal_care',
        followup_type: 'visit', contact_method: 'community_contact', access_barrier: 'transport_cost', travel_time: '30_to_60' } };
    const savedB = await asUser('aiddrisu', [householdB, requestBDoc]);
    assert.ok(savedB.every(x => x.ok), JSON.stringify(savedB));
    const requestA = await eventually(async () => (await reports(w.FORMS.request)).find(r => r.fields.patient_id === householdA._id), 'request A on server');
    const requestB = (await reports(w.FORMS.request)).find(r => r._id === requestBDoc._id);
    const s1 = await snapshot('1-requests-recorded');
    pass('1. Volunteer recorded two routine requests (child welfare; antenatal) for two Tolon households', { households: [nameA, nameB] });

    // 2. Coordinator receives both: accepts A through the UI task, B through the CHT API.
    const { page: coord } = await login(browser, 'rseidu');
    await openTask(coord, [nameA, 'Review outreach request']);
    await check(coord, '/data/status', 'accepted');
    await coord.type('[name="/data/outcome_note"]', 'Received; will be included in outreach planning.');
    await submit(coord);
    const acceptB = await asUser('rseidu', [{ _id: `accept-${requestB._id}`, type: 'data_record', form: w.FORMS.coordination, content_type: 'xml', reported_date: Date.now(),
      contact: { _id: person('rseidu') }, fields: { patient_id: householdB._id, request_id: requestB._id, expected_event: requestB._id, status: 'accepted', outcome_note: 'Received.' } }]);
    assert.ok(acceptB[0].ok);
    await eventually(async () => (await stateOf(requestA)).state === 'accepted' && (await stateOf(requestB)).state === 'accepted', 'both requests accepted');
    pass('2. Coordinator received both synchronized requests and accepted them (append-only coordination events)');

    // 3. The planning engine creates a plan for the next free weekday (a labelled test plan, so these households count).
    const busy = await releaseTestDays(couch, 'sabukari', CHO, password);
    let day = isoDay(Date.now() + 86400000);
    while (busy.has(day) || [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) { day = isoDay(Date.parse(day + 'T12:00:00Z') + 86400000); }
    assert.ok(day <= isoDay(Date.now() + 30 * 86400000), `The CHO has approved outreach on every weekday in the next 30 days (${day}); her visit task would not show yet.`);
    const planRequest = { _id: `oi-request-${Date.now()}`, type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: day, season: 'dry', staff_available: CHO, hours_start: '0800', hours_end: '1400',
        vehicles: MOTORBIKE, use_synthetic_history: 'no', fairness_weight: '0.5', guarantee_communities: '', include_test_records: 'yes' } };
    assert.ok((await asUser('rseidu', [planRequest]))[0].ok);
    const proposal = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${planRequest._id}`), 'the proposal');
    const served = proposal.fields.schedule.trips.reduce((n, t) => n + (t.served[TOLON] || 0), 0);
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(proposal.fields.schedule.status) && served >= 2, `the plan should visit Tolon for both requests (served ${served})`);
    assert.equal(proposal.fields.includes_test_records, true);
    pass(`3. The engine (OR-Tools CP-SAT) planned ${served} routine item(s) in Tolon on ${day}, from the synchronized requests`);

    // 4. Submission (UI), review (UI), two simultaneous approvals (refused), then an offline approval that syncs.
    await openTask(coord, ['Submit outreach plan for review', proposal._id], proposal._id);
    await submit(coord);
    const ack = async (eventId, result) => eventually(async () => { const a = (await reports('carelink_oi_ack')).find(x => x.fields.event_id === eventId); return a && (!result || a.fields.result === result) && a; }, `acknowledgement of ${eventId}`);
    const event = async action => eventually(async () => (await reports('carelink_oi_review')).filter(e => e.fields.proposal_id === proposal._id && e.fields.action === action).sort((a, b) => b.reported_date - a.reported_date)[0], `${action} event`);
    await ack((await event('submit'))._id, 'accepted');
    const { page: sup } = await login(browser, 'mtahiru');
    await openTask(sup, ['Review outreach plan', proposal._id], proposal._id);
    await submit(sup);
    await sync(sup);
    const review = await event('review');
    await ack(review._id, 'accepted');
    const approval = n => ({ _id: `approve-${n}-${Date.now()}`, type: 'data_record', form: 'carelink_oi_review', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('mtahiru') },
      fields: { patient_id: FACILITY, proposal_id: proposal._id, action: 'approve', actor: 'mtahiru', expected_event: review._id, notes: 'Second device.' } });
    const [c1, c2] = await asUser('mtahiru', [approval(1), approval(2)]);
    assert.equal((await ack(c1.id)).fields.result, 'conflict');
    assert.equal((await ack(c2.id)).fields.result, 'conflict');
    await openTask(sup, ['Approve or reject outreach plan', proposal._id], proposal._id);
    await sup.setOfflineMode(true);
    await check(sup, '/data/decision', 'approve');
    await sup.type('[name="/data/notes"]', 'Approved: CHO and motorbike confirmed.');
    await submit(sup);
    await pause(3000);
    assert.ok(!(await reports('carelink_oi_review')).some(e => e.fields.proposal_id === proposal._id && e.fields.action === 'approve' && e.fields.notes === 'Approved: CHO and motorbike confirmed.'), 'offline approval reached the server early');
    await sup.setOfflineMode(false);
    await sync(sup);
    const approved = await eventually(async () => (await reports('carelink_oi_review')).find(e => e.fields.proposal_id === proposal._id && e.fields.notes === 'Approved: CHO and motorbike confirmed.'), 'offline approval to sync');
    await ack(approved._id, 'accepted');
    pass('4. Coordinator submitted and the supervisor independently reviewed; two simultaneous approvals were both refused as a conflict; an approval saved offline was accepted only after it synced');

    // 5. The approved day takes on both open requests; a second approved plan cannot take them while the day is pending.
    const assignment = await eventually(async () => (await reports('carelink_oi_assignment')).find(a => a.fields.proposal_id === proposal._id && a.fields.patient_id === TOLON), 'the Tolon assignment');
    const dayPlan = await eventually(async () => (await reports('carelink_oi_day_plan')).find(p => p._id === dayPlanId(assignment._id)), 'the day plan');
    assert.deepEqual([...dayPlan.fields.request_ids].sort(), [requestA._id, requestB._id].sort());
    await eventually(async () => (await stateOf(requestA)).last._id === linkId(assignment._id, requestA._id) && (await stateOf(requestB)).last._id === linkId(assignment._id, requestB._id), 'both request links');
    assert.equal((await stateOf(requestA)).state, 'scheduled');
    // The second plan only needs approving, so it takes a date beyond the CHO's 30-day task window and leaves near days free.
    let day2 = isoDay(Date.parse(day + 'T12:00:00Z') + 35 * 86400000);
    while ([0, 6].includes(new Date(day2 + 'T12:00:00Z').getUTCDay()) || busy.has(day2)) { day2 = isoDay(Date.parse(day2 + 'T12:00:00Z') + 86400000); }
    const second = { ...planRequest, _id: `oi-request-2-${Date.now()}`, reported_date: Date.now(), fields: { ...planRequest.fields, planning_date: day2, guarantee_communities: TOLON } };
    assert.ok((await asUser('rseidu', [second]))[0].ok);
    const proposal2 = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${second._id}`), 'the second proposal');
    const decide = async (user, action, expected) => (await asUser(user, [{ _id: `${action}-2-${Date.now()}`, type: 'data_record', form: 'carelink_oi_review', content_type: 'xml', reported_date: Date.now(),
      contact: { _id: person(user) }, fields: { patient_id: FACILITY, proposal_id: proposal2._id, action, actor: user, expected_event: expected, notes: 'Second day.' } }]))[0].id;
    const sub2 = await decide('rseidu', 'submit', proposal2._id); await ack(sub2, 'accepted');
    const rev2 = await decide('mtahiru', 'review', sub2); await ack(rev2, 'accepted');
    const app2 = await decide('mtahiru', 'approve', rev2);
    const app2Ack = await ack(app2);
    const plan2 = app2Ack.fields.result === 'accepted' ? await eventually(async () => (await reports('carelink_oi_day_plan')).find(p => p.fields.proposal_id === proposal2._id && p.fields.patient_id === TOLON), 'second day plan') : null;
    assert.ok(!plan2 || !plan2.fields.request_ids.some(id => [requestA._id, requestB._id].includes(id)), 'a request was planned twice');
    pass(`5. The approved day ${day} references exactly the two open requests (stable links in each request's lifecycle); a second approved plan for ${day2} took on neither`, {
      second_plan: app2Ack.fields.result === 'accepted' ? `approved, day plan holds ${plan2.fields.request_ids.length} request(s)` : `not approved: ${app2Ack.fields.reason}` });

    // 6. The CHO completes household A's visit offline, reloads, then syncs.
    const { page: cho } = await login(browser, 'sabukari');
    await openTask(cho, [nameA, 'Household visit planned']);
    await cho.setOfflineMode(true);
    await setValue(cho, '/data/visit_date', today);
    await check(cho, '/data/visit_type', 'outreach_contact');
    await check(cho, '/data/status', 'completed');
    await check(cho, '/data/followup_required', 'no');
    await check(cho, '/data/referral_recorded', 'no');
    await cho.type('[name="/data/outcome_note"]', 'Child welfare clinic visit arranged with the household.');
    await eventually(async () => (await cho.evaluate(() => window.CHTCore?.debugFormModel?.() || '')).includes(`<visit_date>${new Date().toISOString().slice(0, 10)}</visit_date>`), 'the visit date in the form model', 15000);
    await submit(cho);
    await cho.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await cho.waitForFunction(() => !!document.querySelector('.app-root.bootstrapped'), { timeout: 60000 });
    assert.ok(!(await reports(w.FORMS.visit)).some(v => v.fields.request_id === requestA._id), 'offline visit reached the server early');
    await cho.setOfflineMode(false);
    await sync(cho);
    const visit = await eventually(async () => (await reports(w.FORMS.visit)).find(v => v.fields.request_id === requestA._id), 'the visit on the server');
    assert.equal(visit.fields.actor, 'sabukari');
    assert.equal(visit.fields.expected_event, linkId(assignment._id, requestA._id));
    assert.equal(visit.fields.assignment_id, assignment._id);
    assert.equal(visit.fields.proposal_id, proposal._id);
    pass('6. CHO recorded household A\'s visit offline; after an offline reload it synced, stamped with her username and linked to the approved day');

    // 7–8. Only A is completed; B stays open.
    assert.equal((await stateOf(requestA)).state, 'completed');
    assert.equal((await stateOf(requestB)).state, 'scheduled');
    pass('7–8. Household A\'s request is completed through its own lifecycle; household B\'s request stays open (scheduled)');

    // 9. Day counts, before and after the CHO records the outreach day (which closes nothing).
    const dayCounts = async () => eventually(async () => {
      await sync(coord);
      await coord.goto(TAB);
      await coord.waitForSelector('cht-carelink-outreach-intelligence');
      await pause(2000);
      await coord.evaluate(pid => { const b = [...document.querySelector('cht-carelink-outreach-intelligence').shadowRoot.querySelectorAll('button[data-proposal-id]')].find(x => x.dataset.proposalId === pid); b && b.click(); }, proposal._id);
      await pause(1500);
      const t = await coord.evaluate(id => document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.querySelector(`[data-day-plan-id="${id}"]`)?.textContent || '', dayPlan._id);
      return t.includes('Planned 2 · completed 1 · unable 0 · partly 0 · still open 1') && t;
    }, 'day counts in the Outreach Intelligence tab', 120000);
    await dayCounts();
    await shot(coord, '1-day-counts');
    await openTask(cho, ['Planned outreach day', assignment._id]);
    const dayForm = await cho.evaluate(() => document.querySelector('.enketo form').innerText);
    assert.ok(dayForm.includes(nameA) && dayForm.includes(nameB), 'the outreach-day form does not list the planned households');
    await check(cho, '/data/outcome', 'partly');
    await cho.type('[name="/data/reason"]', 'One household not reached before the end of the day.');
    await submit(cho);
    await sync(cho);
    await eventually(async () => (await reports('carelink_oi_outreach_day')).find(r => r.fields.assignment_id === assignment._id), 'outreach day on server');
    assert.equal((await stateOf(requestB)).state, 'scheduled', 'recording the outreach day must not close requests');
    const recorded = await dayCounts();
    assert.match(recorded, /Outreach day recorded by the CHO/);
    pass('9. The day shows planned 2 · completed 1 · still open 1; the CHO\'s outreach-day form listed both households, and recording the day as partly done closed nothing');

    // 10. The updated workload reaches the next forecasting input.
    const s2 = await snapshot('2-after-visit');
    assert.equal(s2.with_test_records.pending_now, s1.with_test_records.pending_now - 1, 'completed request still counted as pending');
    assert.equal(s2.with_test_records.visits_completed_this_week, s1.with_test_records.visits_completed_this_week + 1);
    assert.equal(snapshots['1-requests-recorded'].with_test_records.pending_now, snapshots['0-before'].with_test_records.pending_now + 2, 'new requests did not add to the workload');
    assert.deepEqual(s2.operational, snapshots['0-before'].operational, 'test households changed operational demand');
    pass('10. Next forecasting input: pending Tolon work rose by 2 with the new requests and fell by 1 after the visit; visits completed rose by 1; operational demand (test records excluded) never changed', {
      before: snapshots['0-before'].with_test_records, requests: s1.with_test_records, after_visit: s2.with_test_records });

    // 11. Re-sending the identical visit changes nothing.
    const resend = await asUser('sabukari', [visit]);
    assert.ok(resend[0].error, 'a duplicate visit was accepted');
    await pause(12000); // two planning cycles
    assert.equal((await stateOf(requestA)).state, 'completed');
    assert.equal((await reports(w.FORMS.visit)).filter(v => v.fields.request_id === requestA._id).length, 1);
    assert.equal((await reports('carelink_oi_day_plan')).filter(p => p.fields.assignment_id === assignment._id).length, 1);
    const s3 = await snapshot('3-after-duplicate-sync');
    assert.equal(s3.semantic, s2.semantic, 'forecast inputs changed after a duplicate sync');
    pass(`11. Re-sending the same visit was refused (${resend[0].error}); state, day plan, links and forecast inputs are unchanged after further planning cycles`);
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error('✖ ' + e.message);
    const pages = (await Promise.all(browser.browserContexts().map(c => c.pages()))).flat();
    await Promise.all(pages.map((p, i) => p.screenshot({ path: path.join(evidence, `feedback-failure-${i + 1}.png`), fullPage: true }).catch(() => {})));
    process.exitCode = 1;
  } finally {
    await browser.close();
    for (const s of Object.values(snapshots)) { delete s.semantic; }
    fs.writeFileSync(path.join(evidence, 'feedback-snapshots.json'), JSON.stringify(snapshots, null, 2) + '\n');
    result.limits = ['Chrome DevTools network emulation, not a physical device.', 'Households and requests are made up and marked record_origin test.'];
    fs.writeFileSync(path.join(evidence, 'feedback-flow.json'), JSON.stringify(result, null, 2) + '\n');
  }
})();
