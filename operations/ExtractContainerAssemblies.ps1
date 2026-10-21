$scriptRoot = (Get-Item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/ContainerLifecycle.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot `
    -settingsJSON ([ref]$settingsJSON) `
    -workspaceJSON ([ref]$workspaceJSON)

Ensure-ConfiguredContainers -SettingsJSON $settingsJSON -SkipMissing

Test-DockerProcess

if (-not (Invoke-ContainerAssemblyExtraction `
    -scriptPath $scriptRoot `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON)) {
    return
}

Write-Host ''
Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Yellow
Write-Host 'Reload VS Code now (Developer: Reload Window) so the new .netpackages folders are loaded into the workspace.' -ForegroundColor Yellow
Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Yellow
Write-Host ''

Write-Done
