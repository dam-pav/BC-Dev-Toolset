'use strict';
const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {ids,implicitApplicationId,zeroId,workflowFixture}=require('./fixtures/modern-restore.cjs');
const source=path.resolve(__dirname,'../../common/BackupMgt.ps1').replaceAll("'","''");
describe('Windows modern restore workflow', {skip:process.platform==='win32'?false:'Requires Windows local drive paths and Business Central administration; covered by AL compatibility Windows CI.'},()=>{
function run(options,expectedStatus=0) {
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',`
    $ErrorActionPreference='Stop';. '${source}'
    ${workflowFixture(options)}
  `],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,expectedStatus,result.stderr+'\n'+result.stdout);
  assert.equal(result.stderr,'');
  assert.doesNotMatch(result.stdout,/PRIVATE|password=secret|UNEXPECTED|Exception:|Line\s*\|/);
  const value=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(value.sql,options.entryPoint==='creation'?0:1);assert.equal(value.runtime,true);
  for(const sync of value.syncCalls) {
    assert.equal(sync.Mode,'Sync');assert.equal(sync.Force,true);assert.equal(sync.ExplicitForce,true);
    assert.equal(sync.Confirm,false);assert.equal(sync.ExplicitConfirm,true);
  }
  return value;
}
const writes=new Set(['publish','sync-app','install','app-upgrade','repair','restart','sync-tenant','tenant-upgrade']);
function orderedAppActions(events,stage,tenant) {
  const actions=events.filter(event=>event.Stage===stage && event.Tenant===tenant);
  const index=id=>actions.findIndex(action=>action.Id===id);
  for(const [before,after] of [[ids.system,ids.foundation],[ids.foundation,ids.base],[ids.base,ids.application],[ids.base,ids.extra]]) {
    if(index(before)>=0 && index(after)>=0) assert.ok(index(before)<index(after),JSON.stringify(actions));
  }
  return actions;
}
test('live progress is visible before a blocked serialized helper operation returns',async t=>{
  const script=`$ErrorActionPreference='Stop';. '${source}'\n${workflowFixture({mode:'serialized-progress-block-sync',captureMessages:false})}`;
  const child=spawn('pwsh',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='';let stderr='';let released=false;let timer;
  t.after(()=>{clearTimeout(timer);if(child.exitCode===null && !child.killed)child.kill()});
  const result=await new Promise((resolve,reject)=>{
    const fail=error=>{child.kill();reject(error)};
    timer=setTimeout(()=>fail(new Error('Live progress or the held mock step did not complete within 18 seconds')),18000);
    child.on('error',fail);
    child.stdout.on('data',chunk=>{
      stdout+=chunk.toString();
      if(!released && stdout.includes('BC_FIXTURE_SYNC_ENTERED')){
        try {
          const before=stdout.slice(0,stdout.indexOf('BC_FIXTURE_SYNC_ENTERED'));
          assert.match(before,/BC RESTORE START \[tenant synchronization\].*\[1\/1\].*tenant 'default'/);
          assert.doesNotMatch(stdout,/BC_FIXTURE_SYNC_RETURNED/);
          released=true;child.stdin.end('continue\n');
        }catch(error){fail(error)}
      }
    });
    child.stderr.on('data',chunk=>{stderr+=chunk.toString()});
    child.on('close',(code,signal)=>resolve({code,signal}));
  });
  assert.equal(result.code,0,stderr+'\n'+stdout);assert.equal(stderr,'');assert.equal(released,true);
  const returned=stdout.indexOf('BC_FIXTURE_SYNC_RETURNED');assert.ok(returned>=0);
  assert.match(stdout.slice(returned),/BC RESTORE COMPLETED \[tenant synchronization\].*elapsed \d+(?:[.,]\d+)?s/);
  assert.doesNotMatch(stdout,/PRIVATE|password=secret|UNEXPECTED|Exception:|Line\s*\|/);
  const value=JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(value.sql,1);assert.equal(value.runtime,true);assert.equal(value.admin,1);assert.equal(value.message,null);
});
for(const mode of ['upgrade','install','implicit-payroll-transitive']) {
  test(`${mode} reports bounded starts/completions for every applicable tenant and app stage`,()=>{
    const value=run({mode,multitenant:mode.includes('transitive')});
    const lines=value.messages.filter(line=>line.startsWith('BC RESTORE '));const text=lines.join('\n');
    const stages=['tenant assessment','media package validation','publication catalog lookup','package publication','tenant synchronization','app synchronization','app data upgrade','tenant verification'];
    if(mode==='install') stages.push('app installation');
    if(mode.includes('payroll')) stages.push('extension repair','service restart after extension repair');
    for(const stage of stages) for(const status of ['START','COMPLETED']) assert.ok(text.includes(`BC RESTORE ${status} [${stage}]`),text);
    for(const line of lines){
      const count=line.match(/\[(\d+)\/(\d+)\]/);assert.ok(count,line);
      assert.ok(Number(count[1])>=1 && Number(count[1])<=Number(count[2]),line);
      assert.match(line,/elapsed \d+(?:[.,]\d+)?s/);
      if(/\[(?:media package validation|publication catalog lookup|package publication|extension repair|app synchronization|app installation|app data upgrade)\]/.test(line)) {
        assert.match(line,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        assert.match(line,/\d+\.\d+\.\d+\.\d+/);
      }
    }
    assert.doesNotMatch(text,/BC RESTORE FAILED/);
    assert.doesNotMatch(value.messages.join('\n'),/platform\/media/i);
    assert.match(value.messages.join('\n'),/platform: 27\.0\.57239\.0/i);
  });
}
test('existing target publications are reported as reused without a publishing success claim',()=>{
  const value=run({mode:'progress-catalog-reuse'});
  const text=value.messages.join('\n');
  assert.equal(value.admin,1);assert.ok(!value.events.some(event=>event.Stage==='publish'));
  assert.match(text,/BC RESTORE COMPLETED \[publication catalog lookup\].*(?:already published|reuse)/i);
  assert.doesNotMatch(text,/BC RESTORE (?:START|COMPLETED) \[package publication\]/);
});
test('retained Payroll repair statuses do not invent a container media package version',()=>{
  const value=run({mode:'implicit-payroll'});
  const payroll=value.messages.filter(line=>line.includes('Payroll')).join('\n');
  assert.match(payroll,/retained|no (?:container )?media/i);assert.match(payroll,/1\.3\.0\.0/);
  assert.doesNotMatch(payroll,/container (?:media|package)(?: version)?:? '?1\.3\.0\.0/i);
  assert.match(payroll,/extension repair|Repair/i);
});
test('progress respects selected tenants and publishes shared media exactly once',()=>{
  const value=run({mode:'selected-scope',multitenant:true});const text=value.messages.join('\n');
  const publications=value.messages.filter(line=>line.includes('BC RESTORE START [package publication]'));
  assert.equal(publications.length,5);
  assert.match(text,/BC RESTORE START \[tenant assessment\].*tenant 'north'/);
  assert.doesNotMatch(text,/BC RESTORE START \[(?:tenant synchronization|app synchronization|app installation|app data upgrade)\].*tenant 'north'/);
});
for(const mode of ['sync-null-reference','publish-error','app-upgrade-error']) {
  test(`${mode} emits only authored failed progress and no later completion`,()=>{
    const value=run({mode},1);const lines=value.messages.filter(line=>line.startsWith('BC RESTORE '));
    const failed=lines.findIndex(line=>line.startsWith('BC RESTORE FAILED '));assert.ok(failed>=0,lines.join('\n'));
    assert.ok(!lines.slice(failed+1).some(line=>line.startsWith('BC RESTORE COMPLETED ')),lines.join('\n'));
    assert.doesNotMatch(lines.join('\n'),/PRIVATE|password=secret|backend|license|schema\/confirmation/);
    assert.equal(value.admin,0);
  });
}
for(const mode of ['sync-cap-force-missing','sync-cap-confirm-missing']) {
  test(`${mode} blocks before executor and any tenant/app writes`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);assert.match(value.stage,/preflight/i);
    assert.match(value.message,/Sync-NAVTenant/);assert.match(value.message,/command|parameter|capabilit/i);
    assert.deepEqual(value.syncCalls,[]);assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
    assert.ok(!value.runtimeCalls.some(call=>call.Boundary==='executor'));
  });
}
for(const [mode,kind,hresult] of [
  ['sync-null-reference','NullReference',-2147467261],
  ['serialized-sync-null-reference','NullReference',-2147467261],
  ['sync-wrapped-null-reference','NullReference',-2146233079],
  ['sync-unknown-null-hresult','Unknown',-2147467261],
  ['sync-wrapped-unknown-null-hresult','Unknown',-2146233079],
  ['sync-unknown-failure','Unknown',-2146233079]
]) {
  test(`${mode} reports typed failure and precise tenant-sync side effects without guessed causes`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.match(value.stage,/tenant.*sync|sync.*tenant/i);assert.ok(value.message.includes('Error code: '+hresult+'.'),value.message);
    assert.equal(value.syncCalls.length,1);assert.equal(value.events.filter(event=>event.Stage==='sync-tenant').length,1);
    assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)).map(event=>event.Stage),['sync-tenant']);
    assert.match(value.message,/tenant synchronization.*(?:partially|partial|uncertain)/i);
    assert.match(value.message,/(?:publication|publishing).*not.*started|not.*started.*(?:publication|publishing)/i);
    assert.match(value.message,/repair.*not.*started|not.*started.*repair/i);
    assert.match(value.message,/data upgrade.*not.*started|not.*started.*data upgrade/i);
    assert.match(value.message,/No automatic retry/);
    assert.doesNotMatch(value.message,/license|expired|unexpired|(?:schema|confirmation).*(?:caused|responsible|root cause)/i);
    if(kind==='NullReference') assert.match(value.message,/null[- ]?reference(?:Exception)?/i);
    else {assert.doesNotMatch(value.message,/null[- ]?reference/i);assert.match(value.message,/unknown|not (?:been )?established/i)}
  });
}
for(const mode of ['transport-unknown-failure-kind','transport-nonstring-failure-kind','transport-code-only-nullref','transport-invalid-marker-nullref','transport-success-failure-kind']) {
  test(`${mode} cannot establish a trusted NullReference cause or produce success`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.doesNotMatch(value.message,/null[- ]?reference/i);
    assert.ok(!value.events.some(event=>['publish','repair','sync-app','install','app-upgrade'].includes(event.Stage)));
    assert.match(value.message,/unknown|not (?:been )?established|verif/i);
    assert.match(value.message,/No automatic retry/);
    if(['transport-invalid-marker-nullref','transport-success-failure-kind'].includes(mode)) {
      assert.match(value.message,/unknown|may have partially completed/i);
      assert.doesNotMatch(value.message,/application writes were not started|publication.*not.*started|not.*started.*publication/i);
    }
  });
}
for(const mode of ['implicit-native','implicit-payroll','implicit-payroll-transitive']) {
  test(`${mode} wire metadata resolves Application identity and completes the real restore workflow`,()=>{
    const value=run({mode,multitenant:mode.includes('transitive')});
    assert.equal(value.message,null);assert.equal(value.admin,1);
    assert.ok(value.nativePackageReads>0);assert.ok(value.nativeInstalledReads>0);
    const upgrades=value.events.filter(event=>event.Stage==='app-upgrade');
    for(const tenant of mode.includes('transitive')?['north','south']:['default']) {
      const selected=upgrades.filter(event=>event.Tenant===tenant);
      const application=selected.find(event=>event.Name==='Application');assert.equal(application.Id,implicitApplicationId);
      assert.ok(selected.indexOf(application)<selected.findIndex(event=>event.Id===ids.extra));
    }
    assert.ok(!value.events.some(event=>writes.has(event.Stage) && [ids.application,zeroId].includes(event.Id)));
    const repairs=value.events.filter(event=>event.Stage==='repair');
    assert.equal(repairs.length,mode.includes('transitive')?2:mode.includes('payroll')?1:0);
    if(mode.includes('payroll')){assert.equal(repairs[0].Id,ids.partner);assert.equal(repairs[0].Name,'Payroll')}
    if(mode.includes('transitive')) assert.equal(repairs[1].Name,'Payroll Reporting');
  });
}
for(const mode of ['implicit-minimum-conflict','implicit-payroll-minimum-conflict']) {
  test(`${mode} is rejected from native metadata before any application writes`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.ok(value.nativePackageReads>0);assert.ok(value.nativeInstalledReads>0);
    assert.match(value.stage,/preflight/i);assert.match(value.message,/27\.14\.0\.0/);
    assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
  });
}
for(const mode of ['implicit-snapshot-minimum','implicit-snapshot-minimum-alias','implicit-snapshot-unknown-zero','implicit-snapshot-other-id']) {
  test(`${mode} cannot bypass raw dependency snapshot checks with resolved graph identities`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.match(value.stage,/preflight|publication/i);assert.match(value.message,/dependenc.*changed|dependenc.*drift/i);
    assert.ok(!value.events.some(event=>['publish','repair','sync-app','app-upgrade','install'].includes(event.Stage)));
    assert.match(value.message,/No automatic retry/);
  });
}

for(const tenantSelection of ['omitted','null','empty']) for(const multitenant of [false,true]) for(const mode of ['upgrade','aligned']) {
  test(`creation follow-up ${tenantSelection} tenant selection addresses all actual ${multitenant?'multiple tenants':'default tenant'} (${mode})`,()=>{
    // New-DockerContainer calls this public dispatcher after BcContainerHelper
    // has restored SQL. Its omitted TenantIds must retain the all-target meaning.
    const value=run({entryPoint:'creation',tenantSelection,multitenant,mode});
    assert.equal(value.message,null);assert.equal(value.admin,0);
    assert.ok(!value.events.some(event=>event.Stage==='sql'));
    for(const tenant of multitenant?['north','south']:['default']) {
      assert.ok(value.events.some(event=>event.Stage==='query' && event.Tenant===tenant));
      const upgrades=orderedAppActions(value.events,'app-upgrade',tenant);
      assert.equal(upgrades.length,mode==='upgrade'?5:0);
      if(mode==='upgrade') assert.ok(value.installed[tenant].every(app=>app.Version==='27.13.57301.0'));
    }
    if(mode==='aligned') {
      assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
      assert.ok(!value.runtimeCalls.some(call=>call.Boundary==='executor'));
    } else assert.equal(value.events.filter(event=>event.Stage==='publish').length,5);
    for(const call of value.runtimeCalls) {
      assert.equal(call.UsePwsh,true);assert.equal(call.UseSession,false);
      assert.equal(call.GlobalUsePwsh,true,'Creation follow-up must preserve its caller runtime setting');
    }
  });
}
for(const tenantSelection of ['blank','whitespace','unknown','mixed-null','mixed-blank']) {
  test(`creation follow-up rejects explicit ${tenantSelection} entries instead of treating them as all tenants`,()=>{
    const value=run({entryPoint:'creation',tenantSelection},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.match(value.stage,/tenant preflight/i);assert.match(value.message,/Inspect|Check/);
    assert.match(value.message,/SQL restore returned/);assert.match(value.message,/No automatic retry/);
    assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
    assert.ok(!value.runtimeCalls.some(call=>call.Boundary==='executor'));
  });
}

for(const major of [27,29]) for(const multitenant of [false,true]) {
  test(`BC${major} ${multitenant?'multi':'single'}tenant upgrades actual installed components through the complete restore wrapper`,()=>{
    const value=run({major,multitenant});
    assert.equal(value.message,null);assert.equal(value.admin,1);
    assert.ok(value.runtimeCalls.some(call=>call.Boundary==='discovery'));
    assert.ok(value.runtimeCalls.some(call=>call.Boundary==='executor'));
    for(const call of value.runtimeCalls) {
      assert.equal(call.UsePwsh,true);assert.equal(call.UseSession,false);
      assert.equal(call.ExplicitPwsh,true);assert.equal(call.ExplicitSession,true);
      assert.equal(call.GlobalUsePwsh,multitenant);
    }
    const tenants=multitenant?['north','south']:['default'];
    const firstWrite=value.events.findIndex(event=>writes.has(event.Stage));
    for(const tenant of tenants) assert.ok(value.events.slice(0,firstWrite).some(event=>event.Stage==='query' && event.Tenant===tenant),'All tenant preflights must precede every write');
    const publications=value.events.filter(event=>event.Stage==='publish');
    assert.equal(publications.length,5);assert.equal(new Set(publications.map(event=>event.Id)).size,5);
    for(const tenant of tenants) {
      assert.equal(orderedAppActions(value.events,'sync-app',tenant).length,5);
      assert.equal(orderedAppActions(value.events,'app-upgrade',tenant).length,5,'Old installed publications require explicit per-app version selection');
      const lastWrite=value.events.findLastIndex(event=>writes.has(event.Stage) && (!event.Tenant || event.Tenant===tenant));
      assert.ok(value.events.slice(lastWrite+1).some(event=>event.Stage==='query' && event.Tenant===tenant),'Actual installed state must be verified after writes');
    }
    assert.equal(value.events.at(-1).Stage,'admin');
    if(multitenant) for(const tenant of tenants) assert.ok(value.events.some(event=>event.Stage==='sync-tenant' && event.Tenant===tenant));
    assert.doesNotMatch(value.messages.join('\n'),/Database application version:/);
  });
}
for(const multitenant of [false,true]) {
  test(`aligned ${multitenant?'multi':'single'}tenant installed apps are verified without writes`,()=>{
    const value=run({mode:'aligned',multitenant});
    assert.equal(value.admin,1);assert.equal(value.message,null);
    assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
  });
}
test('missing Business Foundation is installed before upgrading its dependents',()=>{
  const value=run({mode:'install'});
  const installs=value.events.filter(event=>event.Stage==='install');
  assert.equal(installs.length,1);assert.equal(installs[0].Id,ids.foundation);
  assert.equal(value.events.filter(event=>event.Stage==='app-upgrade').length,4);
  assert.ok(value.events.findIndex(event=>event.Stage==='install' && event.Id===ids.foundation)<value.events.findIndex(event=>event.Stage==='app-upgrade' && event.Id===ids.base));
  assert.equal(value.admin,1);
});
for(const mode of ['runtime-parameters-missing','runtime-parameters-string','unexpected-discovery-runtime','unexpected-executor-runtime']) {
  test(`${mode} stops without invoking another runtime or retrying SQL`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.ok(!value.events.some(event=>writes.has(event.Stage)));
    assert.match(value.message,/runtime|PowerShell|fresh|Core/i);
    assert.match(value.message,/SQL restore (?:may already have )?returned/);assert.match(value.message,/No automatic retry/);
    if(mode.startsWith('runtime-parameters')) assert.equal(value.runtimeCalls.length,0);
    if(mode==='unexpected-discovery-runtime') {
      assert.equal(value.runtimeCalls.length,1);
      assert.ok(!value.events.some(event=>event.Stage==='query'));
    }
    if(mode==='unexpected-executor-runtime') assert.equal(value.runtimeCalls.filter(call=>call.Boundary==='executor').length,1);
  });
}
test('a single tenant with synchronization pending is synchronized before publication',()=>{
  const value=run({mode:'sync-pending'});
  const sync=value.events.findIndex(event=>event.Stage==='sync-tenant');
  const publish=value.events.findIndex(event=>event.Stage==='publish');
  assert.ok(sync>=0 && sync<publish);assert.equal(value.admin,1);
});
test('coherent unequal target component versions flow unchanged into each command',()=>{
  const value=run({mode:'unequal-components'});
  const upgrades=value.events.filter(event=>event.Stage==='app-upgrade');
  assert.equal(new Set(upgrades.map(event=>event.Version)).size,5);assert.equal(value.admin,1);
});
test('distinct app GUIDs with identical selection tuples are mutated by their actual GUID',()=>{
  const value=run({mode:'duplicate-identity-tuple'});
  const upgrades=value.events.filter(event=>event.Stage==='app-upgrade');
  assert.equal(upgrades.length,6);assert.equal(new Set(upgrades.map(event=>event.Id)).size,6);
  assert.equal(value.admin,1);
});
test('unchanged custom dependents are repaired once after shared publication and before synchronization',()=>{
  const value=run({mode:'repair',multitenant:true});
  const repair=value.events.filter(event=>event.Stage==='repair');
  assert.equal(repair.length,1);assert.equal(repair[0].Id,ids.partner);assert.equal(repair[0].Version,'1.0.0.0');
  const repairIndex=value.events.findIndex(event=>event.Stage==='repair');
  assert.ok(repairIndex>value.events.findLastIndex(event=>event.Stage==='publish'));
  assert.ok(repairIndex<value.events.findIndex(event=>event.Stage==='sync-app'));
  const restartIndex=value.events.findIndex(event=>event.Stage==='restart');
  assert.ok(restartIndex>repairIndex && restartIndex<value.events.findIndex(event=>event.Stage==='sync-app'));
  assert.equal(value.admin,1);
});
test('explicit tenant selection preflights all mounts and upgrades only the selected default tenant',()=>{
  const value=run({mode:'selected-scope',multitenant:true});
  assert.deepEqual(value.adminTenants,['default']);
  const firstWrite=value.events.findIndex(event=>writes.has(event.Stage));
  for(const tenant of ['default','north']) assert.ok(value.events.slice(0,firstWrite).some(event=>event.Stage==='query' && event.Tenant===tenant));
  assert.ok(!value.events.some(event=>writes.has(event.Stage) && event.Tenant==='north'));
  assert.equal(value.events.filter(event=>event.Stage==='app-upgrade' && event.Tenant==='default').length,5);
  assert.ok(value.installed.north.every(app=>app.Version==='27.0.38460.40242'));
});
for(const mode of ['selected-scope-conflict','selected-scope-repair']) {
  test(`${mode} blocks shared writes before changing an unselected tenant`,()=>{
    const value=run({mode,multitenant:true},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
    assert.match(value.stage,/preflight/i);
  });
}
test('post-upgrade unselected tenant snapshot drift fails before administrator repair',()=>{
  const value=run({mode:'selected-scope-unselected-mutated',multitenant:true},1);
  assert.equal(value.expected,true);assert.equal(value.admin,0);assert.match(value.stage,/verif/i);
  assert.ok(!value.events.some(event=>writes.has(event.Stage) && event.Tenant==='north'));
  assert.match(value.message,/unselected|tenant|snapshot/i);
});
test('an unselected mounted tenant with synchronization pending blocks execution before selected tenant writes',()=>{
  const value=run({mode:'selected-scope-unselected-pending',multitenant:true},1);
  assert.equal(value.expected,true);assert.equal(value.admin,0);
  assert.match(value.stage,/preflight/i);
  assert.match(value.message,/unselected/i);assert.match(value.message,/Operational|synchronization|state/i);
  assert.match(value.message,/Inspect|Check|Reconcile|Select/);
  assert.match(value.message,/SQL restore returned/);assert.match(value.message,/No automatic retry/);
  assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
  assert.ok(!value.runtimeCalls.some(call=>call.Boundary==='executor'));
  assert.ok(value.installed.north.every(app=>app.Version==='27.0.38460.40242'));
});

for(const mode of ['second-tenant-blocked','tenant-not-ready','no-appdb-write','missing-installed-marker']) {
  test(`${mode} blocks every app write before upgrading the first tenant`,()=>{
    const value=run({mode,multitenant:true},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.deepEqual(value.events.filter(event=>writes.has(event.Stage)),[]);
    assert.match(value.message,/SQL restore returned/);assert.match(value.message,/Inspect|Check/);
    assert.match(value.message,/No automatic retry/);
  });
}
const failureStages={
  publish:/publish|publication/i,
  'sync-app':/sync/i,
  'app-upgrade':/upgrade/i,
  install:/install/i,
  'sync-tenant':/tenant.*sync|sync.*tenant/i,
  repair:/repair/i,
  restart:/restart/i,
  query:/discover/i
};
for(const [stage,pattern] of Object.entries(failureStages)) for(const failure of ['throw','error']) {
  test(`modern ${stage} ${failure} preserves stage/status and stops dependent work`,()=>{
    const mode=stage+'-'+failure;
    const value=run({mode,multitenant:['sync-tenant','repair','restart'].includes(stage)},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.match(value.stage,pattern);
    assert.ok(value.message.includes('Error code: '+(failure==='throw'?'-2146233079':'-2146233087')+'.'),value.message);
    assert.match(value.message,/SQL restore returned/);
    assert.match(value.message,/Inspect|Check/);
    assert.match(value.message,/No automatic retry/);
    const failingStage=stage==='query'?'query':stage;
    const attempts=value.events.filter(event=>event.Stage===failingStage);
    assert.equal(attempts.length,1,'Failed mutation/read must not be silently retried');
    if(stage==='publish') assert.ok(!value.events.some(event=>['sync-app','app-upgrade','install'].includes(event.Stage)));
    if(stage==='sync-app') assert.ok(!value.events.some(event=>['app-upgrade','install'].includes(event.Stage)));
    if(stage==='sync-tenant') assert.ok(!value.events.some(event=>['publish','repair','sync-app','app-upgrade','install'].includes(event.Stage)));
  });
}
test('post-upgrade metadata mismatch fails before administrator repair',()=>{
  const value=run({mode:'verify-mismatch'},1);
  assert.equal(value.expected,true);assert.equal(value.admin,0);
  assert.ok(value.events.some(event=>event.Stage==='app-upgrade'));
  assert.match(value.message,/verif|align|match/i);assert.match(value.message,/SQL restore returned/);
  assert.match(value.message,/No automatic retry/);
});
for(const mode of ['package-version-changed','package-dependencies-changed']) {
  test(`${mode} after assessment stops publication before the first package write`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.ok(!value.events.some(event=>['publish','repair','sync-app','app-upgrade','install'].includes(event.Stage)));
    assert.match(value.stage,/preflight|publication/i);
    assert.match(value.message,/SQL restore returned/);assert.match(value.message,/No automatic retry/);
    assert.match(value.message,mode==='package-version-changed'?/identity.*changed|media.*changed/i:/dependenc.*changed|dependenc.*drift/i);
  });
}
for(const [mode,cause] of Object.entries({
  'unsafe-planned-path':/unsafe.*media.*path|media.*path.*unsafe|outside.*Applications/i,
  'linked-media':/link|reparse/i,
  'ambiguous-publication':/ambiguous.*publication|publication.*ambiguous|multiple target publications for one app identity/i,
  'conflicting-publication':/conflict.*publication|publication.*conflict|catalog.*identity/i
})) {
  test(`actual ${mode} guard retains its reviewed cause and failed status`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.match(value.stage,/preflight|publication/i);assert.match(value.message,cause);
    assert.match(value.message,/Error code: -?\d+/);assert.match(value.message,/Inspect|Check|Reconcile/);
    assert.match(value.message,/SQL restore returned/);assert.match(value.message,/No automatic retry/);
    assert.match(value.message,/application writes were not started/);
    assert.ok(!value.events.some(event=>['publish','repair','sync-app','app-upgrade','install'].includes(event.Stage)));
  });
}
for(const mode of ['transport-string-marker','transport-error-code','transport-invalid-write-state','transport-missing-result','transport-extra-record']) {
  test(`${mode} cannot produce success or administrator repair despite aligned forged post-state`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.match(value.stage,/modern.*result.*verif|modern.*transport/i);
    assert.match(value.message,/SQL restore returned/);assert.match(value.message,/No automatic retry/);
    const receipt=value.events.findIndex(event=>event.Stage==='transport-result');assert.ok(receipt>=0);
    assert.ok(!value.events.slice(receipt+1).some(event=>event.Stage==='query'),'Malformed completion must stop before post-state reads');
  });
}
for(const mode of ['transport-unknown-reason','transport-nonstring-reason']) {
  test(`${mode} never promotes unreviewed transport metadata to a trusted cause`,()=>{
    const value=run({mode},1);
    assert.equal(value.expected,true);assert.equal(value.admin,0);
    assert.match(value.message,/unknown|not (?:been )?established|unverified|could not.*verif/i);
    assert.doesNotMatch(value.message,/unsafe.*media.*path|media.*path.*unsafe|outside.*Applications/i);
    assert.ok(!value.events.some(event=>['publish','repair','sync-app','app-upgrade','install'].includes(event.Stage)));
  });
}
test('modern plan/context/arguments and results survive PowerShell serialization transport',()=>{
  const value=run({mode:'serialized-upgrade',multitenant:true});
  assert.equal(value.admin,1);assert.equal(value.message,null);
  for(const tenant of ['north','south']) assert.equal(value.events.filter(event=>event.Stage==='app-upgrade' && event.Tenant===tenant).length,5);
});
test('serialized remote nonterminating failure retains reviewed stage/status and stops admin',()=>{
  const value=run({mode:'serialized-publish-error',multitenant:true},1);
  assert.equal(value.expected,true);assert.equal(value.admin,0);
  assert.match(value.stage,/publication/i);assert.match(value.message,/Error code: -?\d+/);
  assert.equal(value.events.filter(event=>event.Stage==='publish').length,1);
});

});
