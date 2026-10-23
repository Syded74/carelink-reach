'use strict';
// Reads the facility's CHT records as JSON on stdin and prints, as JSON, the day plans and request links
// the planning service should write (lib/oi-links.js). The Python worker writes them with its service account.
const { linkDocs } = require('../lib/oi-links');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify(linkDocs(JSON.parse(input), process.env.CARELINK_FACILITY_ID)));
});
