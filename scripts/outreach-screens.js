'use strict';
/*
  The outreach-first planning tab in Chrome at phone width (npm run outreach-screens -- <phase>): the coordinator's
  at-a-glance card and each section (Needs, Resources, Outreach plan, "Why this plan?", Progress), the supervisor's
  plan view, and the CHO's task list. Read-only. Saves evidence/outreach-first/<phase>-*.png (first screen and each whole section).
*/
const fs = require('node:fs');
const path = require('node:path');
const { launch, login, evidence } = require('./browser-helpers');

const BASE = 'http://localhost:5988/';
const phase = process.argv[2] || 'after';
const OUT = path.join(evidence, 'outreach-first');
fs.mkdirSync(OUT, { recursive: true });
const pause = ms => new Promise(r => setTimeout(r, ms));
const inTab = (page, src, arg) => page.evaluate((s, a) => new Function('root', 'arg', s)(document.querySelector('cht-carelink-outreach-intelligence').shadowRoot, a), src, arg);
// The first phone screen, plus the whole active section as one image (CHT scrolls an inner pane, so full-page capture does not apply).
const save = async (page, name, section) => {
  await pause(1200);
  await page.screenshot({ path: path.join(OUT, `${phase}-${name}-screen.png`) });
  if (section) {
    const tall = await page.viewport();
    await page.setViewport({ ...tall, height: 4000 });
    await pause(800);
    // The tab re-renders when records change; take a fresh handle for each attempt.
    for (let attempt = 0; ; attempt++) {
      try {
        const el = await page.evaluateHandle(s => document.querySelector('cht-carelink-outreach-intelligence').shadowRoot.querySelector(`[data-section="${s}"]`), section);
        await el.asElement().screenshot({ path: path.join(OUT, `${phase}-${name}.png`) });
        break;
      } catch (e) { if (attempt === 2) { throw e; } await pause(1000); }
    }
    await page.setViewport(tall);
  }
  console.log('saved', `${phase}-${name}`);
};

(async () => {
  const browser = await launch();
  try {
    for (const user of ['rseidu', 'mtahiru']) {
      const { page } = await login(browser, user);
      await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true });
      await page.goto(`${BASE}#/ui-extensions/carelink-outreach-intelligence`);
      await page.waitForFunction(() => (document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || '').includes('At a glance'), { timeout: 60000 });
      await pause(2000);
      const who = user === 'rseidu' ? 'coordinator' : 'supervisor';
      for (const label of user === 'rseidu' ? ['Needs', 'Resources', 'Plan', 'Progress'] : ['Plan']) {
        await inTab(page, "[...root.querySelectorAll('.tabs button')].find(b => b.textContent === arg).click();", label);
        await save(page, `${who}-${label.toLowerCase()}`, { Needs: 'needs', Resources: 'resources', Plan: 'plan', Progress: 'progress' }[label]);
      }
      if (user === 'rseidu') {
        await inTab(page, "[...root.querySelectorAll('.tabs button')].find(b => b.textContent === 'Plan').click();");
        await pause(1500);
        await inTab(page, "root.querySelector('[data-plan-id] details').open = true;");
        await save(page, 'coordinator-plan-why', 'plan');
      }
    }
    const { page: cho } = await login(browser, 'sabukari');
    await cho.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true });
    await cho.goto(`${BASE}#/tasks`);
    await cho.waitForSelector('#tasks-list li', { timeout: 60000 }).catch(() => {});
    await pause(2000);
    await cho.screenshot({ path: path.join(OUT, `${phase}-cho-tasks.png`) });
    console.log('saved', `${phase}-cho-tasks.png`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
