'use strict';
/*
  Records the CareLink Reach field workflow as it happens in the app (npm run record-flow), on the laptop copy:
    1. the volunteer registers a household; the CHO registers the mother in it (volunteers cannot register
       individuals in this build);
    2. the coordinator sees the households and people, records resource readiness and requests an outreach plan
       (health worker, hours, motorbike); the supervisor reviews and approves it;
    3. the CHO opens the outreach day and records the mother's ANC visit: complaints, vital signs, danger sign;
    4. the CHO refers her to Tolon District Hospital;
    5. the receiving facility acknowledges, confirms arrival and records the outcome; the CHO closes the referral;
       the coordinator is back at outreach planning.
  Every step is a real tap or keystroke in the CHT UI and is saved; each save is confirmed on the server before
  the next role continues. People and households are generated demonstration data. Nothing is deleted.
  Each role signs in in an unrecorded browser context and its session is reused in a recorded one, so login
  screens and passwords are never filmed. Waiting for sync and the planning worker is cut from the clips.
  Environment: CARELINK_ACCOUNT_PASSWORD, CHT_COUCH_URL (read-only server checks), CARELINK_BASE
  (default http://localhost:5988/; this script refuses any other host).
  Writes clips/workflow/<step>.webm, clips/workflow/timings.json and clips/workflow/state.json; a rerun skips
  steps already recorded, so a failure never saves the same record twice.
*/
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const BASE = process.env.CARELINK_BASE || 'http://localhost:5988/';
const PASSWORD = process.env.CARELINK_ACCOUNT_PASSWORD;
const COUCH = process.env.CHT_COUCH_URL;
if (!PASSWORD || !COUCH) { throw Error('Set CARELINK_ACCOUNT_PASSWORD and CHT_COUCH_URL.'); }
if (new URL(BASE).hostname !== 'localhost') { throw Error('This recording saves records: run it on the laptop copy only.'); }
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(__dirname, 'clips', 'workflow');
const STATE = path.join(OUT, 'state.json');
const TIMINGS = path.join(OUT, 'timings.json');
const PHONE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const FACILITY = 'carelink-facility-tolon-hospital';
const HOUSEHOLD = 'Mahamudu Household, House 21';
const MOTHER = 'Fatima Mahamudu';
const OUTREACH_DAY = '2026-11-03';
fs.mkdirSync(OUT, { recursive: true });
const read = (file, empty) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : empty;
const state = read(STATE, { done: [] });
const timings = read(TIMINGS, {});
const save = () => {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(TIMINGS, JSON.stringify(timings, null, 2) + '\n');
};

// Read-only server checks: a save counts only once the server has it.
async function docs() {
  const url = new URL(COUCH);
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = ''; url.password = '';
  const res = await fetch(new URL('/medic/_all_docs?include_docs=true', url), { headers: { Authorization: auth } });
  return (await res.json()).rows.map(r => r.doc).filter(d => d && !d._deleted);
}
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(what, fn, timeout = 180000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await fn(); if (result) { return result; } await pause(2000); }
  throw Error(`Timed out waiting for ${what}.`);
}
const onServer = (what, test) => eventually(`${what} on the server`, async () => (await docs()).find(test));

// A soft circle where the screen is tapped, like Android's "Show taps".
const TAPS = `addEventListener('pointerdown', e => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
    'background:rgba(120,120,120,.35);border:2px solid rgba(255,255,255,.7);transition:opacity .45s,transform .45s;left:' + e.clientX + 'px;top:' + e.clientY + 'px';
  document.documentElement.append(d);
  requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'scale(1.5)'; });
  setTimeout(() => d.remove(), 600);
}, true);`;

async function session(browser, user) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  await page.goto(`${BASE}medic/login`);
  await page.fill('#user', user);
  await page.fill('#password', PASSWORD);
  await page.click('#login');
  await page.waitForSelector('.app-root.bootstrapped', { state: 'attached', timeout: 240000 });
  const storage = await context.storageState();
  await context.close();
  return storage;
}

// One recorded browser per step. open() runs before the clip starts (loading, syncing); rec.off()/rec.on()
// cut waiting out of the clip; after() confirms the step's records reached the server.
async function step(browser, sessions, id, user, { open, run, after }) {
  if (state.done.includes(id)) { console.log(`– ${id} already recorded`); return; }
  const context = await browser.newContext({ ...PHONE, storageState: sessions[user], recordVideo: { dir: OUT, size: { width: 824, height: 1830 } } });
  await context.addInitScript(TAPS);
  const t0 = Date.now();
  const page = await context.newPage();
  const cuts = [];
  let from = null;
  const now = () => (Date.now() - t0) / 1000;
  const rec = {
    on: async () => { await page.waitForTimeout(900); from = now(); },
    off: async () => { await page.waitForTimeout(1500); cuts.push([from, now()]); from = null; },
  };
  try {
    await open(page);
    await rec.on();
    await run(page, rec);
    if (from !== null) { await rec.off(); }
    if (after) { await sync(page); await after(page); }
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, `${id}-failed.png`) }).catch(() => {});
    await context.close();
    throw Error(`${id}: ${e.message}`);
  }
  const video = page.video();
  await context.close();
  fs.renameSync(await video.path(), path.join(OUT, `${id}.webm`));
  timings[id] = cuts;
  state.done.push(id);
  save();
  console.log(`✔ ${id}: ${cuts.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`).join(', ')}`);
}

// UI helpers: every action is a visible tap or keystroke, scrolled into view first.
const ready = page => page.waitForSelector('.app-root.bootstrapped', { state: 'attached', timeout: 240000 });
const visible = (page, selector) => page.locator(`${selector} >> visible=true`).first();
async function tap(page, locator, after = 700) {
  await locator.waitFor({ state: 'visible', timeout: 60000 });
  await locator.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await page.waitForTimeout(650);
  await locator.click();
  await page.waitForTimeout(after);
}
async function type(page, name, text) {
  const field = visible(page, `[name="${name}"]`);
  await tap(page, field, 250);
  await field.pressSequentially(text, { delay: 55 });
  await page.waitForTimeout(500);
}
async function choose(page, name, value) {
  const option = visible(page, `input[name="${name}"][value="${value}"], input[data-name="${name}"][value="${value}"]`);
  for (let attempt = 0; attempt < 3; attempt++) {
    await tap(page, option, 500);
    if (await option.isChecked()) { return; }
  }
  throw Error(`Could not select ${value} for ${name}`);
}
const setDate = async (page, name, value) => {
  await visible(page, `[name="${name}"]`).evaluate(e => e.closest('.question').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await page.waitForTimeout(700);
  await page.evaluate(([n, v]) => { window.$(`[name="${n}"]`).val(v).trigger('change'); }, [name, value]);
  await page.waitForTimeout(900);
};
async function submit(page) {
  await tap(page, visible(page, '.form-footer .submit'), 300);
  await page.waitForFunction(() => !document.querySelector('.enketo form') || document.querySelector('.invalid-constraint, .invalid-required') ||
    document.body.innerText.includes('Possible duplicate contacts found'), null, { timeout: 60000 });
  const invalid = await page.$('.invalid-constraint, .invalid-required');
  if (invalid) { throw Error('Form rejected: ' + await invalid.evaluate(e => e.closest('.question')?.innerText)); }
  // CHT's duplicate check: these generated names are new, so confirm and save.
  if (await page.$('.enketo form') && await page.evaluate(() => document.body.innerText.includes('Possible duplicate contacts found'))) {
    await tap(page, visible(page, 'input#check'), 400);
    await tap(page, visible(page, '.form-footer .submit'), 300);
    await page.waitForFunction(() => !document.querySelector('.enketo form'), null, { timeout: 60000 });
  }
  await page.waitForTimeout(1800);
}
const fab = async page => tap(page, await onScreen(page, 'mm-fast-action-button .fast-action-fab-button'), 1200);
async function fastAction(page, form) {
  await fab(page);
  if (!await page.$('.enketo form')) { await tap(page, visible(page, `[test-id="${form}"]`), 600); }
  await page.waitForSelector('.enketo form .question', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1200);
}
// The element of a selector that is on screen horizontally (CHT keeps panes off screen on a phone);
// with a name, only links whose first line is exactly that name.
const findOnScreen = (page, selector, name) => page.locator(selector).evaluateAll((es, n) => es.findIndex(e => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth + 1 && (!n || e.innerText.trim().split('\n')[0].trim() === n);
}), name);
async function onScreen(page, selector, name) {
  const index = await eventually(`${name || selector} on screen`, async () => (await findOnScreen(page, selector, name)) + 1, 60000);
  return page.locator(selector).nth(index - 1);
}
const showing = (page, name) => page.evaluate(n => [...document.querySelectorAll('h2[test-id="contact-name"]')].some(h => h.getBoundingClientRect().left >= 0 && h.innerText.trim() === n), name);
const openContact = async (page, name) => {
  if (await showing(page, name)) { await page.waitForTimeout(1500); return; }
  // CHT opens the user's own facility on a phone; go back up to the list when the name is not on this page.
  for (let i = 0; i < 3 && await findOnScreen(page, 'a', name) < 0; i++) {
    await tap(page, page.locator('.navigation .filter-bar-back >> visible=true').first(), 1800);
  }
  await tap(page, await onScreen(page, 'a', name), 600);
  await eventually(`${name}'s page`, () => showing(page, name), 60000);
  await page.waitForTimeout(1800);
};
const taskRow = (page, ...texts) => texts.reduce((l, t) => l.filter({ hasText: t }), page.locator('#tasks-list li >> visible=true')).first();
async function openTask(page, texts, action) {
  await tap(page, taskRow(page, ...texts).locator('a').first(), 600);
  await page.waitForSelector('.enketo form .question, li.actions a.btn', { state: 'visible', timeout: 60000 });
  if (action && !await page.$('.enketo form')) {
    await page.waitForTimeout(1200);
    await tap(page, visible(page, `li.actions a.btn:has-text("${action}")`), 600);
  }
  await page.waitForSelector('.enketo form .question', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1200);
}
// On a phone the tab bar hides inside a record; go back until it shows.
async function tab(page, id) {
  for (let i = 0; i < 4 && !await page.locator(`#${id}`).isVisible(); i++) {
    await tap(page, page.locator('.navigation .filter-bar-back >> visible=true').first(), 1500);
  }
  await tap(page, visible(page, `#${id}`), 1500);
}
const outreachSection = async (page, label) => {
  await tap(page, page.locator('cht-carelink-outreach-intelligence .tabs button', { hasText: label }).first(), 2200);
};
const scrollTo = async (page, locator, hold = 2500) => {
  await locator.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await page.waitForTimeout(hold);
};
async function sync(page) {
  await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
  await page.waitForTimeout(3000);
}
// Before a clip: sync until the route shows what the step needs.
async function until(page, route, test, what) {
  await eventually(what, async () => {
    await sync(page);
    await page.goto(`${BASE}${route}`);
    await ready(page);
    await page.waitForTimeout(3000);
    return test(page);
  }, 240000);
}
const shows = (...texts) => async page => { const t = await page.evaluate(() => document.body.innerText); return texts.every(x => t.includes(x)); };
const tasksWith = (...texts) => async page => (await taskRow(page, ...texts).count()) > 0;
const outreachTab = async page => {
  await page.waitForFunction(() => (document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || '').includes('At a glance'), null, { timeout: 120000 });
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const sessions = {};
    for (const user of ['aiddrisu', 'sabukari', 'rseidu', 'mtahiru']) { sessions[user] = await session(browser, user); }

    // 1. Volunteer registers the household.
    await step(browser, sessions, '01-volunteer-household', 'aiddrisu', {
      open: async page => { await page.goto(`${BASE}#/contacts`); await ready(page); await page.waitForSelector('#contacts-list a', { timeout: 120000 }); await page.waitForTimeout(2500); },
      run: async page => {
        await page.waitForTimeout(1200);
        await openContact(page, 'Tolon');
        await fab(page);
        await page.waitForSelector('.enketo form .question', { state: 'visible', timeout: 60000 });
        await page.waitForTimeout(1200);
        await type(page, '/data/carelink_household/name', HOUSEHOLD);
        await submit(page);
        await page.waitForFunction(n => document.querySelector('h2[test-id="contact-name"]')?.innerText.includes(n), HOUSEHOLD, { timeout: 60000 });
        await page.waitForTimeout(2500);
      },
      after: async () => { state.household = (await onServer('the household', d => d.contact_type === 'carelink_household' && d.name === HOUSEHOLD))._id; },
    });

    // 1b. The CHO registers the mother in that household.
    await step(browser, sessions, '02-cho-registers-mother', 'sabukari', {
      open: page => until(page, `#/contacts/${state.household}`, shows(HOUSEHOLD), 'the household on the CHO phone'),
      run: async page => {
        await fastAction(page, 'carelink_individual');
        await type(page, '/data/carelink_individual/name', MOTHER);
        await choose(page, '/data/carelink_individual/care_stage', 'anc');
        await setDate(page, '/data/carelink_individual/date_of_birth', '1999-05-12');
        await submit(page);
        await page.waitForFunction(n => document.querySelector('h2[test-id="contact-name"]')?.innerText.includes(n), MOTHER, { timeout: 60000 });
        await page.waitForTimeout(2000);
        const due = visible(page, 'text=First ANC visit due');
        if (await due.count()) { await scrollTo(page, due, 3000); }
      },
      after: async () => { state.mother = (await onServer('the mother', d => d.contact_type === 'carelink_individual' && d.name === MOTHER))._id; },
    });

    // 2. The coordinator sees households and people, then the documented need.
    await step(browser, sessions, '03-coordinator-sees-need', 'rseidu', {
      open: page => until(page, '#/contacts', async page => (await page.locator('a:has-text("Tolon")').count()) > 0, 'the contacts list'),
      run: async page => {
        await openContact(page, 'Tolon');
        await scrollTo(page, await onScreen(page, 'a', HOUSEHOLD), 2500);
        await openContact(page, HOUSEHOLD);
        await page.waitForTimeout(1500);
        await tab(page, 'ui-extension-carelink-outreach-intelligence-tab');
        await outreachTab(page);
        await page.waitForTimeout(2500);
        await outreachSection(page, 'Needs');
        const tolon = page.locator('cht-carelink-outreach-intelligence [data-section=needs] >> text=Tolon').first();
        if (await tolon.count()) { await scrollTo(page, tolon, 3500); }
      },
    });

    // 2b. The coordinator records resource readiness and requests the outreach plan.
    await step(browser, sessions, '04-coordinator-plans', 'rseidu', {
      open: async page => { await page.goto(`${BASE}#/contacts/${FACILITY}`); await ready(page); await page.waitForSelector('h2[test-id="contact-name"]', { timeout: 120000 }); },
      run: async page => {
        await page.waitForTimeout(1200);
        await fastAction(page, 'carelink_resource_status');
        await choose(page, '/data/resource_id', 'bp-monitor');
        await choose(page, '/data/status', 'confirmed');
        await type(page, '/data/quantity', '1');
        await submit(page);
        await fastAction(page, 'carelink_oi_request');
        await setDate(page, '/data/planning_date', OUTREACH_DAY);
        await choose(page, '/data/season', 'dry');
        await choose(page, '/data/staff_available_f1', 'carelink-person-sabukari');
        await choose(page, '/data/hours_start', '0800');
        await choose(page, '/data/hours_end', '1400');
        await choose(page, '/data/vehicles_f1', `${FACILITY}-motorbike-1`);
        await choose(page, '/data/use_synthetic_history', 'no');
        if (!await visible(page, '[name="/data/fairness_weight"]').inputValue()) { await type(page, '/data/fairness_weight', '0.5'); }
        await submit(page);
        await page.waitForTimeout(1500);
      },
      after: async () => {
        const request = await onServer('the plan request', d => d.form === 'carelink_oi_request' && d.fields.planning_date === OUTREACH_DAY);
        state.proposal = (await onServer('the generated plan', d => d.form === 'carelink_oi_proposal' && d._id === `carelink-oi-proposal-${request._id}`))._id;
      },
    });

    // 2c. The coordinator reviews the generated plan and submits it.
    await step(browser, sessions, '05-coordinator-submits-plan', 'rseidu', {
      open: page => until(page, '#/tasks', tasksWith('Submit outreach plan for review'), 'the plan task'),
      run: async page => {
        await tab(page, 'ui-extension-carelink-outreach-intelligence-tab');
        await outreachTab(page);
        await outreachSection(page, 'Plan');
        const card = page.locator('cht-carelink-outreach-intelligence [data-plan-id] .card').first();
        if (await card.count()) { await scrollTo(page, card, 3500); }
        const facts = page.locator('cht-carelink-outreach-intelligence [data-plan-id] .facts').first();
        if (await facts.count()) { await scrollTo(page, facts, 3500); }
        await tab(page, 'tasks-tab');
        await openTask(page, ['Submit outreach plan for review']);
        await submit(page);
      },
      after: () => onServer('the submission', d => d.form === 'carelink_oi_review' && d.fields.proposal_id === state.proposal && d.fields.action === 'submit'),
    });

    // 2d. The supervisor reviews and approves.
    await step(browser, sessions, '06-supervisor-approves', 'mtahiru', {
      open: page => until(page, '#/tasks', tasksWith('Review outreach plan'), 'the review task'),
      run: async (page, rec) => {
        await openTask(page, ['Review outreach plan']);
        await submit(page);
        await rec.off();
        await until(page, '#/tasks', tasksWith('Approve or reject outreach plan'), 'the approval task');
        await rec.on();
        await openTask(page, ['Approve or reject outreach plan']);
        await choose(page, '/data/decision', 'approve');
        await type(page, '/data/notes', 'Approved: CHO, motorbike and BP monitor confirmed.');
        await submit(page);
      },
      after: () => onServer('the approved outreach day', d => d.form === 'carelink_oi_assignment' && (d._id + JSON.stringify(d.fields)).includes(OUTREACH_DAY)),
    });

    // 3–4. The CHO's outreach day: the ANC visit with complaints and vitals, then the referral.
    await step(browser, sessions, '07-cho-visit-and-referral', 'sabukari', {
      open: page => until(page, '#/tasks', async page => await tasksWith(MOTHER, 'First ANC visit due')(page) &&
        (await page.locator(`#tasks-list li a[href*="${OUTREACH_DAY}"]`).count()) > 0, 'the approved outreach day on the CHO phone'),
      run: async (page, rec) => {
        await scrollTo(page, page.locator(`#tasks-list li:has(a[href*="${OUTREACH_DAY}"])`).first(), 3000);
        await openTask(page, [MOTHER, 'First ANC visit due'], 'Record a visit');
        await choose(page, '/data/documentation/visit_identification/anc_visit_kind', 'booking');
        await type(page, '/data/documentation/reported_by_the_woman/anc_reported_symptoms', 'Vaginal bleeding since this morning; headache.');
        await type(page, '/data/vitals/systolic_bp', '128');
        await type(page, '/data/vitals/diastolic_bp', '84');
        await type(page, '/data/vitals/weight_kg', '64');
        await choose(page, '/data/signs/danger_signs', 'bleeding_reported');
        await page.waitForTimeout(2500);
        await submit(page);
        await rec.off();
        await until(page, '#/tasks', tasksWith(MOTHER, 'Clinical concern'), 'the concern task');
        await rec.on();
        await openTask(page, [MOTHER, 'Clinical concern'], 'Start a referral');
        await choose(page, '/data/mode', 'new');
        await type(page, '/data/reason', 'Bleeding reported at ANC booking. Needs assessment.');
        await choose(page, '/data/receiving_facility_id', FACILITY);
        await page.waitForTimeout(2000);
        await submit(page);
      },
      after: () => onServer('the referral', d => d.form === 'carelink_mch_referral' && d.fields.patient_id === state.mother && d.fields.state === 'created'),
    });

    // 5. The receiving facility acknowledges, confirms arrival and records the outcome.
    await step(browser, sessions, '08-facility-receives', 'rseidu', {
      open: page => until(page, '#/tasks', tasksWith(MOTHER, 'Referral awaiting acknowledgement'), 'the referral at the facility'),
      run: async page => {
        await openTask(page, [MOTHER, 'Referral awaiting acknowledgement'], 'Acknowledge or update the referral');
        await choose(page, '/data/mode', 'update');
        await choose(page, '/data/next_state', 'acknowledged');
        await type(page, '/data/note', 'Received at Tolon District Hospital.');
        await submit(page);
        await tab(page, 'contacts-tab');
        await openContact(page, 'Tolon');
        await openContact(page, HOUSEHOLD);
        await openContact(page, MOTHER);
        for (const [next, note] of [['arrival_confirmed', 'Arrived at the hospital.'], ['outcome_recorded', 'Assessed at Tolon District Hospital.']]) {
          await fastAction(page, 'carelink_mch_referral');
          await choose(page, '/data/mode', 'update');
          await choose(page, '/data/next_state', next);
          await type(page, '/data/note', note);
          await submit(page);
          await page.waitForTimeout(800);
        }
        const card = visible(page, 'text=Outcome recorded');
        if (await card.count()) { await scrollTo(page, card, 3000); }
      },
      after: () => onServer('the recorded outcome', d => d.form === 'carelink_mch_referral' && d.fields.patient_id === state.mother && d.fields.state === 'outcome_recorded'),
    });

    // 5b. The CHO closes the referral.
    await step(browser, sessions, '09-cho-closes-referral', 'sabukari', {
      open: page => until(page, '#/tasks', tasksWith(MOTHER, 'Referral needs follow-up'), 'the referral task on the CHO phone'),
      run: async page => {
        await openTask(page, [MOTHER, 'Referral needs follow-up'], 'Record referral progress');
        await choose(page, '/data/mode', 'update');
        await choose(page, '/data/next_state', 'closed');
        await submit(page);
        await tab(page, 'contacts-tab');
        await openContact(page, 'Tolon');
        await openContact(page, HOUSEHOLD);
        await openContact(page, MOTHER);
        const card = visible(page, 'text=Closed');
        if (await card.count()) { await scrollTo(page, card, 3500); }
      },
      after: () => onServer('the closed referral', d => d.form === 'carelink_mch_referral' && d.fields.patient_id === state.mother && d.fields.state === 'closed'),
    });

    // Back to planning: the approved day and progress, then the next plan request (opened, not saved).
    await step(browser, sessions, '10-back-to-planning', 'rseidu', {
      open: async page => { await page.goto(`${BASE}#/ui-extensions/carelink-outreach-intelligence`); await ready(page); await outreachTab(page); },
      run: async page => {
        await page.waitForTimeout(2500);
        await outreachSection(page, 'Plan');
        await page.waitForTimeout(1500);
        await outreachSection(page, 'Progress');
        await page.waitForTimeout(1500);
        await tab(page, 'contacts-tab');
        await openContact(page, 'Tolon District Hospital');
        await fastAction(page, 'carelink_oi_request');
        await page.waitForTimeout(2500);
      },
    });
  } finally {
    save();
    await browser.close();
  }
})().catch(e => { console.error('✖', e.message); process.exit(1); });
