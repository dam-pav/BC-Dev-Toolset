'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {authorizeRoot,resolveWithinRoot}=require('../path-security');
const extensionRoot=authorizeRoot(path.resolve(__dirname,'..'),'Extension test source');
const source=path.resolve(__dirname,'../../common/BackupMgt.ps1');
const quote=value=>"'"+value.replaceAll("'","''")+"'";

function moduleFixture(t,config='@{usePwshForBc24=$true}') {
  const root=authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(),'bc-runtime-module-')),'Owned module fixture');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true})); // nosemgrep -- test-owned authorized root
  fs.mkdirSync(resolveWithinRoot(root,'BcContainerHelper')); // nosemgrep -- fixed module directory contained by owned root
  fs.writeFileSync(resolveWithinRoot(root,'BcContainerHelper/BcContainerHelper.psd1'),"@{RootModule='BcContainerHelper.psm1';ModuleVersion='0.0.0';GUID='00000000-0000-0000-0000-000000000089';FunctionsToExport=@('Restore-DatabasesInBcContainer');VariablesToExport=@()}"); // nosemgrep -- fixed manifest contained by owned root
  // This fixture owns root; resolveWithinRoot verifies path.relative containment.
  fs.writeFileSync(resolveWithinRoot(root,'BcContainerHelper/BcContainerHelper.psm1'), // nosemgrep -- fixed module source authorized and contained by the test-owned root
    `
    $script:bcContainerHelperConfig=${config};$script:calls=0;$script:observed=$null
    function Restore-DatabasesInBcContainer {$script:calls++;$script:observed=$script:bcContainerHelperConfig.usePwshForBc24}
    Export-ModuleMember -Function Restore-DatabasesInBcContainer
  `);
  return root;
}
function run(body,moduleRoot,expectedStatus=0) {
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',`
    $ErrorActionPreference='Stop'
    Import-Module Microsoft.PowerShell.Utility
    Import-Module Microsoft.PowerShell.Management
    . ${quote(source)}
    $env:PSModulePath=${quote(moduleRoot)}
    ${body}
  `],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(r.status,expectedStatus,r.stderr+'\n'+r.stdout);
  assert.equal(r.stderr,'',r.stdout);
  assert.doesNotMatch(r.stdout+r.stderr,/PRIVATE|password=secret|Exception:|Line\s*\|/);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}
for(const initial of [true,false]) for(const failure of [true,false]) for(const shadow of [true,false]) {
  test(`fresh lazy helper uses module-owned runtime and restores it: ${initial}/${failure}/shadow=${shadow}`,t=>{
    const root=moduleFixture(t,'@{usePwshForBc24=$'+initial+'}');
    const r=run(`
      if(Get-Module BcContainerHelper){throw 'UNEXPECTED PRELOADED HELPER'}
      ${shadow?'$bcContainerHelperConfig=@{usePwshForBc24=$'+!initial+'}':"if(Get-Variable bcContainerHelperConfig -ErrorAction Ignore){throw 'UNEXPECTED CALLER CONFIG'}"}
      $script:core=0;$failure=$null
      function Invoke-BcContainerSqlBackupRestoreCore {
        param($containerName,$bakFolder,$backupEntries,$configuration)
        $script:core++;if($containerName -ne 'selected'){throw 'UNEXPECTED TARGET'}
        Restore-DatabasesInBcContainer
        ${failure?"throw [TypeLoadException]::new('controlled failure')":''}
      }
      try {Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{})}
      catch {$failure=@{type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult}}
      $module=Get-Module BcContainerHelper;if(-not $module){throw 'HELPER NOT AUTOLOADED'}
      $state=& $module {@{calls=$script:calls;observed=$script:observed;after=$script:bcContainerHelperConfig.usePwshForBc24}}
      @{core=$script:core;helper=$state;failure=$failure;shadow=$(if($${shadow}){$bcContainerHelperConfig.usePwshForBc24})}|ConvertTo-Json -Compress
    `,root);
    assert.equal(r.core,1);assert.equal(r.helper.calls,1);assert.equal(r.helper.observed,false);assert.equal(r.helper.after,initial);
    if(shadow) assert.equal(r.shadow,!initial);
    if(failure){assert.equal(r.failure.type,'System.TypeLoadException');assert.equal(r.failure.hresult,-2146233054)} else assert.equal(r.failure,null);
  });
}
for(const mode of ['missing','null-config','missing-variable','missing-option','string-option','readonly-config','autoload-failure','caller-function']) {
  test(`runtime selection rejects unavailable or incompatible bound helper before SQL (${mode})`,t=>{
    const configs={
      'null-config':'$null',
      'missing-variable':'$null;Remove-Variable bcContainerHelperConfig -Scope Script',
      'missing-option':'@{}',
      'string-option':"@{usePwshForBc24='true'}",
      'readonly-config':'[Collections.Specialized.OrderedDictionary]::new().AsReadOnly()',
      'autoload-failure':"$(throw 'PRIVATE module import password=secret')"
    };
    const root=moduleFixture(t,configs[mode]||'@{usePwshForBc24=$true}');
    const r=run(`
      ${mode==='missing'?"$PSModuleAutoLoadingPreference='None'":''}
      ${mode==='caller-function'?"function Restore-DatabasesInBcContainer {throw 'UNEXPECTED SQL'}":''}
      $bcContainerHelperConfig=@{usePwshForBc24=$true};$script:calls=0;$failure=$null
      function Invoke-BcContainerSqlBackupRestoreCore {$script:calls++}
      try {Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{})}
      catch {$failure=@{expected=$_.Exception.Data['BcDevToolsetExpectedFailure'];stage=$_.Exception.Data['Stage'];message=$_.Exception.Message}}
      @{calls=$script:calls;failure=$failure;shadow=$bcContainerHelperConfig.usePwshForBc24}|ConvertTo-Json -Compress
    `,root);
    assert.equal(r.calls,0);assert.equal(r.shadow,true);assert.equal(r.failure.expected,true);assert.equal(r.failure.stage,'restore runtime selection');
    assert.match(r.failure.message,/BcContainerHelper/);assert.match(r.failure.message,/Import|Install|Check|inspect|reload/i);
    assert.match(r.failure.message,/No BC service stop or SQL restoration was started/);
    assert.match(r.failure.message,/may already have been started.*backup files staged/);
    assert.doesNotMatch(r.failure.message,/No restore preparation|UNEXPECTED|PRIVATE|password=secret/);
  });
}
for(const mode of ['optout','multitenant']) {
  test(`${mode} retains helper selection without requiring module loading`,t=>{
    const root=moduleFixture(t);
    const r=run(`
      $PSModuleAutoLoadingPreference='None';$script:calls=0
      function Invoke-BcContainerSqlBackupRestoreCore {$script:calls++}
      Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries ${mode==='optout'?"@([pscustomobject]@{DatabaseRole='database'})":"@([pscustomobject]@{DatabaseRole='app'},[pscustomobject]@{DatabaseRole='tenant'})"} -configuration ([pscustomobject]@{${mode==='optout'?'restoreUseWindowsPowerShell=$false':''}})
      @{calls=$script:calls;loaded=[bool](Get-Module BcContainerHelper)}|ConvertTo-Json -Compress
    `,root);
    assert.equal(r.calls,1);assert.equal(r.loaded,false);
  });
}
for(const mode of ['setup-failure','reset-failure','primary-and-reset-failure']) {
  test(`runtime option write failure preserves meaningful failed status (${mode})`,t=>{
    const root=moduleFixture(t);
    const r=run(`
      Add-Type -TypeDefinition @'
using System;
using System.Collections;
public class RestoreRuntimeWriteFixture : Hashtable {
  int writes=0;
  readonly int failingWrite;
  public RestoreRuntimeWriteFixture(int failingWrite) { this.failingWrite=failingWrite; base["usePwshForBc24"]=true; }
  public override object this[object key] {
    get { return base[key]; }
    set { if(++writes==failingWrite) throw new InvalidOperationException("PRIVATE config write password=secret"); base[key]=value; }
  }
}
'@
      $script:fixtureConfig=[RestoreRuntimeWriteFixture]::new(${mode==='setup-failure'?1:2})
      function Get-BcRestoreRuntimeConfiguration {$script:fixtureConfig}
      $script:calls=0;$failure=$null;$script:messages=@()
      function Invoke-BcContainerSqlBackupRestoreCore {
        $script:calls++
        if($script:fixtureConfig.usePwshForBc24){throw 'UNEXPECTED RUNTIME'}
        ${mode==='primary-and-reset-failure'?"throw [TypeLoadException]::new('controlled primary failure')":''}
      }
      try {
        Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{}) 6>&1|ForEach-Object {$script:messages += [string]$_}
        $script:messages+='UNEXPECTED SUCCESS'
      }catch{$failure=$_.Exception}
      @{calls=$script:calls;type=$failure.GetType().FullName;hresult=$failure.HResult;stage=$failure.Data['Stage'];expected=$failure.Data['BcDevToolsetExpectedFailure'];message=$failure.Message;messages=$script:messages}|ConvertTo-Json -Compress
      if($failure){exit 1}
    `,root,1);
    assert.equal(r.calls,mode==='setup-failure'?0:1);
    const diagnostics=r.message+'\n'+r.messages.join('\n');
    assert.doesNotMatch(diagnostics,/PRIVATE|password=secret|UNEXPECTED SUCCESS|option reset: usePwshForBc24/);
    assert.match(diagnostics,/Error code: -2146233079/);
    if(mode==='primary-and-reset-failure') {
      assert.equal(r.type,'System.TypeLoadException');assert.equal(r.hresult,-2146233054);
      assert.match(r.message,/controlled primary failure/);
      assert.match(r.messages.join('\n'),/could not be reset.*value is unverified.*Error code:/);
    } else {
      assert.equal(r.expected,true);
      assert.equal(r.stage,mode==='setup-failure'?'restore runtime selection':'restore runtime cleanup');
      assert.match(r.message,/reload the operation host/);
      assert.match(r.message,mode==='setup-failure'?/No BC service stop or SQL restoration was started/:/SQL restoration may have returned or partially completed/);
    }
  });
}
for(const mode of ['invalid-setting','invalid-diagnostics']) {
  test(`invalid runtime settings stop without loading helper (${mode})`,t=>{
    const root=moduleFixture(t);
    const r=run(`
      $script:calls=0;$failure=$null
      function Invoke-BcContainerSqlBackupRestoreCore {$script:calls++}
      try {Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{${mode==='invalid-setting'?"restoreUseWindowsPowerShell='true'":"restoreDiagnostics='true'"}})}
      catch {$failure=$_.Exception.Data['BcDevToolsetExpectedFailure']}
      @{calls=$script:calls;failed=$failure;loaded=[bool](Get-Module BcContainerHelper)}|ConvertTo-Json -Compress
    `,root);
    assert.equal(r.calls,0);assert.equal(r.failed,true);assert.equal(r.loaded,false);
  });
}
test('published restore defaults agree with runtime defaults',()=>{
  function find(value,key) {
    if(!value || typeof value!=='object') return undefined;
    if(Object.hasOwn(value,key)) return value[key];
    for(const child of Object.values(value)){const result=find(child,key);if(result) return result;}
  }
  for(const file of ['package.json','schemas/bcdevtoolset-settings.schema.json']) {
    const metadata=JSON.parse(fs.readFileSync(resolveWithinRoot(extensionRoot,file),'utf8')); // nosemgrep -- fixed metadata contained by extension root
    assert.equal(find(metadata,'restoreUseWindowsPowerShell').default,true);
    assert.equal(find(metadata,'restoreDiagnostics').default,false);
    assert.equal(find(metadata,'restoreInspectionMode').default,'Database');
  }
});
