'use strict';
/*
  Captures the frontline screens reviewed in docs/product/FRONTLINE_USABILITY_REPORT.md (npm run usability-screens -- before|after).
  Saves evidence/usability/<phase>-*.png plus <phase>-text.json (the visible text of each screen) so labels can be audited.
  Opens forms and tasks but never submits anything. Also captures the planning tab at phone width (coordinator, supervisor). Needs CARELINK_ACCOUNT_PASSWORD and the local CHT.
*/
const fs = require('node:fs');
const path = require('node:path');
const { launch, login, evidence } = require('./browser-helpers');
const { connection } = require('./client');

const BASE = 'http://localhost:5988/';
const phase = process.argv[2] || 'after';
const OUT = path.join(evidence, 'usability');
fs.mkdirSync(OUT, { recursive: true });
const pause = ms => new Promise(r => setTimeout(r, ms));
const REPORT_FORMS = ['carelink_coordination', 'carelink_cwc_visit', 'carelink_anc_visit', 'carelink_visit', 'carelink_request', 'carelink_mch_referral',
  'carelink_resource_status', 'carelink_task_resolution', 'carelink_oi_proposal'];

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const docs = (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc).filter(Boolean);
  // Most recent report of each form (any origin: these are display checks only).
  const latest = form => docs.filter(d => d.type === 'data_record' && d.form === form).sort((a, b) => b.reported_date - a.reported_date)[0];
  const texts = {};
  const browser = await launch();
  const save = async (page, name) => {
    await pause(1500);
    await page.screenshot({ path: path.join(OUT, `${phase}-${name}.png`) });
    texts[name] = await page.evaluate(() => (document.querySelector('.content-pane, .right-pane, #reports-content') || document.body).innerText);
    console.log('saved', `${phase}-${name}.png`);
  };
  try {
    const { page: coord } = await login(browser, 'rseidu');
    await coord.setViewport({ width: 1280, height: 1000 });
    for (const form of REPORT_FORMS) {
      const doc = latest(form);
      if (!doc) { console.log('no report for', form); continue; }
      await coord.goto(`${BASE}#/reports/${doc._id}`);
      await coord.waitForSelector('.report-body, .details, mm-report-details, .item-summary', { timeout: 30000 }).catch(() => {});
      await save(coord, `report-${form.replace('carelink_', '')}`);
    }
    await coord.goto(`${BASE}#/tasks`);
    await save(coord, 'coordinator-tasks');
    await coord.goto(`${BASE}#/ui-extensions/carelink-outreach-intelligence`);
    await coord.waitForFunction(() => (document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || '').includes('Outreach plan'), { timeout: 60000 });
    await pause(2000);
    texts['oi-tab'] = await coord.evaluate(() => document.querySelector('cht-carelink-outreach-intelligence').shadowRoot.textContent);
    await coord.setViewport({ width: 1280, height: 1000 });
    await save(coord, 'oi-tab-first-screen');
    await coord.goto(`${BASE}#/contacts/carelink-facility-tolon-hospital/report/carelink_resource_status`);
    await coord.waitForSelector('.enketo form .question', { visible: true });
    await save(coord, 'resource-readiness-form');

    // The planning tab at phone width, as the coordinator and as the supervisor.
    for (const user of ['rseidu', 'mtahiru']) {
      const { page } = user === 'rseidu' ? { page: coord } : await login(browser, user);
      await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true });
      await page.goto(`${BASE}#/ui-extensions/carelink-outreach-intelligence`);
      await page.waitForFunction(() => (document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || '').includes('Outreach plan'), { timeout: 60000 });
      await pause(2500);
      await save(page, `oi-tab-mobile-${user === 'rseidu' ? 'coordinator' : 'supervisor'}`);
    }

    const { page: cho } = await login(browser, 'sabukari');
    await cho.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true });
    await cho.goto(`${BASE}#/tasks`);
    await cho.waitForSelector('#tasks-list li', { timeout: 60000 }).catch(() => {});
    await save(cho, 'cho-tasks');
    texts['cho-task-titles'] = await cho.evaluate(() => [...document.querySelectorAll('#tasks-list li')].map(li => li.innerText.replace(/\s*\n+\s*/g, ' | ')));
  } finally {
    fs.writeFileSync(path.join(OUT, `${phase}-text.json`), JSON.stringify(texts, null, 1));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
