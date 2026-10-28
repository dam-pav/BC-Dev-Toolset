$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
$realPublishApps = ${function:Publish-Apps}
$realPublishDependencies = ${function:Publish-Dependencies}
$realUnpublishApps = ${function:Unpublish-Apps}
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Request-BcDevToolsetMcpPrompt { param($PromptId, $Type, $Question, $Choices) $script:choices = $Choices; $script:answer }
function Select-IndexFromList { 1 }
function Confirm-Option { $script:modePrompts++; $false }
function Test-DockerProcess { $script:dockerCalls++ }
function Ensure-ConfiguredContainers { param($SettingsJSON, [switch]$SkipMissing, [switch]$SkipBcDataProvisioning) Assert ($SettingsJSON.configurations.Count -eq 1) 'Readiness escaped selection'; $script:readyTarget = $SettingsJSON.configurations[0].name }
function Publish-Apps { param($scriptPath, $settingsJSON, $workspaceJSON, $publishAsDev, $runtime, [switch]$skipMissing, [ref]$authContext) $script:deployment = $settingsJSON.configurations; $script:dev = $publishAsDev; $script:runtime = $runtime }
function Publish-Dependencies { param($settingsJSON, [ref]$authContext) $script:deployment = $settingsJSON.configurations }
function Unpublish-Apps { param($scriptPath, $settingsJSON, $workspaceJSON) $script:deployment = $settingsJSON.configurations }
$configs = @(
    [pscustomobject]@{name='dev';serverType='Container';targetType='Dev';container='dev'},
    [pscustomobject]@{name='test-a';serverType='Container';targetType='Test';container='test-a'},
    [pscustomobject]@{name='test-b';serverType='Container';targetType='Test';container='test-b'},
    [pscustomobject]@{name='production';serverType='OnPrem';targetType='Production';serverInstance='BC'},
    [pscustomobject]@{name='cloud';serverType='Cloud';targetType='Test';environmentName='Sandbox'},
    [pscustomobject]@{name='incomplete';serverType='Container';targetType='Test'}
)
$settings = [pscustomobject]@{configurations=$configs;dependenciesPaths=@('dependencies')}
foreach ($mode in @('Apps','Dependencies','Runtime','Unpublish')) {
    foreach ($name in @('dev','test-a','test-b','production','cloud')) {
        $script:answer=$name
        $script:dockerCalls=0; $script:readyTarget=''; $script:modePrompts=0; $script:deployment=@()
        $excluded = $name -eq 'cloud' -and $mode -in @('Runtime','Unpublish')
        $caught=$false
        try { Invoke-SelectedPublishingOperation -scriptPath $PSScriptRoot -settingsJSON $settings -workspaceJSON @{} -Mode $mode }
        catch { if (-not $excluded) { throw }; $caught=$true }
        Assert ($caught -eq $excluded) 'Unsupported cloud target must be rejected'
        if ($excluded) { Assert ($script:deployment.Count -eq 0 -and $script:dockerCalls -eq 0) 'Invalid selection caused side effects'; continue }
        Assert (@($script:deployment).Count -eq 1 -and $script:deployment[0].name -eq $name) "$mode deployed outside $name"
        Assert ($script:dockerCalls -eq [int]($name -in @('dev','test-a','test-b'))) 'Docker was accessed for a non-container'
        if ($script:dockerCalls) { Assert ($script:readyTarget -eq $name) 'Wrong container prepared' }
        if ($mode -in @('Apps','Runtime')) {
            Assert ($script:dev -eq ($mode -eq 'Apps' -and $name -ne 'production')) 'Incorrect Dev/Production publish mode'
            Assert ($script:runtime -eq ($mode -eq 'Runtime')) 'Incorrect package type'
        }
        Assert ($settings.configurations.Count -eq 6) 'Original settings were mutated'
        Assert ($script:choices -notcontains 'incomplete') 'Incomplete target was offered'
    }
}
foreach ($answer in @('missing','TEST-A','incomplete','')) {
    $script:answer=$answer
    $caught=$false
    try { Select-PublishingConfiguration -SettingsJSON $settings -Mode Apps | Out-Null } catch { $caught=$true }
    Assert $caught 'Invalid exact name must be rejected'
}
$script:answer=$null
Assert ((Select-PublishingConfiguration -SettingsJSON $settings -Mode Apps).name -eq 'test-a') 'Interactive selection failed'
$script:answer='dev'
foreach ($invalid in @(@(), @($configs[0], $configs[0]))) {
    $caught=$false
    try { Select-PublishingConfiguration -SettingsJSON @{configurations=$invalid} -Mode Apps | Out-Null } catch { $caught=$true }
    Assert $caught 'Empty or ambiguous configuration list must fail'
}
Write-Host 'Publishing selection regression tests passed.'

# Exercise real deployment helpers with a selected settings object and mocked transports.
& {
    $script:targets = [Collections.Generic.List[string]]::new()
    function Get-SortedApps { @([pscustomobject]@{Name='Workspace';Path='.'}) }
    function Get-PackageParams { param($scriptPath,$settingsJSON,$appJSON,$runtime,[ref]$packageName,[ref]$packagePath) $packageName.Value='workspace.app'; $packagePath.Value=$PSScriptRoot }
    function Test-Path { $true }
    function Get-ChildItem { @([pscustomobject]@{Extension='.app';FullName='dependency.app'}) }
    function Test-DockerContainerExists { $true }
    function Test-BcContainerTenantAccessible { $true }
    function Publish-BcContainerApp { param($containerName) $script:targets.Add($containerName) }
    function Get-AppJSON { param($scriptPath,$appPath,[ref]$appJSON) $appJSON.Value=[pscustomobject]@{application='23.0';Name='Workspace';AppId='id'} }
    function Get-AppDependencies { param($apps) @([pscustomobject]@{Name='Workspace';AppId='id';ProcessOrder=1}) }
    function Get-BcContainerAppInfo { @([pscustomobject]@{Name='Workspace';AppId='id'}) }
    function UnInstall-BcContainerApp { param($containerName) $script:targets.Add($containerName) }
    function Sync-BcContainerApp { param($containerName) $script:targets.Add($containerName) }
    function Unpublish-BcContainerApp { param($containerName) $script:targets.Add($containerName) }
    $selected = @{configurations=@($configs[2]);dependenciesPaths=@('dependencies')}
    $workspace = @{folders=@(@{path='.'})}
    & $realPublishApps -scriptPath $PSScriptRoot -settingsJSON $selected -workspaceJSON $workspace -publishAsDev $false
    & $realPublishDependencies -settingsJSON $selected
    & $realUnpublishApps -scriptPath $PSScriptRoot -settingsJSON $selected -workspaceJSON $workspace
    Assert (($script:targets -join ',') -eq 'test-b,test-b,test-b,test-b,test-b') 'Real helpers must deploy/unpublish only the selected Test target without a group filter'
}
