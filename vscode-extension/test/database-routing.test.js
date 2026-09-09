const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const root=path.resolve(__dirname,'../..');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
function run(script) {
  const result=spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',`. ${quote(path.join(root,'common/WorkspaceMgt.ps1'))}; $ErrorActionPreference='Stop'; $env:BCDEVTOOLSET_MCP_SESSION_ID='agent'; ${script}`],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr || result.stdout);return JSON.parse(result.stdout);
}
test('explicit SQL mapping skips BC discovery including multitenant database selection',()=>{
  const result=run(`
    $script:requests=@(); $script:hostName=''; $script:instance=''
    function Import-BcServiceBackupDiscoveryModules { throw 'Unexpected BC import' }
    function Get-BcServiceDatabaseInfo { throw 'Unexpected BC discovery' }
    function Select-BcServiceSqlBackupConfigurations { @{Source=[pscustomobject]@{name='source';serverType='OnPrem';serverInstance='BC230';databaseServerHost='SQLHOST';databaseInstance='NAMED';databaseName='App';databaseTenants=@([pscustomobject]@{id='one';databaseName='Tenant DB'})};Destination=[pscustomobject]@{name='local';sqlBackupPath='C:\\exports'}} }
    function New-Item {}
    function Test-IsLocalSqlServer {$false}
    function Backup-RemoteSqlDatabases { param($computerName,$databaseInstance,$backupRequests) $script:requests=$backupRequests;$script:hostName=$computerName;$script:instance=$databaseInstance }
    Export-BcServiceSqlBackupSet -scriptPath 'C:\\toolset' -settingsJSON ([pscustomobject]@{}) 6>$null
    @{Host=$script:hostName;Instance=$script:instance;Files=@($script:requests.FileName);Databases=@($script:requests.DatabaseName)} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result,{Host:'SQLHOST',Instance:'NAMED',Files:['App.app.bak','one.tenant.bak'],Databases:['App','Tenant DB']});
});
test('incomplete or invalid explicit mappings fail without BC fallback',()=>{
  for(const config of [
    {databaseServerHost:'SQLHOST'},
    {databaseServerHost:'SQLHOST',databaseName:'App',databaseTenants:[]},
    {databaseServerHost:'SQLHOST',databaseName:'App',databaseTenants:[{id:'one',databaseName:'A'},{id:'one',databaseName:'B'}]},
    {databaseServerHost:'https://SQLHOST',databaseName:'App'}
  ]) {
    const result=run(`
      $c=${quote(JSON.stringify(config))} | ConvertFrom-Json
      try { $null=Get-BcConfiguredDatabaseInfo -configuration $c; throw 'Unexpected success' } catch { @{Error=$_.Exception.Message} | ConvertTo-Json -Compress }
    `);
    assert.match(result.Error,/databaseName is required|non-empty array|unique id|hostname or IP/);
  }
});
test('successful discovery saves full mapping and the next backup bypasses BC',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bcdev-db-route-'));
  const file=path.join(folder,'settings.json');
  fs.writeFileSync(file,JSON.stringify({configurations:[{name:'source',serverType:'OnPrem',server:'https://bc',serverInstance:'BC230'},{name:'untouched',serverType:'OnPrem',server:'https://other',serverInstance:'BC240'}]}));
  try {
    const result=run(`
      Initialize-CredentialConfigurationContext -projectRoot ${quote(folder)} -settingsFiles @(${quote(file)})
      $script:source=(Get-Content -LiteralPath ${quote(file)} -Raw | ConvertFrom-Json).configurations[0]
      $script:discovery=0;$script:backups=0
      function Import-BcServiceBackupDiscoveryModules {}
      function Select-BcServiceSqlBackupConfigurations { @{Source=$script:source;Destination=[pscustomobject]@{name='local';sqlBackupPath='C:\\exports'}} }
      function Get-BcServiceDatabaseInfo { $script:discovery++; [pscustomobject]@{DatabaseServer='SQLHOST';DatabaseInstance='NAMED';DatabaseName='App';Multitenant=$true;Tenants=@([pscustomobject]@{Id='one';DatabaseName='Tenant'})} }
      function New-Item {}
      function Test-IsLocalSqlServer {$false}
      function Backup-RemoteSqlDatabases {$script:backups++}
      Export-BcServiceSqlBackupSet -scriptPath 'C:\\toolset' -settingsJSON ([pscustomobject]@{}) 6>$null
      $script:source=(Get-Content -LiteralPath ${quote(file)} -Raw | ConvertFrom-Json).configurations[0]
      Export-BcServiceSqlBackupSet -scriptPath 'C:\\toolset' -settingsJSON ([pscustomobject]@{}) 6>$null
      @{Discovery=$script:discovery;Backups=$script:backups} | ConvertTo-Json -Compress
    `);
    assert.deepEqual(result,{Discovery:1,Backups:2});
    const saved=JSON.parse(fs.readFileSync(file));
    assert.equal(saved.configurations[0].databaseServerHost,'SQLHOST');
    assert.equal(saved.configurations[0].databaseInstance,'NAMED');
    assert.equal(saved.configurations[0].databaseName,'App');
    assert.deepEqual(saved.configurations[0].databaseTenants,[{id:'one',databaseName:'Tenant'}]);
    assert.equal(saved.configurations[1].databaseServerHost,undefined);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
test('remote BC localhost SQL address resolves to the BC host',()=>{
  const result=run(`
    function Test-LocalBcManagementAvailable {$false}
    function Get-BcServiceDatabaseInfoRemote {[pscustomobject]@{DatabaseServer='localhost'}}
    $info=Get-BcServiceDatabaseInfo -configuration ([pscustomobject]@{managementServer='BC-HOST'}) -serverInstance 'BC230' 6>$null
    @{Host=$info.DatabaseServer} | ConvertTo-Json -Compress
  `);
  assert.equal(result.Host,'BC-HOST');
});
