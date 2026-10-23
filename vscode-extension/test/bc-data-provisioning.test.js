'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');
const helper = path.resolve(__dirname, '../../common/BcDataMgt.ps1');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
test('companion objects reserve 99100..99149 independently of the test app range', () => {
  const companion = require('../../al/BCData/app.json');
  const tests = require('../../al/BCData.Tests/app.json');
  assert.deepEqual(companion.idRanges, [{ from: 99100, to: 99149 }]);
  assert.deepEqual(tests.idRanges, [{ from: 50200, to: 50299 }]);
  const sourceRoot = path.resolve(__dirname, '../../al/BCData/src');
  // Authorized fixed companion source directory, constructed solely from this test's repository location.
  const declarations = fs.readdirSync(sourceRoot).filter(name => name.endsWith('.al')).map(name => { // nosemgrep -- fixed repository source root; no external path input
    const sourcePath = path.resolve(sourceRoot, name);
    const relative = path.relative(sourceRoot, sourcePath);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    const source = fs.readFileSync(sourcePath, 'utf8'); // nosemgrep -- repository source read; path.relative containment asserted immediately above
    const declaration = /^(\w+)\s+(\d+)\s+"([^"]+)"/m.exec(source);
    assert.ok(declaration, `Missing object declaration in ${name}`);
    const [, type, id, objectName] = declaration;
    assert.ok(Number(id) >= 99100 && Number(id) <= 99149, `${name} is outside the companion range`);
    return { type, id: Number(id), name: objectName };
  });
  assert.ok(declarations.some(object => object.type === 'table' && object.id === 99100 && object.name === 'BCD Mutation Receipt'));
  assert.ok(declarations.some(object => object.type === 'codeunit' && object.id === 99100 && object.name === 'BCD Data Service'));
  assert.ok(declarations.some(object => object.type === 'codeunit' && object.id === 99107 && object.name === 'BCD Mutation Service'));
});

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
const selectionFixture = `
  . ${quote(path.resolve(__dirname, '../../common/WorkspaceMgt.ps1'))}
  $settings = @{configurations=@(
    @{name='First';serverType='Container';targetType='Dev';container='bc-first'},
    @{name='Tests';serverType='Container';targetType='Test';container='bc-tests'},
    @{name='Production';serverType='Container';targetType='Production';container='bc-prod'},
    @{name='Remote';serverType='OnPrem';targetType='Dev';container='bc-remote'},
    @{name='Cloud';serverType='Cloud';targetType='Dev';container='bc-cloud'},
    @{name='Blank';serverType='Container';targetType='Dev';container=' '},
    @{name='Second';serverType='Container';targetType='Dev';container='bc-second'}
  )}
  $script:prompts=@(); $script:output=@()
  function Write-Host { param($Object,$ForegroundColor) $script:output += [string]$Object }
  function Request-BcDevToolsetMcpPrompt {
    param($PromptId,$Type,$Question,$Choices,$DefaultValue,$Risk,$AgentAllowed)
    $script:prompts += @{id=$PromptId;type=$Type;choices=$Choices}
    return $script:answer
  }
`;

test('BC Data initialization selection never assigns to the automatic Matches variable', () => {
  const result = run(`
    $assignments=@(
      \${function:Select-BcDataInitializationConfiguration}.Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
        $node.Left.VariablePath.UserPath -ieq 'Matches'
      }, $true)
    )
    @{assignments=$assignments.Count}|ConvertTo-Json -Compress
  `);
  assert.equal(result.assignments, 0);
});

test('BC Data initialization presents numbered Dev containers and selects without typing a name', () => {
  const result = run(selectionFixture + `
    $script:answer=$null; $script:inputs=@('invalid','3','2'); $script:inputIndex=0
    function Read-Host { param($Prompt) $script:inputs[$script:inputIndex++] }
    $selected=Select-BcDataInitializationConfiguration $settings
    @{name=$selected.name;container=$selected.container;output=$script:output;prompts=$script:prompts}|ConvertTo-Json -Depth 6 -Compress
  `);
  assert.equal(result.name, 'Second');
  assert.equal(result.container, 'bc-second');
  assert.ok(result.output.some(line => line.startsWith('[1] First (bc-first)')));
  assert.ok(result.output.some(line => line.startsWith('[2] Second (bc-second)')));
  assert.ok(!result.output.some(line => /Tests|Production|Remote|Cloud|Blank/.test(line)));
  assert.deepEqual(result.prompts[0], { id: 'bcData.connectionId', type: 'choice', choices: ['First', 'Second'] });
});

test('BC Data initialization MCP choices reject Test, Production, remote, missing and inexact targets', () => {
  const result = run(selectionFixture + `
    function Select-IndexFromList { throw 'Unexpected terminal selection' }
    $results=@()
    foreach($answer in @('First','Second','Tests','Production','Remote','Cloud','Blank','Missing','first','')) {
      $script:answer=$answer
      try { $selected=Select-BcDataInitializationConfiguration $settings; $results+=@{name=$selected.name} }
      catch { $results+=@{error=$_.Exception.Message} }
    }
    ConvertTo-Json -InputObject $results -Depth 5 -Compress
  `);
  assert.deepEqual(result.slice(0, 2), [{ name: 'First' }, { name: 'Second' }]);
  assert.ok(result.slice(2).every(item => /unique Dev Container configuration name/.test(item.error)));
});

test('BC Data initialization handles a single Dev choice and rejects absent or ambiguous choices before prompting', () => {
  const result = run(selectionFixture + `
    $script:answer=$null
    function Read-Host { param($Prompt) '' }
    $single=Select-BcDataInitializationConfiguration @{configurations=@($settings.configurations[0])}
    $script:prompts=@(); $errors=@()
    foreach($configurations in @(
      @($settings.configurations[1]),
      @($settings.configurations[0],$settings.configurations[0]),
      @($settings.configurations[0],@{name='first';serverType='Container';targetType='Test';container='other'})
    )) {
      try { Select-BcDataInitializationConfiguration @{configurations=$configurations}|Out-Null }
      catch { $errors+=$_.Exception.Message }
    }
    @{single=$single.name;errors=$errors;prompts=$script:prompts.Count}|ConvertTo-Json -Depth 5 -Compress
  `);
  assert.equal(result.single, 'First');
  assert.match(result.errors[0], /No Dev Container configurations/);
  assert.ok(result.errors.slice(1).every(error => /unique configuration name/.test(error)));
  assert.equal(result.prompts, 0);
});

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

test('renumbered companion upgrades the former 0.1.10.0 installation and advertises its package version', () => {
  const companion = require('../../al/BCData/app.json');
  const compatibility = require('../../bc-data/compatibility.json');
  const tests = require('../../al/BCData.Tests/app.json');
  assert.equal(companion.version, compatibility.version);
  assert.equal(tests.dependencies.find(app => app.id === companion.id).version, companion.version);
  const service = fs.readFileSync(path.resolve(__dirname, '../../al/BCData/src/BCDataService.Codeunit.al'), 'utf8'); // nosemgrep -- fixed repository source file without external input
  assert.ok(service.includes(`Response.Add('appVersion', '${companion.version}');`));
  const result = run(fixture + `
    function Get-ValidatedBcDataPackage { param($ToolsetRoot) [pscustomobject]@{Path='fixed/BCData.app';Manifest=[pscustomobject]@{appId='${companion.id}';version='${companion.version}';application='23.0.0.0';contractVersion=1}} }
    $script:version='0.1.10.0'; $script:readinessVersion='${companion.version}'
    $result=Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $config 6>$null
    @{action=$result.Action;published=$script:published}|ConvertTo-Json -Depth 5 -Compress
  `);
  assert.equal(result.action, 'upgraded');
  assert.equal(result.published.length, 1);
  assert.equal(result.published[0].upgrade, true);
});

test('explicit initialization and automatic provisioning accept valid mutation allowlists', () => {
  const result = run(fixture + `
    $results=@()
    foreach($allowed in @(@(), @('modify'), @('insert','modify','rename','delete'))) {
      $config|Add-Member NoteProperty bcData ([pscustomobject]@{allowedMutationOperations=$allowed;provisioningEnabled=$true}) -Force
      $results+=Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $config 6>$null
      Sync-ConfiguredBcData -ToolsetRoot 'fixed' -Configuration $config 6>$null
    }
    @{actions=@($results.Action);reads=$script:reads;published=$script:published.Count}|ConvertTo-Json -Compress
  `);
  assert.deepEqual(result.actions, ['unchanged', 'unchanged', 'unchanged']);
  assert.equal(result.reads, 6);
  assert.equal(result.published, 0);
});

test('initialization and provisioning accept the all-operations override and ignore redundant lists', () => {
  const result = run(fixture + `
    $results=@()
    foreach($json in @('{}','{"allowedMutationOperations":[]}','{"allowedMutationOperations":["modify"]}',
      '{"allowedMutationOperations":["insert","modify","rename","delete"]}',
      '{"allowedMutationOperations":null}','{"allowedMutationOperations":"ignored"}','{"allowedMutationOperations":["upsert"]}')) {
      $data=ConvertFrom-Json $json
      $data|Add-Member NoteProperty allowedAllMutationOperations $true
      $data|Add-Member NoteProperty provisioningEnabled $true
      $config|Add-Member NoteProperty bcData $data -Force
      $results+=Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $config 6>$null
      Sync-ConfiguredBcData -ToolsetRoot 'fixed' -Configuration $config 6>$null
    }
    @{actions=@($results.Action);reads=$script:reads;published=$script:published.Count}|ConvertTo-Json -Compress
  `);
  assert.deepEqual(result.actions, Array(7).fill('unchanged'));
  assert.equal(result.reads, 14);
  assert.equal(result.published, 0);
});

test('nonboolean all-operations overrides fail before initialization or provisioning accesses the container', () => {
  const result = run(fixture + `
    $errors=@()
    foreach($json in @('null','"true"','"false"','1','0','[]','{}')) {
      $config|Add-Member NoteProperty bcData (ConvertFrom-Json ('{"provisioningEnabled":true,"allowedMutationOperations":["delete"],"allowedAllMutationOperations":'+$json+'}')) -Force
      try{Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $config|Out-Null}catch{$errors+=$_.Exception.Message}
      try{Sync-ConfiguredBcData -ToolsetRoot 'fixed' -Configuration $config}catch{$errors+=$_.Exception.Message}
    }
    @{errors=$errors;reads=$script:reads;published=$script:published.Count}|ConvertTo-Json -Compress
  `);
  assert.equal(result.errors.length, 14);
  assert.ok(result.errors.every(message => /allowedAllMutationOperations must be a boolean/.test(message)));
  assert.equal(result.reads, 0);
  assert.equal(result.published, 0);
});

test('invalid mutation allowlists fail before initialization or automatic provisioning accesses the container', () => {
  const result = run(fixture + `
    $errors=@()
    foreach($override in @('', ',"allowedAllMutationOperations":false')) {
      foreach($json in @('null','true','"delete"','["upsert"]','["delete","delete"]','[1]','[{}]','["Delete"]')) {
        $config|Add-Member NoteProperty bcData (ConvertFrom-Json ('{"provisioningEnabled":true,"allowedMutationOperations":'+$json+$override+'}')) -Force
        try{Initialize-BcDataCompanion -ToolsetRoot 'fixed' -Configuration $config|Out-Null}catch{$errors+=$_.Exception.Message}
        try{Sync-ConfiguredBcData -ToolsetRoot 'fixed' -Configuration $config}catch{$errors+=$_.Exception.Message}
      }
    }
    @{errors=$errors;reads=$script:reads;published=$script:published.Count}|ConvertTo-Json -Compress
  `);
  assert.equal(result.errors.length, 32);
  assert.ok(result.errors.every(message => /allowedMutationOperations must be a unique list/.test(message)));
  assert.equal(result.reads, 0);
  assert.equal(result.published, 0);
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
      $xml=[xml]'<Package><App Id="0f92aea5-4cc0-459b-ae98-ca9e5c2b0304" Name="BC Dev Toolset Data" Publisher="dam-pav" Version="0.1.3.0" Runtime="12.0" Application="23.0.0.0" Target="OnPrem"/><Dependencies/><IdRanges><IdRange MinObjectId="99100" MaxObjectId="99149"/></IdRanges></Package>'
      Assert-BcDataPackageIdentity -Expected $manifest -Document $xml
      $xml.Package.IdRanges.IdRange.MinObjectId='50100'; $xml.Package.IdRanges.IdRange.MaxObjectId='50149'
      try{Assert-BcDataPackageIdentity -Expected $manifest -Document $xml}catch{$oldRange=$_.Exception.Message}
      $xml.Package.IdRanges.IdRange.MinObjectId='99100'; $xml.Package.IdRanges.IdRange.MaxObjectId='99150'
      try{Assert-BcDataPackageIdentity -Expected $manifest -Document $xml}catch{$wideRange=$_.Exception.Message}
      $xml.Package.IdRanges.IdRange.MaxObjectId='99149'
      $manifest.mutationsEnabled=$true
      $manifest|Add-Member NoteProperty mutationServiceName 'BCDDataWrite'
      $manifest|Add-Member NoteProperty mutationProtocolVersion 1
      Assert-BcDataPackageIdentity -Expected $manifest -Document $xml
      $manifest.mutationProtocolVersion=2; try{Assert-BcDataPackageIdentity -Expected $manifest -Document $xml}catch{$protocol=$_.Exception.Message}
      $manifest.mutationProtocolVersion='1'; try{Assert-BcDataPackageIdentity -Expected $manifest -Document $xml}catch{$protocolType=$_.Exception.Message}
      $manifest.mutationProtocolVersion=1
      $manifest.mutationServiceName='Other'; try{Assert-BcDataPackageIdentity -Expected $manifest -Document $xml}catch{$service=$_.Exception.Message}
      $manifest.mutationServiceName='BCDDataWrite'
      $xml.Package.App.Id='wrong'; try{Assert-BcDataPackageIdentity -Expected $manifest -Document $xml}catch{$identity=$_.Exception.Message}
      $manifest|Add-Member NoteProperty sha256 ('0'*64)
      $manifest|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $folder 'bc-data/manifest.json')
      [IO.File]::WriteAllText((Join-Path $folder 'bc-data/BCData.app'),'tampered')
      try{Get-ValidatedBcDataPackage -ToolsetRoot $folder}catch{$checksum=$_.Exception.Message}
      try{Assert-BcDataContainedPath -Root $folder -Path (Join-Path $folder '../escape')}catch{$escape=$_.Exception.Message}
      @{identity=$identity;checksum=$checksum;escape=$escape;protocol=$protocol;protocolType=$protocolType;service=$service;oldRange=$oldRange;wideRange=$wideRange}|ConvertTo-Json -Compress
    }finally{Remove-Item -LiteralPath $folder -Recurse -Force}
  `);
  assert.match(result.identity, /identity mismatch/);
  assert.match(result.checksum, /checksum mismatch/);
  assert.match(result.escape, /escapes/);
  assert.match(result.protocol, /Unsupported/);
  assert.match(result.protocolType, /Unsupported/);
  assert.match(result.service, /Unsupported/);
  assert.match(result.oldRange, /Unexpected BC Data object range/);
  assert.match(result.wideRange, /Unexpected BC Data object range/);
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
      $al='codeunit 99100 Dummy {}'
      [IO.File]::WriteAllText((Join-Path $folder 'al/BCData/src/Dummy.Codeunit.al'),$al)
      $xml='<Package><App Id="0f92aea5-4cc0-459b-ae98-ca9e5c2b0304" Name="BC Dev Toolset Data" Publisher="dam-pav" Version="'+$expected.version+'" Runtime="12.0" Application="23.0.0.0" Target="OnPrem"/><Dependencies/><IdRanges><IdRange MinObjectId="99100" MaxObjectId="99149"/></IdRanges></Package>'
      Add-Type -AssemblyName System.IO.Compression
      $stream=[IO.MemoryStream]::new()
      $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
      foreach($entry in @(@{name='NavxManifest.xml';text=$xml},@{name='src/src/Dummy.Codeunit.al';text=$al})){
        $writer=[IO.StreamWriter]::new($zip.CreateEntry($entry.name).Open());$writer.Write($entry.text);$writer.Dispose()
      }
      $zip.Dispose()
      $header=[byte[]]::new(40);[Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header,0);[BitConverter]::GetBytes([int]40).CopyTo($header,4);[Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header,36)
      [IO.File]::WriteAllBytes((Join-Path $folder ('al/BCData/dam-pav_BC Dev Toolset Data_'+$expected.version+'.app')),[byte[]]($header+$stream.ToArray()));$stream.Dispose()
      & (Join-Path $folder 'vscode-extension/build/prepare-bc-data-package.ps1') 6>$null
      $validated=Get-ValidatedBcDataPackage -ToolsetRoot $folder
      [IO.File]::WriteAllText((Join-Path $folder 'al/BCData/src/Dummy.Codeunit.al'),'changed after compilation')
      try{& (Join-Path $folder 'vscode-extension/build/prepare-bc-data-package.ps1') 6>$null}catch{$stale=$_.Exception.Message}
      @{version=$validated.Manifest.version;stale=$stale;testAppBundled=(Test-Path -LiteralPath (Join-Path $folder 'bc-data/BCData.Tests.app'))}|ConvertTo-Json -Compress
    }finally{Remove-Item -LiteralPath $folder -Recurse -Force}
  `);
  assert.equal(result.version, require('../../bc-data/compatibility.json').version);
  assert.match(result.stale, /sources are stale/);
  assert.equal(result.testAppBundled, false);
});
test('initialization readiness uses exact HTTP/1.0 and validates the actual contract without exposing BC errors', { timeout: 30000 }, async t => {
  const requests = [];
  let compatible = true;
  let mutationMode = 'off';
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push({ version: request.httpVersion, body, authorization: request.headers.authorization, url: request.url });
    const bytes = JSON.stringify({ value: JSON.stringify({ contractVersion: compatible ? 1 : 2, appVersion: '0.1.4.0',
      mutationsEnabled: mutationMode !== 'off', mutationProtocolVersion: mutationMode === 'string' ? '1' : mutationMode === 'on' ? 1 : 2,
      capabilities: ['companies','schema','table-search','read-primary-key', ...(['on', 'string'].includes(mutationMode) ? ['mutation-scopes-v1'] : [])] }) });
    response.writeHead(200, { 'Content-Length': Buffer.byteLength(bytes) }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdata-readiness-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const script = path.join(folder, 'readiness.ps1');
  fs.writeFileSync(script, `param([switch]$RequireMutations)
    $ErrorActionPreference='Stop'; . ${quote(helper)}
    $config=[pscustomobject]@{container='unused';bcData=[pscustomobject]@{baseUrl='http://127.0.0.1:${server.address().port}/BC/ODataV4';tenant='fixture'}}
    $credential=[pscredential]::new('fixture',(ConvertTo-SecureString 'synthetic-secret' -AsPlainText -Force))
    try{$r=Get-BcDataInitializationReadiness -Configuration $config -Credential $credential -Expected ([pscustomobject]@{contractVersion=1;version='0.1.3.0';mutationsEnabled=$RequireMutations.IsPresent}); @{version=$r.appVersion}|ConvertTo-Json -Compress}catch{@{error=$_.Exception.Message}|ConvertTo-Json -Compress}
  `);
  const invoke = (requireMutations = false) => new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...(requireMutations ? ['-RequireMutations'] : [])], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { err += part; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  assert.equal((await invoke()).version, '0.1.4.0');
  assert.match((await invoke(true)).error, /readiness verification failed/);
  mutationMode = 'on';
  assert.equal((await invoke(true)).version, '0.1.4.0');
  mutationMode = 'wrong';
  assert.match((await invoke(true)).error, /readiness verification failed/);
  mutationMode = 'string';
  assert.match((await invoke(true)).error, /readiness verification failed/);
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
  const selection = metadata.promptInputs.find(input => input.promptId === 'bcData.connectionId');
  assert.equal(selection.type, 'choice');
  assert.match(selection.question, /Dev container/);
  const repositoryRoot = authorizeRoot(path.resolve(__dirname, '../..'), 'Repository root');
  const operationPath = resolveWithinRoot(repositoryRoot, 'operations', 'InitializeBcData.ps1');
  assert.throws(() => resolveWithinRoot(repositoryRoot, '..', 'InitializeBcData.ps1'), /escapes its authorized root/);
  // Fixed repository source; resolveWithinRoot enforces path.relative containment before this read.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed source path validated within the authorized repository root
  const operation = fs.readFileSync(operationPath, 'utf8'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  assert.match(operation, /Select-BcDataInitializationConfiguration -SettingsJSON \$settingsJSON/);
  assert.doesNotMatch(operation, /Read-Host/);
  assert.ok(pkg.activationEvents.includes('onCommand:bcDevToolset.operation.initializeBcData'));
  assert.ok(pkg.contributes.commands.some(command => command.command === 'bcDevToolset.operation.initializeBcData'));
  assert.equal(shared.mcpTools.properties.bc_dev_toolset_initialize_bc_data.default, false);
  assert.deepEqual(shared.mcpTools, local.properties.mcpTools);
  const container = config => config.allOf.find(rule => rule.if?.properties?.serverType?.const === 'Container').then.properties.bcData;
  assert.deepEqual(container(shared.configurations.items), container(local.definitions.configuration));
  assert.equal(container(local.definitions.configuration).properties.provisioningEnabled.default, false);
  assert.deepEqual(container(local.definitions.configuration).properties.allowedAllMutationOperations, {
    type: 'boolean', default: false,
    description: 'Permit insert, modify, rename and delete on this connection when true, overriding allowedMutationOperations. False or omitted uses that list. Also requires the mutation MCP tool switch and native BC permissions.'
  });
});
