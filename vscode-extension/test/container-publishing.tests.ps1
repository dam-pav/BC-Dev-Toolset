$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Get-SortedApps { $script:apps }
function Get-PackageParams {
    param($scriptPath,$settingsJSON,$appJSON,$runtime,[ref]$packageName,[ref]$packagePath)
    $packageName.Value = "$($appJSON.Name).app"; $packagePath.Value = $PSScriptRoot
}
function Test-Path { $true }
function Test-DockerContainerExists { param($containerName) Assert ($containerName -eq 'selected') 'Readiness escaped selected target'; $true }
function Test-BcContainerTenantAccessible { param($containerName) Assert ($containerName -eq 'selected') 'Tenant readiness escaped selected target'; $true }
function Resolve-PublishingCredential { @{Credential=[pscredential]::Empty;Prompted=$true} }
function Offer-ConfigurationCredentialStorage { $script:saves++ }
function Uninstall-BcContainerApp { throw 'Normal publishing must not uninstall' }
function Write-Host { param($Object,$ForegroundColor,[switch]$NoNewline) $script:output += [string]$Object }

# A hermetic transport contract double, based on BcContainerHelper 6.1.19's
# Publish-NavContainerApp.ps1. These simulated records/markers are not evidence
# of actual BC data preservation or platform Upgrade trigger execution.
function Publish-BcContainerApp {
    [CmdletBinding()]
    param($containerName,$appFile,[switch]$skipVerification,[switch]$install,[switch]$sync,$scope,
        [switch]$upgrade,[switch]$ignoreIfAppExists,[switch]$useDevEndpoint,[switch]$replacePackageId,$credential)
    $script:attempts++
    Assert ($containerName -eq 'selected') 'Publishing escaped selected target'
    Assert ($skipVerification -and $install -and $sync -and $scope -eq 'Tenant') 'Existing publish options changed'
    Assert ($useDevEndpoint.IsPresent -eq $script:dev) 'Wrong publishing endpoint'
    if ($useDevEndpoint) {
        Assert ($replacePackageId -and $PSBoundParameters.ContainsKey('credential')) 'Dev options/credentials changed'
        Assert (-not $PSBoundParameters.ContainsKey('upgrade') -and -not $PSBoundParameters.ContainsKey('ignoreIfAppExists')) 'Normal-only options reached Dev endpoint'
    } else {
        Assert ($upgrade -and $ignoreIfAppExists) 'Normal publishing must install or upgrade and skip already installed versions'
        Assert (-not $replacePackageId -and -not $PSBoundParameters.ContainsKey('credential')) 'Dev options reached normal publishing'
    }
    if ($script:failure -eq 'throw') { throw 'private backend payload' }
    if ($script:failure -eq 'error') { Write-Error 'private backend payload'; return }
    if ($useDevEndpoint) { return }
    foreach ($file in $appFile) {
        $name = [IO.Path]::GetFileNameWithoutExtension($file)
        $package = @($script:apps | Where-Object Name -eq $name)[0]
        $state = $script:installed[$name]
        if ($ignoreIfAppExists -and $state -and $state.Version -ge $package.Version) {
            $script:events += "skip:$name"
        } elseif ($state) {
            if (-not $upgrade) { throw 'Cannot install a different version of the same app ID' }
            $state.Version = $package.Version; $state.UpgradeMarker++
            $script:events += "upgrade:$name"
        } else {
            $script:installed[$name] = @{Version=$package.Version;Rows=@();UpgradeMarker=0}
            $script:events += "install:$name"
        }
    }
}
function Reset-Scenario {
    $script:attempts=0; $script:saves=0; $script:events=@(); $script:output=@(); $script:installed=@{}; $script:failure=''; $script:dev=$false
    $script:apps=@([pscustomobject]@{Name='Fixture';Version=[version]'26.0.0.50';Dependencies=@()})
}
function Invoke-Publish {
    param([string]$Role='Dev')
    $configuration=@{name='selected';serverType='Container';targetType=$Role;container='selected';authentication='UserPassword'}
    Publish-Apps -scriptPath $PSScriptRoot -settingsJSON @{configurations=@($configuration)} -workspaceJSON @{} -publishAsDev $script:dev
}
foreach ($role in @('Dev','Test','Production')) {
    Reset-Scenario
    Invoke-Publish $role
    Assert (($script:events -join ',') -eq 'install:Fixture') "$role fresh app was not installed"
    Assert ($script:attempts -eq 1 -and $script:saves -eq 0) 'Normal publication repeated or requested credential storage'
}
foreach ($version in @('26.0.0.49','26.0.0.50','26.0.0.51')) {
    Reset-Scenario
    $rows=@(@{Key='seed';SystemId=[guid]'11111111-1111-1111-1111-111111111111';Value=42})
    $script:installed.Fixture=@{Version=[version]$version;Rows=$rows;UpgradeMarker=0}
    $before=$rows | ConvertTo-Json -Compress
    Invoke-Publish
    $upgrading=$version -eq '26.0.0.49'
    $expected=if($upgrading){'upgrade:Fixture'}else{'skip:Fixture'}
    Assert (($script:events -join ',') -eq $expected) "Incorrect lifecycle for $version"
    Assert (($script:installed.Fixture.Rows | ConvertTo-Json -Compress) -eq $before) 'Simulated seeded row changed'
    Assert ($script:installed.Fixture.UpgradeMarker -eq [int]$upgrading) 'Incorrect simulated upgrade marker'
    Assert ($script:installed.Fixture.Version -eq $(if($upgrading){[version]'26.0.0.50'}else{[version]$version})) 'Installed version downgraded'
}
Reset-Scenario
$script:apps=@(
    [pscustomobject]@{Name='Unchanged';Version=[version]'26.0.0.50';Dependencies=@()},
    [pscustomobject]@{Name='Fixture';Version=[version]'26.0.0.50';Dependencies=@()})
$script:installed.Unchanged=@{Version=[version]'26.0.0.50';Rows=@();UpgradeMarker=0}
$script:installed.Fixture=@{Version=[version]'26.0.0.49';Rows=@();UpgradeMarker=0}
Invoke-Publish
Assert (($script:events -join ',') -eq 'skip:Unchanged,upgrade:Fixture') 'Mixed batch did not preserve order or lifecycle'
Assert ($script:attempts -eq 1) 'Mixed batch was split or repeated'

Reset-Scenario; $script:dev=$true
Invoke-Publish
Assert ($script:attempts -eq 1 -and $script:saves -eq 1) 'Dev credential storage changed'

foreach ($failureMode in @('throw','error')) {
    foreach ($developmentMode in @($false,$true)) {
        Reset-Scenario; $script:failure=$failureMode; $script:dev=$developmentMode; $caught=$null
        $settings=@{configurations=@(
            @{name='selected';serverType='Container';targetType='Dev';container='selected';authentication='UserPassword'},
            @{name='must-not-run';serverType='Container';targetType='Dev';container='other';authentication='Windows'})}
        try { Publish-Apps -scriptPath $PSScriptRoot -settingsJSON $settings -workspaceJSON @{} -publishAsDev $developmentMode } catch { $caught=$_.Exception }
        Assert ($null -ne $caught -and $caught.Data['BcDevToolsetExpectedFailure']) "$failureMode did not propagate a reviewed failure"
        Assert ($caught.Data['Stage'] -eq 'Publishing' -and $caught.Data['DeploymentState'] -eq 'Unknown') 'Failure lost stage or side-effect state'
        Assert ($caught.Message -match 'Publishing \(Container\)' -and $caught.Message -match 'partially completed.*Inspect the installed app version and deployment status before retrying') 'Missing actionable failure/partial-deployment guidance'
        Assert ($caught.Message -notmatch 'private backend payload') 'Backend payload leaked'
        Assert ($script:attempts -eq 1 -and $script:saves -eq 0 -and $script:events.Count -eq 0) 'Failed publication continued, retried or stored credentials'
        Assert (($script:output -join ' ') -notmatch 'done|successfully') 'Failed publication reported success'
    }
}
