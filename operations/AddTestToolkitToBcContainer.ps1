Clear-Host

$scriptRoot = (Get-Item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1

Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot `
    -settingsJSON ([ref]$settingsJSON) `
    -workspaceJSON ([ref]$workspaceJSON)

if (-not (Add-TestToolkitToConfiguredContainer -settingsJSON $settingsJSON)) {
    return
}

Write-Done
