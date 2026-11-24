'use strict';
const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ids,state,implicitApplicationState,implicitApplicationId,zeroId,nativeDependencyDtoScript}=require('./fixtures/modern-restore.cjs');
const source=path.resolve(__dirname,'../../common/BackupMgt.ps1').replaceAll("'","''");
describe('Windows modern restore assessment', {skip:process.platform==='win32'?false:'Requires Windows local drive paths and Business Central administration; covered by AL compatibility Windows CI.'},()=>{
function assess(value,{nativeDependencies=false,versionAlias=false}={}) {
  const data=JSON.stringify(value).replaceAll("'","''");
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',`
    $ErrorActionPreference='Stop';. '${source}'
    . (Join-Path (Split-Path '${source}') 'ModernRestoreUpgrade.ps1')
    $state=ConvertFrom-Json '${data}'
    ${nativeDependencies?nativeDependencyDtoScript:''}
    ${nativeDependencies?`
      foreach($app in @($state.PackageApps)+@($state.InstalledApps)){
        $app.Dependencies=@(Convert-FixtureNativeDependencies $app.Dependencies -VersionAlias:$${versionAlias})
        foreach($dependency in $app.Dependencies){if($dependency.AppId -isnot [Guid] -or $dependency.MinVersion -isnot [Version]){throw 'UNEXPECTED DEPENDENCY DTO'}}
      }
    `:''}
    Get-BcModernSystemApplicationUpgradeAssessment -State $state|ConvertTo-Json -Depth 30 -Compress
  `],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.equal(result.stderr,'');
  return JSON.parse(result.stdout.trim());
}
test('native implicit Application dependencies resolve the unique metadata GUID and preserve dependency order',()=>{
  const input=implicitApplicationState();
  const result=assess(input,{nativeDependencies:true});
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  const application=result.Actions.find(app=>app.Name==='Application');
  assert.equal(application.Id,implicitApplicationId);assert.notEqual(application.Id,ids.application);
  const satellite=result.Actions.find(app=>app.Id===ids.extra);
  assert.ok(satellite.Dependencies.includes(implicitApplicationId));assert.ok(!satellite.Dependencies.includes(zeroId));
  assert.ok(result.Actions.indexOf(application)<result.Actions.indexOf(satellite));
});
test('native dependencies exposing matching MinVersion and Version properties remain viable',()=>{
  const result=assess(implicitApplicationState(),{nativeDependencies:true,versionAlias:true});
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  assert.ok(result.Actions.find(app=>app.Id===ids.extra).Dependencies.includes(implicitApplicationId));
});
test('installed native Payroll Application reference schedules Payroll and its transitive dependent for Repair',()=>{
  const result=assess(implicitApplicationState({payroll:true,transitive:true}),{nativeDependencies:true});
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  const payroll=result.Actions.find(app=>app.Id===ids.partner);
  const reporting=result.Actions.find(app=>app.Id==='00000000-0000-0000-0000-000000000007');
  assert.equal(payroll.Action,'Repair');assert.ok(payroll.Dependencies.includes(implicitApplicationId));
  assert.equal(reporting.Action,'Repair');assert.ok(result.Actions.indexOf(payroll)<result.Actions.indexOf(reporting));
});
for(const mode of ['wrong-name','wrong-publisher','missing-identity','missing-application','ambiguous-application','duplicate-application','above-minimum','cycle']) {
  test(`implicit Application normalization rejects ${mode} instead of guessing an identity`,()=>{
    const input=implicitApplicationState();const dependency=input.PackageApps.find(app=>app.Id===ids.extra).Dependencies[0];
    if(mode==='wrong-name') dependency.Name='Other application';
    if(mode==='wrong-publisher') dependency.Publisher='Other publisher';
    if(mode==='missing-identity') delete dependency.AppId;
    if(mode==='missing-application') input.PackageApps=input.PackageApps.filter(app=>app.Id!==implicitApplicationId);
    if(mode==='ambiguous-application') input.PackageApps.push({...input.PackageApps.find(app=>app.Id===implicitApplicationId),Id:'00000000-0000-0000-0000-000000000099'});
    if(mode==='duplicate-application') input.PackageApps.push({...input.PackageApps.find(app=>app.Id===implicitApplicationId)});
    if(mode==='above-minimum') dependency.MinVersion='27.14.0.0';
    if(mode==='cycle') input.PackageApps.find(app=>app.Id===ids.system).Dependencies=[{AppId:zeroId,Name:'Application',Publisher:'Microsoft',MinVersion:'27.13.0.0'}];
    const result=assess(input,{nativeDependencies:mode!=='missing-identity'});
    assert.equal(result.Outcome,'Blocked',JSON.stringify(result));assert.deepEqual(result.Actions,[]);
    assert.ok(result.Reasons.length>0);
  });
}
for(const [label,minimum] of [['unsatisfied','27.14.0.0'],['invalid','PRIVATE invalid minimum password=secret'],['empty',''],['null',null]]) {
  test(`authoritative ${label} MinVersion cannot be masked by a lower Version alias`,()=>{
    const input=implicitApplicationState();const dependency=input.PackageApps.find(app=>app.Id===ids.extra).Dependencies[0];
    dependency.MinVersion=minimum;dependency.Version='27.0.0.0';
    const result=assess(input,{nativeDependencies:minimum==='27.14.0.0',versionAlias:true});
    assert.equal(result.Outcome,'Blocked',JSON.stringify(result));assert.deepEqual(result.Actions,[]);
    assert.doesNotMatch(result.Reasons.join('\n'),/PRIVATE|password=secret/);
  });
}

test('Version-only normalized dependency records remain supported when MinVersion is absent',()=>{
  const input=implicitApplicationState();
  for(const app of [...input.PackageApps,...input.InstalledApps]) for(const dependency of app.Dependencies){dependency.Version=dependency.MinVersion;delete dependency.MinVersion}
  const result=assess(input);assert.equal(result.Outcome,'Viable',JSON.stringify(result));
});
test('repeated dependency failures are deduplicated while distinct minimum requirements remain visible',()=>{
  const input=implicitApplicationState();const satellite=input.PackageApps.find(app=>app.Id===ids.extra);
  const first={AppId:zeroId,Name:'Application',Publisher:'Microsoft',MinVersion:'27.14.0.0'};
  const second={...first,MinVersion:'27.15.0.0'};
  satellite.Dependencies=[...Array.from({length:50},()=>({...first})),second];
  const result=assess(input,{nativeDependencies:true});
  assert.equal(result.Outcome,'Blocked',JSON.stringify(result));
  assert.equal(result.Reasons.length,new Set(result.Reasons).size);
  assert.equal(result.Reasons.length,2,result.Reasons.join('\n'));
  assert.ok(result.Reasons.some(reason=>reason.includes('27.14.0.0')));
  assert.ok(result.Reasons.some(reason=>reason.includes('27.15.0.0')));
});
test('deduplication preserves distinct installed Payroll minimum requirements',()=>{
  const input=implicitApplicationState({payroll:true});const payroll=input.InstalledApps.find(app=>app.Id===ids.partner);
  const first={AppId:zeroId,Name:'Application',Publisher:'Microsoft',MinVersion:'27.14.0.0'};
  payroll.Dependencies=[...Array.from({length:50},()=>({...first})),{...first,MinVersion:'27.15.0.0'}];
  const result=assess(input,{nativeDependencies:true});
  assert.equal(result.Outcome,'Blocked',JSON.stringify(result));assert.deepEqual(result.Actions,[]);
  assert.equal(result.Reasons.length,2,result.Reasons.join('\n'));
  assert.ok(result.Reasons.some(reason=>reason.includes('27.14.0.0')));
  assert.ok(result.Reasons.some(reason=>reason.includes('27.15.0.0')));
});
function dependencyOrder(actions) {
  const index=id=>actions.findIndex(action=>String(action.Id).toLowerCase()===id);
  for(const [before,after] of [[ids.system,ids.foundation],[ids.foundation,ids.base],[ids.base,ids.application],[ids.base,ids.extra]]) {
    assert.ok(index(before)>=0 && index(before)<index(after),JSON.stringify(actions));
  }
}
for(const major of [27,28,31]) {
  test(`modern BC${major} forward component split is viable without DatabaseApplicationVersion`,()=>{
    const input=state(major);
    const result=assess(input);
    assert.equal(result.Outcome,'Viable',JSON.stringify(result));
    assert.equal(result.Actions.length,5);
    dependencyOrder(result.Actions);
    for(const action of result.Actions) {
      assert.equal(action.Action,'Upgrade');
      assert.equal(action.InstalledVersion,major+'.0.38460.40242');
      assert.equal(action.Version,major+'.13.57301.0');
    }
  });
  test(`aligned BC${major} components require no application writes`,()=>{
    const result=assess(state(major,true));
    assert.equal(result.Outcome,'Aligned',JSON.stringify(result));
    assert.deepEqual(result.Actions,[]);
  });
}
test('coherent unequal component target versions are valid',()=>{
  const input=state();
  input.PackageApps.forEach((app,index)=>{app.Version='27.'+(8+index)+'.57301.0'});
  for(const app of input.PackageApps) for(const dependency of app.Dependencies) dependency.MinVersion=input.PackageApps.find(item=>item.Id===dependency.AppId).Version;
  const result=assess(input);
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));dependencyOrder(result.Actions);
});
test('Microsoft satellite versions are independent of the Business Central major',()=>{
  const input=state();
  input.InstalledApps.find(app=>app.Id===ids.extra).Version='1.2.0.0';
  input.PackageApps.find(app=>app.Id===ids.extra).Version='2.0.0.0';
  const result=assess(input);
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  const action=result.Actions.find(app=>app.Id===ids.extra);
  assert.equal(action.InstalledVersion,'1.2.0.0');assert.equal(action.Version,'2.0.0.0');
});
test('a required Business Foundation absent from the tenant is installed before Base Application',()=>{
  const input=state();input.InstalledApps=input.InstalledApps.filter(app=>app.Id!==ids.foundation);
  const result=assess(input);
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  assert.equal(result.Actions.find(app=>app.Id===ids.foundation).Action,'Install');dependencyOrder(result.Actions);
});
test('published but uninstalled packages do not replace affirmative installed metadata',()=>{
  const input=state();input.InstalledApps.push({...input.InstalledApps[0],Version:'27.99.99999.0',IsInstalled:false});
  const result=assess(input);
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  assert.equal(result.Actions.find(app=>app.Id===ids.system).InstalledVersion,'27.0.38460.40242');
});
test('an actual installed thirdparty prerequisite can satisfy a target dependency without being upgraded',()=>{
  const input=state();
  input.InstalledApps.push({Id:ids.partner,Name:'Partner prerequisite',Publisher:'Partner',Version:'1.2.0.0',IsInstalled:true,Dependencies:[]});
  input.PackageApps[0].Dependencies.push({AppId:ids.partner,Name:'Partner prerequisite',Publisher:'Partner',MinVersion:'1.0.0.0'});
  const result=assess(input);
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  assert.ok(!result.Actions.some(action=>action.Id===ids.partner));
});
const mutations={
  downgrade:value=>{value.InstalledApps[0].Version='27.99.99999.0'},
  'cross-major-installed':value=>{value.InstalledApps[0].Version='26.0.0.0'},
  'cross-major-package':value=>{value.PackageApps[0].Version='28.0.0.0'},
  'missing-core-installed':value=>{value.InstalledApps=value.InstalledApps.filter(app=>app.Id!==ids.base)},
  'missing-core-package':value=>{value.PackageApps=value.PackageApps.filter(app=>app.Id!==ids.application)},
  'missing-affected-component-package':value=>{value.PackageApps=value.PackageApps.filter(app=>app.Id!==ids.extra)},
  'duplicate-installed':value=>{value.InstalledApps.push({...value.InstalledApps[0]})},
  'duplicate-package':value=>{value.PackageApps.push({...value.PackageApps[0]})},
  'invalid-installed-version':value=>{value.InstalledApps[0].Version='PRIVATE invalid password=secret'},
  'invalid-package-version':value=>{value.PackageApps[0].Version='PRIVATE invalid password=secret'},
  'missing-installation-marker':value=>{delete value.InstalledApps[0].IsInstalled},
  'invalid-installation-marker':value=>{value.InstalledApps[0].IsInstalled='true'},
  'published-only-core':value=>{value.InstalledApps[0].IsInstalled=false},
  'invalid-app-id':value=>{value.PackageApps[0].Id='PRIVATE invalid password=secret'},
  'app-id-conflict':value=>{value.PackageApps[0].Id='00000000-0000-0000-0000-000000000099'},
  'publisher-conflict':value=>{value.PackageApps[0].Publisher='Untrusted publisher'},
  'missing-dependency':value=>{value.PackageApps[0].Dependencies.push({AppId:ids.partner,Name:'Missing prerequisite',Publisher:'Partner',MinVersion:'1.0.0.0'})},
  'unsatisfied-dependency-version':value=>{value.PackageApps[1].Dependencies[0].MinVersion='27.99.0.0'},
  'invalid-dependency-version':value=>{value.PackageApps[1].Dependencies[0].MinVersion='PRIVATE invalid password=secret'},
  'dependency-cycle':value=>{value.PackageApps[0].Dependencies.push({AppId:ids.base,Name:'Base Application',Publisher:'Microsoft',MinVersion:'27.13.57301.0'})},
  'missing-publish-capability':value=>{delete value.Capabilities['Publish-NAVApp']},
  'missing-readiness-sync-capability':value=>{delete value.Capabilities['Sync-NAVTenant']},
  'missing-unattended-tenant-force-parameter':value=>{value.Capabilities['Sync-NAVTenant']=value.Capabilities['Sync-NAVTenant'].filter(parameter=>parameter!=='Force')},
  'missing-unattended-tenant-confirm-parameter':value=>{value.Capabilities['Sync-NAVTenant']=value.Capabilities['Sync-NAVTenant'].filter(parameter=>parameter!=='Confirm')},
  'missing-additive-sync-mode-parameter':value=>{value.Capabilities['Sync-NAVApp']=value.Capabilities['Sync-NAVApp'].filter(parameter=>parameter!=='Mode')},
  'missing-install-capability':value=>{value.InstalledApps=value.InstalledApps.filter(app=>app.Id!==ids.foundation);delete value.Capabilities['Install-NAVApp']},
  'missing-upgrade-parameter':value=>{value.Capabilities['Start-NAVAppDataUpgrade']=value.Capabilities['Start-NAVAppDataUpgrade'].filter(parameter=>parameter!=='Version')},
  'missing-appid-upgrade-parameter':value=>{value.Capabilities['Start-NAVAppDataUpgrade']=value.Capabilities['Start-NAVAppDataUpgrade'].filter(parameter=>parameter!=='AppId')},
  'tenant-not-operational':value=>{value.TenantState='OperationalWithSyncFailure'},
  'multitenant-appdb-write-disabled':value=>{value.Multitenant=true;value.AllowAppDatabaseWrite=false},
  'thirdparty-dependent-without-repair-capability':value=>{value.InstalledApps.push({Id:ids.partner,Name:'Partner app',Publisher:'Partner',Version:'1.0.0.0',IsInstalled:true,Dependencies:[{AppId:ids.base,Name:'Base Application',Publisher:'Microsoft',MinVersion:'27.0.0.0'}]});delete value.Capabilities['Repair-NAVApp']},
  'runtime-thirdparty-dependent':value=>{value.InstalledApps.push({Id:ids.partner,Name:'Partner app',Publisher:'Partner',Version:'1.0.0.0',IsInstalled:true,IsRuntimePackage:true,Dependencies:[{AppId:ids.base,Name:'Base Application',Publisher:'Microsoft',MinVersion:'27.0.0.0'}]})}
};
for(const [name,mutate] of Object.entries(mutations)) {
  test(`modern assessment blocks ${name} before producing executable actions`,()=>{
    const input=state();mutate(input);const result=assess(input);
    assert.equal(result.Outcome,'Blocked',JSON.stringify(result));
    assert.ok(result.Reasons.length>0,JSON.stringify(result));
    assert.doesNotMatch(result.Reasons.join('\n'),/PRIVATE|password=secret/);
    assert.deepEqual(result.Actions,[]);
  });
}
test('unchanged thirdparty dependent has an explicit supported Repair action',()=>{
  const input=state();input.InstalledApps.push({Id:ids.partner,Name:'Partner app',Publisher:'Partner',Version:'1.0.0.0',IsInstalled:true,Dependencies:[{AppId:ids.base,Name:'Base Application',Publisher:'Microsoft',MinVersion:'27.0.0.0'}]});
  const result=assess(input);
  assert.equal(result.Outcome,'Viable',JSON.stringify(result));
  const action=result.Actions.find(app=>app.Id===ids.partner);
  assert.equal(action.Action,'Repair');assert.equal(action.Version,'1.0.0.0');
  assert.equal(action.Path,'');
  assert.equal(action.InstalledVersion,'1.0.0.0');assert.equal(action.PackageVersion,null);
  assert.equal(action.PackagePath,'');
});
for(const mode of ['invalid-id','wrong-name','wrong-publisher','invalid-minimum','missing-dependency','unsatisfied-minimum','cycle']) {
  test(`custom dependency ${mode} cannot be waived by Repair-NAVApp capability`,()=>{
    const input=state();
    const partner={Id:ids.partner,Name:'Partner app',Publisher:'Partner',Version:'1.0.0.0',IsInstalled:true,Dependencies:[{AppId:ids.base,Name:'Base Application',Publisher:'Microsoft',MinVersion:'27.0.0.0'}]};
    input.InstalledApps.push(partner);
    const dependency=partner.Dependencies[0];
    if(mode==='invalid-id') dependency.AppId='PRIVATE bad GUID password=secret';
    if(mode==='wrong-name') dependency.Name='Other Base';
    if(mode==='wrong-publisher') dependency.Publisher='Other Publisher';
    if(mode==='invalid-minimum') dependency.MinVersion='PRIVATE invalid minimum password=secret';
    if(mode==='missing-dependency') dependency.AppId='00000000-0000-0000-0000-000000000099';
    if(mode==='unsatisfied-minimum') dependency.MinVersion='27.99.99999.0';
    if(mode==='cycle') {
      const second={Id:'00000000-0000-0000-0000-000000000007',Name:'Second partner app',Publisher:'Partner',Version:'1.0.0.0',IsInstalled:true,Dependencies:[{AppId:ids.partner,Name:partner.Name,Publisher:'Partner',MinVersion:'1.0.0.0'}]};
      partner.Dependencies.push({AppId:second.Id,Name:second.Name,Publisher:'Partner',MinVersion:'1.0.0.0'});input.InstalledApps.push(second);
    }
    const result=assess(input);
    assert.equal(result.Outcome,'Blocked',JSON.stringify(result));assert.deepEqual(result.Actions,[]);
    assert.doesNotMatch(result.Reasons.join('\n'),/PRIVATE|password=secret/);
  });
}

});
