'use strict';
/*
  The outreach-first planning tab and the CHO's assignment on the physical phone (npm run outreach-phone):
  coordinator — at a glance, Needs, Resources, Outreach plan (summary and "Why this plan?"), Progress;
  then CHO — task list with the planned outreach day and the day's form. Read-only: opens screens, never
  submits. Switches user by clearing the app only after checking nothing is waiting to sync.
  Saves evidence/outreach-first/phone-*.png. Review every capture for personal phone notifications before sharing.
*/
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const A = require('./android-helpers');
const { evidence } = require('./browser-helpers');

const OUT = path.join(evidence, 'outreach-first');
fs.mkdirSync(OUT, { recursive: true });
const shot = name => { fs.writeFileSync(path.join(OUT, `phone-${name}.png`), execFileSync(A.ADB, ['exec-out', 'screencap', '-p'])); console.log(`saved phone-${name}.png`); };
const TAB = '#/ui-extensions/carelink-outreach-intelligence';
const go = async (page, hash) => {
  await page.goto(A.BASE + hash).catch(() => {});
  await A.pause(800);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.modal-footer button, .modal-footer a')].find(x => /exit|discard|leave/i.test(x.innerText)); b && b.click(); });
  await A.pause(1500);
};
const inTab = (page, fn, arg) => page.evaluate((src, a) => new Function('root', 'arg', src)(document.querySelector('cht-carelink-outreach-intelligence').shadowRoot, a), fn, arg);
async function signIn(session, username) {
  if (session && await A.signedInAs(session.page) === username) { return session; }
  if (session) {
    await A.sync(session.page);
    await A.pause(5000);
    session.browser.disconnect();
  }
  A.adb('shell', 'pm', 'clear', A.APP);
  A.adb('shell', 'monkey', '-p', A.APP, '-c', 'android.intent.category.LAUNCHER', '1');
  await A.pause(10000);
  const next = await A.attach();
  await A.login(next.page, username);
  return next;
}

(async () => {
  A.online();
  A.adb('shell', 'svc', 'power', 'stayon', 'true');
  A.adb('shell', 'monkey', '-p', A.APP, '-c', 'android.intent.category.LAUNCHER', '1');
  await A.pause(8000);
  let session = await signIn(await A.attach(), 'rseidu');
  let page = session.page;
  await A.sync(page);
  await A.pause(3000);
  await page.reload().catch(() => {});
  await A.eventually(() => page.evaluate(() => !!document.querySelector('.app-root.bootstrapped')), 'the app to restart', 120000);
  await go(page, TAB);
  await A.eventually(() => page.evaluate(() => (document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || '').includes('At a glance')), 'the redesigned tab', 300000);
  await A.pause(2000);
  shot('coord-0-at-a-glance');
  for (const [name, label] of [['needs', 'Needs'], ['resources', 'Resources'], ['plan', 'Plan'], ['progress', 'Progress']]) {
    await inTab(page, "[...root.querySelectorAll('.tabs button')].find(b => b.textContent === arg).click();", label);
    await A.pause(1500);
    await inTab(page, "root.querySelector('[data-section=\"' + arg + '\"]').scrollIntoView({ block: 'start' });", name);
    await A.pause(1200);
    shot(`coord-${name}`);
  }
  await inTab(page, "root.querySelector('.tabs button:nth-child(3)').click();");
  await A.pause(1500);
  await inTab(page, "const d = root.querySelector('[data-plan-id] details'); d.open = true; d.scrollIntoView({ block: 'start' });");
  await A.pause(1200);
  shot('coord-plan-why');

  session = await signIn(session, 'sabukari');
  page = session.page;
  await A.eventually(async () => { await A.sync(page); await go(page, '#/tasks'); return (await A.text(page)).includes('Planned outreach day'); }, 'the planned outreach day task', 300000);
  // The task list re-renders while tasks are recalculated; wait until the outreach-day task is on screen.
  await A.eventually(() => page.evaluate(() => {
    if (!location.hash.startsWith('#/tasks')) { return false; }
    const li = [...document.querySelectorAll('#tasks-list li')].find(l => l.innerText.includes('Planned outreach day'));
    if (li) { li.scrollIntoView({ block: 'center' }); }
    return !!li;
  }), 'the outreach-day task on screen', 120000);
  await A.pause(1500);
  shot('cho-tasks');
  await A.eventually(() => page.evaluate(() => {
    const li = [...document.querySelectorAll('#tasks-list li')].find(l => l.innerText.includes('Planned outreach day'));
    if (li) { li.querySelector('a').click(); }
    return !!li;
  }), 'opening the outreach-day task', 60000);
  await A.pause(4000);
  shot('cho-outreach-day');
  session.browser.disconnect();
})().catch(e => { console.error('✖', e.message); process.exit(1); });
