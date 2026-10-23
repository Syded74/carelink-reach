'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const stateDir = process.env.CARELINK_STATE_DIR || path.join(os.homedir(), '.carelink-reach');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
function connection(envName = 'CHT_URL') {
  if (!process.env[envName]) { throw new Error(`Set ${envName}; credentials must not be stored in the project.`); }
  const url = new URL(process.env[envName]);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) { throw new Error('Demo scripts only support localhost.'); }
  const auth = 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64');
  url.username = ''; url.password = ''; url.pathname = '/';
  return async (route, options = {}) => {
    const res = await fetch(new URL(route, url), { ...options, headers: { Authorization: auth, 'Content-Type': 'application/json', ...options.headers } });
    const raw = await res.text();
    let body; try {body = JSON.parse(raw);} catch {body = {reason:raw};}
    if (!res.ok) { const err = new Error(`${options.method || 'GET'} ${route}: ${res.status} ${body.reason || body.error || ''}`); err.status = res.status; throw err; }
    return body;
  };
}
const writePrivate = (name, value) => fs.writeFileSync(path.join(stateDir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
module.exports = { connection, stateDir, writePrivate };
