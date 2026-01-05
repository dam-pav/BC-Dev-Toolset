Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

Invoke-Tests `
    -settingsJSON $settingsJSON `
    -targetType "Dev"

Write-Done
