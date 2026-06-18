Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

$publishAsNormalApps = Confirm-Option `
    -question "Do you want to publish apps as normal apps (not Dev)?" `
    -PromptId "publishApps2Docker.publishAsNormalApps" `
    -Risk "Changes the Docker publish mode from Dev endpoint publishing to normal app publishing."

Publish-Apps `
    -scriptPath $scriptRoot `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON `
    -targetType "Dev" `
    -publishAsDev:(-not $publishAsNormalApps) `
    -skipMissing

Write-Done
