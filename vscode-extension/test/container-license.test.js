const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('container creation ignores an omitted or blank license and warns only for a missing file', {
  skip: process.platform !== 'win32'
}, () => {
  const result = spawnSync('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'container-license.tests.ps1')
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
