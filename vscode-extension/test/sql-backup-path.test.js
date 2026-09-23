const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('SQL backup paths reject unsafe configurations without filesystem probes', {
  skip: process.platform !== 'win32'
}, () => {
  const result = spawnSync('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'sql-backup-path.tests.ps1')
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
