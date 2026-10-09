const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('both container test operations build before container access and deploy with an implicit single target', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'test-preparation.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
