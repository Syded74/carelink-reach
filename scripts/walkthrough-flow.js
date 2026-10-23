'use strict';
/*
  One complete, reproducible CareLink Reach walkthrough in Tolon (npm run walkthrough-flow), through the
  real CHT interface where a person acts, checked against the server at every step:
   1. the volunteer registers a household and records a routine need (antenatal care, transport barrier);
   2. the CHO documents an ANC visit with a routine follow-up date for a mother in another household;
   3. the community's documented demand updates (requests, maternal follow-ups, encounters);
   4. the coordinator accepts the request; the engines produce a resource-feasible plan with explanations;
   5. the supervisor reviews and approves it independently (separation of duties enforced by the server);
   6. the CHO receives the household visit and the mother's follow-up as tasks on the approved day;
   7. the CHO completes the household visit and resolves the mother's ANC follow-up;
   8. what was not done stays open (the mother's missing-assessment obligation);
   9. the next planning run's inputs reflect the verified outcome.
  Generated people and households, marked record_origin 'test'; the plan opts in with include_test_records.
  Leftover open test work in Tolon from earlier runs is closed first through normal append-only events.
  Needs CHT_COUCH_URL, CARELINK_ACCOUNT_PASSWORD and the planning worker. Writes evidence/walkthrough-*.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, login, text, evidence, markTestRecords, releaseTestDays, submitHousehold } = require('./browser-helpers');
const { connection } = require('./client');
const w = require('../lib/workflow');
const mch = require('../lib/mch');
const mo = require('../lib/mch-outreach');
const { exportAggregates, scopeToFacility } = require('../lib/oi-export');
const { dayPlanId, dayProgress } = require('../lib/oi-links');
const { isoDay } = require('../lib/schedules');

const BASE = 'http://localhost:5988/';
const TOLON = 'carelink-community-tolon';
const FACILITY = 'carelink-facility-tolon-hospital';
const CHO = 'carelink-person-sabukari';
const MOTORBIKE = 'carelink-facility-tolon-hospital-motorbike-1';
const person = u => `carelink-person-${u}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, what, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const v = await fn(); if (v) { return v; } await pause(1500); }
  throw Error('Timed out waiting for ' + what);
}
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `walkthrough-${name}.png`), fullPage: true });
async function check(page, name, value) {
  const sel = `input[name="${name}"][value="${value}"], input[data-name="${name}"][value="${value}"]`;
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
const sync = async page => { await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); }); await pause(2500); };
// Opens the first task whose text (and record id) has every expected string; optionally picks an action.
async function openTask(page, expected, action) {
  await eventually(async () => {
    await sync(page);
    await page.goto(`${BASE}#/tasks`);
    await pause(2000);
    for (const li of await page.$$('#tasks-list li')) {
      const t = await li.evaluate(e => e.innerText + ' ' + (e.getAttribute('data-record-id') || ''));
      if (expected.every(x => t.includes(x))) { await (await li.$('a')).click(); return true; }
    }
    return false;
  }, `task ${expected.join(' / ')}`, 180000);
  await page.waitForSelector('.enketo form, li.actions a.btn');
  if (action) {
    await page.evaluate(label => [...document.querySelectorAll('li.actions a.btn')].find(a => a.innerText.trim() === label).click(), action);
  }
  await page.waitForSelector('.enketo form', { visible: true });
}

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = async (username, docs) => (await fetch(`${BASE}medic/_bulk_docs`, { method: 'POST', body: JSON.stringify({ docs }), headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json' } })).json();
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(Boolean);
  const reports = async form => (await all()).filter(d => d.type === 'data_record' && d.form === form);
  const today = isoDay();
  const run = Date.now();
  const tolonLineage = { _id: TOLON, parent: { _id: FACILITY, parent: { _id: 'carelink-district-tolon', parent: { _id: 'carelink-region-northern' } } } };
  const result = { timestamp: new Date().toISOString(), steps: [], snapshots: {} };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, ...(detail ? { detail } : {}) }); console.log('✔ ' + step); };
  const tolonInputs = async () => {
    const d = exportAggregates(scopeToFacility(await all(), FACILITY), today, 'walkthrough', { includeTestRecords: true }).dataset;
    const c = d.current.find(r => r.community_id === TOLON);
    return { encounters: c.pending_followups, open_requests: c.open_requests, open_maternal_followups: c.open_maternal_followups, open_child_followups: c.open_child_followups,
      unique_people: c.unique_people, encounters_request: c.encounters_request, encounters_anc: c.encounters_anc,
      visits_completed_this_week: d.history.filter(r => r.community_id === TOLON).slice(-1).reduce((n, r) => n + r.visits_completed, 0),
      followups_resolved_total: d.history.filter(r => r.community_id === TOLON).reduce((n, r) => n + r.followups_resolved, 0) };
  };
  const browser = await launch();
  try {
    // 0. Close open test work earlier runs left in Tolon (cancelled requests, resolved follow-ups: normal events).
    const before = await all();
    const contacts = new Map(before.filter(d => d.type === 'contact').map(d => [d._id, d]));
    const isTest = id => (contacts.get(id) || {}).record_origin === 'test';
    const openRequests = mo.openRequests(mo.index(before)).filter(r => r.community_id === TOLON && isTest(r.household_id) && !r.state.conflict);
    const cancel = openRequests.map(r => ({ _id: `close-${r.request._id}-${run}`, type: 'data_record', form: w.FORMS.coordination, content_type: 'xml', reported_date: Date.now(),
      contact: { _id: person('rseidu') }, fields: { patient_id: r.household_id, request_id: r.request._id, expected_event: r.state.last._id, status: 'cancelled', outcome_note: 'Closed: left open by an earlier regression run.' } }));
    const resolve = mo.followUps(before, today).routine.filter(i => i.community_id === TOLON && isTest(i.person_id)).map(i => ({
      _id: `close-${i.task_id.replace(/[^A-Za-z0-9-]/g, '-')}-${run}`, type: 'data_record', form: mch.FORMS.resolution, content_type: 'xml', reported_date: Date.now(), contact: { _id: CHO },
      fields: { patient_id: i.person_id, task_id: i.task_id, task_kind: i.kind, source_id: i.source, actor: 'sabukari', reason: 'Closed: left open by an earlier regression run.',
        approval_status: 'pending_clinical_review', created_by: CHO } }));
    if (cancel.length) { assert.ok((await asUser('rseidu', cancel)).every(x => x.ok)); }
    if (resolve.length) { assert.ok((await asUser('sabukari', resolve)).every(x => x.ok)); }
    result.closed_leftovers = { requests: cancel.length, followups: resolve.length };
    result.snapshots['0-before'] = await tolonInputs();

    // 1. Volunteer: household and routine need through the CHT interface.
    const families = ['Ziblim', 'Mumuni', 'Adam', 'Wahab', 'Lukman', 'Nashiru', 'Rafiq', 'Sadiq'];
    const taken = new Set(before.filter(d => d.contact_type === 'carelink_household').map(d => d.name.split(' ')[0]));
    const all2 = [...families, ...families.flatMap(a => families.filter(b => b !== a).map(b => `${a}-${b}`))].filter(f => !taken.has(f));
    const [famA, famB] = all2;
    const houseA = `${famA} Household, House ${run % 800 + 100}`;
    const { page: volunteer } = await login(browser, 'aiddrisu');
    await volunteer.goto(`${BASE}#/contacts/${TOLON}/add/carelink_household`);
    await volunteer.waitForSelector('[name="/data/carelink_household/name"]');
    await volunteer.type('[name="/data/carelink_household/name"]', houseA);
    await submitHousehold(volunteer, houseA);
    const householdA = await eventually(async () => (await all()).find(d => d.contact_type === 'carelink_household' && d.name === houseA), 'household on the server');
    await markTestRecords(couch, [householdA._id]);
    await volunteer.goto(`${BASE}#/contacts/${householdA._id}/report/carelink_request`);
    await volunteer.waitForSelector('.enketo form .question');
    await check(volunteer, '/data/consent', 'yes');
    await check(volunteer, '/data/care_need', 'antenatal_care');
    await check(volunteer, '/data/followup_type', 'visit');
    await check(volunteer, '/data/contact_method', 'community_contact');
    await check(volunteer, '/data/access_barrier', 'transport_unavailable');
    await check(volunteer, '/data/travel_time', 'over_60');
    await submit(volunteer);
    const request = await eventually(async () => (await reports(w.FORMS.request)).find(r => r.fields.patient_id === householdA._id), 'the request on the server');
    await shot(volunteer, '1-volunteer-request');
    pass(`1. Volunteer registered "${houseA}" in Tolon and recorded a routine antenatal-care need with a transport barrier (over 1 hour to the facility)`);

    // 2. CHO: a mother in another household; ANC visit documented through the CHT form with a follow-up date (today).
    const householdB = { _id: `household-walk-${run}`, type: 'contact', contact_type: 'carelink_household', name: `${famB} Household, House ${run % 800 + 101}`, parent: tolonLineage,
      responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', registered_by: person('aiddrisu'), record_origin: 'test', reported_date: run };
    assert.ok((await asUser('aiddrisu', [householdB]))[0].ok);
    const motherName = `Fati ${famB} ${run % 1000}`;
    const mother = { _id: `mother-walk-${run}`, type: 'contact', contact_type: 'carelink_individual', name: motherName, parent: { _id: householdB._id, parent: tolonLineage },
      care_stage: 'anc', sex: 'F', date_of_birth: '2000-08-17', responsible_worker_id: CHO, record_origin: 'test', reported_date: run };
    const pregnancy = { _id: `pregnancy-walk-${run}`, type: 'data_record', form: mch.FORMS.pregnancy, content_type: 'xml', reported_date: Date.now(), contact: { _id: CHO },
      fields: { patient_id: mother._id, pregnancy_id: `preg-walk-${run}`, edd: isoDay(run + 140 * 86400000), approval_status: 'pending_clinical_review', created_by: CHO } };
    assert.ok((await asUser('sabukari', [mother, pregnancy])).every(x => x.ok));
    const { page: cho } = await login(browser, 'sabukari');
    await eventually(async () => { await sync(cho); await cho.goto(`${BASE}#/contacts/${mother._id}`); await pause(2000); return (await text(cho)).includes(motherName); }, 'the mother on the CHO phone');
    await cho.goto(`${BASE}#/contacts/${mother._id}/report/${mch.FORMS.anc}`);
    await cho.waitForSelector('.enketo form .question');
    await check(cho, '/data/documentation/visit_identification/anc_visit_kind', 'booking');
    await cho.type('[name="/data/vitals/systolic_bp"]', '114');
    await cho.type('[name="/data/vitals/diastolic_bp"]', '70');
    await cho.type('[name="/data/vitals/weight_kg"]', '63');
    await setValue(cho, '/data/documentation/counselling_and_plan/care_follow_up_date', today);
    await submit(cho);
    await sync(cho);
    const anc = await eventually(async () => (await reports(mch.FORMS.anc)).find(r => r.fields.patient_id === mother._id), 'the ANC visit on the server');
    const followUp = mch.taskId(mother._id, 'scheduledFollowUp', anc._id);
    const missing = mch.taskId(mother._id, 'missingAssessment', anc._id);
    pass(`2. CHO documented "${motherName}"'s ANC visit through the CHT form with a routine follow-up date; two obligations are open (ANC follow-up, missing assessment)`);

    // 3. Documented community demand updates.
    const s1 = await tolonInputs();
    result.snapshots['1-recorded'] = s1;
    const b = result.snapshots['0-before'];
    assert.deepEqual([s1.open_requests - b.open_requests, s1.open_maternal_followups - b.open_maternal_followups, s1.encounters - b.encounters], [1, 2, 2]);
    pass('3. Tolon\'s documented demand updated: +1 open request, +2 maternal follow-ups, +2 encounters (one household, one mother; no double counting)', { before: b, after: s1 });

    // 4. Coordinator accepts the request (CHT task); the engines plan a resource-feasible day.
    const { page: coord } = await login(browser, 'rseidu');
    await openTask(coord, [houseA, 'Review outreach request']);
    await check(coord, '/data/status', 'accepted');
    await coord.type('[name="/data/outcome_note"]', 'Received; to be planned for outreach.');
    await submit(coord);
    await eventually(async () => w.workflow(request, (await all()).filter(d => d.fields && d.fields.patient_id === householdA._id)).state === 'accepted', 'request accepted');
    const busy = await releaseTestDays(couch, 'sabukari', CHO, password);
    let day = isoDay(Date.now() + 86400000);
    while (busy.has(day) || [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) { day = isoDay(Date.parse(day + 'T12:00:00Z') + 86400000); }
    assert.ok(day <= isoDay(Date.now() + 30 * 86400000), 'no free weekday for the CHO in the next 30 days');
    const planRequest = (id, date) => ({ _id: id, type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: date, season: 'dry', staff_available: CHO, hours_start: '0800', hours_end: '1600',
        vehicles: MOTORBIKE, use_synthetic_history: 'no', fairness_weight: '0.5', guarantee_communities: TOLON, guarantee_min_items: '2', include_test_records: 'yes' } });
    const req1 = planRequest(`oi-request-walk-${run}`, day);
    assert.ok((await asUser('rseidu', [req1]))[0].ok);
    const proposal = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${req1._id}`), 'the proposal');
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(proposal.fields.schedule.status));
    const tolonTrip = proposal.fields.schedule.trips.find(t => t.served[TOLON]);
    assert.ok(tolonTrip && tolonTrip.total_minutes <= tolonTrip.available_minutes);
    pass(`4. Coordinator accepted the request in CHT; the engines produced a ${proposal.fields.schedule.status} plan for ${day} within the CHO's hours (${tolonTrip.total_minutes} of ${tolonTrip.available_minutes} minutes)`,
      { summary: proposal.fields.explanation.summary, tolon_sources: proposal.fields.demand.find(d => d.community_id === TOLON).sources });

    // 5. Coordinator submits; the supervisor reviews and approves through CHT tasks; the coordinator cannot approve.
    await openTask(coord, ['Submit outreach plan for review', proposal._id]);
    await submit(coord);
    const ack = async (id, res) => eventually(async () => { const a = (await reports('carelink_oi_ack')).find(x => x.fields.event_id === id); return a && (!res || a.fields.result === res) && a; }, `acknowledgement of ${id}`);
    const latest = async action => eventually(async () => (await reports('carelink_oi_review')).filter(e => e.fields.proposal_id === proposal._id && e.fields.action === action).sort((x, y) => y.reported_date - x.reported_date)[0], `${action}`);
    await ack((await latest('submit'))._id, 'accepted');
    const { page: sup } = await login(browser, 'mtahiru');
    await openTask(sup, ['Review outreach plan', proposal._id]);
    await submit(sup);
    const review = await latest('review'); await ack(review._id, 'accepted');
    const self = await asUser('rseidu', [{ _id: `self-${run}`, type: 'data_record', form: 'carelink_oi_review', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, proposal_id: proposal._id, action: 'approve', actor: 'rseidu', expected_event: review._id } }]);
    assert.ok(self[0].error, 'the coordinator approved their own plan');
    await openTask(sup, ['Approve or reject outreach plan', proposal._id]);
    await check(sup, '/data/decision', 'approve');
    await sup.type('[name="/data/notes"]', 'Approved: CHO and motorbike confirmed.');
    await submit(sup);
    await ack((await latest('approve'))._id, 'accepted');
    await shot(sup, '2-supervisor-approved');
    pass('5. Coordinator submitted; the supervisor reviewed and approved through CHT tasks; the server refused the coordinator\'s own approval');

    // 6. The CHO receives the work on the approved day.
    const assignment = await eventually(async () => (await reports('carelink_oi_assignment')).find(a => a.fields.proposal_id === proposal._id && a.fields.patient_id === TOLON), 'the Tolon assignment');
    const plan = await eventually(async () => (await reports('carelink_oi_day_plan')).find(p => p._id === dayPlanId(assignment._id)), 'the day plan');
    assert.ok(plan.fields.request_ids.includes(request._id), 'the request was not planned');
    assert.ok(plan.fields.followups.some(f => f.task_id === followUp), 'the ANC follow-up was not planned');
    await openTask(cho, [houseA, 'Household visit planned']);
    pass(`6. The approved ${day} day took on the household request and the mother's follow-ups (planned by type: ${JSON.stringify(assignment.fields.served_by_type)}); the CHO has the visit task`);

    // 7. The CHO completes the household visit and resolves the mother's ANC follow-up.
    await setValue(cho, '/data/visit_date', today);
    await check(cho, '/data/visit_type', 'outreach_contact');
    await check(cho, '/data/status', 'completed');
    await check(cho, '/data/followup_required', 'no');
    await check(cho, '/data/referral_recorded', 'no');
    await cho.type('[name="/data/outcome_note"]', 'Household visited; antenatal booking arranged.');
    await submit(cho);
    await openTask(cho, [motherName, 'ANC follow-up due'], 'Resolve with a reason');
    await cho.type('[name="/data/reason"]', 'Seen at the Tolon outreach day.');
    await submit(cho);
    await sync(cho);
    const visit = await eventually(async () => (await reports(w.FORMS.visit)).find(v => v.fields.request_id === request._id && v.fields.status === 'completed'), 'the visit on the server');
    const resolution = await eventually(async () => (await reports(mch.FORMS.resolution)).find(r => r.fields.task_id === followUp), 'the resolution on the server');
    assert.deepEqual([visit.fields.actor, visit.fields.assignment_id, resolution.fields.actor, resolution.fields.assignment_id], ['sabukari', assignment._id, 'sabukari', assignment._id]);
    pass('7. The CHO completed the household visit and resolved the mother\'s ANC follow-up; both are stamped with her username and the approved day');

    // 8. Remaining needs stay open.
    const docs = await all();
    assert.equal(w.workflow(request, docs.filter(d => d.fields && d.fields.patient_id === householdA._id)).state, 'completed');
    const stillOpen = mo.followUps(docs, today).routine.filter(i => i.person_id === mother._id).map(i => i.task_id);
    assert.deepEqual(stillOpen, [missing]);
    const progress = dayProgress(plan, docs.filter(d => d.type === 'data_record'));
    pass(`8. The request is completed; the mother's missing-assessment obligation stays open. Day progress: requests ${progress.counts.completed}/${progress.counts.planned} completed, follow-ups ${progress.followups.completed}/${progress.followups.planned} completed`);

    // 9. The next planning inputs reflect the verified outcome.
    const s2 = await tolonInputs();
    result.snapshots['2-after'] = s2;
    assert.deepEqual([s2.open_requests - s1.open_requests, s2.open_maternal_followups - s1.open_maternal_followups, s2.followups_resolved_total - s1.followups_resolved_total], [-1, -1, 1]);
    assert.ok(s2.visits_completed_this_week >= s1.visits_completed_this_week + 1);
    const req2 = planRequest(`oi-request-walk2-${run}`, isoDay(Date.parse(day + 'T12:00:00Z') + 40 * 86400000));
    assert.ok((await asUser('rseidu', [req2]))[0].ok);
    const next = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${req2._id}`), 'the next proposal');
    const nextSources = next.fields.demand.find(d => d.community_id === TOLON).sources;
    assert.equal(nextSources.open_requests, s2.open_requests);
    assert.equal(nextSources.open_maternal_followups, s2.open_maternal_followups);
    pass(`9. Next planning inputs: open requests ${s1.open_requests} → ${s2.open_requests}, maternal follow-ups ${s1.open_maternal_followups} → ${s2.open_maternal_followups}, resolved follow-ups +1, visits this week +1; the next plan's inputs match`, { next_plan_sources: nextSources });
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error('✖ ' + e.message);
    const pages = (await Promise.all(browser.browserContexts().map(c => c.pages()))).flat();
    await Promise.all(pages.map((p, i) => p.screenshot({ path: path.join(evidence, `walkthrough-failure-${i + 1}.png`), fullPage: true }).catch(() => {})));
    process.exitCode = 1;
  } finally {
    await browser.close();
    result.limits = ['Chrome against the real CHT server; offline and phone behaviour are covered by the android flows.',
      'Generated records marked record_origin test; the household fixture for the mother and the plan request were written through the CHT API as the real users.'];
    fs.writeFileSync(path.join(evidence, 'walkthrough-flow.json'), JSON.stringify(result, null, 2) + '\n');
  }
})();
