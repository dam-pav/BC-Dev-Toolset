$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }

$regular = [pscustomobject]@{Name='Test Reporting';Dependencies=@(@{id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})}
$tests = @(
    '5d86850b-0d76-4eca-bd7b-951ad998e997',
    'dd0be2ea-f733-4d65-bb34-a28f4624fb14',
    'e7320ebb-08b3-4406-b1ec-b4927d3e280b',
    '40860557-a18d-42ad-aecb-22b7dd80dc80',
    '5f892a06-a83a-4efb-95eb-9ab4dfb858bc'
) | ForEach-Object { [pscustomobject]@{Name="Suite-$_";Dependencies=@(@{id=$_})} }
$script:apps = @($regular) + @($tests)
function Get-SortedApps { $script:apps }
function Get-PackageParams {
    param($scriptPath,$settingsJSON,$appJSON,$runtime,[ref]$packageName,[ref]$packagePath)
    $script:prepared.Add($appJSON.Name)
    $packageName.Value = "$($appJSON.Name).app"
    $packagePath.Value = $PSScriptRoot
    Assert ($runtime -eq $script:expectedRuntime) 'Incorrect package type'
}
function Test-Path { $true }
function Test-DockerContainerExists { $true }
function Test-BcContainerTenantAccessible { $true }
function Publish-BcContainerApp { param($appFile) $script:published += @($appFile) }
function Get-BcConfigurationCredential { [pscredential]::Empty }

foreach ($role in @('Dev','Test','Production')) {
    foreach ($mode in @('Normal','Dev','Runtime')) {
        if ($role -eq 'Production' -and $mode -eq 'Dev') { continue }
        $script:expectedRuntime = $mode -eq 'Runtime'
        $script:prepared = [Collections.Generic.List[string]]::new()
        $script:published = @()
        $settings = @{configurations=@(@{name='selected';serverType='Container';targetType=$role;container='selected';authentication='Windows'})}
        Publish-Apps -scriptPath $PSScriptRoot -settingsJSON $settings -workspaceJSON @{} `
            -publishAsDev ($mode -eq 'Dev') -runtime $script:expectedRuntime
        Assert (($script:prepared -join ',') -eq 'Test Reporting') "$role/$mode prepared test packages"
        Assert ($script:published.Count -eq 1 -and (Split-Path $script:published[0] -Leaf) -eq 'Test Reporting.app') "$role/$mode published test apps"
    }
}

# A test-only workspace must never call the publishing transport or prepare test packages.
$script:apps = @($tests)
$script:prepared.Clear(); $script:published = @()
Publish-Apps -scriptPath $PSScriptRoot -settingsJSON $settings -workspaceJSON @{} -publishAsDev $false
Assert ($script:prepared.Count -eq 0 -and $script:published.Count -eq 0) 'Test-only workspace was published'

# Internal test preparation explicitly includes the suites it is about to execute.
$script:apps = @($regular) + @($tests)
$script:expectedRuntime = $false
$settings.configurations[0].targetType = 'Test'
Publish-Apps -scriptPath $PSScriptRoot -settingsJSON $settings -workspaceJSON @{} -publishAsDev $true -IncludeTestApps
Assert ($script:prepared.Count -eq 6 -and $script:published.Count -eq 6) 'Explicit test preparation lost its test apps'
