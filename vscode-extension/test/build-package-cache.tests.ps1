$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$fixtureRoot = Join-Path $temporaryRoot ('bc-build-cache-test-' + [guid]::NewGuid().ToString('N'))
$payrollId = '7814fb2f-0d3d-47fe-b71f-433d43f6a06d'
$externalId = 'dd0be2ea-f733-4d65-bb34-a28f4624fb14'
$middleId = '11111111-1111-1111-1111-111111111111'
$testsId = '7f66d23b-728e-4e56-89e2-1c6aca3d20e1'

function New-TestPackage {
    param([string] $Path, [string] $Id)
    $stream = [IO.MemoryStream]::new()
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    $writer = [IO.StreamWriter]::new($archive.CreateEntry('NavxManifest.xml').Open())
    $writer.Write("<Package><App Id='$Id' /></Package>")
    $writer.Dispose()
    $archive.Dispose()
    $header = [byte[]]::new(40)
    [Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header, 0)
    [BitConverter]::GetBytes([int]40).CopyTo($header, 4)
    [Text.Encoding]::ASCII.GetBytes('NAVX').CopyTo($header, 36)
    [IO.File]::WriteAllBytes($Path, [byte[]]($header + $stream.ToArray()))
    $stream.Dispose()
}

try {
    foreach ($directory in @('operations', 'common', 'Payroll/.alpackages', 'Middle/.alpackages', 'Tests/.alpackages', 'Tests/.vscode', 'Tests/extra-cache')) {
        New-Item -ItemType Directory -Path (Join-Path $fixtureRoot $directory) -Force | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'operations/BuildAllApps.ps1') -Destination (Join-Path $fixtureRoot 'operations/BuildAllApps.ps1')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'common/PublishingDiagnostics.ps1') -Destination (Join-Path $fixtureRoot 'common/PublishingDiagnostics.ps1')
    Set-Content -LiteralPath (Join-Path $fixtureRoot 'common/WorkspaceMgt.ps1') -Value @'
function Get-WorkspaceRootPath { Get-Item -LiteralPath $env:BCDEVTOOLSET_WORKSPACE_PATH }
function Resolve-BcDevToolsetWorkspaceFile { Get-Item -LiteralPath $env:BCDEVTOOLSET_WORKSPACE_FILE }
function Write-Done { throw 'Unexpected operation completion' }
'@
    $apps = @(
        @{ id=$payrollId; name='Payroll'; dependencies=@() },
        @{ id=$middleId; name='Middle'; dependencies=@(@{id=$payrollId}) },
        @{ id=$testsId; name='Tests'; dependencies=@(@{id=$middleId}) }
    )
    foreach ($app in $apps) {
        $app.publisher = 'Sicom'; $app.version = '23.0.0.16'
        $app | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixtureRoot "$($app.name)/app.json")
    }
    # Reverse folder order also verifies dependency sorting.
    @{ folders=@(@{path='Tests'}, @{path='Middle'}, @{path='Payroll'}) } | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $fixtureRoot 'fixture.code-workspace')
    foreach ($folder in @('Payroll', 'Middle', 'Tests')) {
        New-TestPackage -Path (Join-Path $fixtureRoot "$folder/.alpackages/library.app") -Id $externalId
    }
    $testCache = Join-Path $fixtureRoot 'Tests/.alpackages'
    foreach ($name in @('Sicom_Payroll_23.0.0.7.app', 'Sicom_Payroll_23.0.0.42.app', 'renamed.dep.app')) {
        New-TestPackage -Path (Join-Path $testCache $name) -Id $payrollId
    }
    @{ 'al.packageCachePath' = @('.alpackages', 'extra-cache') } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $fixtureRoot 'Tests/.vscode/settings.json')
    New-TestPackage -Path (Join-Path $fixtureRoot 'Tests/extra-cache/another-renamed.app') -Id $payrollId
    $sourceHashes = @(Get-ChildItem -LiteralPath $testCache | Get-FileHash | ForEach-Object Hash)
    $env:BCDEVTOOLSET_WORKSPACE_PATH = $fixtureRoot
    $env:BCDEVTOOLSET_WORKSPACE_FILE = Join-Path $fixtureRoot 'fixture.code-workspace'
    $env:BCDEVTOOLSET_ALTOOL_PATH = Join-Path $fixtureRoot 'fake-altool.ps1'
    Set-Content -LiteralPath $env:BCDEVTOOLSET_ALTOOL_PATH -Value @'
if ($args -contains '--help') { 'altool compile'; exit 0 }
$cache = ($args | Where-Object { $_ -like '-packagecachepath:*' }).Substring(18)
$project = ($args | Where-Object { $_ -like '-project:*' }).Substring(9)
$output = ($args | Where-Object { $_ -like '-out:*' }).Substring(5)
$global:observedCaches += $cache
$app = Get-Content -LiteralPath (Join-Path $project 'app.json') -Raw | ConvertFrom-Json
$global:compiledApps += $app.name
$files = @(Get-ChildItem -LiteralPath $cache -Filter '*.app')
if ($files.Name -notcontains 'library.app') { throw 'External dependency missing' }
if ($app.name -eq 'Tests') {
    if ($files.Count -ne 3 -or $files.Name -notcontains 'Sicom_Payroll_23.0.0.16.app' -or
        $files.Name -notcontains 'Sicom_Middle_23.0.0.16.app') { throw 'Stale or missing transitive workspace dependency' }
}
New-TestPackage -Path $output -Id $app.id
exit 0
'@
    # A nonterminating copy error must stop dependent compilation.
    function Copy-Item {
        [CmdletBinding()] param([string] $LiteralPath, [string] $Destination, [switch] $Force)
        $global:stagedCaches += $Destination
        if (($global:copyFailure -eq 'external' -and $LiteralPath -like '*library.app') -or
            ($global:copyFailure -eq 'workspace' -and $LiteralPath -like '*Sicom_Payroll*')) {
            Write-Error 'Simulated copy failure with private backend detail'
            return
        }
        Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force -ErrorAction Stop
    }
    foreach ($mode in @('success', 'corrupt', 'external', 'workspace')) {
        $global:compiledApps = @(); $global:observedCaches = @(); $global:stagedCaches = @(); $global:copyFailure = $mode
        $invalidPackage = Join-Path $testCache 'invalid.app'
        if ($mode -eq 'corrupt') { Set-Content -LiteralPath $invalidPackage -Value 'broken package' }
        try {
            & (Join-Path $fixtureRoot 'operations/BuildAllApps.ps1') -SkipOperationUI
            if ($mode -ne 'success') { throw 'Cache failure was accepted' }
            if (($global:compiledApps -join ',') -ne 'Payroll,Middle,Tests') { throw 'Incorrect build order' }
        } catch {
            if ($mode -eq 'success') { throw }
            if (-not $_.Exception.Data['BcDevToolsetExpectedFailure'] -or $_.Exception.Data['Stage'] -ne 'build package cache' -or
                $_.Exception.Message -notmatch 'Check|replace' -or $_.Exception.Message -notmatch 'not started' -or
                $_.Exception.Message -match 'private backend detail') { throw }
            if ($global:compiledApps -contains 'Tests') { throw 'Dependent compiler ran after cache failure' }
            if ($mode -eq 'external' -and $global:compiledApps.Count) { throw 'Compiler ran after import failure' }
        } finally {
            if (Test-Path -LiteralPath $invalidPackage) { Remove-Item -LiteralPath $invalidPackage }
        }
        foreach ($cache in @($global:observedCaches + $global:stagedCaches)) {
            if (Test-Path -LiteralPath $cache) { throw 'Temporary cache was not cleaned up' }
        }
        $afterHashes = @(Get-ChildItem -LiteralPath $testCache | Get-FileHash | ForEach-Object Hash)
        if (($sourceHashes -join ',') -ne ($afterHashes -join ',')) { throw 'Source cache was modified' }
    }
} finally {
    # Only remove this test-owned, direct child of the OS temporary directory.
    $validatedFixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
    if ([IO.Path]::GetDirectoryName($validatedFixtureRoot) -eq $temporaryRoot -and
        [IO.Path]::GetFileName($validatedFixtureRoot).StartsWith('bc-build-cache-test-')) {
        Remove-Item -LiteralPath $validatedFixtureRoot -Recurse -Force -ErrorAction Stop
    }
}
