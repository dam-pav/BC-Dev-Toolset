'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const common = path.resolve(__dirname, '../../common');
function run(body) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    . ${quote(path.join(common, 'BackupMgt.ps1'))}
    . ${quote(path.join(common, 'BcDataMgt.ps1'))}
    $config=[pscustomobject]@{name='Remote';serverType='OnPrem';server='bc.example';managementServer='admin.example';serverInstance='BC';authentication='Windows'}
    $settings=[pscustomobject]@{PublicODataBaseUrl='';ODataServicesPort='7448';ODataServicesSSLEnabled='true';ODataServicesEnabled='true';ODataServicesV4EndpointEnabled='true'}
    ${body}
  `], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('OData discovery prefers public URLs and derives listener URLs independently of developer port', () => {
  assert.deepEqual(run(`
    $urls=@()
    $config | Add-Member NoteProperty port 9999
    $urls+=Resolve-BcDataDiscoveredBaseUrl $config $settings
    $settings.PublicODataBaseUrl='https://bc.example/proxy/'
    $urls+=Resolve-BcDataDiscoveredBaseUrl $config $settings
    $settings.PublicODataBaseUrl='https://bc.example/proxy/ODataV4/'
    $urls+=Resolve-BcDataDiscoveredBaseUrl $config $settings
    $settings.PublicODataBaseUrl='https://bc.example/proxy/OData/'
    $urls+=Resolve-BcDataDiscoveredBaseUrl $config $settings
    $settings.PublicODataBaseUrl='';$settings.ODataServicesSSLEnabled='false'
    $config.serverInstance='MicrosoftDynamicsNavServer$BC Test'
    $urls+=Resolve-BcDataDiscoveredBaseUrl $config $settings
    ConvertTo-Json -InputObject $urls -Compress
  `), ['https://bc.example:7448/BC/ODataV4', 'https://bc.example/proxy/ODataV4', 'https://bc.example/proxy/ODataV4', 'https://bc.example/proxy/ODataV4', 'http://bc.example:7448/BC%20Test/ODataV4']);
});

test('disabled, malformed, cross-host and insecure discovered endpoints fail before saving', () => {
  const result = run(`
    $errors=@()
    foreach($change in @(@{ODataServicesEnabled='false'},@{ODataServicesV4EndpointEnabled='false'},@{ODataServicesPort='0'},@{ODataServicesSSLEnabled='unknown'},@{PublicODataBaseUrl='https://other.example/BC'},@{PublicODataBaseUrl='https://user:secret@bc.example/BC'},@{PublicODataBaseUrl='https://bc.example/BC?secret=value'})) {
      $candidate=$settings.PSObject.Copy()
      foreach($key in $change.Keys){$candidate.$key=$change[$key]}
      try { Resolve-BcDataDiscoveredBaseUrl $config $candidate | Out-Null; $errors+='unexpected success' } catch { $errors+=$_.Exception.Message }
    }
    $config.authentication='UserPassword';$settings.ODataServicesSSLEnabled='false'
    try { Resolve-BcDataDiscoveredBaseUrl $config $settings | Out-Null; $errors+='unexpected success' } catch { $errors+=$_.Exception.Message }
    ConvertTo-Json -InputObject $errors -Compress
  `);
  assert.equal(result.length, 8);
  assert.ok(result.every(message => !message.includes('unexpected success') && !message.includes('secret')));
});

test('remote OData discovery uses existing administrative session, selected instance and all five keys; cleans up on nonterminating errors', () => {
  const result = run(`
    $script:closed=0;$script:keys=@();$script:fail=$false
    function Test-IsLocalSqlServer { $false }
    function New-RemoteBackupSession { param($computerName,$configuration)
      if($computerName -ne 'admin.example' -or $configuration.name -ne 'Remote'){throw 'Wrong connection'}
      'session'
    }
    function Remove-PSSession { $script:closed++ }
    function Invoke-Command { param($Session,$ScriptBlock,$ArgumentList) & $ScriptBlock @ArgumentList }
    function Get-NAVServerConfiguration {
      [CmdletBinding()]param($ServerInstance,$KeyName)
      if($ServerInstance -ne 'BC'){throw 'Wrong instance'}
      $script:keys+=$KeyName
      if($script:fail){Write-Error 'synthetic backend secret';return}
      [pscustomobject]@{KeyValue=$settings.$KeyName}
    }
    $found=Get-BcDataODataSettings $config
    $script:fail=$true
    try { Initialize-BcDataBaseUrl $config;throw 'Unexpected continuation' } catch { $message=$_.Exception.Message }
    @{settings=$found;keys=$script:keys;closed=$script:closed;message=$message}|ConvertTo-Json -Depth 10 -Compress
  `);
  assert.equal(result.settings.ODataServicesPort, '7448');
  assert.deepEqual(result.keys.slice(0, 5), ['PublicODataBaseUrl', 'ODataServicesPort', 'ODataServicesSSLEnabled', 'ODataServicesEnabled', 'ODataServicesV4EndpointEnabled']);
  assert.equal(result.closed, 2);
  assert.match(result.message, /discovery failed before deployment/);
  assert.doesNotMatch(result.message, /synthetic backend secret/);
});

test('initialization persists discovered URL in original configuration while preserving BC Data permissions and explicit overrides', () => {
  const result = run(`
    $root=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $root
    try {
      $file=Join-Path $root 'settings.json'
      $config | Add-Member NoteProperty bcData ([pscustomobject]@{tenant='one';allowedMutationOperations=@('insert')})
      [IO.File]::WriteAllText($file, (@{configurations=@($config)} | ConvertTo-Json -Depth 10))
      $script:credentialConfigurationFiles=@([pscustomobject]@{Root=$root;Path=$file;IsWorkspace=$false})
      function Get-BcDataODataSettings { $settings }
      Initialize-BcDataBaseUrl $config
      $saved=([IO.File]::ReadAllText($file)|ConvertFrom-Json).configurations[0].bcData
      function Get-BcDataODataSettings { throw 'Explicit URL must skip discovery' }
      Initialize-BcDataBaseUrl $config
      @{saved=$saved;memory=$config.bcData}|ConvertTo-Json -Depth 10 -Compress
    } finally { Remove-Item -LiteralPath $file -Force; Remove-Item -LiteralPath $root -Force }
  `);
  const expected = { tenant: 'one', allowedMutationOperations: ['insert'], baseUrl: 'https://bc.example:7448/BC/ODataV4' };
  assert.deepEqual(result.saved, expected);
  assert.deepEqual(result.memory, expected);
});

test('local discovery unwraps values and initialization stops before package or deployment work when OData is disabled', () => {
  const result = run(`
    function Test-IsLocalSqlServer { $true }
    function Import-BcServiceBackupDiscoveryModules {}
    function New-RemoteBackupSession { throw 'Unexpected remote connection' }
    function Get-NAVServerConfiguration {
      [CmdletBinding()]param($ServerInstance,$KeyName)
      [pscustomobject]@{Value=$settings.$KeyName}
    }
    $found=Get-BcDataODataSettings $config
    $config | Add-Member NoteProperty targetType 'Test'
    $settings.ODataServicesEnabled='false'
    function Get-ValidatedBcDataPackage { throw 'Unexpected package work' }
    function Find-BcConfigurationDocument { throw 'Unexpected settings write' }
    try { Initialize-BcDataCompanion -Configuration $config;throw 'Unexpected continuation' } catch { $message=$_.Exception.Message }
    @{port=$found.ODataServicesPort;message=$message}|ConvertTo-Json -Compress
  `);
  assert.equal(result.port, '7448');
  assert.match(result.message, /Enable ODataServicesEnabled/);
});
