'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { connection, stateDir, writePrivate } = require('./client');
const { generate } = require('../lib/demo-data');
(async () => {
  const api = connection();
  const couch = connection('CHT_COUCH_URL');
  const manifestPath = path.join(stateDir, 'seed-manifest.json');
  if (process.argv.includes('--cleanup')) {
    if (!fs.existsSync(manifestPath)) { throw new Error('No seed manifest: refusing cleanup.'); }
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    for (const username of manifest.users) { try { await api('/api/v1/users/' + username, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) { throw e; } } }
    const all = (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc);
    const docs = all.filter(d => manifest.docIds.includes(d._id) ||
      (d.type === 'data_record' && d.fields && d.fields.demo === 'true' && d.fields.patient_id && manifest.docIds.includes(d.fields.patient_id)) ||
      (['task','target','user-settings'].includes(d.type) && (manifest.users.some(u => d.user === 'org.couchdb.user:' + u || d._id.includes('org.couchdb.user:' + u)))));
    if (docs.length) {
      const result = await couch('/medic/_bulk_docs', { method: 'POST', body: JSON.stringify({docs:docs.map(d => ({_id:d._id,_rev:d._rev,_deleted:true}))}) });
      if (result.some(d => d.error)) { throw new Error('Cleanup contained errors: ' + JSON.stringify(result.filter(d=>d.error))); }
    }
    fs.renameSync(manifestPath, manifestPath + '.cleaned-' + Date.now());
    console.log(`Removed ${docs.length} manifest-owned demo documents; original records preserved.`); return;
  }
  const { docs, users } = generate();
  // Stable IDs and create-only inserts make reruns idempotent and preserve demo edits.
  const existing = await couch('/medic/_all_docs', { method:'POST', body:JSON.stringify({keys:docs.map(d=>d._id)}) });
  const present = new Set(existing.rows.filter(r=>r.value && !r.value.deleted).map(r=>r.id));
  const newDocs = docs.filter(d=>!present.has(d._id));
  // Persist ownership before writes, so partial installation can be safely cleaned.
  if (!fs.existsSync(manifestPath)) { writePrivate('seed-manifest.json',{docIds:docs.map(d=>d._id),users:users.map(u=>u.username),created_at:new Date().toISOString()}); }
  else {
    // Later seed versions (e.g. maternal and child tracking) add documents: record them so cleanup owns them too.
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    const added = docs.map(d=>d._id).filter(id=>!manifest.docIds.includes(id));
    if (added.length) { writePrivate('seed-manifest.json',{...manifest,docIds:[...manifest.docIds,...added],updated_at:new Date().toISOString()}); }
  }
  if (newDocs.length) {
    const results = await couch('/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs:newDocs})});
    if (results.some(r=>r.error)) { throw new Error('Seed insert failed: '+JSON.stringify(results.filter(r=>r.error))); }
  }
  const credentialsPath = path.join(stateDir,'demo-credentials.json');
  const credentials = fs.existsSync(credentialsPath) ? JSON.parse(fs.readFileSync(credentialsPath)) : {};
  for (const user of users) {
    let exists = false;
    try { await couch('/_users/' + encodeURIComponent('org.couchdb.user:' + user.username)); exists = true; } catch(e) { if(e.status!==404) {throw e;} }
    if (!exists || !credentials[user.username]) {
      const password = 'ClR-' + crypto.randomBytes(18).toString('base64url') + '-7a!';
      const route = '/api/v1/users' + (exists ? '/' + user.username : '');
      const payload = exists ? {password} : {...user, place:Array.isArray(user.place)?user.place[0]:user.place, password, fullname:'DEMO '+user.username};
      const result = await api(route,{method:'POST',body:JSON.stringify(payload)});
      if (result.error) {throw Error(JSON.stringify(result));}
      credentials[user.username]={password,role:user.roles[0]};
      writePrivate('demo-credentials.json',credentials);
    }
    if (Array.isArray(user.place)) { await api('/api/v1/users/' + user.username, {method:'POST',body:JSON.stringify({place:user.place})}); }
  }
  console.log(JSON.stringify({inserted:newDocs.length,unchanged:present.size,accounts:users.length,credentials:credentialsPath}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
