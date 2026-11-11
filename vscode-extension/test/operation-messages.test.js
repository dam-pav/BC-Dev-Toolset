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

for (const mode of ['prepare-error', 'sql-throw', 'sql-error', 'start-error', 'version-empty', 'version-error', 'modern-empty']) {
  test(`single-tenant restore stops with clean recovery guidance (${mode})`, (t) => {
    const { root, write } = fixture(t);
    write('operations/operations.json', JSON.stringify([
      { id: 'restore', title: 'Restore SQL backup', script: 'operations/Test.ps1' }
    ]));
    write('common/BackupMgt.ps1', fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common/BackupMgt.ps1'), 'utf8')); // nosemgrep -- fixed source contained by repository root
    write('common/CredentialMgt.ps1', '');
    write('common/RemotingMgt.ps1', '');
    const stage = mode === 'prepare-error' ? 'restore preparation' : mode.startsWith('sql') ? 'SQL restoration' : mode === 'start-error' ? 'BC service start' : mode === 'modern-empty' ? 'application version compatibility verification' : 'application version discovery';
    write('operations/Test.ps1', `
      . (Join-Path $PSScriptRoot '../common/BackupMgt.ps1')
      function global:Write-Host {
        param($Object,[ConsoleColor]$ForegroundColor)
        if ($Object -eq 'Restore SQL backup failed during ${stage}.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) { throw 'Expected red heading' }
          [Console]::WriteLine('FAILURE HEADING COLOR: Red')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
      function Get-BcContainerSqlBackupRestoreParameters { @{containerName='target';bakFile='database.bak'} }
      $script:invocations=0
      function Invoke-ScriptInBcContainer {
        [CmdletBinding()]param($containerName,$ScriptBlock,$ArgumentList)
        $script:invocations++
        if ($script:invocations -eq 1) { ${mode === 'prepare-error' ? "Write-Error 'private preparation failure'" : "return 'CRONUS'"} }
        if ($script:invocations -eq 2) {
          ${mode === 'start-error' ? "Write-Error 'private service error'" : "return"}
        }
        ${mode === 'version-error' ? "Write-Error 'private module failure'" : "[pscustomobject]@{PlatformVersion='"+(mode === 'modern-empty'?'27':'26')+".0.0.0';DatabaseApplicationVersion='';InstalledApps=@();PackageApps=@()}"}
      }
      function Restore-DatabasesInBcContainer {
        [CmdletBinding()]param($containerName,$bakFile,$databaseName)
        Write-Host 'SQL ATTEMPT'
        ${mode === 'sql-throw' ? "throw [TypeLoadException]::new('Could not load type ServiceCollection; secret connection payload')" : mode === 'sql-error' ? "Write-Error 'private SQL error'" : ''}
      }
      function Repair-BcContainerAdministratorAfterRestore { throw 'UNEXPECTED ADMIN REPAIR' }
      Restore-BcContainerSqlBackupEntries -containerName target -bakFolder unused -backupEntries @() -configuration ([pscustomobject]@{})
      Write-Host 'UNEXPECTED SUCCESS'
    `);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', './Invoke-BcDevToolsetOperation.ps1', '-Operation', 'restore', '-NonInteractive'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /FAILURE HEADING COLOR: Red/);
    assert.ok(result.stdout.includes(`failed during ${stage}.`));
    assert.match(result.stdout, /Inspect|Check/);
    assert.match(result.stdout, /before.*retry/);
    assert.match(result.stdout, /No automatic retry or alternate restore/);
    assert.equal(result.stdout.split('SQL ATTEMPT').length - 1, mode === 'prepare-error' ? 0 : 1);
    if (mode === 'prepare-error') assert.match(result.stdout, /SQL restoration was not started/);
    if (mode.startsWith('sql')) assert.match(result.stdout, /removed the target database.*service may be stopped/);
    if (mode === 'sql-throw') {
      assert.match(result.stdout, /administration module could not load a required .NET type/);
      assert.match(result.stdout, /Error code: -2146233054/);
    }
    if (mode === 'version-empty') assert.match(result.stdout, /empty platform or database application version.*Get-NAVApplication/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED|Exception:|secret connection|private |DONE/);
  });
}


for (const mode of ['unsupported-helper', 'target-mismatch', 'already-active', 'missing-module', 'verify-native', 'verify-setup', 'verify-unavailable', 'verify-pass']) {
  test(`restore diagnostic rejection survives the outer restore boundary (${mode})`, (t) => {
    const { root, write } = fixture(t);
    const verify = mode.startsWith('verify-');
    const success = mode === 'verify-pass';
    const stage = verify ? 'diagnostic backup verification' : 'restore diagnostic compatibility';
    write('operations/operations.json', JSON.stringify([
      { id: 'restore', title: 'Restore SQL backup', script: 'operations/Test.ps1' }
    ]));
    for (const name of ['BackupMgt', 'RestoreDiagnostics']) {
      write(`common/${name}.ps1`, fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common', `${name}.ps1`), 'utf8')); // nosemgrep -- fixed source files contained by repository root
    }
    write('common/CredentialMgt.ps1', '');
    write('common/RemotingMgt.ps1', '');
    write('CustomSettings.config', '<configuration><appSettings><add key="DatabaseServer" value="fixture"/><add key="DatabaseInstance" value=""/></appSettings></configuration>');
    if (verify && mode !== 'verify-unavailable') {
      if (process.platform === 'win32') {
        write('sqlcmd.cmd', `@echo off\r\necho private verification native payload 1>&2\r\nexit /b ${success ? 0 : 37}\r\n`);
      } else {
        write('sqlcmd', `#!/bin/sh\necho private verification native payload >&2\nexit ${success ? 0 : 37}\n`);
        fs.chmodSync(resolveWithinRoot(root, 'sqlcmd'), 0o755); // nosemgrep -- fixed executable fixture contained by the test-owned root
      }
    }
    write('operations/Test.ps1', `
      . (Join-Path $PSScriptRoot '../common/BackupMgt.ps1')
      function global:Write-Host {
        param($Object,[ConsoleColor]$ForegroundColor)
        if ($Object -eq 'Restore SQL backup failed during ${stage}.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) { throw 'UNEXPECTED HEADING COLOR' }
          [Console]::WriteLine('FAILURE HEADING COLOR: Red')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
      function global:Get-Module {
        param([string[]]$Name,[switch]$ListAvailable)
        if ($ListAvailable) { return }
        Microsoft.PowerShell.Core\\Get-Module @PSBoundParameters
      }
      $bcContainerHelperConfig=@{usePwshForBc24=$true}
      function Get-BcContainerSqlBackupRestoreParameters { @{containerName='target';bakFile='database.bak'} }
      function Invoke-ScriptInBcContainer { Write-Host 'PREPARATION ONCE'; 'CRONUS' }
      function Repair-BcContainerAdministratorAfterRestore { ${success ? "Write-Host 'ADMIN ONCE'" : "throw 'UNEXPECTED ADMIN REPAIR'"} }
      function Invoke-BcContainerSystemApplicationUpgradeAfterRestore { ${success ? "Write-Host 'VERSION ONCE'" : "throw 'UNEXPECTED VERSION CHECK'"} }
      function global:docker { throw 'UNEXPECTED DOCKER ACCESS' }
      ${verify ? '$env:PATH=$PWD.Path' : ''}
      function global:Get-Item {
        ${mode === 'verify-setup' ? "Write-Error 'private verification setup payload'" : ''}
        @{FullName=$PWD.Path}
      }
      $module=New-Module -Name BcContainerHelper -ScriptBlock {
        $script:bcContainerHelperConfig=@{usePsSession=$false;usePwshForBc24=$true}
        function Invoke-ScriptInBcContainer {
          param($containerName,$scriptblock,$argumentList,$useSession,$usePwsh)
          ${verify ? `
          # Simulate remoting serialization: transport must not depend on exception types.
          $transport=@(& $scriptblock @argumentList)
          foreach ($item in $transport) { $item | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json }
          ` : "throw 'UNEXPECTED SQL EXECUTION'"}
        }
        function Restore-DatabasesInBcContainer {
          [CmdletBinding()]param($containerName,$bakFile,$databaseName)
          Write-Host 'HELPER ATTEMPT'
          Invoke-ScriptInBcContainer -containerName '${mode === 'target-mismatch' ? 'other' : 'target'}' -scriptblock {
            param($name,$backup)
            function Remove-NAVDatabase { Write-Host 'REMOVE ONCE' }
            function New-NAVDatabase { Write-Host 'NEW ONCE' }
            Remove-NAVDatabase
            ${mode === 'unsupported-helper' ? "Write-Host 'UNEXPECTED SQL EXECUTION'" : 'New-NAVDatabase'}
          } -argumentList @($containerName,$bakFile)
        }
        ${mode === 'already-active' ? '$script:BcRestoreOriginalInvoke=(Get-Command Invoke-ScriptInBcContainer).ScriptBlock' : ''}
        Export-ModuleMember -Function Restore-DatabasesInBcContainer
      }
      Import-Module $module
      ${mode === 'missing-module' ? "function Restore-DatabasesInBcContainer { throw 'UNEXPECTED SQL EXECUTION' }" : ''}
      $before=& $module { (Get-Command Invoke-ScriptInBcContainer).ScriptBlock.ToString() }
      try {
        Restore-BcContainerSqlBackupEntries -containerName target -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{restoreDiagnostics=$true})
        Write-Host '${success ? 'RESTORE COMPLETED' : 'UNEXPECTED SUCCESS'}'
      } finally {
        $after=& $module { (Get-Command Invoke-ScriptInBcContainer).ScriptBlock.ToString() }
        if ($before -cne $after) { throw 'UNEXPECTED HOOK CHANGE' }
        $active=& $module { [bool](Get-Variable BcRestoreOriginalInvoke -Scope Script -ErrorAction Ignore) }
        if ($active -ne $${mode === 'already-active'}) { throw 'UNEXPECTED WRAPPER STATE' }
        $owned=& $module { @(Get-Variable BcRestoreDiagnosticCode,BcRestoreDiagnosticTarget,BcRestoreDiagnosticRejections,BcRestoreVerificationToken,BcRestoreExpectedFailureFactory -Scope Script -ErrorAction Ignore).Count }
        if ($owned -ne 0) { throw 'UNEXPECTED DIAGNOSTIC STATE' }
        if (-not $bcContainerHelperConfig.usePwshForBc24) { throw 'UNEXPECTED RUNTIME STATE' }
        Write-Host 'CLEANUP VERIFIED'
      }
    `);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', './Invoke-BcDevToolsetOperation.ps1', '-Operation', 'restore', '-NonInteractive'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.status, success ? 0 : 1, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /CLEANUP VERIFIED/);
    if (success) {
      for (const marker of ['BC_RESTORE_BACKUP_VERIFY: passed', 'REMOVE ONCE', 'NEW ONCE', 'VERSION ONCE', 'ADMIN ONCE', 'RESTORE COMPLETED']) {
        assert.equal(result.stdout.split(marker).length - 1, 1, result.stdout);
      }
      assert.doesNotMatch(result.stdout, /UNEXPECTED|private verification|failed during/);
      return;
    }
    assert.match(result.stdout, /FAILURE HEADING COLOR: Red/);
    const reason = { 'unsupported-helper': /Unsupported helper restore command boundaries/, 'target-mismatch': /Diagnostic target mismatch/, 'already-active': /diagnostic wrapper is already active/, 'missing-module': /requires the loaded BcContainerHelper module/ }[mode];
    if (!verify) assert.match(result.stdout, reason);
    if (mode === 'verify-native') assert.match(result.stdout, /Fresh backup SQL verification failed\. Native exit code: 37/);
    if (mode === 'verify-setup') assert.match(result.stdout, /verification setup failed; the underlying cause is unknown\. Error code:/);
    if (mode === 'verify-unavailable') assert.match(result.stdout, /sqlcmd executable is unavailable/);
    if (verify) assert.match(result.stdout, /no database removal was attempted/);
    assert.match(result.stdout, /SQL restore was not started/);
    assert.match(result.stdout, /BC service may already be stopped/);
    assert.match(result.stdout, /Check .*before.*retry/);
    assert.match(result.stdout, /No automatic retry/);
    assert.equal(result.stdout.split('PREPARATION ONCE').length - 1, 1);
    assert.equal(result.stdout.split('HELPER ATTEMPT').length - 1, verify || ['unsupported-helper', 'target-mismatch'].includes(mode) ? 1 : 0);
    assert.doesNotMatch(result.stdout, /UNEXPECTED|Exception:|private verification|removed the target database|REMOVE ONCE|NEW ONCE|DONE/);
    if (!verify) assert.doesNotMatch(result.stdout, /underlying cause/);
  });
}

for (const mode of ['inspect-error', 'identity-mismatch', 'host-error', 'fresh-host-exit', 'shell-error', 'shell-nonterminating', 'shell-exit']) {
  test(`restore inspection preserves safe failure context and stops (${mode})`, (t) => {
    const { root, write } = fixture(t);
    write('operations/operations.json', JSON.stringify([
      { id: 'inspect', title: 'Inspect SQL restore environment', script: 'operations/Test.ps1' }
    ]));
    write('common/RestoreDiagnostics.ps1', fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common/RestoreDiagnostics.ps1'), 'utf8')); // nosemgrep -- fixed source contained by repository root
    const stage = mode === 'inspect-error' || mode === 'identity-mismatch' ? 'container identity inspection' : mode === 'host-error' ? 'host diagnostic inventory' : mode === 'fresh-host-exit' ? 'fresh host process inventory' : 'container powershell inventory';
    write('operations/Test.ps1', `
      . (Join-Path $PSScriptRoot '../common/PublishingDiagnostics.ps1')
      . (Join-Path $PSScriptRoot '../common/RestoreDiagnostics.ps1')
      function global:Write-Host {
        param($Object,[ConsoleColor]$ForegroundColor)
        if ($Object -eq 'Inspect SQL restore environment failed during ${stage}.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) { throw 'UNEXPECTED HEADING COLOR' }
          [Console]::WriteLine('FAILURE HEADING COLOR: Red')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
      function Invoke-ConfiguredContainerDocker {
        ${mode === 'inspect-error' ? "throw 'private inspect payload'" : ''}
        '{"Name":"/${mode === 'identity-mismatch' ? 'other' : 'target'}","Running":true}'
      }
      function Get-BcRestoreDiagnosticCode {
        ${mode === 'host-error' ? "Write-Error 'private host payload'" : ''}
        'function Write-BcRestoreSnapshot { param($Stage) }'
      }
      function docker {
        Write-Host 'SHELL ATTEMPT'
        ${mode === 'shell-error' ? "throw 'private shell payload'" : mode === 'shell-nonterminating' ? "Write-Error 'private shell payload'" : '$global:LASTEXITCODE=9'}
      }
      function Get-Process { @{Path='Invoke-FreshInventoryFixture'} }
      function Invoke-FreshInventoryFixture { $global:LASTEXITCODE=17 }
      Get-BcRestoreEnvironment -SettingsJSON @{configurations=@(@{serverType='Container';container='target';restoreInspectionMode='${mode === 'fresh-host-exit' ? 'Full' : 'Database'}'})}
      Write-Host 'UNEXPECTED SUCCESS'
    `);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', './Invoke-BcDevToolsetOperation.ps1', '-Operation', 'inspect', '-NonInteractive'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /FAILURE HEADING COLOR: Red/);
    assert.ok(result.stdout.includes(`failed during ${stage}.`), result.stdout);
    assert.match(result.stdout, /Check .*before retrying/);
    assert.match(result.stdout, /No lifecycle or SQL writes were requested/);
    assert.match(result.stdout, /no restore was started/);
    assert.equal(result.stdout.split('SHELL ATTEMPT').length - 1, mode.startsWith('shell-') ? 1 : 0);
    if (mode === 'identity-mismatch') assert.match(result.stdout, /did not match the selected container name/);
    if (mode === 'shell-exit') assert.match(result.stdout, /Native exit code: 9/);
    if (mode === 'fresh-host-exit') assert.match(result.stdout, /Native exit code: 17/);
    if (mode.endsWith('error') || mode === 'shell-nonterminating') assert.match(result.stdout, /underlying cause is unknown.*Error code:/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED|Exception:|private |DONE/);
  });
}

for (const mode of ['container', 'stopped', 'unhealthy', 'service', 'invalid', 'readiness-error', 'export-error']) {
  test(`unified backup selects first and prepares only its source (${mode})`, (t) => {
    const { root, write } = fixture(t);
    const operation = operations.find(operation => operation.id === 'backupBcDatabases');
    write(operation.script, fs.readFileSync(resolveWithinRoot(repositoryRoot, operation.script), 'utf8')); // nosemgrep -- fixed source confined to repository root
    write('common/ContainerLifecycle.ps1', fs.readFileSync(resolveWithinRoot(repositoryRoot, 'common/ContainerLifecycle.ps1'), 'utf8')); // nosemgrep -- fixed source confined to repository root
    write('common/PublishApps.ps1', '');
    const backupPath = resolveWithinRoot(repositoryRoot, 'common/BackupMgt.ps1').replaceAll("'", "''");
    write('common/WorkspaceMgt.ps1', `
      . '${backupPath}'
      $script:events = [collections.generic.list[string]]::new()
      $script:recovered = $false
      function Initialize-Context {
        param($scriptPath, [ref]$settingsJSON, [ref]$workspaceJSON)
        $settingsJSON.Value = @{configurations=@(
          [pscustomobject]@{name='Other';serverType='Container';container='unrelated';sqlBackupPath='other'},
          [pscustomobject]@{name='Source';serverType='Container';container='selected'},
          [pscustomobject]@{name='Destination';serverType='Container';container='destination';sqlBackupPath='chosen'},
          [pscustomobject]@{name='Remote';serverType='OnPrem';serverInstance='BC230'}
        )}
      }
      function Test-RemotingAgentWorkflow { $false }
      function Select-IndexFromList {
        param($Title,$Options,$DefaultIndex)
        $script:events.Add('select:' + $Title)
        if ($Title -like 'Select source*') { ${mode === 'service' ? 3 : 1} } else { 1 }
      }
      function Get-SqlBackupRootPath {
        param($sqlBackupPath)
        $script:events.Add('path:' + $sqlBackupPath)
        ${mode === 'invalid' ? "throw 'private invalid path'" : "'C:\\chosen'"}
      }
      function Test-DockerProcess { $script:events.Add('docker') }
      function docker {
        param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DockerArguments)
        $global:LASTEXITCODE=0
        $script:events.Add($DockerArguments -join ' ')
        if ($DockerArguments[0] -eq 'info') { return 'windows' }
        if ($DockerArguments[-1] -ne 'selected') { throw 'UNEXPECTED unrelated container access' }
        if ('${mode}' -eq 'readiness-error') { throw 'private readiness error' }
        if ($DockerArguments[1] -in @('start','restart')) { $script:recovered=$true; return }
        $status=if ('${mode}' -eq 'stopped' -and -not $script:recovered) {'exited'} else {'running'}
        $health=if ('${mode}' -eq 'unhealthy' -and -not $script:recovered) {'unhealthy'} else {'healthy'}
        @{Name='/selected';State=@{Status=$status;Health=@{Status=$health}}} | ConvertTo-Json -Depth 4 -Compress
      }
      function Export-BcContainerSqlBackupSet {
        [CmdletBinding()]param($scriptPath,$settingsJSON,$Selection)
        $script:events.Add('container:' + $Selection.Source.name + ':' + $Selection.Destination.name + ':' + $Selection.BackupRootPath)
        ${mode === 'export-error' ? "Write-Error 'private export failure'" : ''}
      }
      function Export-BcServiceSqlBackupSet {
        param($scriptPath,$settingsJSON,$Selection)
        $script:events.Add('service:' + $Selection.Source.name + ':' + $Selection.Destination.name)
      }
      function Write-Done { $script:events.Add('done') }
    `);
    const result = JSON.parse(run(root, `
      try { . ./${operation.script} 6>$null } catch { $failure=$_.Exception; $message=$failure.Message }
      @{Events=@($script:events);Failure=$message;Expected=$failure.Data['BcDevToolsetExpectedFailure']} | ConvertTo-Json -Compress
    `.replace("$failure.Data['BcDevToolsetExpectedFailure']", "$(if ($failure) {$failure.Data['BcDevToolsetExpectedFailure']} else {$false})")));
    assert.ok(result.Events[0].startsWith('select:Select source'));
    assert.ok(result.Events[1].startsWith('select:Select destination'));
    assert.equal(result.Events[2], 'path:chosen');
    assert.ok(result.Events.every(event => !/unrelated|destination$/.test(event)));
    if (mode === 'service') {
      assert.deepEqual(result.Events.slice(3), ['service:Remote:Destination', 'done']);
    } else if (mode === 'invalid') {
      assert.equal(result.Events.length, 3);
      assert.match(result.Failure, /configuration selection.*No backup or container startup was started.*Review/s);
    } else {
      assert.equal(result.Events[3], 'docker');
      if (mode === 'readiness-error') {
        assert.match(result.Failure, /source container readiness.*No SQL backup was started.*Check Docker/s);
        assert.ok(!result.Events.some(event => event.startsWith('container:')));
      } else {
        assert.equal(result.Events.filter(event => event.startsWith('container:')).length, 1);
        assert.ok(result.Events.includes('container:Source:Destination:C:\\chosen'));
        if (mode === 'stopped') assert.ok(result.Events.includes('container start -- selected'));
        if (mode === 'unhealthy') assert.ok(result.Events.includes('container restart -- selected'));
      }
    }
    if (['invalid', 'readiness-error', 'export-error'].includes(mode)) {
      assert.equal(result.Expected, true);
      assert.ok(!result.Events.includes('done'));
      assert.doesNotMatch(result.Failure, /private /);
      if (mode === 'export-error') assert.match(result.Failure, /partially completed.*Inspect.*before retrying/s);
    } else {
      assert.equal(result.Failure, null);
      assert.equal(result.Events.at(-1), 'done');
    }
  });
}

for (const stage of ['configuration selection', 'backup path validation', 'source container readiness', 'SQL backup and export']) {
  test(`unified backup launcher preserves failed status and red guidance (${stage})`, (t) => {
    const { root, write } = fixture(t);
    write('operations/operations.json', JSON.stringify([{id:'backupBcDatabases',title:'Create and export SQL backup set',script:'operations/Test.ps1'}]));
    write('operations/Test.ps1', `
      . (Join-Path $PSScriptRoot '../common/PublishingDiagnostics.ps1')
      function global:Write-Host {
        param($Object,[ConsoleColor]$ForegroundColor)
        if ($Object -eq 'Create and export SQL backup set failed during ${stage}.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) { throw 'Expected red heading' }
          [Console]::WriteLine('RED HEADING')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
      throw (New-BcExpectedFailure -Stage '${stage}' -Message 'SQL backup failed. Inspect selected source and destination before retrying. No automatic fallback was attempted.')
      Write-Done
    `);
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File','./Invoke-BcDevToolsetOperation.ps1','-Operation','backupBcDatabases','-NonInteractive'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(result.status,1,result.stderr || result.stdout);
    assert.equal(result.stderr,'');
    assert.match(result.stdout,/RED HEADING/);
    assert.match(result.stdout,/Inspect selected source and destination before retrying/);
    assert.doesNotMatch(result.stdout,/Exception:|DONE/);
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

for (const missingData of [false, true]) for (const invocation of ['terminal', 'file']) {
  test(`initialization ${missingData ? 'missing data credentials' : 'disabled OData'} renders clean guidance and preserves failure (${invocation})`, (t) => {
    const stage = missingData ? 'Authentication' : 'OData configuration';
    const { root, write } = fixture(t);
    const operation = operations.find(operation => operation.id === 'initializeBcData');
    write('operations/operations.json', JSON.stringify([operation]));
    for (const relative of [operation.script, 'common/BcDataMgt.ps1', 'common/BcDataPackage.ps1', 'common/EndpointCredentials.ps1']) {
      write(relative, fs.readFileSync(resolveWithinRoot(repositoryRoot, relative), 'utf8')); // nosemgrep -- contained by repository root
    }
    const workspaceHelper = resolveWithinRoot(root, 'common/WorkspaceMgt.ps1');
    const workspaceSource = fs.readFileSync(workspaceHelper, 'utf8'); // nosemgrep -- workspaceHelper is contained by the test-owned root through resolveWithinRoot immediately above
    write('common/WorkspaceMgt.ps1', workspaceSource + `
      function Write-Host {
        param($Object, [ConsoleColor]$ForegroundColor)
        if ($Object -eq 'Initialize BC Data Access failed during ${stage}.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) { throw 'Expected failure heading must be red' }
          [Console]::WriteLine('FAILURE HEADING COLOR: Red')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
      function Initialize-Context {
        param($scriptPath,[ref]$settingsJSON,[ref]$workspaceJSON)
        $settingsJSON.Value=@{configurations=@(
          [pscustomobject]@{name='taopaipai';serverType='OnPrem';targetType='Dev';server='bc.example';serverInstance='BC';authentication='Windows';${missingData ? "remoteUser='remote-fixture';remotePassword='synthetic-remote'" : "useManagementCredentials='currentWindows';useDataCredentials='currentWindows'"}}
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
    assert.ok(result.stdout.includes('Initialize BC Data Access failed during ' + stage + '.'));
    if (missingData) {
      assert.match(result.stdout, /Selected data credentials \(bc\) are not configured/);
      assert.match(result.stdout, /useDataCredentials/);
      assert.doesNotMatch(result.stdout, /Starting OData discovery|baseUrl saved|attempting OData readiness/);
    } else assert.match(result.stdout, /no bcData.baseUrl found.*Starting OData discovery/);
    assert.doesNotMatch(result.stdout, /resolved and validated|baseUrl saved|attempting OData readiness request|request succeeded/);
    if (!missingData) assert.match(result.stdout, /Enable ODataServicesEnabled and ODataServicesV4EndpointEnabled/);
    if (!missingData) assert.match(result.stdout, /No companion was deployed[. ]/);
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
    for (const relative of ['common/BcDataMgt.ps1', 'common/BcDataPackage.ps1', 'common/EndpointCredentials.ps1']) {
      write(relative, fs.readFileSync(resolveWithinRoot(repositoryRoot, relative), 'utf8')); // nosemgrep -- contained by repository root
    }
    write('settings/config.json', 'original');
    write('operations/Test.ps1', `
      . (Join-Path $PSScriptRoot '../common/BcDataMgt.ps1')
      $config=[pscustomobject]@{name='Remote';serverType='OnPrem';server='bc.example';serverInstance='BC';authentication='Windows';useManagementCredentials='currentWindows';useDataCredentials='currentWindows'}
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
    assert.match(result.stdout, /no bcData.baseUrl found.*Starting OData discovery/);
    assert.match(result.stdout, /OData discovery resolved and validated https:\/\/bc.example\/BC\/ODataV4/);
    assert.doesNotMatch(result.stdout, /baseUrl saved|attempting OData readiness request|request succeeded/);
    assert.match(result.stdout, /No companion was deployed[. ]/);
    assert.match(result.stdout, failure === 'write-failure' ? /Inspect the configuration file before retrying/ : /initialize again/);
    assert.doesNotMatch(result.stdout, /Exception:|Line\s*\||BcDataMgt\.ps1:\d|DONE|UNEXPECTED DEPLOYMENT/);
  });
}


for (const mode of ['healthy', 'stopped', 'unhealthy', 'declined', 'missing', 'readiness-error', 'no-target']) {
  test(`restore prepares only its selected and confirmed container (${mode})`, (t) => {
    const { root, write } = fixture(t);
    const operation=operations.find(operation => operation.id === 'restoreBcContainerDatabases');
    write(operation.script,fs.readFileSync(resolveWithinRoot(repositoryRoot,operation.script),'utf8')); // nosemgrep -- fixed source confined to repository root
    write('common/ContainerLifecycle.ps1',fs.readFileSync(resolveWithinRoot(repositoryRoot,'common/ContainerLifecycle.ps1'),'utf8')); // nosemgrep -- fixed source confined to repository root
    write('common/PublishApps.ps1','');
    write('operations/operations.json',JSON.stringify([operation]));
    const backupPath=resolveWithinRoot(repositoryRoot,'common/BackupMgt.ps1').replaceAll("'","''");
    write('common/WorkspaceMgt.ps1',`
      . '${backupPath}'
      $script:events=[collections.generic.list[string]]::new()
      $script:started=$false
      function Get-OperationDefinitions {
        param($ScriptPath)
        $definition=Get-Content (Join-Path $ScriptPath 'operations/operations.json') -Raw | ConvertFrom-Json
        $definition | Add-Member ScriptPath (Join-Path $ScriptPath $definition.script)
        $definition
      }
      function Initialize-Context {
        param($scriptPath,[ref]$settingsJSON,[ref]$workspaceJSON)
        if ('${mode}' -eq 'no-target') { $settingsJSON.Value=@{configurations=@()}; return }
        $settingsJSON.Value=@{configurations=@('other','selected' | ForEach-Object {
          [pscustomobject]@{name=$_;serverType='Container';container=$_;sqlBackupPath=$_;bcData=@{provisioningEnabled=$true}}
        })}
      }
      function Select-IndexFromList { $script:events.Add('select'); 1 }
      function Get-SqlBackupRootPath { param($sqlBackupPath) $sqlBackupPath }
      function Test-Path { $true }
      function Get-SqlBackupSetEntries {
        $script:events.Add('validate-backup')
        [pscustomobject]@{SourceFileName='CRONUS.database.bak';DatabaseRole='database';DatabaseName='CRONUS'}
      }
      function Confirm-Option { $script:events.Add('confirm'); $${mode !== 'declined'} }
      function Test-DockerProcess { $script:events.Add('docker') }
      function docker {
        param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DockerArguments)
        $global:LASTEXITCODE=0
        $script:events.Add($DockerArguments -join ' ')
        if ($DockerArguments[0] -eq 'info') { return 'windows' }
        if ($DockerArguments[-1] -ne 'selected') { throw 'UNEXPECTED unrelated access' }
        if ('${mode}' -eq 'missing') { throw 'No such container' }
        if ('${mode}' -eq 'readiness-error') { Write-Error 'Readiness probe failed'; return }
        if ($DockerArguments[1] -eq 'start') { $script:started=$true; return }
        $status=if ('${mode}' -eq 'stopped' -and -not $script:started) {'exited'} else {'running'}
        $health=if ('${mode}' -eq 'unhealthy') {'unhealthy'} else {'healthy'}
        @{Name='/selected';State=@{Status=$status;Health=@{Status=$health}}} | ConvertTo-Json -Depth 4 -Compress
      }
      function Sync-ConfiguredBcData { throw 'UNEXPECTED app provisioning' }
      function Copy-SqlBackupSetToSharedFolder { param($containerName) $script:events.Add('stage:'+$containerName); 'staged' }
      function Restore-BcContainerSqlBackupEntries { param($containerName) $script:events.Add('restore:'+$containerName); Write-Host 'RESTORE CALLED' }
      function Write-Done { $script:events.Add('done'); Write-Host 'DONE' }
      function global:Write-Host {
        param($Object,[ConsoleColor]$ForegroundColor)
        if ($Object -eq '${operation.title} failed during restore target readiness.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) {throw 'Expected red failure heading'}
          [Console]::WriteLine('RED READINESS HEADING')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
    `);
    const result=JSON.parse(run(root,`
      try { . ./${operation.script} 6>$null } catch { $failure=$_.Exception }
      @{Events=@($script:events);Failure=$failure.Message;Expected=$(if ($failure) {$failure.Data['BcDevToolsetExpectedFailure']} else {$false})} | ConvertTo-Json -Compress
    `));
    if (mode === 'no-target') {
      assert.deepEqual(result.Events,[]);
      assert.equal(result.Expected,true);
      assert.match(result.Failure,/Configure a target and backup folder before retrying.*No container startup or SQL restoration was started/s);
      return;
    }
    assert.deepEqual(result.Events.slice(0,3),['select','validate-backup','confirm']);
    assert.ok(result.Events.every(event => !event.includes('other')));
    if (mode === 'declined') {
      assert.deepEqual(result.Events,['select','validate-backup','confirm','done']);
      assert.equal(result.Failure,null);
    } else {
      assert.equal(result.Events[3],'docker');
      assert.ok(result.Events.every(event => !event.startsWith('container restart')));
      if (['missing','readiness-error'].includes(mode)) {
        assert.equal(result.Expected,true);
        assert.match(result.Failure,/No SQL restoration or backup staging was started.*Check Docker.*before retrying/s);
        assert.ok(result.Events.every(event => !/^(stage:|restore:|done)/.test(event)));
        const launch=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File','./Invoke-BcDevToolsetOperation.ps1','-Operation',operation.id,'-NonInteractive'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
        assert.equal(launch.status,1,launch.stderr || launch.stdout);
        assert.equal(launch.stderr,'');
        assert.match(launch.stdout,/RED READINESS HEADING/);
        assert.match(launch.stdout,/No SQL restoration or backup staging was started/);
        assert.doesNotMatch(launch.stdout,/RESTORE CALLED|DONE|Exception:/);
      } else {
        assert.equal(result.Failure,null);
        assert.deepEqual(result.Events.slice(-3),['stage:selected','restore:selected','done']);
        assert.equal(result.Events.includes('container start -- selected'),mode === 'stopped');
      }
    }
  });
}


for (const [label,configuration,diagnostic] of [
  ['missing database name',{databaseServerHost:'sql-host'},/databaseName is required/],
  ['invalid host',{databaseServerHost:'https://sql-host',databaseName:'App'},/databaseServerHost must be a hostname or IP/],
  ['empty tenants',{databaseServerHost:'sql-host',databaseName:'App',databaseTenants:[]},/databaseTenants must be a non-empty array/],
  ['duplicate tenant IDs',{databaseServerHost:'sql-host',databaseName:'App',databaseTenants:[{id:'one',databaseName:'One'},{id:'one',databaseName:'Two'}]},/unique id and a databaseName/]
]) {
  test(`unified backup preserves reviewed mapping diagnostics and failed status (${label})`,(t)=>{
    const {root,write}=fixture(t);
    write('operations/operations.json',JSON.stringify([{id:'backup',title:'SQL backup',script:'operations/Test.ps1'}]));
    const backupPath=resolveWithinRoot(repositoryRoot,'common/BackupMgt.ps1').replaceAll("'","''");
    write('operations/Test.ps1',`
      . '${backupPath}'
      function global:Write-Host {
        param($Object,[ConsoleColor]$ForegroundColor)
        if ($Object -eq 'SQL backup failed during SQL backup configuration validation.') {
          if ($ForegroundColor -ne [ConsoleColor]::Red) {throw 'Expected red heading'}
          [Console]::WriteLine('RED CONFIGURATION HEADING')
        }
        Microsoft.PowerShell.Utility\\Write-Host @PSBoundParameters
      }
      function Select-SqlBackupConfigurations {
        $source='${JSON.stringify({name:'Source',serverType:'OnPrem',serverInstance:'BC230',...configuration}).replaceAll("'","''")}' | ConvertFrom-Json
        [pscustomobject]@{Source=$source;Destination=[pscustomobject]@{name='Dest'};BackupRootPath='validated-root'}
      }
      function Import-BcServiceBackupDiscoveryModules {throw 'UNEXPECTED discovery'}
      function Get-ConfigurationCredential {throw 'UNEXPECTED credentials'}
      function New-Item {throw 'UNEXPECTED write'}
      function Backup-RemoteSqlDatabases {throw 'UNEXPECTED backup'}
      function Backup-RegularSqlDatabase {throw 'UNEXPECTED backup'}
      function Write-SqlBackupSetSource {throw 'UNEXPECTED manifest write'}
      function Save-BcDatabaseServerHost {throw 'UNEXPECTED configuration save'}
      Export-SqlBackupSet -scriptPath unused -settingsJSON @{}
      Write-Done
    `);
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File','./Invoke-BcDevToolsetOperation.ps1','-Operation','backup','-NonInteractive'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(result.status,1,result.stderr || result.stdout);
    assert.equal(result.stderr,'');
    assert.match(result.stdout,/RED CONFIGURATION HEADING/);
    assert.match(result.stdout,diagnostic);
    assert.match(result.stdout,/Correct the selected OnPrem source configuration and retry/);
    assert.match(result.stdout,/No SQL backup, export, or configuration writes were started/);
    assert.doesNotMatch(result.stdout,/underlying cause has not been established|partially completed|UNEXPECTED|DONE|Exception:/);
  });
}
