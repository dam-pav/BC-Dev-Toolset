$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repositoryRoot 'common/BcDataPackage.ps1')
$inputs = Get-Content -LiteralPath (Join-Path $repositoryRoot 'bc-data/build-inputs.json') -Raw | ConvertFrom-Json
$cache = Join-Path $repositoryRoot '.bcdevtoolset/ci-inputs'
$symbols = Join-Path $cache 'symbols'
New-Item -ItemType Directory -Path $symbols -Force | Out-Null
$archivePath = Join-Path $cache 'platform.zip'
$uri = [uri]$inputs.artifactUrl
if ($uri.Scheme -cne 'https' -or $uri.Host -cne 'bcartifacts-exdbf9fwegejdqak.b02.azurefd.net' -or
    $uri.AbsolutePath -cne '/onprem/23.18.32409.0/platform' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
    throw 'Unexpected companion baseline artifact URL.'
}
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $archivePath
}
Add-Type -AssemblyName System.IO.Compression
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
