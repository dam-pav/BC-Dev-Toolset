'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const source = path.resolve(__dirname, '../../common/RestoreDiagnostics.ps1').replace(/'/g, "''");
function run(body) {
  // Inventory the fixture's loaded modules, without scanning machine-wide module
  // installations at every snapshot. Restore boundaries and hooks remain real.
  const moduleInventory = 'function Get-Module { param([string[]]$Name,[switch]$ListAvailable) if($ListAvailable){return}; Microsoft.PowerShell.Core\\Get-Module @PSBoundParameters }';
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; . '"+source+"';\n"+moduleInventory+'\n'+body.join('\n')], {
    encoding:'utf8',timeout:30000,windowsHide:true
  });
}
test('diagnostic inventory rejects ambiguous and invalid targets before Docker', () => {
  for(const configurations of ["@()", "@(@{serverType='Container';container='-bad'})", "@(@{serverType='Container';container='a'},@{serverType='Container';container='b'})"]) {
    const r=run([
      "function New-BcExpectedFailure { param($Stage,$Message) [Exception]::new($Message) }",
      "function Invoke-ConfiguredContainerDocker { throw 'UNEXPECTED DOCKER' }",
      "try { Get-BcRestoreEnvironment -SettingsJSON @{configurations="+configurations+"}; exit 9 }",
      "catch { if($_.Exception.Message -like '*UNEXPECTED*'){throw}; Write-Host $_.Exception.Message; exit 1 }"
    ]);
    assert.equal(r.status,1,r.stderr);
    assert.match(r.stdout,/Select exactly one/);
    assert.doesNotMatch(r.stdout+r.stderr,/UNEXPECTED/);
  }
});
test('stopped inventory reports identity without Docker exec, lifecycle or SQL work', () => {
  const r=run([
    'function Invoke-ConfiguredContainerDocker { param($DockerArguments)',
    "if($DockerArguments[1] -ne 'inspect'){throw 'UNEXPECTED WRITE'}",
    '\'{"Name":"/target","Id":"immutable-id","Image":"image","Status":"exited","Running":false,"Health":null}\'',
    '}',
    "function docker { throw 'UNEXPECTED EXEC' }",
    "Get-BcRestoreEnvironment -SettingsJSON @{configurations=@(@{serverType='Container';container='target'})}"
  ]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/immutable-id/);
  assert.match(r.stdout,/no startup attempted/);
});
test('State inventory never launches a process or loads diagnostic modules for a running container',()=>{
  const r=run([
    'function Invoke-ConfiguredContainerDocker { param($DockerArguments)',
    '\'{"Name":"/target","Id":"immutable-id","Image":"image","Status":"running","Running":true,"Health":"healthy"}\'',
    '}',
    "function Get-BcRestoreDiagnosticCode { throw 'UNEXPECTED MODULE CAPTURE' }",
    "function docker { throw 'UNEXPECTED EXEC' }",
    "Get-BcRestoreEnvironment -SettingsJSON @{configurations=@(@{serverType='Container';container='target';restoreInspectionMode='State'})}"
  ]);
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/BC_RESTORE_CONTAINER/);
  assert.doesNotMatch(r.stdout+r.stderr,/UNEXPECTED|BC_RESTORE_DIAGNOSTIC /);
});
test('invalid inspection mode stops before Docker access',()=>{
  const r=run([
    "function New-BcExpectedFailure { param($Stage,$Message) [Exception]::new($Message) }",
    "function Invoke-ConfiguredContainerDocker { throw 'UNEXPECTED DOCKER' }",
    "try { Get-BcRestoreEnvironment -SettingsJSON @{configurations=@(@{serverType='Container';container='target';restoreInspectionMode='bad'})};exit 9 } catch { Write-Host $_.Exception.Message;exit 1 }"
  ]);
  assert.equal(r.status,1);assert.match(r.stdout,/must be Full, Database or State/);
  assert.doesNotMatch(r.stdout+r.stderr,/UNEXPECTED/);
});
test('Database inventory uses Windows PowerShell only and skips fresh-host/resolver probes',()=>{
  const r=run([
    'function Invoke-ConfiguredContainerDocker { param($DockerArguments)',
    '\'{"Name":"/target","Id":"immutable-id","Image":"image","Status":"running","Running":true,"Health":"healthy"}\'',
    '}',
    '$script:calls=0',
    'function docker { $script:calls++;',
    "if($args[0] -ne 'exec' -or $args[2] -ne 'powershell'){throw 'UNEXPECTED SHELL'}",
    '$body=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($args[-1]))',
    "if($body -notmatch \"if\\('Database' -eq 'Full'\\)\"){throw 'UNEXPECTED RESOLVER MODE'}",
    "$global:LASTEXITCODE=0;'DATABASE PROBE ONLY'",
    '}',
    "Get-BcRestoreEnvironment -SettingsJSON @{configurations=@(@{serverType='Container';container='target';restoreInspectionMode='Database'})}",
    "if($script:calls -ne 1){throw 'UNEXPECTED CALL COUNT'}"
  ]);
  assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout+r.stderr,/UNEXPECTED|host-fresh-process/);
});
for(const mode of ['success','sql-failure','capture-failure','unsupported-helper']) {
  const fail=mode!=='success';
  test('instrumented helper preserves call boundaries, failure and cleanup: '+mode, () => {
    const r=run([
      '$module=New-Module -Name BcContainerHelper -ScriptBlock {',
      '$script:bcContainerHelperConfig=@{usePsSession=$false;usePwshForBc24=$true}',
      'function Invoke-ScriptInBcContainer { param($containerName,$scriptblock,$argumentList,$useSession,$usePwsh) & $scriptblock @argumentList }',
      'function Restore-DatabasesInBcContainer { param($containerName)',
      'Invoke-ScriptInBcContainer -containerName $containerName -scriptblock {',
      'param($name)',
      "function Remove-NAVDatabase { Write-Host 'REMOVE ONCE' }",
      "function New-NAVDatabase { "+(mode==='sql-failure'?"throw [TypeLoadException]::new('secret password connection string')":"Write-Host 'NEW ONCE'")+" }",
      'Remove-NAVDatabase',
      mode==='unsupported-helper'?'Write-Host NO-NEW-COMMAND':'New-NAVDatabase',
      '} -argumentList @($containerName)',
      '}',
      'Export-ModuleMember -Function Restore-DatabasesInBcContainer',
      '}',
      'Import-Module $module',
      mode==='capture-failure' ? "$script:originalCode=Get-BcRestoreDiagnosticCode; function Get-BcRestoreDiagnosticCode { $script:originalCode.Replace('$ErrorActionPreference = ''Stop''', 'if($Stage -eq ''before-Remove-NAVDatabase''){throw ''Capture unavailable''}; $ErrorActionPreference = ''Stop''') }" : '',
      '$before=& $module { (Get-Command Invoke-ScriptInBcContainer).ScriptBlock.ToString() }',
      '$failed=$false',
      "try { Invoke-BcInstrumentedSqlRestore -RestoreParameters @{containerName='target'} }",
      "catch { $failed=$true; Write-Host ('FAILURE TYPE '+$_.Exception.GetType().FullName) }",
      '$after=& $module { (Get-Command Invoke-ScriptInBcContainer).ScriptBlock.ToString() }',
      "if($before -cne $after){throw 'HOOK NOT RESTORED'}",
      "if('BcRestoreAssemblyEvents' -as [type]) { $null=[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]::new('Microsoft.Extensions.DiagnosticCleanupFixture'),[Reflection.Emit.AssemblyBuilderAccess]::Run); if([BcRestoreAssemblyEvents]::Drain().Count){throw 'ASSEMBLY EVENT HOOK NOT REMOVED'} }",
      'if($failed){exit 1}'
    ]);
    assert.equal(r.status,fail?1:0,r.stderr+'\n'+r.stdout);
    const records=r.stdout.split(/\r?\n/).filter(l=>l.startsWith('BC_RESTORE_DIAGNOSTIC '))
      .map(l=>JSON.parse(Buffer.from(l.slice('BC_RESTORE_DIAGNOSTIC '.length),'base64').toString('utf8')));
    const stages=records.map(x=>x.stage);
    if(mode==='unsupported-helper') {
      assert.deepEqual(stages,['host-before-restore']);
    } else if(mode==='capture-failure') {
      assert.ok(stages.includes('container-restore-failed'));
      assert.doesNotMatch(r.stdout,/REMOVE ONCE|NEW ONCE/);
    } else {
      assert.ok(stages.includes('before-Remove-NAVDatabase'),JSON.stringify(stages));
      assert.ok(stages.includes('before-New-NAVDatabase'),JSON.stringify(stages));
      assert.ok(stages.includes(fail?'container-restore-failed':'container-restore-returned'));
    }
    assert.equal(r.stdout.split('REMOVE ONCE').length-1,mode==='capture-failure'||mode==='unsupported-helper'?0:1);
    assert.equal(new Set(records.map(x=>x.pid)).size,1);
    assert.doesNotMatch(JSON.stringify(records)+r.stdout+r.stderr,/secret password|connection string|HOOK NOT RESTORED/);
    if(mode==='sql-failure'||mode==='capture-failure') assert.ok(records.find(x=>x.stage==='container-restore-failed').exceptions.length);
  });
}
for(const nativeFailure of [false,true]) {
  test('running inventory uses only read-only commands and propagates native failure: '+nativeFailure, () => {
    const r=run([
      "function New-BcExpectedFailure { param($Stage,$Message) [Exception]::new($Message) }",
      'function Invoke-ConfiguredContainerDocker { param($DockerArguments)',
      "if($DockerArguments[1] -ne 'inspect'){throw 'UNEXPECTED WRITE'}",
      '\'{"Name":"/target","Id":"immutable-id","Image":"image","Status":"running","Running":true,"Health":"healthy"}\'',
      '}',
      '$script:calls=0',
      'function docker {',
      "$script:calls++; if($args[0] -ne 'exec' -or $args[1] -ne 'target'){throw 'UNEXPECTED TARGET'}",
      '$body=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($args[-1]))',
      "if($body -match '(?im)^\\s*(Remove-NAVDatabase|New-NAVDatabase|Set-NAVServerInstance|Restore-DatabasesInBcContainer)\\b'){throw 'UNEXPECTED WRITE'}",
      '$global:LASTEXITCODE='+(nativeFailure?'9':'0'),
      "Write-Output 'READ ONLY PROBE'",
      '}',
      '$failed=$false',
      "try { Get-BcRestoreEnvironment -SettingsJSON @{configurations=@(@{serverType='Container';container='target';restoreInspectionMode='Full'})} }",
      "catch { $failed=$true; Write-Host $_.Exception.Message }",
      "if($script:calls -ne "+(nativeFailure?'1':'2')+"){throw 'UNEXPECTED CALL COUNT'}",
      'if($failed){exit 1}'
    ]);
    assert.equal(r.status,nativeFailure?1:0,r.stderr);
    assert.doesNotMatch(r.stdout+r.stderr,/UNEXPECTED/);
    if(nativeFailure) assert.match(r.stdout,/powershell exit=9/);
  });
}
