Clear-Host

$scriptPath = $PSScriptRoot
. $scriptPath/common/WorkspaceMgt.ps1
. $scriptPath/common/PublishApps.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptPath  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

Install-FontsToContainer `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON `
    -targetType "Dev"

Write-Done
