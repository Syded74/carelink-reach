const puppeteer = require('puppeteer-core');
const BASE = 'https://carelink-reach-gh.southafricanorth.cloudapp.azure.com/';
const OUT = process.env.HOME + '/Downloads/carelink-reach-config/evidence/azure';
require('fs').mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  try {
    for (const [user, hash, expect] of [['aiddrisu', '#/contacts', 'Tolon'], ['sabukari', '#/tasks', 'Tasks'], ['rseidu', '#/ui-extensions/carelink-outreach-intelligence', 'At a glance'], ['mtahiru', '#/ui-extensions/carelink-outreach-intelligence', 'At a glance']]) {
      const ctx = await b.createIncognitoBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true });
      const t0 = Date.now();
      await p.goto(BASE + 'medic/login', { waitUntil: 'networkidle2', timeout: 90000 });
      await p.type('#user', user); await p.type('#password', process.env.CARELINK_ACCOUNT_PASSWORD);
      await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 180000 }).catch(() => {}), p.click('#login')]);
      await p.waitForFunction(() => !!document.querySelector('.app-root.bootstrapped'), { timeout: 240000 });
      await p.goto(BASE + hash).catch(() => {}); await new Promise(r => setTimeout(r, 6000));
      const text = await p.evaluate(() => document.body.innerText + (document.querySelector('cht-carelink-outreach-intelligence')?.shadowRoot?.textContent || ''));
      await p.screenshot({ path: `${OUT}/${user}.png` });
      console.log(`${text.includes(expect) ? '✔' : '✖'} ${user}: signed in and loaded ${hash} in ${Math.round((Date.now() - t0) / 1000)}s`);
      await ctx.close();
    }
  } finally { await b.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
