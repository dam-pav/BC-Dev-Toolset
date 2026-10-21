$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repositoryRoot 'common/BcDataPackage.ps1')
$sourceRoot = Join-Path $repositoryRoot 'al/BCData'
$compatibilityPath = Join-Path $repositoryRoot 'bc-data/compatibility.json'
$expected = Get-Content -LiteralPath $compatibilityPath -Raw | ConvertFrom-Json
$app = Get-Content -LiteralPath (Join-Path $sourceRoot 'app.json') -Raw | ConvertFrom-Json
foreach ($key in @('name','publisher','version','runtime','application')) {
    if ($app.$key -cne $expected.$key) { throw "Companion app.json and compatibility manifest disagree: $key." }
}
if ($app.id -cne $expected.appId) { throw 'Companion app ID mismatch.' }
$fileName = "$($app.publisher)_$($app.name)_$($app.version).app"
$packagePath = Assert-BcDataContainedPath -Root $sourceRoot -Path (Join-Path $sourceRoot $fileName)
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'Build the BC Data companion through Toolset MCP before preparing the runtime package.' }
$bytes = [IO.File]::ReadAllBytes($packagePath)
$archive = Get-BcDataArchive -Bytes $bytes
try {
    Assert-BcDataPackageIdentity -Expected $expected -Document (Read-BcDataArchiveManifest -Archive $archive)
    # Prove the packaged sources match this checkout, rather than trusting an old
    # ignored .app with the same version. No timestamps or paths form identities.
    $sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'src') -File -Filter '*.al' -Recurse)
    $entries = @($archive.Entries | Where-Object FullName -like 'src/*.al')
    if ($entries.Count -ne $sourceFiles.Count) { throw 'Companion package source list is stale.' }
    foreach ($file in $sourceFiles) {
        $validatedSource = Assert-BcDataContainedPath -Root $sourceRoot -Path $file.FullName
        $entryName = 'src/' + [IO.Path]::GetRelativePath($sourceRoot, $validatedSource).Replace('\','/')
        $entry = $archive.GetEntry($entryName)
        if ($null -eq $entry -or $entry.Length -gt 1048576) { throw 'Companion package source is missing or oversized.' }
        $reader = [IO.StreamReader]::new($entry.Open())
        try { $packagedText = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($packagedText.Replace("`r`n","`n") -cne [IO.File]::ReadAllText($validatedSource).Replace("`r`n","`n")) {
            throw 'Companion package sources are stale. Rebuild through Toolset MCP.'
        }
    }
} finally { $archive.Dispose() }
$destination = Join-Path $repositoryRoot 'bc-data/BCData.app'
[IO.File]::WriteAllBytes($destination, $bytes)
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
$expected | Add-Member NoteProperty sha256 $hash
$expected | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $repositoryRoot 'bc-data/manifest.json') -Encoding utf8
Write-Host "Prepared BC Data $($expected.version), contract $($expected.contractVersion)."
