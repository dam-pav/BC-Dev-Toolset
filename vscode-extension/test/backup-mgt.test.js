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

function assessSystemApplicationUpgrade({ platformVersion, databaseVersion, installedApps, packageApps }) {
  const script = [
    `. ${quotePowerShell(backupMgtPath)}`,
    `$installedApps = ConvertFrom-Json ${quotePowerShell(JSON.stringify(installedApps))}`,
    `$packageApps = ConvertFrom-Json ${quotePowerShell(JSON.stringify(packageApps))}`,
    `Get-BcSystemApplicationUpgradeAssessment -platformVersion ${quotePowerShell(platformVersion)} -databaseApplicationVersion ${quotePowerShell(databaseVersion)} -installedApps @($installedApps) -packageApps @($packageApps) | ConvertTo-Json -Depth 5 -Compress`
  ].join('; ');
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const microsoftAppNames = ['System Application', 'Base Application', 'Application'];

function versionedApps(version, includePaths = false) {
  return microsoftAppNames.map((Name) => ({
    Name,
    Version: version,
    ...(includePaths ? { Path: `C:\\Applications\\${Name}.app` } : {})
  }));
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

test('uses the direct backup-file restore path for a stopped single-tenant service', () => {
  const script = [
    `. ${quotePowerShell(backupMgtPath)}`,
    "$entries = @([pscustomobject]@{ DatabaseName='CRONUS'; DatabaseRole='database'; HelperFileName='database.bak' })",
    "Get-BcContainerSqlBackupRestoreParameters -containerName 'OTPtest' -bakFolder 'C:\\restore' -backupEntries $entries | ConvertTo-Json -Compress"
  ].join('; ');
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    bakFile: 'C:\\restore\\database.bak',
    containerName: 'OTPtest',
    databaseName: 'CRONUS'
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

test('accepts a same-major restored database split when container packages match the platform', () => {
  const assessment = assessSystemApplicationUpgrade({
    platformVersion: '23.0.31371.0',
    databaseVersion: '23.0.12831.0',
    installedApps: versionedApps('23.0.12034.12841'),
    packageApps: versionedApps('23.5.16502.31399', true)
  });

  assert.equal(assessment.SplitDetected, true);
  assert.equal(assessment.Viable, true);
  assert.equal(assessment.TargetVersion, '23.5.16502.31399');
  assert.equal(assessment.Apps.length, 3);
});

test('does not attempt an upgrade when restored system components are already aligned', () => {
  const assessment = assessSystemApplicationUpgrade({
    platformVersion: '23.5.16502.31399',
    databaseVersion: '23.5.16502.31399',
    installedApps: versionedApps('23.5.16502.31399'),
    packageApps: versionedApps('23.5.16502.31399', true)
  });

  assert.equal(assessment.SplitDetected, false);
  assert.equal(assessment.Viable, false);
  assert.match(assessment.Reason, /already match/i);
});

test('rejects downgrade, cross-major, and mismatched-package upgrade assessments', () => {
  const downgrade = assessSystemApplicationUpgrade({
    platformVersion: '23.5.16502.31399',
    databaseVersion: '23.6.0.0',
    installedApps: versionedApps('23.6.0.0'),
    packageApps: versionedApps('23.5.16502.31399', true)
  });
  assert.equal(downgrade.Viable, false);
  assert.match(downgrade.Reason, /newer than/i);

  const crossMajor = assessSystemApplicationUpgrade({
    platformVersion: '24.1.0.0',
    databaseVersion: '23.5.0.0',
    installedApps: versionedApps('23.5.0.0'),
    packageApps: versionedApps('24.1.0.0', true)
  });
  assert.equal(crossMajor.Viable, false);
  assert.match(crossMajor.Reason, /major version/i);

  const mismatchedPackages = versionedApps('23.5.16502.31399', true);
  mismatchedPackages[1].Version = '23.4.0.0';
  const mismatch = assessSystemApplicationUpgrade({
    platformVersion: '23.5.16502.31399',
    databaseVersion: '23.0.0.0',
    installedApps: versionedApps('23.0.0.0'),
    packageApps: mismatchedPackages
  });
  assert.equal(mismatch.Viable, false);
  assert.match(mismatch.Reason, /one matching version/i);

  const platformMismatch = assessSystemApplicationUpgrade({
    platformVersion: '22.0.0.0',
    databaseVersion: '23.0.0.0',
    installedApps: versionedApps('23.0.0.0'),
    packageApps: versionedApps('23.5.16502.31399', true)
  });
  assert.equal(platformMismatch.Viable, false);
  assert.match(platformMismatch.Reason, /platform major version/i);
});

test('system application restore upgrade keeps additive sync and dependency order', () => {
  const source = fs.readFileSync(backupMgtPath, 'utf8');
  const upgradeFunction = source.match(/function Invoke-BcContainerSystemApplicationUpgradeAfterRestore[\s\S]*?^}/m)?.[0] ?? '';
  const publishCommand = upgradeFunction.match(/Publish-NAVApp[\s\S]*?\| Out-Null/)?.[0] ?? '';

  assert.match(upgradeFunction, /System Application[\s\S]*Base Application[\s\S]*Application/);
  assert.match(publishCommand, /-SkipVerification[\s\S]*-Force/);
  assert.doesNotMatch(publishCommand, /-Confirm/);
  assert.match(upgradeFunction, /Sync-NAVApp[\s\S]*-Mode Add/);
  assert.match(upgradeFunction, /Start-NAVAppDataUpgrade/);
  assert.match(upgradeFunction, /Set-NAVApplication[\s\S]*-Force[\s\S]*-Confirm:\$false[\s\S]*Sync-NAVTenant[\s\S]*-Mode Sync[\s\S]*-Force[\s\S]*-Confirm:\$false[\s\S]*Start-NAVDataUpgrade[\s\S]*-Force[\s\S]*-Confirm:\$false/);
  assert.match(upgradeFunction, /Get-NAVServerSession[\s\S]*Remove-NAVServerSession[\s\S]*-Force[\s\S]*-Confirm:\$false/);
  assert.doesNotMatch(upgradeFunction, /ForceSync/);
  assert.doesNotMatch(upgradeFunction, /Test Toolkit|test libraries/i);
});
