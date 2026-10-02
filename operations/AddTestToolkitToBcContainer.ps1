Clear-Host

$scriptRoot = (Get-Item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/ContainerLifecycle.ps1

Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot `
    -settingsJSON ([ref]$settingsJSON) `
    -workspaceJSON ([ref]$workspaceJSON)

Ensure-ConfiguredContainers -SettingsJSON $settingsJSON -SkipMissing

if (-not (Add-TestToolkitToConfiguredContainer -settingsJSON $settingsJSON)) {
    return
}

Write-Done
