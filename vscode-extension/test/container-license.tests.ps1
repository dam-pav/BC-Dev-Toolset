$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')

$script:probes = @()
function Test-Path {
    param([string] $LiteralPath, [string] $PathType)
    $script:probes += $LiteralPath
    if ($PathType -ne 'Leaf') { throw 'License probe must require a file' }
    return $LiteralPath -eq 'C:\valid\license.flf'
}
function Resolve-Path {
    param([string] $LiteralPath)
    return [pscustomobject]@{ Path = $LiteralPath }
}

foreach ($settings in @(
    [pscustomobject]@{},
    [pscustomobject]@{ licenseFile = $null },
    [pscustomobject]@{ licenseFile = '' },
    [pscustomobject]@{ licenseFile = '   ' }
)) {
    $observed = @(Get-ConfiguredContainerLicenseFile -settingsJSON $settings 3>&1)
    $result = $observed -join ''
    if ($result -ne '') { throw 'Blank license must not be passed to container creation' }
    if (@($observed | Where-Object { $_ -is [System.Management.Automation.WarningRecord] }).Count -ne 0) {
        throw 'Blank license must not produce a warning'
    }
}
if ($script:probes.Count -ne 0) { throw 'Blank license triggered a filesystem probe' }

$observed = @(Get-ConfiguredContainerLicenseFile -settingsJSON ([pscustomobject]@{ licenseFile = 'C:\missing\license.flf' }) 3>&1)
if (@($observed | Where-Object { $_ -is [System.Management.Automation.WarningRecord] -and $_.ToString() -match 'could not be found' }).Count -ne 1) {
    throw 'Missing license warning was not reported'
}

$observed = @(Get-ConfiguredContainerLicenseFile -settingsJSON ([pscustomobject]@{ licenseFile = 'C:\valid\license.flf' }) 3>&1)
if ($observed.Count -ne 1 -or $observed[0] -ne 'C:\valid\license.flf') { throw 'Existing license was not resolved' }
if (@($script:probes).Count -ne 2) { throw 'Expected exactly two nonblank license probes' }

Write-Output 'Container license resolution tests passed.'
