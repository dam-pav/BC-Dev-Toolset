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

Publish-Apps `
    -scriptPath $scriptPath `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON `
    -runtime $true `
    -targetType "Dev" `
    -skipMissing

Write-Done