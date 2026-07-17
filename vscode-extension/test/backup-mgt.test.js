'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const backupMgtPath = path.resolve(__dirname, '..', '..', 'common', 'BackupMgt.ps1');

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getBackupEntries(fileNames) {
  const backupFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dev-toolset-backup-test-'));
  try {
    for (const fileName of fileNames) {
      fs.writeFileSync(path.join(backupFolder, fileName), '');
    }

    const script = [
      `. ${quotePowerShell(backupMgtPath)}`,
      `@(Get-SqlBackupSetEntries -backupRootPath ${quotePowerShell(backupFolder)}) | ConvertTo-Json -Compress`
    ].join('; ');
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(backupFolder, { recursive: true, force: true });
  }
}

test('removes a shared container prefix when staging a multitenant backup set', () => {
  const entries = getBackupEntries([
    'OTPtest.CRONUS.app.bak',
    'OTPtest.default.tenant.bak',
    'OTPtest.tenant.tenant.bak'
  ]);

  assert.deepEqual(entries.map(({ DatabaseName, HelperFileName }) => ({ DatabaseName, HelperFileName }))
    .sort((left, right) => left.HelperFileName.localeCompare(right.HelperFileName)), [
    { DatabaseName: 'CRONUS', HelperFileName: 'app.bak' },
    { DatabaseName: 'default', HelperFileName: 'default.bak' },
    { DatabaseName: 'tenant', HelperFileName: 'tenant.bak' }
  ]);
});

test('preserves database names in a service-created backup set', () => {
  const entries = getBackupEntries([
    'CRONUS.app.bak',
    'default.tenant.bak',
    'tenant.tenant.bak'
  ]);

  assert.deepEqual(entries.map(({ DatabaseName, HelperFileName }) => ({ DatabaseName, HelperFileName }))
    .sort((left, right) => left.HelperFileName.localeCompare(right.HelperFileName)), [
    { DatabaseName: 'CRONUS', HelperFileName: 'app.bak' },
    { DatabaseName: 'default', HelperFileName: 'default.bak' },
    { DatabaseName: 'tenant', HelperFileName: 'tenant.bak' }
  ]);
});

test('passes tenant IDs to BcContainerHelper so a stopped service can be restored', () => {
  const script = [
    `. ${quotePowerShell(backupMgtPath)}`,
    "$entries = @([pscustomobject]@{ DatabaseName='default'; DatabaseRole='tenant' }, [pscustomobject]@{ DatabaseName='tenant'; DatabaseRole='tenant' })",
    "Get-BcContainerSqlBackupRestoreParameters -containerName 'OTPtest' -bakFolder 'C:\\restore' -backupEntries $entries | ConvertTo-Json -Compress"
  ].join('; ');
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    bakFolder: 'C:\\restore',
    containerName: 'OTPtest',
    tenant: ['default', 'tenant']
  });
});

test('uses tenant IDs for service backup filenames while retaining source database names', () => {
  const script = [
    `. ${quotePowerShell(backupMgtPath)}`,
    "$info = [pscustomobject]@{ DatabaseName='BC App'; Multitenant=$true; Tenants=@([pscustomobject]@{ Id='north'; DatabaseName='BC Tenant North' }, [pscustomobject]@{ Id='south'; DatabaseName='BC Tenant South' }) }",
    "@(Get-BcServiceSqlBackupRequests -serviceDatabaseInfo $info -serverInstance 'BC') | ConvertTo-Json -Compress"
  ].join('; ');
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { DatabaseName: 'BC App', FileName: 'BC App.app.bak' },
    { DatabaseName: 'BC Tenant North', FileName: 'north.tenant.bak' },
    { DatabaseName: 'BC Tenant South', FileName: 'south.tenant.bak' }
  ]);
});
