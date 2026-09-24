const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('selective isolation settings, partitioning, reporting and failure handling', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'test-isolation.tests.ps1')], {
    cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('shared and local isolation setting schemas stay aligned', () => {
  const pkg = require('../package.json');
  const schema = require('../schemas/bcdevtoolset-settings.schema.json');
  const shared = pkg.contributes.configuration.flatMap(group => Object.values(group.properties))
    .find(property => property.properties?.testIsolationDisabledCodeunits)
    .properties.testIsolationDisabledCodeunits;
  const local = schema.properties.testIsolationDisabledCodeunits;
  const maximumAlObjectId = 2 ** 31 - 1;
  assert.deepEqual(shared.items, { type: 'integer', minimum: 1, maximum: maximumAlObjectId });
  assert.deepEqual(shared.items, local.items);
  assert.deepEqual(shared.default, []);
  assert.deepEqual(local.default, []);
});
