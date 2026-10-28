const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

for (const scenario of ['interrupted', 'truncated', 'exhausted', 'corrupt-cache', 'valid-cache', 'checksum']) {
  test(`pinned baseline download handles ${scenario} without accepting incomplete or unverified content`, () => {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'bc-data-symbol-download.tests.ps1'), '-Scenario', scenario],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
