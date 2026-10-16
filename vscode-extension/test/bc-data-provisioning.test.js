'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const helper = path.resolve(__dirname, '../../common/BcDataMgt.ps1');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function run(body) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; . ${quote(helper)}; ${body}`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
const fixture = `
  $script:published=@(); $script:reads=0; $script:version='0.1.3.0'; $script:readinessVersion='0.1.3.0'
  $config=[pscustomobject]@{name='Dedicated';serverType='Container';targetType='Test';container='dedicated';authentication='UserPassword'}
  function Get-ValidatedBcDataPackage { param($ToolsetRoot) [pscustomobject]@{Path='fixed/BCData.app';Manifest=[pscustomobject]@{appId='0f92aea5-4cc0-459b-ae98-ca9e5c2b0304';version='0.1.3.0';application='23.0.0.0';contractVersion=1}} }
  function Get-BcConfigurationCredential { param($configuration) [pscredential]::new('fixture',(ConvertTo-SecureString 'synthetic-secret' -AsPlainText -Force)) }
  function Get-BcContainerAppInfo { param($containerName,$tenant,[switch]$tenantSpecificProperties)
    $script:reads++; if($containerName -ne 'dedicated' -or $tenant -ne 'default' -or -not $tenantSpecificProperties){throw 'Wrong target'}
    [pscustomobject]@{Name='Base Application';Publisher='Microsoft';AppId='base';Version='23.18.32409.0';IsInstalled=$true}
    if($script:version){[pscustomobject]@{AppId='0f92aea5-4cc0-459b-ae98-ca9e5c2b0304';Version=$script:version;IsInstalled=$true}}
  }
  function Publish-BcContainerApp { param($containerName,$tenant,$appFile,$scope,[switch]$skipVerification,[switch]$sync,[switch]$install,[switch]$upgrade)
    $script:published+=@{container=$containerName;tenant=$tenant;app=$appFile;scope=$scope;sync=$sync.IsPresent;install=$install.IsPresent;upgrade=$upgrade.IsPresent}
  }
  function Get-BcDataInitializationReadiness { param($Configuration,$Credential,$Expected) [pscustomobject]@{contractVersion=1;appVersion=$script:readinessVersion} }
`;
test('explicit initialization installs absent, upgrades older and preserves compatible equal/newer companions', () => {
  const result = run(fixture + `
    $results=@()
    foreach($version in @('', '0.1.2.0','0.1.3.0','0.1.4.0')) {
      $script:version=$version; $script:readinessVersion=if($version -eq '0.1.4.0'){$version}else{'0.1.3.0'}
      $results+=Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $config 6>$null
    }
    @{results=$results;published=$script:published;reads=$script:reads}|ConvertTo-Json -Depth 8 -Compress
  `);
  assert.deepEqual(result.results.map(item => item.Action), ['installed', 'upgraded', 'unchanged', 'unchanged']);
  assert.equal(result.published.length, 2);
  assert.ok(result.published.every(call => call.container === 'dedicated' && call.tenant === 'default' && call.app === 'fixed/BCData.app' && call.scope === 'Tenant' && call.install && call.sync));
  assert.equal(result.published[0].upgrade, false);
  assert.equal(result.published[1].upgrade, true);
});
test('automatic provisioning defaults off and does no package, credential, metadata or readiness work', () => {
  const result = run(`
    function Initialize-BcDataCompanion { throw 'Disabled provisioning executed' }
    foreach($data in @($null, [pscustomobject]@{}, [pscustomobject]@{provisioningEnabled=$false})) {
      Sync-ConfiguredBcData -ToolsetRoot 'missing' -Configuration ([pscustomobject]@{bcData=$data})
    }
    try { Sync-ConfiguredBcData -ToolsetRoot 'missing' -Configuration ([pscustomobject]@{bcData=[pscustomobject]@{provisioningEnabled='true'}}) } catch { $errorMessage=$_.Exception.Message }
    @{passed=$true;error=$errorMessage}|ConvertTo-Json -Compress
  `);
  assert.equal(result.passed, true);
  assert.match(result.error, /must be a boolean/);
});
test('production, remote, option-like container names and invalid endpoints fail before deployment', () => {
  const result = run(fixture + `
    $errors=@()
    foreach($change in @(@{targetType='Production'},@{serverType='OnPrem'},@{container='--all'},@{bcData=[pscustomobject]@{baseUrl='http://user:secret@elsewhere/ODataV4'}})) {
      $candidate=$config.PSObject.Copy()
      foreach($key in $change.Keys){$candidate|Add-Member NoteProperty $key $change[$key] -Force}
      try{Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $candidate|Out-Null}catch{$errors+=$_.Exception.Message}
    }
    @{errors=$errors;reads=$script:reads;published=$script:published.Count}|ConvertTo-Json -Compress
  `);
  assert.equal(result.errors.length, 4);
  assert.equal(result.reads, 0);
  assert.equal(result.published, 0);
});
test('incompatible newer companion is never downgraded and initialization reports failed readiness', () => {
  const result = run(fixture + `
    $script:version='2.0.0.0'
    function Get-BcDataInitializationReadiness { throw 'incompatible contract' }
    try{Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $config|Out-Null}catch{$message=$_.Exception.Message}
    @{message=$message;published=$script:published.Count}|ConvertTo-Json -Compress
  `);
  assert.equal(result.published, 0);
  assert.match(result.message, /incompatible/);
});
test('package checksum/embedded identity/path checks reject tampering before deployment', () => {
  const result = run(`
    $folder=Join-Path ([IO.Path]::GetTempPath()) ('bcdata-package-'+[guid]::NewGuid())
    New-Item -ItemType Directory -Path (Join-Path $folder 'bc-data')|Out-Null
    try {
      $manifest=[pscustomobject]@{appId='0f92aea5-4cc0-459b-ae98-ca9e5c2b0304';name='BC Dev Toolset Data';publisher='dam-pav';version='0.1.3.0';contractVersion=1;runtime='12.0';application='23.0.0.0';serviceName='BCDData';packageFile='BCData.app';mutationsEnabled=$false}
      $xml=[xml]'<Package><App Id="0f92aea5-4cc0-459b-ae98-ca9e5c2b0304" Name="BC Dev Toolset Data" Publisher="dam-pav" Version="0.1.3.0" Runtime="12.0" Application="23.0.0.0" Target="OnPrem"/><Dependencies/><IdRanges><IdRange MinObjectId="50100" MaxObjectId="50149"/></IdRanges></Package>'
      Assert-BcDataPackageIdentity -Expected $manifest -Document $xml
      $xml.Package.App.Id='wrong'; try{Assert-BcDataPackageIdentity -Expected $manifest -Document $xml}catch{$identity=$_.Exception.Message}
      $manifest|Add-Member NoteProperty sha256 ('0'*64)
      $manifest|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $folder 'bc-data/manifest.json')
      [IO.File]::WriteAllText((Join-Path $folder 'bc-data/BCData.app'),'tampered')
      try{Get-ValidatedBcDataPackage -ToolsetRoot $folder}catch{$checksum=$_.Exception.Message}
      try{Assert-BcDataContainedPath -Root $folder -Path (Join-Path $folder '../escape')}catch{$escape=$_.Exception.Message}
      @{identity=$identity;checksum=$checksum;escape=$escape}|ConvertTo-Json -Compress
    }finally{Remove-Item -LiteralPath $folder -Recurse -Force}
  `);
  assert.match(result.identity, /identity mismatch/);
  assert.match(result.checksum, /checksum mismatch/);
  assert.match(result.escape, /escapes/);
});
test('runtime preparation accepts current embedded sources and blocks stale same-version packages', () => {
  const builder = path.resolve(__dirname, '../build/prepare-bc-data-package.ps1');
  const packageHelper = path.resolve(__dirname, '../../common/BcDataPackage.ps1');
  const compatibility = path.resolve(__dirname, '../../bc-data/compatibility.json');
  const result = run(`
    $folder=Join-Path ([IO.Path]::GetTempPath()) ('bcdata-staging-'+[guid]::NewGuid())
    foreach($child in @('vscode-extension/build','common','bc-data','al/BCData/src')){New-Item -ItemType Directory -Path (Join-Path $folder $child) -Force|Out-Null}
    try{
      Copy-Item -LiteralPath ${quote(builder)} -Destination (Join-Path $folder 'vscode-extension/build/prepare-bc-data-package.ps1')
      Copy-Item -LiteralPath ${quote(packageHelper)} -Destination (Join-Path $folder 'common/BcDataPackage.ps1')
      Copy-Item -LiteralPath ${quote(compatibility)} -Destination (Join-Path $folder 'bc-data/compatibility.json')
      $expected=Get-Content -LiteralPath (Join-Path $folder 'bc-data/compatibility.json') -Raw|ConvertFrom-Json
      @{id=$expected.appId;name=$expected.name;publisher=$expected.publisher;version=$expected.version;runtime=$expected.runtime;application=$expected.application}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $folder 'al/BCData/app.json')
      $al='codeunit 50100 Dummy {}'
      [IO.File]::WriteAllText((Join-Path $folder 'al/BCData/src/Dummy.Codeunit.al'),$al)
      $xml='<Package><App Id="0f92aea5-4cc0-459b-ae98-ca9e5c2b0304" Name="BC Dev Toolset Data" Publisher="dam-pav" Version="0.1.3.0" Runtime="12.0" Application="23.0.0.0" Target="OnPrem"/><Dependencies/><IdRanges><IdRange MinObjectId="50100" MaxObjectId="50149"/></IdRanges></Package>'
      Add-Type -AssemblyName System.IO.Compression
      $stream=[IO.MemoryStream]::new()
      $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
      foreach($entry in @(@{name='NavxManifest.xml';text=$xml},@{name='src/src/Dummy.Codeunit.al';text=$al})){
        $writer=[IO.StreamWriter]::new($zip.CreateEntry($entry.name).Open());$writer.Write($entry.text);$writer.Dispose()
      }
      $zip.Dispose()
      $header=[byte[]]::new(40);[Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header,0);[BitConverter]::GetBytes([int]40).CopyTo($header,4);[Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header,36)
      [IO.File]::WriteAllBytes((Join-Path $folder 'al/BCData/dam-pav_BC Dev Toolset Data_0.1.3.0.app'),[byte[]]($header+$stream.ToArray()));$stream.Dispose()
      & (Join-Path $folder 'vscode-extension/build/prepare-bc-data-package.ps1') 6>$null
      $validated=Get-ValidatedBcDataPackage -ToolsetRoot $folder
      [IO.File]::WriteAllText((Join-Path $folder 'al/BCData/src/Dummy.Codeunit.al'),'changed after compilation')
      try{& (Join-Path $folder 'vscode-extension/build/prepare-bc-data-package.ps1') 6>$null}catch{$stale=$_.Exception.Message}
      @{version=$validated.Manifest.version;stale=$stale;testAppBundled=(Test-Path -LiteralPath (Join-Path $folder 'bc-data/BCData.Tests.app'))}|ConvertTo-Json -Compress
    }finally{Remove-Item -LiteralPath $folder -Recurse -Force}
  `);
  assert.equal(result.version, '0.1.3.0');
  assert.match(result.stale, /sources are stale/);
  assert.equal(result.testAppBundled, false);
});
test('initialization readiness uses exact HTTP/1.0 and validates the actual contract without exposing BC errors', { timeout: 30000 }, async t => {
  const requests = [];
  let compatible = true;
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push({ version: request.httpVersion, body, authorization: request.headers.authorization, url: request.url });
    const bytes = JSON.stringify({ value: JSON.stringify({ contractVersion: compatible ? 1 : 2, appVersion: '0.1.4.0', mutationsEnabled: false, capabilities: ['companies','schema','table-search','read-primary-key'] }) });
    response.writeHead(200, { 'Content-Length': Buffer.byteLength(bytes) }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdata-readiness-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const script = path.join(folder, 'readiness.ps1');
  fs.writeFileSync(script, `$ErrorActionPreference='Stop'; . ${quote(helper)}
    $config=[pscustomobject]@{container='unused';bcData=[pscustomobject]@{baseUrl='http://127.0.0.1:${server.address().port}/BC/ODataV4';tenant='fixture'}}
    $credential=[pscredential]::new('fixture',(ConvertTo-SecureString 'synthetic-secret' -AsPlainText -Force))
    try{$r=Get-BcDataInitializationReadiness -Configuration $config -Credential $credential -Expected ([pscustomobject]@{contractVersion=1;version='0.1.3.0'}); @{version=$r.appVersion}|ConvertTo-Json -Compress}catch{@{error=$_.Exception.Message}|ConvertTo-Json -Compress}
  `);
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { err += part; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  assert.equal((await invoke()).version, '0.1.4.0');
  compatible = false;
  const failed = await invoke();
  assert.match(failed.error, /readiness verification failed/);
  assert.ok(!failed.error.includes('synthetic-secret'));
  assert.ok(requests.every(request => request.version === '1.0' && request.body === '{"inputJson":"{}"}' && request.url.endsWith('tenant=fixture')));
  assert.ok(requests.every(request => request.authorization === 'Basic ' + Buffer.from('fixture:synthetic-secret').toString('base64')));
});
test('initialization metadata, command, switches and scopes are aligned', () => {
  const metadata = require('../../operations/operations.json').find(op => op.id === 'initializeBcData');
  const pkg = require('../package.json');
  const local = require('../schemas/bcdevtoolset-settings.schema.json');
  const shared = pkg.contributes.configuration.find(group => group.properties.bcDevToolset).properties.bcDevToolset.properties;
  assert.equal(metadata.script, 'operations/InitializeBcData.ps1');
  assert.ok(pkg.activationEvents.includes('onCommand:bcDevToolset.operation.initializeBcData'));
  assert.ok(pkg.contributes.commands.some(command => command.command === 'bcDevToolset.operation.initializeBcData'));
  assert.equal(shared.mcpTools.properties.bc_dev_toolset_initialize_bc_data.default, false);
  assert.deepEqual(shared.mcpTools, local.properties.mcpTools);
  const container = config => config.allOf.find(rule => rule.if?.properties?.serverType?.const === 'Container').then.properties.bcData;
  assert.deepEqual(container(shared.configurations.items), container(local.definitions.configuration));
  assert.equal(container(local.definitions.configuration).properties.provisioningEnabled.default, false);
});
