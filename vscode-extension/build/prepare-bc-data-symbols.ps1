$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repositoryRoot 'common/BcDataPackage.ps1')
$inputs = Get-Content -LiteralPath (Join-Path $repositoryRoot 'bc-data/build-inputs.json') -Raw | ConvertFrom-Json
$cache = Join-Path $repositoryRoot '.bcdevtoolset/ci-inputs'
$symbols = Join-Path $cache 'symbols'
New-Item -ItemType Directory -Path $symbols -Force | Out-Null
$archivePath = Assert-BcDataContainedPath -Root $cache -Path (Join-Path $cache 'platform.zip')
$downloadPath = Assert-BcDataContainedPath -Root $cache -Path (Join-Path $cache 'platform.zip.download')
$uri = [uri]$inputs.artifactUrl
if ($uri.Scheme -cne 'https' -or $uri.Host -cne 'bcartifacts-exdbf9fwegejdqak.b02.azurefd.net' -or
    $uri.AbsolutePath -cne '/onprem/23.18.32409.0/platform' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
    throw 'Unexpected companion baseline artifact URL.'
}
Add-Type -AssemblyName System.IO.Compression
if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    try {
        $cachedArchive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try { $null = $cachedArchive.Entries.Count } finally { $cachedArchive.Dispose() }
    } catch {
        # An interrupted earlier bootstrap must not leave an unusable cache entry.
        Remove-Item -LiteralPath $archivePath -Force
    }
}
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Write-Host "Downloading pinned BC baseline artifact (attempt $attempt/3)."
            if (Test-Path -LiteralPath $downloadPath -PathType Leaf) { Remove-Item -LiteralPath $downloadPath -Force }
            Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $downloadPath -ErrorAction Stop
            $downloadedArchive = [IO.Compression.ZipFile]::OpenRead($downloadPath)
            try { $null = $downloadedArchive.Entries.Count } finally { $downloadedArchive.Dispose() }
            # Commit only a complete ZIP to the cache. Symbol checksums below remain mandatory.
            Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force -ErrorAction Stop
            break
        } catch {
            if (Test-Path -LiteralPath $downloadPath -PathType Leaf) { Remove-Item -LiteralPath $downloadPath -Force }
            if ($attempt -eq 3) { throw "Pinned BC baseline artifact download failed after 3 attempts. Cause: $($_.Exception.Message)" }
            Write-Warning "Baseline download attempt $attempt failed; retrying with a fresh partial file."
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if (@($inputs.symbols).Count -ne 4) { throw 'Expected four pinned baseline packages.' }
    foreach ($symbol in $inputs.symbols) {
        if ([string]$symbol.file -notmatch '^[A-Za-z_ ][A-Za-z_ .]*\.app$' -or [string]$symbol.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid pinned symbol definition.' }
        $destination = Assert-BcDataContainedPath -Root $symbols -Path (Join-Path $symbols $symbol.file)
        # Archive names are lookup keys only: never extract them as filesystem paths.
        $entries = @($archive.Entries | Where-Object { $_.FullName.Replace('\','/') -ieq [string]$symbol.entry })
        if ($entries.Count -ne 1 -or $entries[0].Length -gt 134217728) { throw "Missing, duplicate or oversized baseline package: $($symbol.file)." }
        $inputStream = $entries[0].Open()
        $outputStream = [IO.File]::Create($destination)
        try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $symbol.sha256) {
            Remove-Item -LiteralPath $destination
            throw "Pinned symbol checksum mismatch: $($symbol.file)."
        }
    }
} finally { $archive.Dispose() }
Write-Host "Prepared four verified BC $($inputs.applicationVersion) baseline packages."
