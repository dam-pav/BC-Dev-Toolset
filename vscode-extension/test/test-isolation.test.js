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

test('an invalid codeunit selection exits through the red launcher diagnostic before starting work', () => {
  const command = `
    function global:Write-Host {
      param($Object, [ConsoleColor] $ForegroundColor)
      if ($Object -eq 'Run AL test tool tests failed during test selection validation.' -and
          $ForegroundColor -ne 'Red') { throw 'Test selection failure heading must be red' }
      Microsoft.PowerShell.Utility\\Write-Host $Object
    }
    & ./Invoke-BcDevToolsetOperation.ps1 -Operation invokeTests -NonInteractive
    exit $LASTEXITCODE
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8',
    env: { ...process.env, BCDEVTOOLSET_TEST_CODEUNIT_IDS: '[]', BCDEVTOOLSET_TEST_SUITE: '' }
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Run AL test tool tests failed during test selection validation\./);
  assert.match(result.stdout, /codeunitIds must be a non-empty JSON array.*Choose valid test codeunits or request all tests.*No build, container preparation, or test execution was started\./);
  assert.doesNotMatch(result.stdout, /DONE/);
  assert.equal(result.stderr, '');
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
