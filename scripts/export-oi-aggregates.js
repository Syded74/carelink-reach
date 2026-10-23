'use strict';
// Writes the community-level dataset for outreach-intelligence/ (npm run oi-export). Read-only on CHT.
const fs = require('node:fs');
const path = require('node:path');
const { connection, stateDir } = require('./client');
const { exportAggregates, scopeToFacility } = require('../lib/oi-export');

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const docs = (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc);
  // CARELINK_INCLUDE_TEST_RECORDS is set only for a plan request marked as a regression test (labelled as such).
  const { dataset, provenance } = exportAggregates(scopeToFacility(docs, process.env.CARELINK_FACILITY_ID), undefined, undefined,
    { includeTestRecords: process.env.CARELINK_INCLUDE_TEST_RECORDS === '1' });
  const dir = path.join(stateDir, 'outreach-intelligence');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'live-cht.json'), JSON.stringify(dataset, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'live-cht-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { mode: 0o600 });
  console.log(`Exported ${dataset.communities.length} communities, ${dataset.history.length} community-weeks to ${dir}`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
