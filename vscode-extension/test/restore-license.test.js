'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = authorizeRoot(path.resolve(__dirname, '../..'), 'Repository source');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const backupSource = resolveWithinRoot(repositoryRoot, 'common/BackupMgt.ps1');
const testSource = resolveWithinRoot(repositoryRoot, 'common/TestMgt.ps1');

function fixture(t) {
  const root = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-restore-license-')), 'Owned license test fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); // nosemgrep -- test-owned authorized root
  const write = (relative, content) => {
    const validatedTarget = resolveWithinRoot(root, relative);
    fs.mkdirSync(path.dirname(validatedTarget), { recursive: true }); // nosemgrep -- contained by fixture root
    fs.writeFileSync(validatedTarget, content); // nosemgrep -- contained by fixture root
    return validatedTarget;
  };
  return { root, write, license: write('valid.bclicense', 'fixture license, never imported into a container') };
}

function run(script, cwd) {
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; . " + quote(backupSource) + ';\n' +
    // Runtime ownership has its own isolated-module regression suite. License
    // tests keep that boundary narrow and never import the installed helper.
    'function Get-BcRestoreRuntimeConfiguration { $bcContainerHelperConfig };\n' + script], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 30000
  });
}
function jsonResult(result, status = 0) {
  assert.equal(result.status, status, result.stderr + '\n' + result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function coreFixture(license, mode = 'success') {
  return `
    $bcContainerHelperConfig=@{usePwshForBc24=$true}
    $script:events=[Collections.Generic.List[string]]::new()
    function Get-BcContainerSqlBackupRestoreParameters { @{containerName='selected';bakFile='unused.bak'} }
    function Invoke-ScriptInBcContainer {
      param($containerName,$ScriptBlock,$ArgumentList)
      if($containerName -ne 'selected'){throw 'UNEXPECTED TARGET'}
      if($ScriptBlock.ToString() -match 'DatabaseName'){$script:events.Add('prepare');return 'CRONUS'}
      if($ScriptBlock.ToString() -match 'Set-NAVServerInstance'){$script:events.Add('service-start');return}
      if($ScriptBlock.ToString() -match 'Get-NAVTenant'){$script:events.Add('tenant-discovery');return 'default'}
      throw 'UNEXPECTED CONTAINER SCRIPT'
    }
    function Restore-DatabasesInBcContainer { $script:events.Add('sql') }
    function Invoke-BcRestoreLicenseImport {
      param($ContainerName,$ValidatedLicenseFile)
      if($ContainerName -ne 'selected' -or $ValidatedLicenseFile -ne ${quote(license)}){throw 'UNEXPECTED IMPORT PARAMETERS'}
      $script:events.Add('import-restart')
      ${mode === 'import-error' ? "throw (New-BcRestoreFailure -Stage 'restore license import' -State 'SQL restore returned; license import may have partially completed. Inspect the license and service before retrying verification.' -Detail 'Configured license import failed.')" : ''}
    }
    function Invoke-BcContainerSystemApplicationUpgradeAfterRestore { $script:events.Add('versions') }
    function Repair-BcContainerAdministratorAfterRestore { $script:events.Add('admin') }
    $failure=$null
    try {
      Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{}) -settingsJSON @{licenseFile=${quote(license)}}
    } catch { $failure=$_.Exception }
    @{events=@($script:events);message=$failure.Message;stage=$failure.Data['Stage'];expected=$failure.Data['BcDevToolsetExpectedFailure'];runtime=$bcContainerHelperConfig.usePwshForBc24}|ConvertTo-Json -Compress
    if($failure){exit 1}
  `.replace("$failure.Data['Stage']", "$(if($failure){$failure.Data['Stage']})")
    .replace("$failure.Data['BcDevToolsetExpectedFailure']", "$(if($failure){$failure.Data['BcDevToolsetExpectedFailure']})");
}

test('configured license is imported once after SQL and before application/user verification', t => {
  const f = fixture(t);
  const value = jsonResult(run(coreFixture(f.license), f.root));
  assert.deepEqual(value.events, ['prepare', 'sql', 'service-start', 'import-restart', 'versions', 'admin']);
  assert.equal(value.runtime, true);
  assert.equal(value.message, null);
});

test('multitenant license import precedes mounted-tenant discovery and application verification', t => {
  const f = fixture(t);
  const body = coreFixture(f.license)
    .replace("@{containerName='selected';bakFile='unused.bak'}", "@{containerName='selected';bakFolder='unused'}")
    .replace("@([pscustomobject]@{DatabaseRole='database'})", "@([pscustomobject]@{DatabaseRole='app'},[pscustomobject]@{DatabaseRole='tenant';DatabaseName='default'})");
  const value = jsonResult(run(body, f.root));
  assert.deepEqual(value.events, ['sql', 'import-restart', 'tenant-discovery', 'versions', 'admin']);
  assert.equal(value.runtime, true);
});

test('license import failure stops verification, preserves failure and resets runtime', t => {
  const f = fixture(t);
  const result = run(coreFixture(f.license, 'import-error'), f.root);
  const value = jsonResult(result, 1);
  assert.deepEqual(value.events, ['prepare', 'sql', 'service-start', 'import-restart']);
  assert.equal(value.expected, true);
  assert.equal(value.runtime, true);
  assert.match(value.message, /license/i);
  assert.match(value.message, /SQL restore returned/i);
  assert.match(value.message, /Inspect|Check/);
  assert.match(value.message, /No automatic retry/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|password=secret|Exception:|Line\s*\|/);
});

test('license removed after SQL fails at host read without starting remote import or restart', t => {
  const f = fixture(t);
  const result = run(`
    $bcContainerHelperConfig=@{usePwshForBc24=$true}
    $script:events=[Collections.Generic.List[string]]::new()
    function Get-BcContainerSqlBackupRestoreParameters {@{containerName='selected';bakFile='unused.bak'}}
    function Invoke-ScriptInBcContainer {
      param($containerName,$ScriptBlock,$ArgumentList)
      if($ScriptBlock.ToString() -match 'DatabaseName'){$script:events.Add('prepare');return 'CRONUS'}
      if($ScriptBlock.ToString() -match 'Import-NAVServerLicense'){$script:events.Add('UNEXPECTED remote-import');throw 'PRIVATE remote backend password=secret'}
      if($ScriptBlock.ToString() -match 'Set-NAVServerInstance'){$script:events.Add('service-start');return}
      throw 'UNEXPECTED CONTAINER SCRIPT'
    }
    function Restore-DatabasesInBcContainer {
      $script:events.Add('sql')
      Remove-Item -LiteralPath ${quote(f.license)} -ErrorAction Stop
    }
    function Invoke-BcContainerSystemApplicationUpgradeAfterRestore {$script:events.Add('UNEXPECTED versions')}
    function Repair-BcContainerAdministratorAfterRestore {$script:events.Add('UNEXPECTED admin')}
    $failure=$null
    try {Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{}) -settingsJSON @{licenseFile=${quote(f.license)}}}
    catch {$failure=$_.Exception}
    @{events=@($script:events);message=$failure.Message;stage=$failure.Data['Stage'];expected=$failure.Data['BcDevToolsetExpectedFailure'];runtime=$bcContainerHelperConfig.usePwshForBc24}|ConvertTo-Json -Compress
    if($failure){exit 1}
  `, f.root);
  const value = jsonResult(result, 1);
  assert.deepEqual(value.events, ['prepare', 'sql', 'service-start']);
  assert.equal(value.expected, true);
  assert.equal(value.runtime, true);
  assert.equal(value.stage, 'restored license read');
  assert.match(value.message, /SQL restore returned/);
  assert.match(value.message, /license import and its BC service restart were not started/);
  assert.match(value.message, /license file could not be read after SQL restore/);
  assert.match(value.message, /Error code: -?\d+/);
  assert.match(value.message, /Restore access|Check|Inspect/);
  assert.match(value.message, /No automatic retry/);
  assert.ok(!value.message.includes(f.license), value.message);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|password=secret|UNEXPECTED|Exception:|Line\s*\|/);
});

test('absent and blank workspace licenses preserve restore without any import', t => {
  const f = fixture(t);
  for (const license of ['', '   ']) {
    const value = jsonResult(run(coreFixture(license), f.root));
    assert.deepEqual(value.events, ['prepare', 'sql', 'service-start', 'versions', 'admin']);
    assert.equal(value.runtime, true);
  }
  const omittedSettings = coreFixture('').replace(" -settingsJSON @{licenseFile=''}", '');
  assert.deepEqual(jsonResult(run(omittedSettings, f.root)).events, ['prepare', 'sql', 'service-start', 'versions', 'admin']);
});

test('unavailable or unsafe configured license fails before preparation and SQL', t => {
  const f = fixture(t);
  const cases = [resolveWithinRoot(f.root, 'missing.bclicense'), f.root, 'https://private.invalid/license.bclicense',
    'Env:PRIVATE', '\\\\server\\share\\license.bclicense', 'C:\\private\\*.bclicense', 'C:\\private\\license.bclicense:stream', '\\\\?\\C:\\license.bclicense'];
  for (const candidate of cases) {
    const result = run(coreFixture(candidate), f.root);
    const value = jsonResult(result, 1);
    assert.deepEqual(value.events, [], candidate);
    assert.equal(value.expected, true, candidate);
    assert.equal(value.runtime, true, candidate);
    assert.match(value.message, /license/i);
    assert.match(value.message, /No .*SQL|SQL .*not.*started/i);
    assert.match(value.message, /Check|Correct|Configure|Verify/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE backend|UNEXPECTED/);
  }
});

test('license resolver returns a normalized local file and skips an omitted setting', t => {
  const f = fixture(t);
  const value = jsonResult(run(`
    @{file=(Get-BcRestoreValidatedLicenseFile -SettingsJSON @{licenseFile=${quote(f.license)}});empty=(Get-BcRestoreValidatedLicenseFile -SettingsJSON @{})}|ConvertTo-Json -Compress
  `, f.root));
  assert.equal(value.file, f.license);
  assert.ok(value.empty === '' || value.empty === null);
});

for (const mode of ['success', 'staging-error', 'import-throw', 'import-error', 'restart-throw', 'restart-error', 'cleanup-error', 'import-cleanup-error', 'missing-result', 'invalid-stage']) {
  test(`real remote license boundary preserves safe status and cleans its owned file (${mode})`, t => {
    const f = fixture(t);
    const result = run(`
      $script:events=[Collections.Generic.List[string]]::new()
      function Join-Path {
        param($Path,$ChildPath)
        if($Path -eq 'C:\\Run\\my'){
          ${mode === 'staging-error' ? "throw [IO.IOException]::new('PRIVATE staging backend password=secret')" : ''}
          return [IO.Path]::Combine(${quote(f.root)},$ChildPath)
        }
        Microsoft.PowerShell.Management\\Join-Path @PSBoundParameters
      }
      function Import-NAVServerLicense {
        [CmdletBinding()]param($LicenseFile,$ServerInstance,$Database)
        $script:events.Add('import')
        if($ServerInstance -ne 'BC' -or $Database -ne 'NavDatabase'){throw 'UNEXPECTED IMPORT PARAMETERS'}
        if([IO.File]::ReadAllText($LicenseFile) -ne [IO.File]::ReadAllText(${quote(f.license)})){throw 'UNEXPECTED LICENSE BYTES'}
        ${mode === 'import-throw' || mode === 'import-cleanup-error' ? "throw [InvalidOperationException]::new('PRIVATE expired-license backend password=secret')" : mode === 'import-error' ? "Write-Error 'PRIVATE expired-license backend password=secret'" : ''}
      }
      function Set-NAVServerInstance {
        [CmdletBinding()]param($ServerInstance,[switch]$Restart)
        $script:events.Add('restart')
        if($ServerInstance -ne 'BC' -or -not $Restart){throw 'UNEXPECTED RESTART PARAMETERS'}
        ${mode === 'restart-throw' ? "throw [UnauthorizedAccessException]::new('PRIVATE restart backend password=secret')" : mode === 'restart-error' ? "Write-Error 'PRIVATE restart backend password=secret'" : ''}
      }
      ${mode === 'cleanup-error' || mode === 'import-cleanup-error' ? "function Remove-Item { [CmdletBinding()]param($LiteralPath,[switch]$Force) throw [ArgumentException]::new('PRIVATE cleanup backend password=secret') }" : ''}
      function Invoke-ScriptInBcContainer {
        param($containerName,$ScriptBlock,$ArgumentList)
        if($containerName -ne 'selected'){throw 'UNEXPECTED TARGET'}
        ${mode === 'missing-result' ? "return 'unverified backend response'" : mode === 'invalid-stage'
    ? "return [pscustomobject]@{BcRestoreLicenseResult=1;Status='Failed';ErrorCode=-2146233079;CleanupFailed=$false;FailureStage='PRIVATE transport stage'}"
    : '& $ScriptBlock @ArgumentList'}
      }
      $failure=$null
      try { Invoke-BcRestoreLicenseImport -ContainerName selected -ValidatedLicenseFile (Get-BcRestoreValidatedLicenseFile -SettingsJSON @{licenseFile=${quote(f.license)}}) }
      catch {$failure=$_.Exception}
      @{events=@($script:events);remaining=@(Get-ChildItem -LiteralPath ${quote(f.root)} -Filter 'bcdevtoolset-restore-license-*').Count;message=$failure.Message;stage=$(if($failure){$failure.Data['Stage']});expected=$(if($failure){$failure.Data['BcDevToolsetExpectedFailure']})}|ConvertTo-Json -Compress
      if($failure){exit 1}
    `, f.root);
    const value = jsonResult(result, mode === 'success' ? 0 : 1);
    assert.deepEqual(value.events, ['staging-error', 'missing-result', 'invalid-stage'].includes(mode) ? [] : mode.startsWith('import-') ? ['import'] : ['import', 'restart']);
    assert.equal(value.remaining, ['cleanup-error', 'import-cleanup-error'].includes(mode) ? 1 : 0);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|password=secret|UNEXPECTED|unverified backend response|Line\s*\|/);
    if (mode === 'success') assert.equal(value.message, null);
    else {
      assert.equal(value.expected, true);
      assert.match(value.message, /license/i);
      assert.match(value.message, /SQL restore returned/);
      assert.match(value.message, /Inspect|Check/);
      assert.match(value.message, /No automatic retry/);
      if (['cleanup-error', 'import-cleanup-error'].includes(mode)) assert.match(value.message, /cleanup failed/i);
      if (mode === 'staging-error') {
        assert.match(value.stage, /license.*stag/i);
        assert.match(value.message, /Error code: -2146232800/);
      }
      if (mode.startsWith('import-')) {
        assert.match(value.stage, /license.*import/i);
        assert.match(value.message, new RegExp('Error code: ' + (mode === 'import-error' ? '-2146233087' : '-2146233079')));
      }
      if (mode.startsWith('restart-')) {
        assert.match(value.stage, /service.*restart/i);
        assert.match(value.message, new RegExp('Error code: ' + (mode === 'restart-error' ? '-2146233087' : '-2147024891')));
      }
      if (mode === 'cleanup-error') {
        assert.match(value.stage, /license.*cleanup/i);
        assert.match(value.message, /Error code: -2147024809/);
      }
      if (mode === 'invalid-stage') assert.match(value.message, /not.*verif|unverified|incomplete|invalid/i);
      if (!['missing-result', 'invalid-stage'].includes(mode)) assert.doesNotMatch(value.message, /could not be installed,.*restart failed, or completion/i);
    }
  });
}

test('modern discovery preserves stage and numeric failure without guessing an expired license from backend text', () => {
  const result = run(`
    Import-Module Microsoft.PowerShell.Utility
    Import-Module Microsoft.PowerShell.Management
    $PSModuleAutoLoadingPreference='None'
    function Invoke-ScriptInBcContainer { param($ScriptBlock,$ArgumentList,[bool]$usePwsh,[bool]$useSession) & $ScriptBlock @ArgumentList }
    function Get-NAVAppInfo {
      [CmdletBinding()]param($ServerInstance,$Tenant,[switch]$TenantSpecificProperties,$Id,$Name,$Publisher,$Version,$Path)
      Write-Error 'Your program license has expired. PRIVATE connection password=secret'
    }
    $context=[pscustomobject]@{PlatformVersion='27.0.0.0';Multitenant=$false;TenantIds=@('default');TenantStates=@([pscustomobject]@{Id='default';State='Operational';AllowAppDatabaseWrite=$true})}
    $failure=$null
    try { Get-BcModernRestoredApplicationState -ContainerName selected -TenantId default -Context $context }
    catch { $failure=$_.Exception }
    @{message=$failure.Message;expected=$failure.Data['BcDevToolsetExpectedFailure']}|ConvertTo-Json -Compress
    if($failure){exit 1}
  `);
  const value = jsonResult(result, 1);
  assert.equal(value.expected, true);
  assert.match(value.message, /application version discovery/);
  assert.match(value.message, /Error code: -?\d+/);
  assert.match(value.message, /Inspect|Check/);
  assert.doesNotMatch(value.message, /expir|unexpired|invalid license|license is invalid/i);
  assert.match(value.message, /SQL restore returned/);
  assert.match(value.message, /No automatic retry/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|password=secret|Your program license has expired|Line\s*\|/);
});

for (const caller of ['manual', 'automatic']) {
  test(`${caller} restore forwards workspace license settings to the shared restore`, t => {
    const f = fixture(t);
    const result = run(`
      . ${quote(testSource)}
      $configuration=[pscustomobject]@{name='Selected';serverType='Container';container='selected';sqlBackupPath='backups'}
      $settings=@{licenseFile=${quote(f.license)};configurations=@($configuration)}
      function Select-ContainerSqlBackupConfigurations { $configuration }
      function Assert-SqlBackupPath {}
      function Get-SqlBackupRootPath { ${quote(f.root)} }
      function Get-SqlBackupSetEntries { [pscustomobject]@{SourceFileName='fixture.bak';DatabaseRole='database';DatabaseName='CRONUS'} }
      function Confirm-Option {$true}
      function Test-DockerProcess {}
      function Ensure-ConfiguredContainers { param($SettingsJSON,[switch]$RequireRunningOnly,[ref]$ReadyContainerNames) $ReadyContainerNames.Value=@('selected') }
      function Copy-SqlBackupSetToSharedFolder { 'unused' }
      $script:forwarded=$null
      function Restore-BcContainerSqlBackupEntries { param($containerName,$bakFolder,$backupEntries,$configuration,$settingsJSON) $script:forwarded=$settingsJSON.licenseFile }
      ${caller === 'manual'
    ? 'Restore-BcContainerSqlBackupSet -scriptPath unused -settingsJSON $settings'
    : 'Restore-TestContainerBackupIfExists -scriptPath unused -configuration $configuration -settingsJSON $settings'}
      @{forwarded=$script:forwarded}|ConvertTo-Json -Compress
    `, f.root);
    assert.equal(jsonResult(result).forwarded, f.license);
  });

  test(`${caller} invalid-license failure accurately reports earlier startup/staging and prevents SQL`, t => {
    const f = fixture(t);
    const result = run(`
      . ${quote(testSource)}
      $bcContainerHelperConfig=@{usePwshForBc24=$true}
      $script:events=[Collections.Generic.List[string]]::new()
      $configuration=[pscustomobject]@{name='Selected';serverType='Container';container='selected';sqlBackupPath='backups'}
      $settings=@{licenseFile=${quote(resolveWithinRoot(f.root, 'missing.bclicense'))};configurations=@($configuration)}
      function Select-ContainerSqlBackupConfigurations {$configuration}
      function Assert-SqlBackupPath {}
      function Get-SqlBackupRootPath {${quote(f.root)}}
      function Get-SqlBackupSetEntries {[pscustomobject]@{SourceFileName='fixture.bak';DatabaseRole='database';DatabaseName='CRONUS'}}
      function Confirm-Option {$true}
      function Test-DockerProcess {}
      function Ensure-ConfiguredContainers {param($SettingsJSON,[switch]$RequireRunningOnly,[ref]$ReadyContainerNames) $script:events.Add('started');$ReadyContainerNames.Value=@('selected')}
      function Copy-SqlBackupSetToSharedFolder {$script:events.Add('staged');'unused'}
      function Get-BcContainerSqlBackupRestoreParameters {$script:events.Add('UNEXPECTED preparation');@{}}
      function Restore-DatabasesInBcContainer {$script:events.Add('UNEXPECTED sql')}
      $failure=$null
      try {
        ${caller === 'manual'
    ? 'Restore-BcContainerSqlBackupSet -scriptPath unused -settingsJSON $settings'
    : 'Restore-TestContainerBackupIfExists -scriptPath unused -configuration $configuration -settingsJSON $settings'}
        $script:events.Add('UNEXPECTED success')
      }catch{$failure=$_.Exception}
      @{events=@($script:events);message=$failure.Message;expected=$failure.Data['BcDevToolsetExpectedFailure']}|ConvertTo-Json -Compress
      if($failure){exit 1}
    `, f.root);
    const value = jsonResult(result, 1);
    assert.deepEqual(value.events, caller === 'manual' ? ['started', 'staged'] : ['staged']);
    assert.equal(value.expected, true);
    assert.match(value.message, /No BC service stop or SQL restoration was started by this restore/);
    assert.match(value.message, /selected container may already have been started and backup files staged/);
    assert.doesNotMatch(result.stdout + result.stderr, /No restore preparation|UNEXPECTED|SQL backup set restored/);
  });
}

for (const restoreFails of [false, true]) {
  test(`test initialization forwards selected test settings into automatic restore and propagates failure (${restoreFails})`, t => {
    const f = fixture(t);
    const result = run(`
      . ${quote(testSource)}
      $configuration=[pscustomobject]@{name='Selected';serverType='Container';container='selected'}
      $other=[pscustomobject]@{name='Other';serverType='Container';container='other'}
      $settings=[pscustomobject]@{licenseFile=${quote(f.license)};configurations=@($other,$configuration)}
      $script:events=[Collections.Generic.List[string]]::new();$script:forwarded=$null;$script:target=$null
      function Test-DockerProcess {}
      function New-TestExecutionContainerIfMissing {$false}
      function Ensure-ConfiguredContainers {}
      function Test-DockerContainerRunning {$true}
      function Assert-BcTestContainerPlatform {'27.0.0.0'}
      function Test-AutoRestoreBeforeTest {$true}
      function Restore-TestContainerBackupIfExists {
        param($scriptPath,$configuration,$settingsJSON)
        $script:events.Add('restore');$script:forwarded=$settingsJSON.licenseFile
        $script:target=@($settingsJSON.configurations).container -join ','
        ${restoreFails ? "throw (New-BcExpectedFailure -Stage 'restore license import' -Message 'License import failed; inspect target before retrying verification.')" : ''}
      }
      function Publish-Dependencies {$script:events.Add('dependencies')}
      function Publish-Apps {$script:events.Add('apps')}
      $failure=$null
      try {$null=Initialize-TestExecutionContainer -scriptPath unused -settingsJSON $settings -workspaceJSON @{} -Selection ([pscustomobject]@{Configuration=$configuration;Platform='27.0.0.0'})}
      catch{$failure=$_.Exception}
      @{events=@($script:events);forwarded=$script:forwarded;target=$script:target;failed=($null -ne $failure)}|ConvertTo-Json -Compress
      if($failure){exit 1}
    `, f.root);
    const value = jsonResult(result, restoreFails ? 1 : 0);
    assert.equal(value.forwarded, f.license);
    assert.equal(value.target, 'selected');
    assert.equal(value.failed, restoreFails);
    assert.deepEqual(value.events, restoreFails ? ['restore'] : ['restore', 'dependencies', 'apps']);
  });
}

test('launcher renders license import failure as a red heading, plain guidance and failed status', t => {
  const f = fixture(t);
  const launcher = resolveWithinRoot(repositoryRoot, 'Invoke-BcDevToolsetOperation.ps1');
  f.write('Invoke-BcDevToolsetOperation.ps1', fs.readFileSync(launcher, 'utf8')); // nosemgrep -- fixed source within repository root
  f.write('common/PublishingDiagnostics.ps1', fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common/PublishingDiagnostics.ps1'), 'utf8')); // nosemgrep -- fixed source contained by repository root
  f.write('operations/operations.json', JSON.stringify([{ id: 'restore', title: 'Restore SQL backup', script: 'operations/Test.ps1' }]));
  f.write('common/WorkspaceMgt.ps1', `
    function Get-OperationDefinitions {
      param($ScriptPath)
      $d=Get-Content (Join-Path $PSScriptRoot '../operations/operations.json') -Raw|ConvertFrom-Json
      foreach($x in $d){$x|Add-Member ScriptPath (Join-Path $ScriptPath $x.script);$x}
    }
    function Initialize-Context {}
  `);
  f.write('operations/Test.ps1', `
    . ${quote(backupSource)}
    function Get-BcRestoreRuntimeConfiguration {$bcContainerHelperConfig}
    function global:Write-Host {
      param($Object,[ConsoleColor]$ForegroundColor)
      if($Object -like 'Restore SQL backup failed during*'){
        if($ForegroundColor -ne [ConsoleColor]::Red){throw 'UNEXPECTED HEADING COLOR'}
        [Console]::WriteLine('FAILURE HEADING COLOR: Red')
      }
      Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
    }
    ${coreFixture(f.license, 'import-error').replace(
    'catch { $failure=$_.Exception }', 'catch { throw }')}
    Write-Host 'UNEXPECTED SUCCESS'
  `);
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', './Invoke-BcDevToolsetOperation.ps1', '-Operation', 'restore', '-NonInteractive'], {
    cwd: f.root, encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /FAILURE HEADING COLOR: Red/);
  assert.match(result.stdout, /license/i);
  assert.match(result.stdout, /SQL restore returned/);
  assert.doesNotMatch(result.stdout, /PRIVATE|password=secret|UNEXPECTED|Exception:|At line:|Line\s*\|/);
});
