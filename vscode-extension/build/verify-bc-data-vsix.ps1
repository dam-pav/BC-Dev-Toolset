param([Parameter(Mandatory=$true)][string]$VsixPath)
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repositoryRoot 'common/BcDataPackage.ps1')
# CLI path is explicitly authorized only beneath this checkout (CI writes dist/).
$validatedVsix = Assert-BcDataContainedPath -Root $repositoryRoot -Path ([IO.Path]::GetFullPath($VsixPath))
$staged = Get-ValidatedBcDataPackage -ToolsetRoot $repositoryRoot
$archive = [IO.Compression.ZipFile]::OpenRead($validatedVsix)
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('bcdata-vsix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $temporaryRoot 'bc-data') -Force | Out-Null
try {
    $apps = @($archive.Entries | Where-Object { $_.FullName -like '*.app' })
    if ($apps.Count -ne 1 -or $apps[0].FullName -cne 'extension/runtime/bc-data/BCData.app') { throw 'VSIX must contain exactly the companion app and no test apps.' }
    $bundleFiles = @($archive.Entries | Where-Object { $_.FullName.StartsWith('extension/runtime/bc-data/', [StringComparison]::OrdinalIgnoreCase) -and -not $_.FullName.EndsWith('/') })
    if ($bundleFiles.Count -ne 3) { throw 'VSIX must contain only the three required companion bundle files.' }
    foreach ($file in @('BCData.app','manifest.json','compatibility.json')) {
        $expectedEntry = "extension/runtime/bc-data/$file"
        $entries = @($archive.Entries | Where-Object FullName -ieq $expectedEntry)
        if ($entries.Count -ne 1 -or $entries[0].FullName -cne $expectedEntry -or $entries[0].Length -gt 16777216) { throw 'VSIX companion bundle is missing, duplicated or oversized.' }
        $inputStream = $entries[0].Open()
        $outputStream = [IO.File]::Create((Join-Path $temporaryRoot "bc-data/$file"))
        try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
    }
    $bundle = Get-ValidatedBcDataPackage -ToolsetRoot $temporaryRoot
    $bundledCompatibility = [IO.File]::ReadAllText((Join-Path $temporaryRoot 'bc-data/compatibility.json')).Replace("`r`n", "`n")
    $checkoutCompatibility = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'bc-data/compatibility.json')).Replace("`r`n", "`n")
    if ($bundle.Manifest.sha256 -cne $staged.Manifest.sha256 -or
        $bundledCompatibility -cne $checkoutCompatibility) {
        throw 'VSIX companion differs from the validated checkout build.'
    }
    Write-Host "Verified bundled BC Data $($bundle.Manifest.version), SHA256 $($bundle.Manifest.sha256)."
} finally {
    $archive.Dispose()
    # Exclusively owned GUID directory, with its resolved parent checked before deletion.
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($temporaryRoot)) -cne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe verification cleanup path.' }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}
