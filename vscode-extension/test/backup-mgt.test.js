'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const backupMgtPath = path.resolve(__dirname, '..', '..', 'common', 'BackupMgt.ps1');

test('remoting recovery cancels cleanly or repairs and retries with explicit credentials', () => {
  for (const repair of [false, true]) {
    const script = `
      . ${quotePowerShell(backupMgtPath)}
      $script:attempts = 0
      $script:repairs = 0
      $script:answers = [collections.generic.queue[string]]::new()
      ${repair ? "$script:answers.Enqueue('T'); $script:answers.Enqueue('y')" : "$script:answers.Enqueue('')"}
      function Read-Host { $script:answers.Dequeue() }
      function Offer-ConfigurationCredentialStorage {}
      function Get-Credential { [pscredential]::new('server\\user', (ConvertTo-SecureString 'test' -AsPlainText -Force)) }
      function Invoke-BackupRemotingRepair { param($computerName, $addTrustedHost) if ($computerName -ne 'taopaipai' -or -not $addTrustedHost) { throw 'Wrong repair' }; $script:repairs++ }
      function New-PSSession {
        param($ComputerName, $Credential, $ErrorAction)
        $script:attempts++
        if ($script:attempts -eq 1) { throw 'TrustedHosts required' }
        if (-not $Credential) { throw 'Missing credential' }
        'connected'
      }
      try {
        $session = New-RemoteBackupSession -computerName 'taopaipai' -configuration ([pscustomobject]@{}) 6>$null
        @{ Session=$session; Repairs=$script:repairs; Attempts=$script:attempts } | ConvertTo-Json -Compress
      } catch {
        @{ Cancelled=$_.Exception.Data['BackupRemotingCancelled']; Repairs=$script:repairs; Attempts=$script:attempts } | ConvertTo-Json -Compress
      }
    `;
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), repair
      ? { Session: 'connected', Repairs: 1, Attempts: 2 }
      : { Cancelled: true, Repairs: 0, Attempts: 1 });
  }
});

test('successful remote sessions are returned without recovery actions', () => {
  const script = `
    . ${quotePowerShell(backupMgtPath)}
    function New-PSSession { param($ComputerName, $ErrorAction) @{ Host=$ComputerName; Mode=$ErrorAction } }
    New-RemoteBackupSession -computerName 'backup-host' -configuration ([pscustomobject]@{}) | ConvertTo-Json -Compress
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { Host: 'backup-host', Mode: 'Stop' });
});

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
    function Invoke-ScriptInBcContainer { param($containerName, $ScriptBlock) & $ScriptBlock }
    function Get-NAVTenant { [pscustomobject]@{ Id='north' }; [pscustomobject]@{ Id='south' } }
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

test('restore distinguishes the template database from mounted tenants and rejects missing tenants', () => {
  for (const mounted of [['default'], ['default', 'tenant'], []]) {
    const script = `
      $ErrorActionPreference = 'Stop'
      . ${quotePowerShell(backupMgtPath)}
      function Restore-DatabasesInBcContainer {
        param($tenant)
        if (($tenant -join ',') -ne 'default,tenant') { throw 'Template must still be restored' }
      }
      function Invoke-BcContainerSystemApplicationUpgradeAfterRestore {}
      function Invoke-ScriptInBcContainer { param($ScriptBlock) & $ScriptBlock }
      function Get-NAVTenant {
        foreach ($id in (ConvertFrom-Json ${quotePowerShell(JSON.stringify(mounted))})) { [pscustomobject]@{ Id=$id } }
      }
      function Repair-BcContainerAdministratorAfterRestore { param($tenants) 'repair:' + ($tenants -join ',') }
      $entries = @('default', 'tenant') | ForEach-Object { [pscustomobject]@{ DatabaseRole='tenant'; DatabaseName=$_ } }
      try {
        Restore-BcContainerSqlBackupEntries -containerName target -bakFolder 'C:\\restore' -backupEntries $entries -configuration ([pscustomobject]@{})
      } catch { 'error:' + $_.Exception.Message }
    `;
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (mounted.length) assert.equal(result.stdout.trim(), `repair:${mounted.join(',')}`);
    else assert.match(result.stdout, /error:Database restore completed, but restored tenants are not mounted.*default/);
  }
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

// Exercises a Windows drive through PowerShell's filesystem provider (unavailable on Linux).
test('uses the direct backup-file restore path for a stopped single-tenant service', { skip: process.platform !== 'win32' && 'Requires Windows drive path semantics; covered by AL compatibility Windows CI' }, () => {
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


function discoverRemoteService({ command = '"C:\\BC23\\Service\\Microsoft.Dynamics.Nav.Server.exe" $230', missingService = false, missingTools = false, failImport = false, multitenant = true } = {}) {
  const script = `
    . ${quotePowerShell(backupMgtPath)}
    $script:loaded = $false; $script:removed = $false; $script:imported = ''; $script:seenService = ''
    function New-RemoteBackupSession { 'session' }
    function Remove-PSSession { $script:removed = $true }
    function Invoke-Command { param($Session, $ScriptBlock, [object[]] $ArgumentList, $ErrorAction) & $ScriptBlock @ArgumentList }
    function Get-CimInstance {
      if ($${missingService}) { return }
      [pscustomobject]@{ Name='MicrosoftDynamicsNavServer$230'; PathName=${quotePowerShell(command)} }
      [pscustomobject]@{ Name='MicrosoftDynamicsNavServer$240'; PathName='"C:\\BC24\\Service\\Microsoft.Dynamics.Nav.Server.exe" $240' }
    }
    function Get-Command { param($Name) if ($script:loaded -and ($Name -eq 'Get-NAVServerConfiguration' -or $${multitenant})) { $true } }
    function Test-Path { param($LiteralPath, $PathType) -not $${missingTools} }
    function Import-Module {
      param($Name, $ErrorAction)
      $script:imported = $Name
      if ($${failImport}) { throw 'Loader compatibility error' }
      $script:loaded = $true
    }
    function Get-NAVServerConfiguration {
      param($ServerInstance, $KeyName, $ErrorAction)
      $script:seenService = $ServerInstance
      switch ($KeyName) {
        'DatabaseServer' { 'sql-host' }
        'DatabaseInstance' { 'SQL' }
        'DatabaseName' { 'BC App' }
        'Multitenant' { '${multitenant}' }
      }
    }
    function Get-NAVTenant { [pscustomobject]@{ Id='tenant1'; DatabaseName='BC Tenant' } }
    try { $info = Get-BcServiceDatabaseInfoRemote -computerName taopaipai -serverInstance '230' -configuration ([pscustomobject]@{}) }
    catch { $failure = $_.Exception.Message }
    @{ Info=$info; Error=$failure; Imported=$script:imported; Removed=$script:removed; Instance=$script:seenService } | ConvertTo-Json -Depth 5 -Compress
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// The remote Windows script runs locally in this harness, including System.IO Windows path parsing.
test('remote discovery loads administration tools from the exact registered service installation', { skip: process.platform !== 'win32' && 'Requires Windows service installation paths; covered by AL compatibility Windows CI' }, () => {
  for (const command of ['"C:\\BC23\\Service\\Microsoft.Dynamics.Nav.Server.exe" $230', 'D:\\Custom BC\\Service\\Microsoft.Dynamics.Nav.Server.exe $230']) {
    const result = discoverRemoteService({ command });
    assert.equal(result.Error, null);
    assert.equal(result.Removed, true);
    assert.equal(result.Instance, '230');
    assert.match(result.Imported, /(?:BC23|Custom BC)\\Service\\NavAdminTool.ps1$/);
    assert.equal(result.Info.DatabaseServer, 'sql-host');
    assert.deepEqual(result.Info.Tenants, [{ Id: 'tenant1', DatabaseName: 'BC Tenant' }]);
  }
});

test('single tenant remote discovery does not require tenant cmdlets', () => {
  const result = discoverRemoteService({ multitenant: false });
  assert.equal(result.Error, null);
  assert.deepEqual(result.Info.Tenants, []);
});

test('remote discovery reports installation failures and always closes the session', () => {
  for (const [options, expected] of [
    [{ missingService: true }, /Check serverInstance and managementServer/],
    [{ missingTools: true }, /Install or repair/],
    [{ failImport: true }, /Loader compatibility error/],
    [{ command: 'relative\\Microsoft.Dynamics.Nav.Server.exe' }, /unsupported executable path/]
  ]) {
    const result = discoverRemoteService(options);
    assert.match(result.Error, expected);
    assert.equal(result.Removed, true);
    assert.equal(result.Info, null);
  }
});


// The mocked remoting executes Windows export paths through the local PowerShell provider.
test('service SQL export uses one source and destination and stops on SQL or copy failures', { skip: process.platform !== 'win32' && 'Requires Windows export paths; covered by AL compatibility Windows CI' }, () => {
  for (const mode of ['sql', 'missing', 'copy', 'success']) {
    const script = `
      . ${quotePowerShell(backupMgtPath)}
      $script:copies=0; $script:backups=0; $script:closed=0; $script:localClears=0; $script:hostSaves=0; $script:messages=@()
      function Write-Host { param($Object) $script:messages += [string]$Object }
      function Save-BcDatabaseServerHost { $script:hostSaves++ }
      function Import-BcServiceBackupDiscoveryModules {}
      function Select-IndexFromList { 1 }
      function Read-Host { 'n' }
      $env:BCDEVTOOLSET_MCP_SESSION_ID=''; $env:BCDEVTOOLSET_NON_INTERACTIVE=''
      function Get-BcServiceDatabaseInfo { param($configuration) if ($configuration.name -ne 'Source2') { throw 'Wrong source' }; [pscustomobject]@{ DatabaseServer='DB-SERVER'; DatabaseInstance='SQLSERVER2019'; DatabaseName='Test'; Multitenant=$false; Tenants=@() } }
      function Test-IsLocalSqlServer { $false }
      function New-RemoteBackupSession { 'session' }
      function Remove-PSSession { $script:closed++ }
      function Invoke-Command { [CmdletBinding()]param($Session,$ScriptBlock,[object[]]$ArgumentList) & $ScriptBlock @ArgumentList }
      function New-Item {}
      function Get-ChildItem { param($Path) if ($Path -like 'C:\\exports\\*') { $script:localClears++ } }
      function Remove-Item {}
      function Get-Command { $true }
      function Test-Path { '${mode}' -ne 'missing' }
      function Backup-SqlDatabase {
        [CmdletBinding()]param($ServerInstance,$Database,$BackupFile,$CopyOnly,$Initialize,$SqlCredential)
        $script:backups++
        if ('${mode}' -eq 'sql') {
          $inner = [Exception]::new('SQL login rejected: diagnostic detail')
          Write-Error -Exception ([Exception]::new('Failed to connect to server', $inner))
        }
      }
      function Copy-Item {
        [CmdletBinding()]param($FromSession,$Path,$Destination,[switch]$Force)
        if ($Destination -ne 'C:\\exports\\two') { throw 'Wrong destination' }
        $script:copies++
        if ('${mode}' -eq 'copy') { Write-Error 'Transfer failed' }
      }
      $settings = [pscustomobject]@{ configurations=@(
        [pscustomobject]@{name='Source1';serverType='OnPrem';serverInstance='BC220'},
        [pscustomobject]@{name='Source2';serverType='OnPrem';serverInstance='BC230';databaseUser='sqluser';databasePassword='test-only'},
        [pscustomobject]@{name='Local';serverType='Container';sqlBackupPath='C:\\exports\\one'},
        [pscustomobject]@{name='Test';serverType='Container';sqlBackupPath='C:\\exports\\two'}
      ) }
      try { Export-BcServiceSqlBackupSet -scriptPath 'C:\\toolset' -settingsJSON $settings }
      catch { $failure=$_.Exception.Message }
      @{ Error=$failure; Copies=$script:copies; Backups=$script:backups; Closed=$script:closed; Clears=$script:localClears; HostSaves=$script:hostSaves; Success=(@($script:messages | Where-Object { $_ -like 'SQL backup set exported*' }).Count) } | ConvertTo-Json -Compress
    `;
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.Success, mode === 'success' ? 1 : 0);
    assert.equal(output.HostSaves, mode === 'success' ? 1 : 0);
    assert.equal(output.Backups, 1);
    assert.equal(output.Closed, 1);
    assert.equal(output.Copies, ['sql', 'missing'].includes(mode) ? 0 : 1);
    if (['sql', 'missing'].includes(mode)) assert.equal(output.Clears, 0);
    if (mode === 'sql') {
      assert.match(output.Error, /SQL login rejected: diagnostic detail/);
      assert.match(output.Error, /configured SQL credentials/);
    } else if (mode === 'missing') assert.match(output.Error, /without creating/);
    else if (mode === 'copy') assert.match(output.Error, /Transfer failed/);
    else assert.equal(output.Error, null);
  }
});


test('agent service backup selections require explicit unique eligible names without prompting', () => {
  for (const destination of ['Local', 'Unknown', 'Duplicate', '']) {
    const script = `
      . ${quotePowerShell(backupMgtPath)}
      $env:BCDEVTOOLSET_MCP_SESSION_ID='agent'
      $env:BCDEVTOOLSET_SERVICE_BACKUP_INPUTS=${quotePowerShell(JSON.stringify({ 'serviceBackup.source': 'Source', 'serviceBackup.destination': destination }))}
      function Select-IndexFromList { throw 'Unexpected prompt' }
      $settings = [pscustomobject]@{ configurations=@(
        [pscustomobject]@{name='Source';serverType='OnPrem';serverInstance='BC230'},
        [pscustomobject]@{name='Local';serverType='Container';sqlBackupPath='C:\\Local'},
        [pscustomobject]@{name='Duplicate';serverType='Container';sqlBackupPath='C:\\A'},
        [pscustomobject]@{name='Duplicate';serverType='Container';sqlBackupPath='C:\\B'}
      ) }
      try { $selection=Select-BcServiceSqlBackupConfigurations -settingsJSON $settings; @{Source=$selection.Source.name; Destination=$selection.Destination.name} | ConvertTo-Json -Compress }
      catch { @{Error=$_.Exception.Message} | ConvertTo-Json -Compress }
    `;
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    if (destination === 'Local') assert.deepEqual(output, { Source: 'Source', Destination: 'Local' });
    else assert.match(output.Error, /No backup was started/);
  }
});

test('human service backup asks for the destination even with one eligible configuration', () => {
  const script = `
    . ${quotePowerShell(backupMgtPath)}
    $env:BCDEVTOOLSET_MCP_SESSION_ID=''; $env:BCDEVTOOLSET_NON_INTERACTIVE=''
    $script:titles=@()
    function Select-IndexFromList { param($Title,$Options) $script:titles += $Title; 0 }
    $settings=[pscustomobject]@{configurations=@(
      [pscustomobject]@{name='Source';serverType='OnPrem';serverInstance='BC230'},
      [pscustomobject]@{name='Local';serverType='Container';sqlBackupPath='C:\\Local'}
    )}
    $selection=Select-BcServiceSqlBackupConfigurations -settingsJSON $settings
    @{Count=$script:titles.Count; Title=$script:titles[0]; Destination=$selection.Destination.name} | ConvertTo-Json -Compress
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.Count, 1);
  assert.match(output.Title, /destination configuration/);
  assert.equal(output.Destination, 'Local');
});
