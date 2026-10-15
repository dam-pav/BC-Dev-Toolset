const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('platform target resolver classifies numeric release versions and validates artifact targets', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'test-targets.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
