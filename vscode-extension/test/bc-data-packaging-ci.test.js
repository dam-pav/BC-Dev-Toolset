'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function run(body) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${body}`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('every VSIX workflow requires its same-run source-built companion and verifies before publishing', () => {
  for (const file of ['extension-package.yml','latest-extension.yml','marketplace-publish.yml','publish-stable-release.yml']) {
    const text = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    assert.match(text, /uses: \.\/\.github\/workflows\/build-bc-data.yml/);
    assert.match(text, /needs: companion/);
    assert.match(text, /actions\/download-artifact@v4[\s\S]*?name: bc-data-companion[\s\S]*?path: al\/BCData/);
    const verify = text.indexOf('verify-bc-data-vsix.ps1');
    assert.ok(verify > text.indexOf('npm run package'));
    const publish = text.search(/gh release create|git push --atomic|bash \.\/\.github\/scripts\/publish-vsix/);
    assert.ok(publish < 0 || verify < publish);
  }
  for (const file of ['extension-package.yml','latest-extension.yml']) {
    const text = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    assert.match(text, /al\/BCData\/\*\*/); assert.match(text, /bc-data\/\*\*/);
  }
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-bc-data.yml'), 'utf8');
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /--install-extension "ms-dynamics-smb.al@/);
  assert.match(workflow, /build-bc-data-ci.js/);
  assert.match(workflow, /prepare-bc-data-package.ps1/);
  assert.doesNotMatch(workflow, /download-artifact|restore.*cache|New-BcContainer/);
});

test('symbol bootstrap verifies pinned content and rejects altered packages and escaping filenames', () => {
  const result = run(`
    Add-Type -AssemblyName System.IO.Compression
    $folder=Join-Path ([IO.Path]::GetTempPath()) ('bcdata-ci-symbols-'+[guid]::NewGuid())
    foreach($child in @('vscode-extension/build','common','bc-data','.bcdevtoolset/ci-inputs')){New-Item -ItemType Directory -Path (Join-Path $folder $child) -Force|Out-Null}
    try {
      Copy-Item -LiteralPath ${quote(path.join(root,'vscode-extension/build/prepare-bc-data-symbols.ps1'))} -Destination (Join-Path $folder 'vscode-extension/build')
      Copy-Item -LiteralPath ${quote(path.join(root,'common/BcDataPackage.ps1'))} -Destination (Join-Path $folder 'common')
      $inputs=Get-Content -LiteralPath ${quote(path.join(root,'bc-data/build-inputs.json'))} -Raw|ConvertFrom-Json
      $zip=[IO.Compression.ZipFile]::Open((Join-Path $folder '.bcdevtoolset/ci-inputs/platform.zip'),[IO.Compression.ZipArchiveMode]::Create)
      foreach($symbol in $inputs.symbols){$bytes=[Text.Encoding]::UTF8.GetBytes('synthetic '+$symbol.file);$symbol.sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant();$stream=$zip.CreateEntry($symbol.entry).Open();$stream.Write($bytes);$stream.Dispose()};$zip.Dispose()
      $config=Join-Path $folder 'bc-data/build-inputs.json';$inputs|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $config
      & (Join-Path $folder 'vscode-extension/build/prepare-bc-data-symbols.ps1') 6>$null
      $count=@(Get-ChildItem -LiteralPath (Join-Path $folder '.bcdevtoolset/ci-inputs/symbols') -Filter '*.app').Count
      $inputs.symbols[0].sha256='0'*64;$inputs|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $config
      try{& (Join-Path $folder 'vscode-extension/build/prepare-bc-data-symbols.ps1') 6>$null}catch{$tampered=$_.Exception.Message}
      $removed=-not(Test-Path -LiteralPath (Join-Path $folder ('.bcdevtoolset/ci-inputs/symbols/'+$inputs.symbols[0].file)))
      $inputs.symbols[0].file='../escape.app';$inputs|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $config
      try{& (Join-Path $folder 'vscode-extension/build/prepare-bc-data-symbols.ps1') 6>$null}catch{$escape=$_.Exception.Message}
      @{count=$count;tampered=$tampered;removed=$removed;escape=$escape}|ConvertTo-Json -Compress
    }finally{Remove-Item -LiteralPath $folder -Recurse -Force}
  `);
  assert.equal(result.count, 4); assert.match(result.tampered, /checksum mismatch/);
  assert.equal(result.removed, true); assert.match(result.escape, /Invalid pinned symbol/);
});

test('finished VSIX verification rejects missing, altered, duplicate and test app bundles', () => {
  const result = run(`
    Add-Type -AssemblyName System.IO.Compression
    $folder=Join-Path ([IO.Path]::GetTempPath()) ('bcdata-ci-vsix-'+[guid]::NewGuid())
    foreach($child in @('vscode-extension/build','common','bc-data')){New-Item -ItemType Directory -Path (Join-Path $folder $child) -Force|Out-Null}
    try {
      Copy-Item -LiteralPath ${quote(path.join(root,'vscode-extension/build/verify-bc-data-vsix.ps1'))} -Destination (Join-Path $folder 'vscode-extension/build')
      Copy-Item -LiteralPath ${quote(path.join(root,'common/BcDataPackage.ps1'))} -Destination (Join-Path $folder 'common')
      $compatibility=Get-Content -LiteralPath ${quote(path.join(root,'bc-data/compatibility.json'))} -Raw
      $expected=$compatibility|ConvertFrom-Json
      $memory=[IO.MemoryStream]::new();$zip=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Create,$true)
      $writer=[IO.StreamWriter]::new($zip.CreateEntry('NavxManifest.xml').Open());$writer.Write('<Package><App Id="'+$expected.appId+'" Name="'+$expected.name+'" Publisher="'+$expected.publisher+'" Version="'+$expected.version+'" Runtime="12.0" Application="23.0.0.0" Target="OnPrem"/><Dependencies/><IdRanges><IdRange MinObjectId="50100" MaxObjectId="50149"/></IdRanges></Package>');$writer.Dispose();$zip.Dispose()
      $header=[byte[]]::new(40);[Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header,0);[BitConverter]::GetBytes([int]40).CopyTo($header,4);[Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header,36)
      $app=[byte[]]($header+$memory.ToArray());$memory.Dispose()
      $expected|Add-Member NoteProperty sha256 ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($app)).ToLowerInvariant())
      $manifest=$expected|ConvertTo-Json -Depth 5
      [IO.File]::WriteAllBytes((Join-Path $folder 'bc-data/BCData.app'),$app);[IO.File]::WriteAllText((Join-Path $folder 'bc-data/manifest.json'),$manifest);[IO.File]::WriteAllText((Join-Path $folder 'bc-data/compatibility.json'),$compatibility)
      $errors=@();$accepted=0
      foreach($mode in @('valid','missing','altered','duplicate','case-collision','recipe','test-app')){
        $vsix=Join-Path $folder ($mode+'.vsix');$zip=[IO.Compression.ZipFile]::Open($vsix,[IO.Compression.ZipArchiveMode]::Create)
        foreach($file in @('BCData.app','manifest.json','compatibility.json')){
          if($mode -eq 'missing' -and $file -eq 'BCData.app'){continue}
          $bytes=if($file -eq 'BCData.app'){$app}else{[IO.File]::ReadAllBytes((Join-Path $folder ('bc-data/'+$file)))}
          if($mode -eq 'altered' -and $file -eq 'BCData.app'){$bytes=[Text.Encoding]::UTF8.GetBytes('altered')}
          $entry=$zip.CreateEntry('extension/runtime/bc-data/'+$file).Open();$entry.Write([byte[]]$bytes,0,$bytes.Length);$entry.Dispose()
        }
        if($mode -eq 'duplicate'){$null=$zip.CreateEntry('extension/runtime/bc-data/manifest.json')}
        if($mode -eq 'case-collision'){$null=$zip.CreateEntry('extension/runtime/bc-data/Manifest.json')}
        if($mode -eq 'recipe'){$null=$zip.CreateEntry('extension/runtime/bc-data/build-inputs.json')}
        if($mode -eq 'test-app'){$null=$zip.CreateEntry('extension/runtime/bc-data/BCData.Tests.app')}
        $zip.Dispose()
        try{& (Join-Path $folder 'vscode-extension/build/verify-bc-data-vsix.ps1') -VsixPath $vsix 6>$null;$accepted++}catch{$errors+=$_.Exception.Message}
      }
      @{accepted=$accepted;errors=$errors}|ConvertTo-Json -Depth 3 -Compress
    }finally{if($zip){$zip.Dispose()};Remove-Item -LiteralPath $folder -Recurse -Force}
  `);
  assert.equal(result.accepted, 1); assert.equal(result.errors.length, 6);
  assert.ok(result.errors.some(message => /checksum mismatch/.test(message)));
  assert.ok(result.errors.some(message => /three required/.test(message)));
  assert.ok(result.errors.some(message => /exactly the companion/.test(message)));
});
