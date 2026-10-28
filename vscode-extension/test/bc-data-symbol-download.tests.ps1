param([ValidateSet('interrupted','truncated','exhausted','corrupt-cache','valid-cache','checksum')][string]$Scenario)
$ErrorActionPreference='Stop'
function Assert($condition,$message) { if (-not $condition) { throw $message } }
$repositoryRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$temporaryRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot=Join-Path $temporaryRoot ('bcdata-download-test-'+[guid]::NewGuid())
try {
    foreach ($child in @('vscode-extension/build','common','bc-data','.bcdevtoolset/ci-inputs')) {
        New-Item -ItemType Directory -Path (Join-Path $fixtureRoot $child) -Force | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'vscode-extension/build/prepare-bc-data-symbols.ps1') -Destination (Join-Path $fixtureRoot 'vscode-extension/build')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'common/BcDataPackage.ps1') -Destination (Join-Path $fixtureRoot 'common')
    $inputs=Get-Content -LiteralPath (Join-Path $repositoryRoot 'bc-data/build-inputs.json') -Raw | ConvertFrom-Json
    $sourceZip=Join-Path $fixtureRoot 'source.zip'
    $zip=[IO.Compression.ZipFile]::Open($sourceZip,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($symbol in $inputs.symbols) {
            $bytes=[Text.Encoding]::UTF8.GetBytes('synthetic '+$symbol.file)
            $symbol.sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
            $stream=$zip.CreateEntry($symbol.entry).Open()
            try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    if ($Scenario -eq 'checksum') { $inputs.symbols[0].sha256='0'*64 }
    $inputs | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'bc-data/build-inputs.json')
    $cache=Join-Path $fixtureRoot '.bcdevtoolset/ci-inputs'
    $archivePath=Join-Path $cache 'platform.zip'
    $downloadPath=Join-Path $cache 'platform.zip.download'
    if ($Scenario -eq 'corrupt-cache') { Set-Content -LiteralPath $archivePath -Value 'incomplete cached zip' }
    elseif ($Scenario -eq 'valid-cache') { Copy-Item -LiteralPath $sourceZip -Destination $archivePath }
    # A prior process might also have left an interrupted temporary download.
    Set-Content -LiteralPath $downloadPath -Value 'old partial download'
    $downloadState=@{Attempts=0;Delays=0}
    function Start-Sleep { $downloadState.Delays++ }
    function Invoke-WebRequest {
        param($Uri,$OutFile)
        $downloadState.Attempts++
        Assert ($Uri -eq $inputs.artifactUrl -and $OutFile -eq $downloadPath) 'Bootstrap changed the pinned URL or downloaded directly into the cache'
        Assert (-not (Test-Path -LiteralPath $archivePath)) 'An incomplete download was exposed as a cached archive'
        Assert (-not (Test-Path -LiteralPath $OutFile)) 'A partial download was reused'
        if ($Scenario -eq 'exhausted' -or ($downloadState.Attempts -eq 1 -and $Scenario -in @('interrupted','truncated'))) {
            Set-Content -LiteralPath $OutFile -Value 'partial response'
            if ($Scenario -ne 'truncated') { throw 'The response ended prematurely. (ResponseEnded)' }
            return
        }
        Copy-Item -LiteralPath $sourceZip -Destination $OutFile
    }
    $failure=$null
    try { & (Join-Path $fixtureRoot 'vscode-extension/build/prepare-bc-data-symbols.ps1') 6>$null 3>$null }
    catch { $failure=$_.Exception.Message }
    if ($Scenario -eq 'exhausted') {
        Assert ($failure -match 'failed after 3 attempts' -and $downloadState.Attempts -eq 3 -and $downloadState.Delays -eq 2) 'Retries were not bounded or failure was hidden'
        Assert (-not (Test-Path -LiteralPath $archivePath) -and -not (Test-Path -LiteralPath $downloadPath)) 'Failed download left a partial cache entry'
    } elseif ($Scenario -eq 'checksum') {
        Assert ($failure -match 'checksum mismatch' -and $downloadState.Attempts -eq 1) 'Checksum verification was bypassed or retried as a network failure'
        Assert (-not (Test-Path -LiteralPath (Join-Path $cache ('symbols/'+$inputs.symbols[0].file)))) 'Invalid symbol was retained'
    } else {
        Assert (-not $failure) "Bootstrap failed: $failure"
        $expectedAttempts=if ($Scenario -eq 'valid-cache') {0} elseif ($Scenario -in @('interrupted','truncated')) {2} else {1}
        Assert ($downloadState.Attempts -eq $expectedAttempts) 'Unexpected number of download attempts'
        Assert (@(Get-ChildItem -LiteralPath (Join-Path $cache 'symbols') -Filter '*.app').Count -eq 4) 'Bootstrap did not verify all four baseline packages'
        $verified=[IO.Compression.ZipFile]::OpenRead($archivePath)
        $verified.Dispose()
        if ($Scenario -ne 'valid-cache') { Assert (-not (Test-Path -LiteralPath $downloadPath)) 'Completed download left a temporary file' }
    }
} finally {
    $validatedFixture=[IO.Path]::GetFullPath($fixtureRoot)
    $relative=[IO.Path]::GetRelativePath($temporaryRoot,$validatedFixture)
    if ([IO.Path]::IsPathRooted($relative) -or $relative.StartsWith('..') -or -not $relative.StartsWith('bcdata-download-test-')) { throw 'Unsafe fixture cleanup target' }
    Remove-Item -LiteralPath $validatedFixture -Recurse -Force
}
