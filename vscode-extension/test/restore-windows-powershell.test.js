'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {authorizeRoot,resolveWithinRoot}=require('../path-security');
const extensionRoot=authorizeRoot(path.resolve(__dirname,'..'),'Extension test source');
const source=path.resolve(__dirname,'../../common/BackupMgt.ps1').replace(/'/g,"''");
function run(body) {
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',
    "$ErrorActionPreference='Stop'; . '"+source+"';\n"+body.join('\n')],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}
for(const initial of [true,false]) for(const failure of [true,false]) for(const setting of ['$true','$null']) {
  test('restore PS5 override is scoped across the workflow and restored: '+initial+'/'+failure+'/'+setting,()=>{
    const r=run([
      '$bcContainerHelperConfig=@{usePwshForBc24=$'+initial+'}',
      '$script:calls=0; $script:observed=$null; $failure=$null',
      'function Invoke-BcContainerSqlBackupRestoreCore { param($containerName,$bakFolder,$backupEntries,$configuration)',
      '$script:calls++; $script:observed=$bcContainerHelperConfig.usePwshForBc24',
      "if($containerName -ne 'selected'){throw 'Bad target forwarding'}",
      failure?"throw [TypeLoadException]::new('controlled failure')":'',
      '}',
      "try { Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{restoreUseWindowsPowerShell="+setting+"}) }",
      'catch { $failure=@{type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult} }',
      '@{calls=$script:calls;observed=$script:observed;after=$bcContainerHelperConfig.usePwshForBc24;failure=$failure}|ConvertTo-Json -Compress'
    ]);
    assert.equal(r.calls,1);assert.equal(r.observed,false);assert.equal(r.after,initial);
    if(failure){assert.equal(r.failure.type,'System.TypeLoadException');assert.equal(r.failure.hresult,Number('-2146233054'))}
    else assert.equal(r.failure,null);
  });
}
test('explicit opt-out leaves helper runtime selection alone',()=>{
  const r=run([
    '$bcContainerHelperConfig=@{usePwshForBc24=$true};$script:observed=$null',
    'function Invoke-BcContainerSqlBackupRestoreCore { param($containerName,$bakFolder,$backupEntries,$configuration) $script:observed=$bcContainerHelperConfig.usePwshForBc24 }',
    "Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{restoreUseWindowsPowerShell=$false})",
    '@{observed=$script:observed;after=$bcContainerHelperConfig.usePwshForBc24}|ConvertTo-Json -Compress'
  ]);
  assert.equal(r.observed,true);assert.equal(r.after,true);
});
for(const mode of ['invalid-setting','missing-helper','invalid-diagnostics']) {
  test('invalid PS5 selection fails before restore preparation: '+mode,()=>{
    const r=run([
      '$script:calls=0;$failure=$null',
      mode==='missing-helper'?'$bcContainerHelperConfig=$null':'$bcContainerHelperConfig=@{usePwshForBc24=$true}',
      'function Invoke-BcContainerSqlBackupRestoreCore { $script:calls++ }',
      "try { Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='database'}) -configuration ([pscustomobject]@{restoreUseWindowsPowerShell="+(mode==='invalid-setting'?"'true'":'$true')+(mode==='invalid-diagnostics'?";restoreDiagnostics='true'":'')+"}) }",
      'catch { $failure=@{expected=$_.Exception.Data["BcDevToolsetExpectedFailure"];message=$_.Exception.Message} }',
      '@{calls=$script:calls;failure=$failure}|ConvertTo-Json -Compress'
    ]);
    assert.equal(r.calls,0);assert.equal(r.failure.expected,true);
    assert.match(r.failure.message,/No restore preparation, service stop or SQL restoration was started/);
  });
}

for(const setting of ['$true','$null']) {
  test('multitenant restore retains helper selection even with PS5 enabled: '+setting,()=>{
    const r=run([
      '$bcContainerHelperConfig=@{usePwshForBc24=$true};$script:calls=0',
      'function Invoke-BcContainerSqlBackupRestoreCore { if(-not $bcContainerHelperConfig.usePwshForBc24){throw "Unexpected override"};$script:calls++ }',
      "Restore-BcContainerSqlBackupEntries -containerName selected -bakFolder unused -backupEntries @([pscustomobject]@{DatabaseRole='app'},[pscustomobject]@{DatabaseRole='tenant'}) -configuration ([pscustomobject]@{restoreUseWindowsPowerShell="+setting+"})",
      '@{calls=$script:calls;after=$bcContainerHelperConfig.usePwshForBc24}|ConvertTo-Json -Compress'
    ]);
    assert.equal(r.calls,1);assert.equal(r.after,true);
  });
}

test('published restore defaults agree with runtime defaults',()=>{
  const fs=require('node:fs');
  function find(value,key) {
    if(!value || typeof value!=='object') return undefined;
    if(Object.hasOwn(value,key)) return value[key];
    for(const child of Object.values(value)) {const result=find(child,key);if(result) return result;}
  }
  for(const file of ['package.json','schemas/bcdevtoolset-settings.schema.json']) {
    const metadata=JSON.parse(fs.readFileSync(resolveWithinRoot(extensionRoot,file),'utf8')); // nosemgrep -- fixed metadata names contained by the authorized extension root
    assert.equal(find(metadata,'restoreUseWindowsPowerShell').default,true);
    assert.equal(find(metadata,'restoreDiagnostics').default,false);
    assert.equal(find(metadata,'restoreInspectionMode').default,'Database');
  }
});
