const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const document = fs.readFileSync(path.join(__dirname, '..', '..', 'documentation', 'BCDataCompatibilityExperiments.md'), 'utf8');
const ledger = document.split('## Result ledger')[1]?.split('### Historical checkpoint')[0] ?? '';

test('compatibility ledger records the passing BC24, BC25 and BC26 qualification runs', () => {
  for (const [target, version] of [
    ['BC24', '24.18.40043.0'],
    ['BC25', '25.18.48229.0'],
    ['BC26', '26.18.55014.0']
  ]) {
    const row = ledger.split('\n').find(line => line.startsWith(`| ${target} |`));
    assert.ok(row, `${target} must appear in the current ledger`);
    assert.ok(row.includes(version), `${target} must identify its tested application build`);
    for (const result of ['118/118', '64 authorization checks', '8/8', '10/10', '4/4', 'HTTP/1.0 passed']) {
      assert.ok(row.includes(result), `${target} must retain the recorded result: ${result}`);
    }
    assert.match(row, /Passed/);
    assert.doesNotMatch(row, /Not run|Pending/);
  }
  assert.match(ledger, /BC25[^\n]*Each locking mode[^\n]*both tri-state and legacy locking/);
});

test('ledger separates qualified builds from pending migration and historical gates', () => {
  assert.match(ledger, /companion \*\*0\.1\.10\.0\*\*/);
  assert.match(ledger, /do not qualify the later \*\*0\.1\.11\.0\*\* object-ID migration build/);
  assert.match(ledger, /\| BC27\.0 \| Not run \| Not run \| Pending \|/);
  assert.match(document, /### Historical checkpoint \(2026-10-15\)[\s\S]*pending gates are historical, not the current result ledger/);
});
