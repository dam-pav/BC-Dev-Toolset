Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/TestMgt.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

Invoke-PageScriptTests `
    -settingsJSON $settingsJSON `
    -targetType "Dev"

Write-Done
