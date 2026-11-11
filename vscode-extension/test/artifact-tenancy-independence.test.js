'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('missing/Cloud/OnPrem app target selects artifacts independently of explicit container tenancy',()=>{
  const source=path.resolve(__dirname,'../../common/WorkspaceMgt.ps1').replace(/'/g,"''");
  const code=[
    "$ErrorActionPreference='Stop'; . '"+source+"'",
    "foreach($target in @('','Cloud','OnPrem')) { foreach($tenancy in @($false,$true)) {",
    "$app=[pscustomobject]@{application='23.0.0.0'}; if($target){$app|Add-Member target $target}",
    "$configuration=[pscustomobject]@{name='Local';serverType='Container';container='test';multitenant=$tenancy}",
    "$expected=if($target -eq 'OnPrem'){'OnPrem'}else{'Sandbox'}",
    "if((Get-AppArtifactType -appJSON $app) -ne $expected){throw 'Artifact selection depended on tenancy'}",
    "if((Resolve-ContainerMultitenantMode -configuration $configuration -backupEntries @()) -ne $tenancy){throw 'Explicit tenancy was not preserved'}",
    '}}'
  ].join('\n');
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stderr);
});
