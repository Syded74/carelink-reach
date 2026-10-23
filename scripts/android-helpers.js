'use strict';
// Driving the CareLink Reach CHT Android app on a USB-connected phone (adb + the WebView's DevTools socket).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { evidence } = require('./browser-helpers');

const ADB = path.join(process.env.HOME, 'Library/Android/sdk/platform-tools/adb');
const APP = 'org.medicmobile.webapp.mobile.carelink_reach_local';
const BASE = 'http://localhost:5988/';
const adb = (...args) => execFileSync(ADB, args).toString().trim();
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, what, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { const v = await fn(); if (v) { return v; } } catch (e) { /* page reloading */ } await pause(2000); }
  throw Error('Timed out waiting for ' + what);
}
const online = () => adb('reverse', 'tcp:5988', 'tcp:5988');
const offline = () => { try { adb('reverse', '--remove', 'tcp:5988'); } catch (e) { /* already removed */ } };
const restart = async () => {
  adb('shell', 'am', 'force-stop', APP);
  adb('shell', 'monkey', '-p', APP, '-c', 'android.intent.category.LAUNCHER', '1');
  await pause(6000);
};
// Attach to the app's WebView (a new socket after every restart).
async function attach() {
  const pid = await eventually(async () => adb('shell', 'pidof', APP), 'the app process', 30000);
  adb('forward', 'tcp:9333', `localabstract:webview_devtools_remote_${pid}`);
  const browser = await eventually(() => puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null }), 'the WebView debugger', 30000);
  const page = await eventually(async () => (await browser.pages()).find(p => p.url().startsWith(BASE)), 'the app page', 30000);
  page.setDefaultTimeout(60000);
  return { browser, page };
}
const shot = async (name) => fs.writeFileSync(path.join(evidence, `android-${name}.png`), execFileSync(ADB, ['exec-out', 'screencap', '-p']));
const text = page => page.evaluate(() => document.body.innerText);
async function check(page, name, value) {
  const sel = `input[name="${name}"][value="${value}"], input[data-name="${name}"][value="${value}"]`;
  for (let i = 0; i < 3; i++) { await page.$eval(sel, e => e.scrollIntoView({ block: 'center' })); await page.click(sel); await pause(400); if (await page.$eval(sel, e => e.checked)) { return; } }
  throw Error(`Could not select ${value} for ${name}`);
}
async function submit(page) {
  await page.$eval('.form-footer .submit', e => e.scrollIntoView({ block: 'center' }));
  await page.click('.form-footer .submit');
  await page.waitForFunction(() => !document.querySelector('.enketo form') || document.querySelector('.invalid-constraint, .invalid-required'), { timeout: 60000 });
  const invalid = await page.$('.invalid-constraint, .invalid-required');
  if (invalid) { throw Error('Form rejected: ' + await invalid.evaluate(e => e.closest('.question')?.innerText)); }
}
const sync = page => page.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sync now'); a && a.click(); });
async function login(page, username) {
  await page.goto(`${BASE}medic/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForSelector('#user');
  await page.type('#user', username);
  await page.type('#password', process.env.CARELINK_ACCOUNT_PASSWORD);
  await page.click('#login');
  await eventually(() => page.evaluate(() => !!document.querySelector('.app-root.bootstrapped')), `${username} signed in`, 300000);
}
const signedInAs = page => page.evaluate(() => (document.cookie.match(/userCtx=([^;]+)/) || [])[1]).then(c => c && JSON.parse(decodeURIComponent(c)).name);

module.exports = { ADB, APP, BASE, adb, pause, eventually, online, offline, restart, attach, shot, text, check, submit, sync, login, signedInAs };
