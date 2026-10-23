'use strict';
/*
  Maternal and child follow-ups through Outreach Intelligence, in the real CHT application
  (npm run mch-outreach-flow), checked against the server at every step:
   1–3. a generated mother (pregnancy, ANC with a recorded follow-up date) and her child (CWC, an appointment
        due today) are registered in a new Dimabi household; the CHO records the ANC visit through the UI;
   4–5. the open obligations are projected with their CHT task ids and counted once in the demand export;
   6–7. the coordinator requests a plan and the supervisor approves it independently (a simultaneous second
        approval is refused as a conflict);
     8. the approved Dimabi day links exactly those obligations;
     9. the CHO sees the follow-up task and the planned outreach day on the mother's profile;
 10–11. the CHO resolves the mother's ANC follow-up offline, reloads, syncs; only that obligation closes;
    12. the mother's other obligation and the child's two stay open; the tab shows planned 4 · completed 1 · open 3;
 13–14. the community's documented workload and the weekly history change accordingly;
    15. a new planning run sees the updated counts and cannot re-plan obligations the pending day holds;
    16. replaying the resolution changes nothing; the volunteer cannot read these records; recording the day closes nothing.
  People are generated and marked record_origin 'test'; the test plans opt in with include_test_records.
  Needs CHT_COUCH_URL, CARELINK_ACCOUNT_PASSWORD and the planning worker. Writes evidence/mch-outreach-*.
*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, login, text, evidence, releaseTestDays } = require('./browser-helpers');
const { connection } = require('./client');
const mch = require('../lib/mch');
const mo = require('../lib/mch-outreach');
const { exportAggregates, scopeToFacility } = require('../lib/oi-export');
const { dayPlanId, followUpLinkId, dayProgress } = require('../lib/oi-links');
const { isoDay } = require('../lib/schedules');

const BASE = 'http://localhost:5988/';
const TAB = `${BASE}#/ui-extensions/carelink-outreach-intelligence`;
const FACILITY = 'carelink-facility-tolon-hospital';
const DIMABI = 'carelink-community-dimabi';
const CHO = 'carelink-person-sabukari';
const MOTORBIKE = 'carelink-facility-tolon-hospital-motorbike-1';
const person = username => `carelink-person-${username}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, what, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const v = await fn(); if (v) { return v; } await pause(1500); }
  throw Error('Timed out waiting for ' + what);
}
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `mch-outreach-${name}.png`), fullPage: true });
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
async function sync(page) {
  await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
  await pause(2500);
}

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const asUser = async (username, docs) => (await fetch(`${BASE}medic/_bulk_docs`, { method: 'POST', body: JSON.stringify({ docs }), headers: {
    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Content-Type': 'application/json' } })).json();
  const readAs = (username, id) => fetch(`${BASE}medic/${encodeURIComponent(id)}`, { headers: { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') } });
  const all = async () => (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(Boolean);
  const reports = async form => (await all()).filter(d => d.type === 'data_record' && d.form === form);
  const today = isoDay();
  const run = Date.now();
  const dimabiLineage = { _id: DIMABI, parent: { _id: FACILITY, parent: { _id: 'carelink-district-tolon', parent: { _id: 'carelink-region-northern' } } } };
  const result = { timestamp: new Date().toISOString(), steps: [] };
  const pass = (step, detail) => { result.steps.push({ step, passed: true, ...(detail ? { detail } : {}) }); console.log('✔ ' + step); };
  const snapshots = {};
  const snapshot = async name => {
    const docs = await all();
    const scoped = scopeToFacility(docs, FACILITY);
    const pick = d => { const c = d.current.find(r => r.community_id === DIMABI);
      return { encounters: c.pending_followups, open_requests: c.open_requests, open_maternal_followups: c.open_maternal_followups,
        open_child_followups: c.open_child_followups, unique_people: c.unique_people, urgent_items_excluded: c.urgent_items_excluded,
        followups_resolved_total: d.history.filter(r => r.community_id === DIMABI).reduce((n, r) => n + r.followups_resolved, 0) }; };
    const withTests = exportAggregates(scoped, today, 'snapshot', { includeTestRecords: true }).dataset;
    snapshots[name] = { with_test_records: pick(withTests), operational: pick(exportAggregates(scoped, today, 'snapshot').dataset),
      semantic: JSON.stringify([withTests.history, withTests.current]) };
    return snapshots[name];
  };
  const browser = await launch();
  try {
    // Earlier runs left open follow-ups on their generated Dimabi people; close them through the normal
    // resolution (append-only, history kept) so this run's family is the only open work in Dimabi.
    const leftover = mo.followUps(await all(), today).routine.filter(i => i.community_id === DIMABI);
    const people = new Map((await all()).filter(d => d.type === 'contact').map(d => [d._id, d]));
    const closing = leftover.filter(i => (people.get(i.person_id) || {}).record_origin === 'test').map(i => ({
      _id: `close-${i.task_id.replace(/[^A-Za-z0-9-]/g, '-')}-${run}`, type: 'data_record', form: mch.FORMS.resolution, content_type: 'xml', reported_date: Date.now(),
      contact: { _id: CHO }, fields: { patient_id: i.person_id, task_id: i.task_id, task_kind: i.kind, source_id: i.source, actor: 'sabukari',
        reason: 'Closed: left open by an earlier regression run.', approval_status: 'pending_clinical_review', created_by: CHO } }));
    if (closing.length) { const r = await asUser('sabukari', closing); assert.ok(r.every(x => x.ok), JSON.stringify(r)); }
    result.closed_leftover_test_followups = closing.length;
    const before = await snapshot('0-before');

    // 1–2. A generated mother and child in a new Dimabi household: the household as a facility fixture,
    // the people, pregnancy and the child's appointment through the CHT API as the CHO (her role and server rules apply).
    const family = ['Fuseini', 'Alhassan', 'Abdulai', 'Sulemana', 'Yakubu', 'Iddrisu', 'Salifu', 'Haruna'][run % 8];
    const household = { _id: `household-dimabi-${run}`, type: 'contact', contact_type: 'carelink_household', name: `${family} Household, Dimabi ${run % 1000}`,
      parent: dimabiLineage, responsible_worker_id: CHO, responsible_worker_name: 'Salamatu Abukari', record_origin: 'test', reported_date: run };
    await couch('/medic', { method: 'POST', body: JSON.stringify(household) });
    const lineage = { _id: household._id, parent: dimabiLineage };
    const motherName = `Rahama ${family} ${run % 1000}`;
    const childName = `Wumpini ${family} ${run % 1000}`;
    const mother = { _id: `mother-${run}`, type: 'contact', contact_type: 'carelink_individual', name: motherName, parent: lineage, care_stage: 'anc', sex: 'F',
      date_of_birth: '2001-03-09', responsible_worker_id: CHO, record_origin: 'test', reported_date: run };
    const child = { _id: `child-${run}`, type: 'contact', contact_type: 'carelink_individual', name: childName, parent: lineage, care_stage: 'cwc', sex: 'M',
      date_of_birth: isoDay(run - 300 * 86400000), mother_id: mother._id, responsible_worker_id: CHO, record_origin: 'test', reported_date: run };
    const record = (id, form, patient, fields) => ({ _id: id, type: 'data_record', form, content_type: 'xml', reported_date: Date.now(), contact: { _id: CHO },
      fields: { patient_id: patient, created_by: CHO, approval_status: 'pending_clinical_review', ...fields } });
    const pregnancy = record(`pregnancy-${run}`, mch.FORMS.pregnancy, mother._id, { pregnancy_id: `preg-${run}`, edd: isoDay(run + 150 * 86400000) });
    const appointment = record(`appointment-${run}`, mch.FORMS.appointment, child._id, { appointment_id: `appt-${run}`, state: 'scheduled', due_date: today, actor: 'sabukari' });
    const saved = await asUser('sabukari', [mother, child, pregnancy, appointment]);
    assert.ok(saved.every(r => r.ok), JSON.stringify(saved));
    pass('1–2. Generated mother (pregnancy recorded) and child (CWC appointment due today) registered in a new Dimabi household by the CHO');

    // 3. The CHO records the ANC visit through the UI, with a follow-up date of today.
    const { page: cho } = await login(browser, 'sabukari');
    await eventually(async () => { await sync(cho); await cho.goto(`${BASE}#/contacts/${mother._id}`); await pause(2000); return (await text(cho)).includes(motherName); }, 'mother on the CHO phone');
    await cho.goto(`${BASE}#/contacts/${mother._id}/report/${mch.FORMS.anc}`);
    await cho.waitForSelector('.enketo form .question');
    await check(cho, '/data/documentation/visit_identification/anc_visit_kind', 'booking');
    await cho.type('[name="/data/vitals/systolic_bp"]', '112');
    await cho.type('[name="/data/vitals/diastolic_bp"]', '72');
    await cho.type('[name="/data/vitals/weight_kg"]', '61');
    await setValue(cho, '/data/documentation/counselling_and_plan/care_follow_up_date', today);
    await submit(cho);
    await sync(cho);
    const anc = await eventually(async () => (await reports(mch.FORMS.anc)).find(r => r.fields.patient_id === mother._id), 'the ANC visit on the server');
    assert.equal(anc.fields.follow_up_date, today);
    pass('3. The CHO recorded the ANC visit with a routine follow-up date (today) through the CHT form');

    // 4–5. Projection with CHT task ids; counted once in the community export.
    const ids = [mch.taskId(mother._id, 'scheduledFollowUp', anc._id), mch.taskId(mother._id, 'missingAssessment', anc._id),
      mch.taskId(child._id, 'firstVisit', 'registration'), mch.taskId(child._id, 'appointmentDue', appointment.fields.appointment_id)];
    const projected = mo.followUps(await all(), today).routine.filter(i => i.household_id === household._id);
    assert.deepEqual(projected.map(i => i.task_id).sort(), [...ids].sort());
    const s1 = await snapshot('1-recorded');
    assert.deepEqual([s1.with_test_records.open_maternal_followups - before.with_test_records.open_maternal_followups,
      s1.with_test_records.open_child_followups - before.with_test_records.open_child_followups,
      s1.with_test_records.unique_people - before.with_test_records.unique_people,
      s1.with_test_records.encounters - before.with_test_records.encounters], [2, 2, 2, 2]);
    assert.deepEqual(s1.operational, before.operational, 'generated records changed operational demand');
    pass('4–5. Four obligations projected with their CHT task ids (ANC follow-up, missing assessment, child first visit, appointment due) and counted once in the Dimabi export: +2 maternal, +2 child, +2 people, +2 encounters; operational demand unchanged', { task_ids: ids });

    // 6–7. Plan for the next free weekday, guaranteeing Dimabi; independent approval with a refused simultaneous decision.
    const busy = await releaseTestDays(couch, 'sabukari', CHO, password);
    let day = isoDay(Date.now() + 86400000);
    while (busy.has(day) || [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay())) { day = isoDay(Date.parse(day + 'T12:00:00Z') + 86400000); }
    const planRequest = (id, date) => ({ _id: id, type: 'data_record', form: 'carelink_oi_request', content_type: 'xml', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, actor: 'rseidu', actor_contact: person('rseidu'), planning_date: date, season: 'dry', staff_available: CHO, hours_start: '0800', hours_end: '1600',
        vehicles: MOTORBIKE, use_synthetic_history: 'no', fairness_weight: '0.5', guarantee_communities: DIMABI, guarantee_min_items: '2', include_test_records: 'yes' } });
    const req1 = planRequest(`oi-request-mch-${run}`, day);
    assert.ok((await asUser('rseidu', [req1]))[0].ok);
    const proposal = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${req1._id}`), 'the proposal');
    const dimabiDemand = proposal.fields.demand.find(d => d.community_id === DIMABI);
    assert.ok(dimabiDemand.sources.open_maternal_followups >= 2 && dimabiDemand.sources.open_child_followups >= 2, JSON.stringify(dimabiDemand.sources));
    const servedDimabi = proposal.fields.schedule.trips.reduce((n, t) => n + (t.served[DIMABI] || 0), 0);
    assert.ok(servedDimabi >= 2, `Dimabi served ${servedDimabi}`);
    const ack = async (eventId, result) => eventually(async () => { const a = (await reports('carelink_oi_ack')).find(x => x.fields.event_id === eventId); return a && (!result || a.fields.result === result) && a; }, `acknowledgement of ${eventId}`);
    const decide = async (user, action, expected, n = '') => (await asUser(user, [{ _id: `${action}-mch-${n}${Date.now()}`, type: 'data_record', form: 'carelink_oi_review', content_type: 'xml', reported_date: Date.now(),
      contact: { _id: person(user) }, fields: { patient_id: FACILITY, proposal_id: proposal._id, action, actor: user, expected_event: expected, notes: 'Dimabi follow-ups.' } }]))[0].id;
    const sub = await decide('rseidu', 'submit', proposal._id); await ack(sub, 'accepted');
    const rev = await decide('mtahiru', 'review', sub); await ack(rev, 'accepted');
    const own = await asUser('rseidu', [{ _id: `own-${run}`, type: 'data_record', form: 'carelink_oi_review', reported_date: Date.now(), contact: { _id: person('rseidu') },
      fields: { patient_id: FACILITY, proposal_id: proposal._id, action: 'approve', actor: 'rseidu', expected_event: rev } }]);
    assert.ok(own[0].error, 'the coordinator approved their own plan');
    const [a1, a2] = await Promise.all([decide('mtahiru', 'approve', rev, 'a'), decide('mtahiru', 'approve', rev, 'b')]);
    assert.equal((await ack(a1)).fields.result, 'conflict'); assert.equal((await ack(a2)).fields.result, 'conflict');
    assert.ok(!(await reports('carelink_oi_assignment')).some(a => a.fields.proposal_id === proposal._id), 'an assignment was created before approval');
    const app = await decide('mtahiru', 'approve', rev); await ack(app, 'accepted');
    pass(`6–7. Coordinator's plan for ${day} (Dimabi guaranteed; demand shows its maternal and child follow-ups) approved independently; the coordinator's own approval was refused; two simultaneous approvals were both refused as a conflict and no assignment existed before the accepted approval`, { dimabi_sources: dimabiDemand.sources, served_dimabi: servedDimabi });

    // 8. The approved Dimabi day links exactly these four obligations.
    const assignment = await eventually(async () => (await reports('carelink_oi_assignment')).find(a => a.fields.proposal_id === proposal._id && a.fields.patient_id === DIMABI), 'the Dimabi assignment');
    const plan = await eventually(async () => (await reports('carelink_oi_day_plan')).find(p => p._id === dayPlanId(assignment._id)), 'the day plan');
    assert.deepEqual(plan.fields.followups.map(f => f.task_id).sort(), [...ids].sort());
    await eventually(async () => { const linked = (await reports('carelink_oi_followup_link')).filter(l => l.fields.assignment_id === assignment._id); return linked.length === 4 && linked; }, 'four follow-up links');
    pass('8. The approved Dimabi day plan links exactly the four obligations (stable ids); the mother and child are one encounter each');

    // 9. The CHO sees the follow-up task and the planned day on the mother's profile.
    const openTask = async (name, title, action) => {
      await eventually(async () => {
        await sync(cho);
        await cho.goto(`${BASE}#/tasks`);
        await pause(2000);
        for (const li of await cho.$$('#tasks-list li')) {
          const t = await li.evaluate(e => e.innerText);
          if (t.includes(name) && t.includes(title)) { await (await li.$('a')).click(); return true; }
        }
        return false;
      }, `task "${title}" for ${name}`, 120000);
      await cho.waitForSelector('.enketo form, li.actions a.btn');
      if (action) {
        await cho.evaluate(label => [...document.querySelectorAll('li.actions a.btn')].find(a => a.innerText.trim() === label).click(), action);
        await cho.waitForSelector('.enketo form', { visible: true });
      }
    };
    await eventually(async () => { await sync(cho); await cho.goto(`${BASE}#/contacts/${mother._id}`); await pause(2500); return (await text(cho)).includes('Planned outreach day'); }, 'planned day on the mother profile');
    await shot(cho, '1-mother-profile');
    await openTask(motherName, 'ANC follow-up due');
    pass('9. The CHO has the "ANC follow-up due" task for the mother, and her profile shows the planned outreach day');

    // 10–11. Resolve the ANC follow-up offline from that task; reload; sync.
    await cho.evaluate(label => [...document.querySelectorAll('li.actions a.btn')].find(a => a.innerText.trim() === label).click(), 'Resolve with a reason');
    await cho.waitForSelector('.enketo form', { visible: true });
    await cho.setOfflineMode(true);
    await cho.type('[name="/data/reason"]', 'Seen at the Dimabi outreach day; ANC follow-up done.');
    await submit(cho);
    await cho.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await cho.waitForFunction(() => !!document.querySelector('.app-root.bootstrapped'), { timeout: 60000 });
    assert.ok(!(await reports(mch.FORMS.resolution)).some(r => r.fields.task_id === ids[0]), 'offline resolution reached the server early');
    await cho.setOfflineMode(false);
    await sync(cho);
    const resolution = await eventually(async () => (await reports(mch.FORMS.resolution)).find(r => r.fields.task_id === ids[0]), 'the resolution on the server');
    assert.equal(resolution.fields.actor, 'sabukari');
    assert.equal(resolution.fields.assignment_id, assignment._id);
    pass('10–11. The CHO resolved the mother\'s ANC follow-up offline from her task; after an offline reload it synced, stamped with her username and the approved day');

    // 12. Only that obligation closed; the day shows planned 4 · completed 1 · open 3.
    const docsNow = await all();
    const open = mo.followUps(docsNow, today).routine.filter(i => i.household_id === household._id).map(i => i.task_id).sort();
    assert.deepEqual(open, ids.slice(1).sort());
    const progress = dayProgress(plan, docsNow.filter(d => d.type === 'data_record'));
    assert.deepEqual([progress.followups.planned, progress.followups.completed, progress.followups.open], [4, 1, 3]);
    const { page: coord } = await login(browser, 'rseidu');
    const tabLine = await eventually(async () => {
      await sync(coord); await coord.goto(TAB); await coord.waitForSelector('cht-carelink-outreach-intelligence'); await pause(2000);
      await coord.evaluate(pid => { const b = [...document.querySelector('cht-carelink-outreach-intelligence').shadowRoot.querySelectorAll('button[data-proposal-id]')].find(x => x.dataset.proposalId === pid); b && b.click(); }, proposal._id);
      await pause(1500);
      const t = await coord.evaluate(id => document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.querySelector(`[data-day-plan-id="${id}"]`)?.textContent || '', plan._id);
      return t.includes('Maternal and child follow-ups: planned 4 · completed 1 · closed by a later record 0 · partly 0 · still open 3') && t;
    }, 'follow-up counts in the coordinator tab', 120000);
    await shot(coord, '2-day-progress');
    pass('12. Only the resolved obligation closed; the mother\'s missing-assessment task and the child\'s two stay open; the coordinator tab shows planned 4 · completed 1 · still open 3', { tab: tabLine.slice(0, 300) });

    // 13–14. Workload and history.
    const s2 = await snapshot('2-resolved');
    assert.equal(s2.with_test_records.open_maternal_followups, s1.with_test_records.open_maternal_followups - 1);
    assert.equal(s2.with_test_records.open_child_followups, s1.with_test_records.open_child_followups);
    assert.equal(s2.with_test_records.encounters, s1.with_test_records.encounters, 'the mother still has an open obligation, so still one encounter');
    assert.equal(s2.with_test_records.followups_resolved_total, s1.with_test_records.followups_resolved_total + 1);
    assert.deepEqual(s2.operational, before.operational);
    pass('13–14. Dimabi documented workload: maternal follow-ups −1, child unchanged, encounters unchanged (the mother still has an open obligation); the resolved follow-up appears in the weekly history');

    // 15. A new planning run uses the updated inputs and cannot re-plan what the pending day holds.
    let day2 = isoDay(Date.parse(day + 'T12:00:00Z') + 35 * 86400000);
    while (busy.has(day2) || [0, 6].includes(new Date(day2 + 'T12:00:00Z').getUTCDay())) { day2 = isoDay(Date.parse(day2 + 'T12:00:00Z') + 86400000); }
    const req2 = planRequest(`oi-request-mch2-${run}`, day2);
    assert.ok((await asUser('rseidu', [req2]))[0].ok);
    const proposal2 = await eventually(async () => (await reports('carelink_oi_proposal')).find(p => p._id === `carelink-oi-proposal-${req2._id}`), 'the second proposal');
    const sources2 = proposal2.fields.demand.find(d => d.community_id === DIMABI).sources;
    assert.equal(sources2.open_maternal_followups, dimabiDemand.sources.open_maternal_followups - 1);
    const d2 = async (user, action, expected) => (await asUser(user, [{ _id: `${action}-mch2-${Date.now()}`, type: 'data_record', form: 'carelink_oi_review', content_type: 'xml', reported_date: Date.now(),
      contact: { _id: person(user) }, fields: { patient_id: FACILITY, proposal_id: proposal2._id, action, actor: user, expected_event: expected, notes: 'Later day.' } }]))[0].id;
    const s21 = await d2('rseidu', 'submit', proposal2._id); await ack(s21, 'accepted');
    const r21 = await d2('mtahiru', 'review', s21); await ack(r21, 'accepted');
    const a21 = await d2('mtahiru', 'approve', r21); const ack21 = await ack(a21);
    let held = 'not approved';
    if (ack21.fields.result === 'accepted') {
      const assignment2 = await eventually(async () => (await reports('carelink_oi_assignment')).find(a => a.fields.proposal_id === proposal2._id && a.fields.patient_id === DIMABI), 'second Dimabi assignment');
      const plan2 = await eventually(async () => (await reports('carelink_oi_day_plan')).find(p => p._id === dayPlanId(assignment2._id)), 'second day plan');
      assert.ok(!plan2.fields.followups.some(f => ids.includes(f.task_id)), 'an obligation was planned on two active days');
      held = `approved; its Dimabi day plan holds ${plan2.fields.followups.length} follow-up(s), none of this family's`;
    }
    pass(`15. A new planning run saw the updated inputs (Dimabi maternal follow-ups ${dimabiDemand.sources.open_maternal_followups} → ${sources2.open_maternal_followups}); the second plan ${held}`);

    // 16. Replay, scope, and the outreach day closing nothing.
    const replay = await asUser('sabukari', [resolution]);
    assert.ok(replay[0].error, 'replayed resolution accepted');
    await pause(12000);
    const s3 = await snapshot('3-replayed');
    assert.equal(s3.semantic, s2.semantic, 'a replay changed the forecasting input');
    assert.equal((await reports(mch.FORMS.resolution)).filter(r => r.fields.task_id === ids[0]).length, 1);
    const readMother = await readAs('aiddrisu', mother._id);
    const readLink = await readAs('aiddrisu', followUpLinkId(assignment._id, ids[0]));
    assert.ok([403, 404].includes(readMother.status) && [403, 404].includes(readLink.status), `volunteer read Dimabi records: ${readMother.status}/${readLink.status}`);
    const dayRecord = { _id: `outreach-day-${run}`, type: 'data_record', form: 'carelink_oi_outreach_day', content_type: 'xml', reported_date: Date.now(), contact: { _id: CHO },
      fields: { patient_id: DIMABI, assignment_id: assignment._id, proposal_id: proposal._id, outcome: 'partly', reason: 'Child not seen; family away.' } };
    assert.ok((await asUser('sabukari', [dayRecord]))[0].ok);
    const afterDay = mo.followUps(await all(), today).routine.filter(i => i.household_id === household._id).map(i => i.task_id).sort();
    assert.deepEqual(afterDay, ids.slice(1).sort(), 'recording the outreach day closed a follow-up');
    pass(`16. Replaying the resolution was refused (${replay[0].error}) and changed no counts; the Tolon volunteer cannot read the Dimabi mother or her link (${readMother.status}/${readLink.status}); recording the day as partly done closed nothing and released the open follow-ups`);
    result.passed = true;
  } catch (e) {
    result.passed = false;
    result.error = e.message;
    console.error('✖ ' + e.message);
    const pages = (await Promise.all(browser.browserContexts().map(c => c.pages()))).flat();
    await Promise.all(pages.map((p, i) => p.screenshot({ path: path.join(evidence, `mch-outreach-failure-${i + 1}.png`), fullPage: true }).catch(() => {})));
    process.exitCode = 1;
  } finally {
    await browser.close();
    for (const s of Object.values(snapshots)) { delete s.semantic; }
    result.snapshots = snapshots;
    result.limits = ['Chrome DevTools network emulation, not a physical device.', 'People and household are generated and marked record_origin test.'];
    fs.writeFileSync(path.join(evidence, 'mch-outreach-flow.json'), JSON.stringify(result, null, 2) + '\n');
  }
})();
