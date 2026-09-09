'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const backupMgtPath = path.resolve(__dirname, '..', '..', 'common', 'BackupMgt.ps1');

function runRestoreRepair({ users = [], permissions = [], authentication = 'UserPassword', actualAuthentication = 'NavUserPassword', configurationShape = 'string', failCreate = false } = {}) {
  const script = `
    $ErrorActionPreference = 'Stop'
    . ${quotePowerShell(backupMgtPath)}
    $script:users = @(ConvertFrom-Json ${quotePowerShell(JSON.stringify(users))})
    $script:permissions = @(ConvertFrom-Json ${quotePowerShell(JSON.stringify(permissions))})
    $script:calls = [System.Collections.Generic.List[object]]::new()
    function Get-BcConfigurationCredential {
      param($configuration)
      [pscredential]::new($configuration.bcUser, (ConvertTo-SecureString $configuration.bcPassword -AsPlainText -Force))
    }
    function Get-BcRestoreWindowsNetworkAccount { 'NETWORK\\developer' }
    function New-Object {
      param($TypeName, $ArgumentList)
      if ($TypeName -ne 'System.Security.Principal.NTAccount') { throw "Unexpected type: $TypeName" }
      $account = [pscustomobject]@{}
      $account | Add-Member ScriptMethod Translate { param($type) [pscustomobject]@{ Value = 'S-1-5-21-123' } }
      $account
    }
    function Invoke-ScriptInBcContainer {
      param($containerName, $ScriptBlock, $ArgumentList)
      $ServerInstance = 'BC'
      & $ScriptBlock @ArgumentList
    }
    function Get-NAVServerConfiguration {
      param($ServerInstance, $KeyName)
      if ($ServerInstance -ne 'BC' -or $KeyName -ne 'ClientServicesCredentialType') { throw 'Unexpected configuration query' }
      $value = ${quotePowerShell(actualAuthentication)}
      switch (${quotePowerShell(configurationShape)}) {
        'string' { $value }
        'Value' { [pscustomobject]@{ Value = $value } }
        'KeyValue' { [pscustomobject]@{ KeyValue = $value } }
        'null' { $null }
        'unknown' { [pscustomobject]@{ Unexpected = $value } }
      }
    }
    function Get-NAVServerUser { $script:users }
    function Get-NAVServerUserPermissionSet { $script:permissions }
    function New-NAVServerUser {
      param($ServerInstance, $Tenant, $UserName, $WindowsAccount, $Password, [switch]$ChangePasswordAtNextLogOn, $State, $ExpiryDate)
      if ($${failCreate}) { throw 'Company information is required' }
      $script:calls.Add(@{ Action='create'; Tenant=$Tenant; UserName=$UserName; WindowsAccount=$WindowsAccount; SecurePassword=($Password -is [securestring]) })
    }
    function Set-NAVServerUser {
      param($ServerInstance, $Tenant, $UserName, $WindowsAccount, $Password, [switch]$ChangePasswordAtNextLogOn, $State, $ExpiryDate, [switch]$Force)
      $script:calls.Add(@{ Action='update'; Tenant=$Tenant; State=$State; NeverExpires=($ExpiryDate -eq [datetime]::MinValue); SecurePassword=($Password -is [securestring]); ChangePassword=[bool]$ChangePasswordAtNextLogOn })
    }
    function New-NAVServerUserPermissionSet {
      param($ServerInstance, $Tenant, $UserName, $WindowsAccount, $PermissionSetId)
      $script:calls.Add(@{ Action='grant'; Tenant=$Tenant; PermissionSetId=$PermissionSetId })
    }
    $configuration = [pscustomobject]@{ container='target'; authentication=${quotePowerShell(authentication)}; bcUser='admin'; bcPassword='test-only-password' }
    try {
      Repair-BcContainerAdministratorAfterRestore -configuration $configuration -tenants @('default', 'other', 'default') 6>$null
      @{ Calls=@($script:calls.ToArray()); Error=$null } | ConvertTo-Json -Depth 6 -Compress
    } catch {
      @{ Calls=@($script:calls.ToArray()); Error=$_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /test-only-password/);
  return JSON.parse(result.stdout);
}

test('restore creates the configured administrator and grants SUPER once in each restored tenant', () => {
  const result = runRestoreRepair({ users: [{ UserName: 'source-admin' }] });
  assert.equal(result.Error, null);
  assert.deepEqual(result.Calls.map(({ Action, Tenant }) => [Action, Tenant]), [
    ['create', 'default'], ['grant', 'default'],
    ['create', 'other'], ['grant', 'other']
  ]);
  assert.ok(result.Calls.filter(call => call.Action === 'create').every(call => call.UserName === 'admin' && call.SecurePassword));
  assert.ok(result.Calls.filter(call => call.Action === 'grant').every(call => call.PermissionSetId === 'SUPER'));
});

test('restore reads scalar and wrapped authentication settings', () => {
  for (const configurationShape of ['string', 'Value', 'KeyValue']) {
    const result = runRestoreRepair({ configurationShape });
    assert.equal(result.Error, null, configurationShape);
    assert.equal(result.Calls.filter(call => call.Action === 'create').length, 2);
  }
});

test('unreadable authentication stops before user changes without reporting a configuration mismatch', () => {
  for (const options of [{ actualAuthentication: '' }, { actualAuthentication: '  ' }, { configurationShape: 'null' }, { configurationShape: 'unknown' }]) {
    const result = runRestoreRepair(options);
    assert.match(result.Error, /Could not read.*ClientServicesCredentialType/);
    assert.doesNotMatch(result.Error, /does not match configured/);
    assert.deepEqual(result.Calls, []);
  }
});

test('restore repairs existing disabled password users without duplicate users or SUPER grants', () => {
  const result = runRestoreRepair({
    users: [{ UserName: 'ADMIN', State: 'Disabled' }],
    permissions: [{ PermissionSetId: 'SUPER', CompanyName: '' }]
  });
  assert.equal(result.Error, null);
  assert.equal(result.Calls.length, 2);
  assert.ok(result.Calls.every(call => call.Action === 'update' && call.State === 'Enabled' && call.NeverExpires && call.SecurePassword && !call.ChangePassword));
});

test('company-specific SUPER is insufficient for restored administrative access', () => {
  const result = runRestoreRepair({
    users: [{ UserName: 'admin', State: 'Enabled' }],
    permissions: [{ PermissionSetId: 'SUPER', CompanyName: 'CRONUS' }]
  });
  assert.equal(result.Error, null);
  assert.equal(result.Calls.filter(call => call.Action === 'grant').length, 2);
});

test('Windows restore uses the outbound account instead of the configured password username', () => {
  const result = runRestoreRepair({ authentication: 'Windows', actualAuthentication: 'Windows' });
  assert.equal(result.Error, null);
  assert.ok(result.Calls.filter(call => call.Action === 'create').every(call => call.WindowsAccount === 'NETWORK\\developer' && !call.SecurePassword));
  assert.equal(result.Calls.filter(call => call.Action === 'update').length, 0);
});

test('Windows restore matches existing users by SID and leaves valid administrators unchanged', () => {
  const result = runRestoreRepair({
    authentication: 'Windows', actualAuthentication: 'Windows',
    users: [{ UserName: 'different-spelling', WindowsSecurityId: 'S-1-5-21-123', State: 'Enabled' }],
    permissions: [{ PermissionSetId: 'SUPER', CompanyName: '' }]
  });
  assert.equal(result.Error, null);
  assert.deepEqual(result.Calls, []);
});

test('restore stops on authentication mismatch and surfaces extension user-creation failures', () => {
  const mismatch = runRestoreRepair({ actualAuthentication: 'Windows' });
  assert.match(mismatch.Error, /does not match configured/);
  assert.deepEqual(mismatch.Calls, []);
  const extensionFailure = runRestoreRepair({ failCreate: true });
  assert.match(extensionFailure.Error, /restore completed.*Company information is required.*disable it \(or uninstall it\).*source/i);
  assert.deepEqual(extensionFailure.Calls, []);
  const unsupported = runRestoreRepair({ authentication: 'AAD' });
  assert.match(unsupported.Error, /does not support authentication/);
  assert.deepEqual(unsupported.Calls, []);
});

test('native outbound lookup honors a Windows net-only logon', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    . ${quotePowerShell(backupMgtPath)}
    $null = Get-BcRestoreWindowsNetworkAccount
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RestoreNetOnlyTest {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LogonUserW(string user, string domain, string password,
        int type, int provider, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ImpersonateLoggedOnUser(IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool RevertToSelf();
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    public static string Read(System.Reflection.MethodInfo readIdentity) {
        IntPtr token;
        // LOGON32_LOGON_NEW_CREDENTIALS + WINNT50: same semantics as runas /netonly.
        // These synthetic credentials are never authenticated against a server.
        if (!LogonUserW("restore-test", "RESTORETEST", "synthetic-test-only", 9, 3, out token))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if (!ImpersonateLoggedOnUser(token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return (string)readIdentity.Invoke(null, null); }
            finally { if (!RevertToSelf()) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        }
        finally { CloseHandle(token); }
    }
}
'@
    $name = [RestoreNetOnlyTest]::Read([BcDevToolset.RestoreNetworkIdentity].GetMethod('GetAccount'))
    if ($name -notin @('RESTORETEST\\restore-test', 'restore-test@RESTORETEST')) { throw 'Outbound identity did not match the net-only account.' }
    Write-Output 'passed'
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'passed');
});

test('shared restore repairs access after restore and upgrade with the selected configuration', () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    . ${quotePowerShell(backupMgtPath)}
    $script:events = [System.Collections.Generic.List[string]]::new()
    function Restore-DatabasesInBcContainer { $script:events.Add('restore') }
    function Invoke-BcContainerSystemApplicationUpgradeAfterRestore { $script:events.Add('upgrade') }
    function Repair-BcContainerAdministratorAfterRestore {
      param($configuration, $tenants)
      if ($configuration.bcUser -ne 'selected-admin') { throw 'Lost selected configuration' }
      $script:events.Add('repair:' + ($tenants -join ','))
    }
    $config = [pscustomobject]@{ container='target'; bcUser='selected-admin' }
    $entries = @([pscustomobject]@{ DatabaseRole='tenant'; DatabaseName='north' }, [pscustomobject]@{ DatabaseRole='tenant'; DatabaseName='south' })
    Restore-BcContainerSqlBackupEntries -containerName target -bakFolder 'C:\\restore' -backupEntries $entries -configuration $config
    ConvertTo-Json -InputObject @($script:events.ToArray()) -Compress
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['restore', 'upgrade', 'repair:north,south']);
});

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
