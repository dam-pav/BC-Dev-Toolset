# for comprehensive Keyname list see: https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/configure-server-instance
Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

# Make sure Docker is runningDocker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)


Update-ContainerServerConfiguration `
    -settingsJSON $settingsJSON

Write-Done
