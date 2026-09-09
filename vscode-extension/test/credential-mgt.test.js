const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function run(script) {
  const result = spawnSync('pwsh', ['-NoLogo','-NoProfile','-NonInteractive','-Command', `. ${quote(path.join(root,'common/WorkspaceMgt.ps1'))}; $ErrorActionPreference='Stop'; $script:credentialProjectScope='11111111-1111-1111-1111-111111111111'; ${script}`], {encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
test('native storage updates only the chosen credential pair in settings and workspace files', {skip:process.platform !== 'win32'}, () => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bcdev-credentials-'));
  try {
    for (const workspace of [false,true]) {
      const file=path.join(folder,workspace ? 'test.code-workspace' : 'settings.json');
      const result=run(`
        Initialize-WindowsCredentialStore
        $configuration=[pscustomobject]@{name=('test-'+[guid]::NewGuid());serverType='Container';container=('test-'+[guid]::NewGuid());bcUser='plain';bcPassword='plain';remoteUser='plain';remotePassword='plain';databaseUser='plain';databasePassword='plain';password='legacy'}
        $other=[pscustomobject]@{name='other';serverType='Container';container=$configuration.container;bcPassword='untouched'}
        $doc=if ($${workspace}) { @{settings=@{'dam-pav.bcdevtoolset'=@{configurations=@($configuration,$other)}}} } else { @{configurations=@($configuration,$other)} }
        $doc | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath ${quote(file)}
        Initialize-CredentialConfigurationContext -settingsFiles $(if (-not $${workspace}) { @(${quote(file)}) } else { @() }) -workspaceFile $(if ($${workspace}) { ${quote(file)} } else { '' })
        $targets=@(); $passed=0
        try {
          foreach ($kind in @('remote','database','bc')) {
            $target=Get-ConfigurationCredentialTarget -configuration $configuration -kind $kind
            $targets += $target
            $credential=[pscredential]::new('stored',(ConvertTo-SecureString 'synthetic-value' -AsPlainText -Force))
            Save-ConfigurationCredential -configuration $configuration -kind $kind -credential $credential 6>$null
            $saved=Get-Content -LiteralPath ${quote(file)} -Raw | ConvertFrom-Json
            $entries=if ($${workspace}) { $saved.settings.'dam-pav.bcdevtoolset'.configurations } else { $saved.configurations }
            if (-not $entries[0].($kind+'Credential') -or $entries[0].PSObject.Properties[$kind+'Password'] -or $entries[0].PSObject.Properties[$kind+'User'] -or $entries[1].bcPassword -ne 'untouched') { throw 'Incorrect file update' }
            $configuration | Add-Member NoteProperty ($kind+'Password') 'ignored' -Force
            $resolved=Get-ConfigurationCredential -configuration $configuration -kind $kind
            if ($resolved.UserName -ne 'stored' -or $resolved.GetNetworkCredential().Password -ne 'synthetic-value') { throw 'Incorrect credential resolution' }
            if ($kind -eq 'remote' -and (Get-ConfigurationCredential -configuration $configuration -kind database).GetNetworkCredential().Password -ne 'plain') { throw 'Mixed mode failed' }
            [BcDevToolset.CredentialStore]::Delete($target)
            try { $null=Get-ConfigurationCredential -configuration $configuration -kind $kind; throw 'Unexpected fallback' }
            catch { if ($_.Exception.Message -notmatch 'Stored .* credential is missing') { throw } }
            $configuration.($kind+'Credential')=$false
            $passed++
          }
          @{Passed=$passed} | ConvertTo-Json -Compress
        } finally { foreach ($target in $targets) { [BcDevToolset.CredentialStore]::Delete($target) } }
      `);
      assert.equal(result.Passed,3);
    }
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});
test('identity ignores password, username and backup path changes; legacy flags stay compatible', () => {
  const result=run(`
    $c=[pscustomobject]@{name='Remote';server='https://host';remoteUser='one';remotePassword='one';sqlBackupPath='C:\\one';admin='admin';password='legacy';bcCredential=$false}
    $first=Get-ConfigurationCredentialTarget -configuration $c -kind remote
    $c.remoteUser='two';$c.remotePassword='two';$c.sqlBackupPath='D:\\two'
    $same=Get-ConfigurationCredentialTarget -configuration $c -kind remote
    $different=Get-ConfigurationCredentialTarget -configuration $c -kind database
    $legacy=Get-BcConfigurationCredential -configuration $c
    $c.bcCredential='true'
    try { $null=Get-BcConfigurationCredential -configuration $c } catch { $failure=$_.Exception.Message }
    @{Stable=($first -eq $same);Separate=($first -ne $different);Legacy=($legacy.GetNetworkCredential().Password -eq 'legacy');Error=$failure} | ConvertTo-Json -Compress
  `);
  assert.equal(result.Stable,true);assert.equal(result.Separate,true);assert.equal(result.Legacy,true);
  assert.match(result.Error,/must be a boolean/);
});
test('agent missing secure remoting credential aborts before connection or input', {skip:process.platform !== 'win32'}, () => {
  const result=run(`
    $env:BCDEVTOOLSET_MCP_SESSION_ID='agent'; $script:calls=0
    function Read-Host { throw 'Unexpected prompt' }
    function Get-Credential { throw 'Unexpected prompt' }
    function New-PSSession { $script:calls++ }
    $c=[pscustomobject]@{name='missing';server=('test-'+[guid]::NewGuid());remoteCredential=$true;remoteUser='ignored';remotePassword='ignored'}
    try { $null=New-RemoteBackupSession -computerName host -configuration $c } catch { $failure=$_.Exception.Message }
    @{Calls=$script:calls;Error=$failure} | ConvertTo-Json -Compress
  `);
  assert.equal(result.Calls,0);assert.match(result.Error,/Stored remote credential is missing/);
  assert.doesNotMatch(result.Error,/WinRM|Unexpected/);
});
test('schema uses independent boolean flags and disallows plaintext passwords when true', () => {
  const schema=JSON.parse(fs.readFileSync(path.join(root,'vscode-extension/schemas/bcdevtoolset-settings.schema.json'))).definitions.configuration;
  for(const kind of ['bc','remote','database']) {
    assert.equal(schema.properties[kind+'Credential'].type,'boolean');
    const rule=schema.allOf.find(rule=>rule.if?.required?.includes(kind+'Credential'));
    assert.equal(rule.if.properties[kind+'Credential'].const,true);
    assert.deepEqual(rule.then.properties[kind+'Password'].not,{});
    assert.deepEqual(rule.then.properties[kind+'User'].not,{});
    if(kind==='bc') assert.deepEqual(rule.then.properties.admin.not,{});
  }
});


test('backup reuses entered remoting credentials and offers storage only after local export', () => {
  for (const failExport of [false, true]) {
    const result=run(`
      $env:BCDEVTOOLSET_MCP_SESSION_ID='';$env:BCDEVTOOLSET_NON_INTERACTIVE=''
      $script:attempts=0;$script:saved=0;$script:entries=0;$script:exported=$false
      $script:answers=[collections.generic.queue[string]]::new()
      $script:answers.Enqueue('C');$script:answers.Enqueue('y')
      function Read-Host { $script:answers.Dequeue() }
      function Get-Credential { $script:entries++; [pscredential]::new('entered',(ConvertTo-SecureString 'synthetic' -AsPlainText -Force)) }
      function Save-ConfigurationCredential {
        param($configuration,$kind,$credential)
        if (-not $script:exported -or $kind -ne 'remote' -or $credential.UserName -ne 'entered') { throw 'Incorrect save timing' }
        $script:saved++
      }
      function New-PSSession {
        param($ComputerName,$Credential,$ErrorAction)
        $script:attempts++
        if ($script:attempts -eq 1) { throw 'Access denied' }
        if ($Credential.UserName -ne 'entered') { throw 'Wrong retry credential' }
        'connected'
      }
      function Import-BcServiceBackupDiscoveryModules {}
      function Select-BcServiceSqlBackupConfigurations { @{Source=[pscustomobject]@{name='source';serverInstance='BC230'};Destination=[pscustomobject]@{name='local';sqlBackupPath='C:\\exports'}} }
      function Get-BcServiceDatabaseInfo {
        param($configuration)
        $null=New-RemoteBackupSession -computerName 'bc-host' -configuration $configuration
        [pscustomobject]@{DatabaseServer='sql-host';DatabaseInstance='';DatabaseName='test';Multitenant=$false;Tenants=@()}
      }
      function New-Item {}
      function Test-IsLocalSqlServer { $false }
      function Save-BcDatabaseServerHost {}
      function Backup-RemoteSqlDatabases {
        param($configuration,$computerName)
        $null=New-RemoteBackupSession -computerName $computerName -configuration $configuration
        if ($${failExport}) { throw 'Local copy failed' }
        $script:exported=$true
      }
      try { Export-BcServiceSqlBackupSet -scriptPath 'C:\\toolset' -settingsJSON ([pscustomobject]@{}) 6>$null } catch { $failure=$_.Exception.Message }
      @{Attempts=$script:attempts;Entries=$script:entries;Saved=$script:saved;Remaining=$script:answers.Count;Cleared=($null -eq $script:backupCredentialContext);Error=$failure} | ConvertTo-Json -Compress
    `);
    assert.equal(result.Attempts,3);
    assert.equal(result.Entries,1);
    assert.equal(result.Saved,failExport ? 0 : 1);
    assert.equal(result.Remaining,failExport ? 1 : 0);
    assert.equal(result.Cleared,true);
    assert.equal(result.Error,failExport ? 'Local copy failed' : null);
  }
});

test('human SQL recovery offers storage after successful export and agents never prompt', () => {
  for(const agent of [false,true]) {
    const result=run(`
      $env:BCDEVTOOLSET_MCP_SESSION_ID=$(if ($${agent}) {'agent'} else {''});$env:BCDEVTOOLSET_NON_INTERACTIVE=''
      $script:attempts=0;$script:saved=0;$script:prompts=0
      function Import-BcServiceBackupDiscoveryModules {}
      function Select-BcServiceSqlBackupConfigurations { @{Source=[pscustomobject]@{name='source';serverInstance='BC230'};Destination=[pscustomobject]@{name='local';sqlBackupPath='C:\\exports'}} }
      function Get-BcServiceDatabaseInfo { [pscustomobject]@{DatabaseServer='sql-host';DatabaseInstance='';DatabaseName='test';Multitenant=$false;Tenants=@()} }
      function New-Item {}
      function Test-IsLocalSqlServer { $false }
      function Read-Host { $script:prompts++; 'y' }
      function Get-Credential { [pscredential]::new('sql-entered',(ConvertTo-SecureString 'synthetic' -AsPlainText -Force)) }
      function Backup-RemoteSqlDatabases { param($sqlCredential) $script:attempts++; if ($script:attempts -eq 1) { throw 'SQL backup failed: login rejected' }; if ($sqlCredential.UserName -ne 'sql-entered') { throw 'Wrong retry credential' } }
      function Save-ConfigurationCredential { param($configuration,$kind,$credential) if ($script:attempts -ne 2 -or $kind -ne 'database') { throw 'Incorrect save timing' }; $script:saved++ }
      try { Export-BcServiceSqlBackupSet -scriptPath 'C:\\toolset' -settingsJSON ([pscustomobject]@{}) 6>$null } catch { $failure=$_.Exception.Message }
      @{Attempts=$script:attempts;Saved=$script:saved;Prompts=$script:prompts;Error=$failure} | ConvertTo-Json -Compress
    `);
    assert.equal(result.Attempts,agent ? 1 : 2);assert.equal(result.Saved,agent ? 0 : 1);assert.equal(result.Prompts,agent ? 0 : 2);
    if(agent) assert.match(result.Error,/SQL backup failed/);else assert.equal(result.Error,null);
  }
});


test('ambiguous configuration ownership aborts before storage or file changes', () => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bcdev-credential-owner-'));
  const file=path.join(folder,'settings.json');
  const config={name:'duplicate',serverType:'OnPrem',server:'https://host',remoteUser:'plain',remotePassword:'keep'};
  const original=JSON.stringify({configurations:[config,config]});fs.writeFileSync(file,original);
  try {
    const result=run(`
      Initialize-CredentialConfigurationContext -projectRoot ${quote(folder)} -settingsFiles @(${quote(file)})
      function Initialize-WindowsCredentialStore { throw 'Unexpected vault access' }
      $configuration=${quote(JSON.stringify(config))} | ConvertFrom-Json
      $credential=[pscredential]::new('test',(ConvertTo-SecureString 'synthetic' -AsPlainText -Force))
      try { Save-ConfigurationCredential -configuration $configuration -kind remote -credential $credential } catch { @{Error=$_.Exception.Message} | ConvertTo-Json -Compress }
    `);
    assert.match(result.Error,/Cannot uniquely locate/);
    assert.equal(fs.readFileSync(file,'utf8'),original);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
test('MCP credential setup returns human instructions without accepting secrets', async () => {
  const {__test:mcp}=require('../mcp-server');
  const name='bc_dev_toolset_configure_stored_credentials';
  const tool=mcp.getTools().find(tool=>tool.name===name);
  assert.deepEqual(tool.inputSchema,{type:'object',properties:{},additionalProperties:false});
  const result=await mcp.callTool({name,arguments:{}});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/No operation was started/);
});


test('container identity shares by container name and ignores configuration and project labels', () => {
  const result=run(`
    $c=[pscustomobject]@{name='Local';serverType='Container';container='Payroll';server='https://old-label'}
    $first=Get-ConfigurationCredentialTarget -configuration $c -kind bc
    $c.name='Different project label';$c.server='https://another-label';$c.container=' payroll '
    $shared=Get-ConfigurationCredentialTarget -configuration $c -kind bc
    $c.name='Local';$c.container='Payroll-Test'
    $separate=Get-ConfigurationCredentialTarget -configuration $c -kind bc
    $c.container=''
    try { $null=Get-ConfigurationCredentialTarget -configuration $c -kind bc } catch { $failure=$_.Exception.Message }
    @{Shared=($first -eq $shared);Separate=($first -ne $separate);Error=$failure} | ConvertTo-Json -Compress
  `);
  assert.equal(result.Shared,true);assert.equal(result.Separate,true);
  assert.match(result.Error,/container name is required/);
});


test('remote credentials are project-scoped while container credentials remain shared', () => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bcdev-project-scope-'));
  const first=path.join(folder,'first');const second=path.join(folder,'second');
  fs.mkdirSync(first);fs.mkdirSync(second);
  try {
    const result=run(`
      $remote=[pscustomobject]@{name='Remote';serverType='OnPrem';server='https://same-host';serverInstance='BC230'}
      $container=[pscustomobject]@{name='Local';serverType='Container';container='shared-container'}
      Initialize-CredentialConfigurationContext -projectRoot ${quote(first)}
      try { $null=Get-ConfigurationCredentialTarget -configuration $remote -kind remote } catch { $missing=$_.Exception.Message }
      $createdOnRead=Test-Path -LiteralPath ${quote(path.join(first,'.bcdevtoolset/credential-scope.json'))}
      $null=Get-ProjectCredentialScope -Create
      $remoteOne=Get-ConfigurationCredentialTarget -configuration $remote -kind remote
      $containerOne=Get-ConfigurationCredentialTarget -configuration $container -kind bc
      Initialize-CredentialConfigurationContext -projectRoot ${quote(second)}
      $null=Get-ProjectCredentialScope -Create
      $remoteTwo=Get-ConfigurationCredentialTarget -configuration $remote -kind remote
      $containerTwo=Get-ConfigurationCredentialTarget -configuration $container -kind bc
      Initialize-CredentialConfigurationContext -projectRoot ${quote(first)}
      $remoteAgain=Get-ConfigurationCredentialTarget -configuration $remote -kind remote
      @{Separate=($remoteOne -ne $remoteTwo);Stable=($remoteOne -eq $remoteAgain);SharedContainer=($containerOne -eq $containerTwo);CreatedOnRead=$createdOnRead;Missing=$missing} | ConvertTo-Json -Compress
    `);
    assert.equal(result.Separate,true);assert.equal(result.Stable,true);assert.equal(result.SharedContainer,true);
    assert.equal(result.CreatedOnRead,false);assert.match(result.Missing,/Project credential scope is missing/);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
