Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot `
    -settingsJSON ([ref]$settingsJSON) `
    -workspaceJSON ([ref]$workspaceJSON)

if (-not ($authContext)) {
    $authContext = @{}
}

$publishAsNormalApps = Confirm-Option `
    -question "Do you want to publish apps as normal apps (not Dev)?" `
    -PromptId "publishApps2Test.publishAsNormalApps" `
    -Risk "Changes the test environment publish mode from Dev endpoint publishing to normal app publishing."

Publish-Apps `
    -scriptPath $scriptRoot `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON `
    -targetType "Test" `
    -publishAsDev:(-not $publishAsNormalApps) `
    -skipMissing `
    -authContext ([ref]$authContext)

Write-Done
