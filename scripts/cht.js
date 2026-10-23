'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const target = process.env.CHT_URL;
if (args.some(a => a.startsWith('upload-') || a.startsWith('backup-') || a.startsWith('validate-')) && !target) {
  throw new Error('Set CHT_URL to the authenticated local CHT API URL. See CARELINK_SETUP.md.');
}
const cli = require.resolve('cht-conf/src/bin/index.js');
const child = spawnSync(process.execPath, [cli, '--source=' + root, '--skip-version-check', '--skip-git-check', '--skip-dependency-check', ...(target ? ['--url=' + target] : []), ...args], { cwd: root, stdio: 'inherit' });
process.exit(child.status || (child.error ? 1 : 0));
