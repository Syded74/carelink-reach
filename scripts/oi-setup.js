'use strict';
/*
  Creates (or rotates) the online CHT service account the Outreach Intelligence planning service uses
  (npm run oi-setup). Needs CHT_URL with admin rights once; afterwards the service never uses admin.
  Credentials are written privately to ~/.carelink-reach/oi-service.json (mode 0600), never to the project.
*/
const crypto = require('node:crypto');
const { connection, writePrivate } = require('./client');

const USERNAME = 'carelink_oi_service';
(async () => {
  const api = connection('CHT_URL');
  const password = 'Oi-' + crypto.randomBytes(24).toString('base64url') + '-9z!';
  let exists = true;
  try { await api(`/api/v2/users/${USERNAME}`); } catch (e) { if (e.status !== 404) { throw e; } exists = false; }
  if (exists) {
    await api(`/api/v1/users/${USERNAME}`, { method: 'POST', body: JSON.stringify({ password, roles: ['carelink_oi_service'] }) });
  } else {
    await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ username: USERNAME, password, roles: ['carelink_oi_service'], fullname: 'Outreach planning service (system account)' }) });
  }
  const url = new URL(process.env.CHT_URL);
  writePrivate('oi-service.json', { url: `${url.protocol}//${url.host}`, username: USERNAME, password });
  console.log(`${exists ? 'Rotated' : 'Created'} ${USERNAME}; credentials saved privately to ~/.carelink-reach/oi-service.json`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
