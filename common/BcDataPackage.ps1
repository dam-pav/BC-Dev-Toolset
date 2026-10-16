# Package validation shared by release preparation and explicit initialization.
function Assert-BcDataContainedPath {
    param([string] $Root, [string] $Path)
    $resolvedRoot = [IO.Path]::GetFullPath($Root)
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $relative = [IO.Path]::GetRelativePath($resolvedRoot, $resolvedPath)
    if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) {
        throw 'BC Data package path escapes its authorized root.'
    }
    return $resolvedPath
}

function Get-BcDataArchive {
    param([byte[]] $Bytes)
    if ($Bytes.Length -lt 44 -or $Bytes.Length -gt 16777216 -or
        [Text.Encoding]::ASCII.GetString($Bytes, 0, 4) -cne 'NAVX' -or
        [BitConverter]::ToInt32($Bytes, 4) -ne 40 -or
        [Text.Encoding]::ASCII.GetString($Bytes, 36, 4) -cne 'NAVX') { throw 'Invalid BC Data NAVX package.' }
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.MemoryStream]::new($Bytes, 40, $Bytes.Length - 40)
    try { return [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read) }
    catch { $stream.Dispose(); throw 'Invalid BC Data package archive.' }
}

function Read-BcDataArchiveManifest {
    param([IO.Compression.ZipArchive] $Archive)
    $entries = @($Archive.Entries | Where-Object FullName -ceq 'NavxManifest.xml')
    if ($entries.Count -ne 1 -or $entries[0].Length -gt 65536) { throw 'BC Data package must contain one bounded NavxManifest.xml.' }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 65536
    $reader = [Xml.XmlReader]::Create($entries[0].Open(), $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        return $document
    } finally { $reader.Dispose() }
}

function Assert-BcDataPackageIdentity {
    param($Expected, [Xml.XmlDocument] $Document)
    if ($Expected.appId -cne '0f92aea5-4cc0-459b-ae98-ca9e5c2b0304' -or
        $Expected.name -cne 'BC Dev Toolset Data' -or $Expected.publisher -cne 'dam-pav' -or
        $Expected.contractVersion -ne 1 -or $Expected.serviceName -cne 'BCDData' -or
        $Expected.packageFile -cne 'BCData.app' -or $Expected.mutationsEnabled -isnot [bool] -or $Expected.mutationsEnabled -ne $false -or
        $Expected.runtime -cne '12.0' -or $Expected.application -cne '23.0.0.0' -or
        [string]$Expected.version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Unsupported BC Data compatibility manifest.' }
    $app = $Document.Package.App
    foreach ($pair in @(@('Id','appId'), @('Name','name'), @('Publisher','publisher'), @('Version','version'), @('Runtime','runtime'), @('Application','application'))) {
        if ([string]$app.($pair[0]) -cne [string]$Expected.($pair[1])) { throw "BC Data package identity mismatch: $($pair[0])." }
    }
    if ($app.Target -cne 'OnPrem' -or @($Document.Package.Dependencies.ChildNodes | Where-Object NodeType -eq 'Element').Count -gt 0) {
        throw 'BC Data package must be the standalone OnPrem companion without app dependencies.'
    }
    $range = $Document.Package.IdRanges.IdRange
    if ($range.MinObjectId -cne '50100' -or $range.MaxObjectId -cne '50149') { throw 'Unexpected BC Data object range.' }
}

function Get-ValidatedBcDataPackage {
    param([string] $ToolsetRoot)
    $root = [IO.Path]::GetFullPath($ToolsetRoot)
    $manifestPath = Assert-BcDataContainedPath -Root $root -Path (Join-Path $root 'bc-data/manifest.json')
    $packagePath = Assert-BcDataContainedPath -Root $root -Path (Join-Path $root 'bc-data/BCData.app')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw 'Bundled BC Data package is missing. Build the companion through Toolset and run npm run prepare:runtime before packaging the extension.'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.sha256) {
        throw 'Bundled BC Data package checksum mismatch.'
    }
    $archive = Get-BcDataArchive -Bytes ([IO.File]::ReadAllBytes($packagePath))
    try { Assert-BcDataPackageIdentity -Expected $manifest -Document (Read-BcDataArchiveManifest -Archive $archive) }
    finally { $archive.Dispose() }
    return [pscustomobject]@{ Path = $packagePath; Manifest = $manifest }
}
