const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const operations = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'operations', 'operations.json'), 'utf8'));

function fixture(t) {
  const root = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-operation-messages-')), 'Test fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); // nosemgrep -- test-owned authorized root
  const write = (relative, content) => {
    const target = resolveWithinRoot(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); // nosemgrep -- contained by test-owned root
    fs.writeFileSync(target, content); // nosemgrep -- contained by test-owned root
  };
  write('Invoke-BcDevToolsetOperation.ps1', fs.readFileSync(path.join(repositoryRoot, 'Invoke-BcDevToolsetOperation.ps1'), 'utf8'));
  write('common/PublishingDiagnostics.ps1', fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common/PublishingDiagnostics.ps1'), 'utf8')); // nosemgrep -- fixed source read contained by repository root through resolveWithinRoot
  write('common/WorkspaceMgt.ps1', `
    function Get-OperationDefinitions {
      param($ScriptPath)
      $definitions = Get-Content (Join-Path $PSScriptRoot '../operations/operations.json') -Raw | ConvertFrom-Json
      foreach ($definition in $definitions) {
        $definition | Add-Member ScriptPath (Join-Path $ScriptPath $definition.script)
        $definition
      }
    }
    function Initialize-Context {}
    function Test-DockerProcess {}
    function Invoke-ContainerAssemblyExtraction { return ($env:TEST_EXTRACTION_SUCCESS -eq 'true') }
    function Write-Done { Write-Host '!!!!     DONE     !!!!' }
  `);
  write('common/ContainerLifecycle.ps1', 'function Ensure-ConfiguredContainers {}');
  return { root, write };
}

function run(root, script, extraEnv = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', cwd: root, env: { ...process.env, ...extraEnv }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.replace(/\r/g, '');
}

for (const mode of ['single', 'selected', 'all', 'none']) {
  test(`container backup checks readiness before offering only available targets (${mode})`, (t) => {
    const { root, write } = fixture(t);
    const operation = operations.find(operation => operation.id === 'backupBcContainerDatabases');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed source path validated as contained by the repository root
    write(operation.script, fs.readFileSync(resolveWithinRoot(repositoryRoot, 'operations/BackupBcContainerDatabases.ps1'), 'utf8')); // nosemgrep -- fixed source path validated as contained by the repository root
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed source path validated as contained by the repository root
    write('common/ContainerLifecycle.ps1', fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common/ContainerLifecycle.ps1'), 'utf8')); // nosemgrep -- fixed source path validated as contained by the repository root
    write('common/PublishApps.ps1', '');
    const backupPath = path.join(repositoryRoot, 'common/BackupMgt.ps1').replaceAll("'", "''");
    write('common/WorkspaceMgt.ps1', `
      . '${backupPath}'
      $script:events = [collections.generic.list[string]]::new()
      $hostHelperFolder = Join-Path $PSScriptRoot '../helper'
      function Test-DockerProcess {}
      function Initialize-Context {
        param($scriptPath, [ref]$settingsJSON, [ref]$workspaceJSON)
        $settingsJSON.Value = @{configurations=@('Core','CoreTest','Missing'${['selected', 'all'].includes(mode) ? ",'Other'" : ''} | ForEach-Object {
          [pscustomobject]@{name=$_;serverType='Container';container=$_;sqlBackupPath=$_}
        })}
      }
      function Get-SqlBackupRootPath { param($sqlBackupPath) Join-Path $PSScriptRoot "../exports/$sqlBackupPath" }
      function Select-IndexFromList {
        param($Options)
        $script:events.Add('select:' + ($Options -join '|'))
        ${mode === 'all' ? 2 : 0}
      }
      function docker {
        param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DockerArguments)
        $global:LASTEXITCODE=0
        $script:events.Add($DockerArguments -join ' ')
        if ($DockerArguments[0] -eq 'info') { return 'windows' }
        if ($DockerArguments[1] -eq 'restart') { throw 'Container unavailable; recover it before retrying.' }
        $name = $DockerArguments[-1]
        if ($name -eq 'Missing') { throw 'No such container' }
        @{Name="/$name";State=@{Status='running';Health=@{Status=$(if ($name -ne 'CoreTest' -and $${mode !== 'none'}) {'healthy'} else {'unhealthy'})}}} |
          ConvertTo-Json -Depth 5 -Compress
      }
      function Test-DockerContainerRunning { $true }
      function Backup-BcContainerDatabases {
        param($containerName, $bakFolder)
        $script:events.Add("backup:$containerName")
        Set-Content -LiteralPath (Join-Path $bakFolder 'database.bak') -Value 'fixture backup'
      }
      function Get-BcContainerDatabaseBackupMap {
        [pscustomobject]@{HelperFileName='database.bak';ExportFileName='Core.database.database.bak'}
      }
      function Write-Done { $script:events.Add('done') }
    `);
    const output = run(root, `
      $ErrorActionPreference='Continue'
      $messages=[collections.generic.list[string]]::new()
      try {
        . ./operations/BackupBcContainerDatabases.ps1 6>&1 | ForEach-Object { $messages.Add([string]$_) }
        $operationExitCode=if ($?) { 0 } else { 1 }
      } catch { $failure=$_.Exception.Message; $operationExitCode=1 }
      @{Events=@($script:events.ToArray());Failure=$failure;ExitCode=$operationExitCode;Messages=($messages -join '|');Exported=(Test-Path './exports/Core/Core.database.database.bak')} |
        ConvertTo-Json -Compress
    `);
    const result = JSON.parse(output);
    assert.match(result.Messages, /Unavailable containers excluded:.*CoreTest/);
    assert.match(result.Messages, /Missing.*missing; skipped/);
    assert.ok(result.Events.includes('container restart -- CoreTest'));
    if (mode !== 'none') {
      assert.equal(result.Failure, null);
      assert.equal(result.ExitCode, 0);
      assert.equal(result.Exported, true);
      assert.ok(result.Events.includes('backup:Core'));
      assert.ok(result.Events.includes('done'));
      assert.ok(!result.Events.includes('backup:CoreTest'));
      assert.ok(!result.Events.includes('backup:Missing'));
      assert.equal(result.Events.includes('backup:Other'), mode === 'all');
      const picker = result.Events.find(event => event.startsWith('select:'));
      if (mode === 'single') assert.equal(picker, undefined);
      else {
        assert.match(picker, /Core \(Core\).*Other \(Other\).*All qualified containers/);
        assert.doesNotMatch(picker, /CoreTest|Missing/);
        assert.ok(result.Events.indexOf(picker) > result.Events.indexOf('container restart -- CoreTest'));
      }
    } else {
      assert.equal(result.Exported, false);
      assert.equal(result.ExitCode, 1);
      assert.match(result.Failure, /No available containers.*No backup was started.*Recover/);
      assert.ok(result.Events.every(event => !event.startsWith('backup:') && !event.startsWith('select:') && event !== 'done'));
    }
  });
}

for (const nonInteractive of [false, true]) {
  test(`launcher identifies every PowerShell operation (nonInteractive=${nonInteractive})`, (t) => {
    const { root, write } = fixture(t);
    const psOperations = operations.filter(operation => operation.script?.endsWith('.ps1'));
    write('operations/operations.json', JSON.stringify(psOperations));
    for (const operation of psOperations) {
      const source = fs.readFileSync(resolveWithinRoot(repositoryRoot, operation.script), 'utf8'); // nosemgrep -- contained by repository root
      assert.doesNotMatch(source, /^\s*Clear-Host\s*$/m, `${operation.id} must not erase the launcher banner`);
      write(operation.script, "Write-Host 'OPERATION BODY'");
    }
    const output = run(root, `
      function Clear-Host { Write-Host 'TERMINAL CLEARED' }
      $operations = Get-Content './operations/operations.json' -Raw | ConvertFrom-Json
      foreach ($operation in $operations) {
        & ./Invoke-BcDevToolsetOperation.ps1 -Operation $operation.id ${nonInteractive ? '-NonInteractive' : ''}
      }
    `);
    const headings = output.split('\n').filter(line => /^!!!!  .*  !!!!$/.test(line));
    assert.deepEqual(headings, psOperations.map(operation => `!!!!  ${operation.title}  !!!!`));
    assert.equal(output.split('TERMINAL CLEARED').length - 1, nonInteractive ? 0 : psOperations.length);
    const lines = output.trim().split('\n');
    for (const heading of headings) {
      const index = lines.indexOf(heading);
      assert.equal(lines[index - 1], '!'.repeat(heading.length));
      assert.equal(lines[index + 1], '!'.repeat(heading.length));
      if (!nonInteractive) assert.equal(lines[index - 2], 'TERMINAL CLEARED');
      assert.equal(lines[index + 4], 'OPERATION BODY');
    }
  });
}

for (const failOperation of [false, true]) {
  test(`non-interactive overrides leave the caller's clear commands intact (failure=${failOperation})`, (t) => {
    const { root, write } = fixture(t);
    write('operations/operations.json', JSON.stringify([
      { id: 'test', title: 'Test operation', script: 'operations/Test.ps1' }
    ]));
    write('operations/Test.ps1', `
      Clear-Host
      clear
      cls
      if ($env:TEST_OPERATION_THROW -eq 'true') { throw 'Expected fixture failure' }
    `);
    const output = run(root, `
      function global:Clear-Host { Write-Host 'CALLER CLEAR-HOST' }
      function global:Clear-Custom { Write-Host 'CALLER CLEAR ALIAS' }
      Set-Alias clear Clear-Custom -Scope Global -Force
      Set-Alias cls Clear-Custom -Scope Global -Force
      $originalClearHost = (Get-Command Clear-Host).Definition
      try {
        & ./Invoke-BcDevToolsetOperation.ps1 -Operation test -NonInteractive
        if ($env:TEST_OPERATION_THROW -eq 'true') { throw 'Fixture did not throw' }
      } catch {
        if ($_.Exception.Message -ne 'Expected fixture failure') { throw }
      }
      if ((Get-Command Clear-Host).Definition -ne $originalClearHost) { throw 'Caller Clear-Host changed' }
      if ((Get-Alias clear).Definition -ne 'Clear-Custom') { throw 'Caller clear alias changed' }
      if ((Get-Alias cls).Definition -ne 'Clear-Custom') { throw 'Caller cls alias changed' }
      Write-Host 'NON-INTERACTIVE FINISHED'
      $env:TEST_OPERATION_THROW = 'false'
      & ./Invoke-BcDevToolsetOperation.ps1 -Operation test
    `, { TEST_OPERATION_THROW: String(failOperation) });
    const [before, after] = output.split('NON-INTERACTIVE FINISHED');
    assert.doesNotMatch(before, /CALLER CLEAR/);
    assert.equal(after.split('CALLER CLEAR-HOST').length - 1, 2);
    assert.equal(after.split('CALLER CLEAR ALIAS').length - 1, 2);
  });
}

for (const success of [true, false]) {
  test(`assembly extraction prints reload instructions only on success (${success})`, (t) => {
    const { root, write } = fixture(t);
    const operation = operations.find(operation => operation.id === 'extractContainerAssemblies');
    write('operations/operations.json', JSON.stringify([operation]));
    write(operation.script, fs.readFileSync(path.join(repositoryRoot, 'operations', 'ExtractContainerAssemblies.ps1'), 'utf8'));
    const output = run(root, '& ./Invoke-BcDevToolsetOperation.ps1 -Operation extractContainerAssemblies -NonInteractive', {
      TEST_EXTRACTION_SUCCESS: String(success)
    });
    if (success) {
      assert.match(output, /!{10,}\nReload VS Code now \(Developer: Reload Window\).*\.netpackages.*workspace\.\n!{10,}/);
      assert.ok(output.indexOf('Reload VS Code') < output.indexOf('DONE'));
    } else {
      assert.doesNotMatch(output, /Reload VS Code|DONE/);
    }
  });
}

for (const invocation of ['terminal', 'file']) {
  test(`disabled OData initialization renders guidance without an exception and preserves failure (${invocation})`, (t) => {
    const { root, write } = fixture(t);
    const operation = operations.find(operation => operation.id === 'initializeBcData');
    write('operations/operations.json', JSON.stringify([operation]));
    for (const relative of [operation.script, 'common/BcDataMgt.ps1', 'common/BcDataPackage.ps1']) {
      write(relative, fs.readFileSync(resolveWithinRoot(repositoryRoot, relative), 'utf8')); // nosemgrep -- contained by repository root
    }
    const workspaceHelper = resolveWithinRoot(root, 'common/WorkspaceMgt.ps1');
    const workspaceSource = fs.readFileSync(workspaceHelper, 'utf8'); // nosemgrep -- workspaceHelper is contained by the test-owned root through resolveWithinRoot immediately above
    write('common/WorkspaceMgt.ps1', workspaceSource + `
      function Write-Host {
        param($Object, [ConsoleColor]$ForegroundColor)
        if ($Object -eq 'Initialize BC Data Access failed during OData configuration.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) { throw 'Expected failure heading must be red' }
          [Console]::WriteLine('FAILURE HEADING COLOR: Red')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
      function Initialize-Context {
        param($scriptPath,[ref]$settingsJSON,[ref]$workspaceJSON)
        $settingsJSON.Value=@{configurations=@(
          [pscustomobject]@{name='taopaipai';serverType='OnPrem';targetType='Dev';server='bc.example';serverInstance='BC';authentication='Windows'}
        )}
      }
      function Request-BcDevToolsetMcpPrompt { 'taopaipai' }
      function Confirm-Option { $true }
      function Get-RemoteComputerNameFromServer { 'bc.example' }
      function Test-IsLocalSqlServer { $true }
      function Import-BcServiceBackupDiscoveryModules {}
      function Get-NAVServerConfiguration {}
      function Get-BcServerConfigValue {
        param($serverInstance,$keyName)
        if($keyName -eq 'ODataServicesEnabled'){return 'true'}
        if($keyName -eq 'ODataServicesV4EndpointEnabled'){return 'false'}
        return ''
      }
    `);
    const command = `
      $env:BCDEVTOOLSET_WORKSPACE_PATH='original-workspace'
      $env:BCDEVTOOLSET_NON_INTERACTIVE='original-mode'
      & ./Invoke-BcDevToolsetOperation.ps1 -Operation initializeBcData -NonInteractive
      $failed=-not $?; $code=$LASTEXITCODE
      if(-not $failed -or $code -ne 1){throw 'Failure status lost'}
      if($env:BCDEVTOOLSET_WORKSPACE_PATH -ne 'original-workspace' -or $env:BCDEVTOOLSET_NON_INTERACTIVE -ne 'original-mode'){throw 'Environment was not restored'}
      Write-Host 'CALLER CONTINUES WITH FAILED STATUS AND RESTORED ENVIRONMENT'
      exit $code
    `;
    const args = invocation === 'terminal'
      ? ['-Command', command]
      : ['-File', './Invoke-BcDevToolsetOperation.ps1', '-Operation', 'initializeBcData', '-NonInteractive'];
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /FAILURE HEADING COLOR: Red/);
    assert.match(result.stdout, /Initialize BC Data Access failed during OData configuration\./);
    assert.match(result.stdout, /Enable ODataServicesEnabled and ODataServicesV4EndpointEnabled/);
    assert.match(result.stdout, /No companion was deployed[. ]/);
    assert.doesNotMatch(result.stdout, /Exception:|Line\s*\||BcDataMgt\.ps1:\d|DONE|UNEXPECTED/);
    if (invocation === 'terminal') assert.match(result.stdout, /CALLER CONTINUES WITH FAILED STATUS AND RESTORED ENVIRONMENT/);
  });
}

for (const invalidPackage of ['OnPrem', 'old-range', 'dependencies']) {
  test(`stale companion is identified as a Toolset packaging problem without exception decoration (${invalidPackage})`, (t) => {
    const { root, write } = fixture(t);
    write('operations/operations.json', JSON.stringify([
      { id: 'initializeBcData', title: 'Initialize BC Data Access', script: 'operations/Test.ps1' }
    ]));
    write('common/BcDataPackage.ps1', fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common/BcDataPackage.ps1'), 'utf8')); // nosemgrep -- contained by repository root
    write('operations/Test.ps1', `
      . (Join-Path $PSScriptRoot '../common/BcDataPackage.ps1')
      $expected=[pscustomobject]@{appId='0f92aea5-4cc0-459b-ae98-ca9e5c2b0304';name='BC Dev Toolset Data';publisher='dam-pav';version='0.1.10.0';contractVersion=1;runtime='12.0';application='23.0.0.0';serviceName='BCDData';packageFile='BCData.app';mutationsEnabled=$false}
      $document=[xml]'<Package><App Id="0f92aea5-4cc0-459b-ae98-ca9e5c2b0304" Name="BC Dev Toolset Data" Publisher="dam-pav" Version="0.1.10.0" Runtime="12.0" Application="23.0.0.0" Target="${invalidPackage === 'OnPrem' ? 'OnPrem' : 'Cloud'}"/><Dependencies>${invalidPackage === 'dependencies' ? '<Dependency Id="unexpected"/>' : ''}</Dependencies><IdRanges><IdRange MinObjectId="${invalidPackage === 'old-range' ? '50100' : '99100'}" MaxObjectId="${invalidPackage === 'old-range' ? '50149' : '99149'}"/></IdRanges></Package>'
      Assert-BcDataPackageIdentity -Expected $expected -Document $document
      Write-Host 'UNEXPECTED DEPLOYMENT'
      Write-Done
    `);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', './Invoke-BcDevToolsetOperation.ps1', '-Operation', 'initializeBcData', '-NonInteractive'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /failed during BC Data package validation\./);
    assert.match(result.stdout, /This is a Toolset packaging problem\./);
    assert.match(result.stdout, /Rebuild.*prepare the Toolset runtime.*corrected Toolset release/);
    assert.match(result.stdout, /No companion was deployed\./);
    assert.doesNotMatch(result.stdout, /Exception:|Line\s*\||BcDataPackage\.ps1:\d|DONE|UNEXPECTED DEPLOYMENT/);
  });
}

for (const failure of ['unreadable', 'changed', 'write-failure']) {
  test(`OData persistence failures retain clean rendering and failed status (${failure})`, (t) => {
    const { root, write } = fixture(t);
    write('operations/operations.json', JSON.stringify([
      { id: 'initializeBcData', title: 'Initialize BC Data Access', script: 'operations/Test.ps1' }
    ]));
    for (const relative of ['common/BcDataMgt.ps1', 'common/BcDataPackage.ps1']) {
      write(relative, fs.readFileSync(resolveWithinRoot(repositoryRoot, relative), 'utf8')); // nosemgrep -- contained by repository root
    }
    write('settings/config.json', 'original');
    write('operations/Test.ps1', `
      . (Join-Path $PSScriptRoot '../common/BcDataMgt.ps1')
      $config=[pscustomobject]@{name='Remote';serverType='OnPrem';server='bc.example';serverInstance='BC';authentication='Windows'}
      $script:settingsPath=Join-Path $PSScriptRoot '../settings/config.json'
      function Get-BcDataODataSettings {
        [pscustomobject]@{PublicODataBaseUrl='https://bc.example/BC/ODataV4';ODataServicesEnabled='true';ODataServicesV4EndpointEnabled='true'}
      }
      function Find-BcConfigurationDocument {
        ${failure === 'unreadable' ? 'Remove-Item -LiteralPath $script:settingsPath -Force' : ''}
        [pscustomobject]@{Path=$script:settingsPath;Text='${failure === 'changed' ? 'different' : 'original'}';Configuration=$config;Document=@{configurations=@($config)}}
      }
      ${failure === 'write-failure' ? `function ConvertTo-Json {
        param([Parameter(ValueFromPipeline)]$InputObject,$Depth)
        Remove-Item -LiteralPath $script:settingsPath -Force
        Remove-Item -LiteralPath (Split-Path $script:settingsPath -Parent) -Force
        '{}'
      }` : ''}
      Initialize-BcDataBaseUrl $config
      Write-Host 'UNEXPECTED DEPLOYMENT'
      Write-Done
    `);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', './Invoke-BcDevToolsetOperation.ps1', '-Operation', 'initializeBcData', '-NonInteractive'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /failed during OData settings persistence\./);
    assert.match(result.stdout, /No companion was deployed[. ]/);
    assert.match(result.stdout, failure === 'write-failure' ? /Inspect the configuration file before retrying/ : /initialize again/);
    assert.doesNotMatch(result.stdout, /Exception:|Line\s*\||BcDataMgt\.ps1:\d|DONE|UNEXPECTED DEPLOYMENT/);
  });
}
