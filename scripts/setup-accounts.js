'use strict';
/*
  Creates the Tolon District place hierarchy and one account per person in planning/tolon-district.json
  (npm run setup-accounts). People are fictional. The password comes from CARELINK_ACCOUNT_PASSWORD and is
  never written to the project; usernames, roles and places go to ~/.carelink-reach/accounts.json (mode 0600).
  Places and people are create-only, so reruns leave edited records alone; existing accounts are updated
  to the roster's role, place and person record, and get the password again.
*/
const { connection, writePrivate } = require('./client');
const district = require('../planning/tolon-district.json');

function records(now = Date.now()) {
  const docs = [];
  const place = (p, type, parent) => {
    const doc = { _id: p.id, type: 'contact', contact_type: 'carelink_' + type, name: p.name, reported_date: now, ...(parent && { parent }) };
    docs.push(doc); return { _id: doc._id, ...(parent && { parent }) };
  };
  const region = place(district.region, 'region');
  const districtRef = place(district.district, 'district', region);
  const users = [{ username: district.admin.username, fullname: district.admin.name, roles: [district.admin.role], place: district.district.id }];
  for (const f of district.facilities) {
    const facility = place(f, 'facility', districtRef);
    const community = Object.fromEntries(f.communities.map(c => [c.id, place(c, 'community', facility)]));
    for (const p of f.people) {
      const places = p.communities || [f.id];
      docs.push({ _id: p.id, type: 'contact', contact_type: 'carelink_individual', name: p.name, carelink_role: p.role,
        reported_date: now, parent: p.communities ? community[p.communities[0]] : facility });
      users.push({ username: p.username, fullname: p.name, roles: [p.role], place: places, contact: p.id });
    }
  }
  return { docs, users };
}

(async () => {
  const password = process.env.CARELINK_ACCOUNT_PASSWORD;
  if (!password) { throw new Error('Set CARELINK_ACCOUNT_PASSWORD.'); }
  const api = connection();
  const couch = connection('CHT_COUCH_URL');
  const { docs, users } = records();
  const names = Object.fromEntries(docs.map(d => [d._id, d.name]));
  const existing = await couch('/medic/_all_docs', { method: 'POST', body: JSON.stringify({ keys: docs.map(d => d._id) }) });
  const present = new Set(existing.rows.filter(r => r.value && !r.value.deleted).map(r => r.id));
  const fresh = docs.filter(d => !present.has(d._id));
  if (fresh.length) {
    const results = await couch('/medic/_bulk_docs', { method: 'POST', body: JSON.stringify({ docs: fresh }) });
    if (results.some(r => r.error)) { throw new Error('Insert failed: ' + JSON.stringify(results.filter(r => r.error))); }
  }
  const accounts = {};
  for (const { username, fullname, roles, place, contact } of users) {
    const places = [].concat(place);
    let exists = true;
    try { await api('/api/v2/users/' + username); } catch (e) { if (e.status !== 404) { throw e; } exists = false; }
    const profile = { password, fullname, roles, place: places, ...(contact && { contact }) };
    if (exists) {
      await api('/api/v1/users/' + username, { method: 'POST', body: JSON.stringify(profile) });
    } else {
      await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ ...profile, username, place: places[0] }) });
      if (places.length > 1) { await api('/api/v1/users/' + username, { method: 'POST', body: JSON.stringify({ place: places }) }); }
    }
    accounts[username] = { fullname, role: roles[0], places: places.map(id => names[id]) };
  }
  writePrivate('accounts.json', accounts);
  console.log(JSON.stringify({ inserted: fresh.length, unchanged: present.size, accounts: Object.keys(accounts).length }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
