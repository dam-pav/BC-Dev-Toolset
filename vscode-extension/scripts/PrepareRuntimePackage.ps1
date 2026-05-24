[CmdletBinding()]
param()

$extensionRoot = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
$repositoryRoot = (Get-Item -LiteralPath (Join-Path $extensionRoot '..')).FullName
$runtimeRoot = Join-Path $extensionRoot 'runtime'

$runtimeItems = @(
    'Invoke-BcDevToolsetOperation.ps1',
    'common',
    'operations',
    'visualization'
)

if (Test-Path -LiteralPath $runtimeRoot) {
    Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

foreach ($item in $runtimeItems) {
    $sourcePath = Join-Path $repositoryRoot $item
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Runtime package source not found: $sourcePath"
    }

    Copy-Item -LiteralPath $sourcePath -Destination $runtimeRoot -Recurse -Force
}

Write-Host "Prepared bundled runtime at $runtimeRoot"
