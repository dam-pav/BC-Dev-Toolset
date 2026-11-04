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
    write(operation.script, fs.readFileSync(path.join(repositoryRoot, 'operations/BackupBcContainerDatabases.ps1'), 'utf8'));
    write('common/ContainerLifecycle.ps1', fs.readFileSync(path.join(repositoryRoot, 'common/ContainerLifecycle.ps1'), 'utf8'));
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
      $ErrorActionPreference='Stop'
      try { $messages = . ./operations/BackupBcContainerDatabases.ps1 6>&1 }
      catch { $failure=$_.Exception.Message }
      @{Events=@($script:events.ToArray());Failure=$failure;Messages=($messages -join '|');Exported=(Test-Path './exports/Core/Core.database.database.bak')} |
        ConvertTo-Json -Compress
    `);
    const result = JSON.parse(output);
    assert.equal(result.Failure, null);
    assert.match(result.Messages, /Unavailable containers excluded:.*CoreTest/);
    assert.match(result.Messages, /Missing.*missing; skipped/);
    assert.ok(result.Events.includes('container restart -- CoreTest'));
    if (mode !== 'none') {
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
      assert.match(result.Messages, /No available containers.*No backup was started.*Recover/);
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
