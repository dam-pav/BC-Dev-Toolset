Clear-Host

$scriptPath = (get-item $PSScriptRoot).Parent
. $scriptPath/common/WorkspaceMgt.ps1
. $scriptPath/common/PublishApps.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptPath  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

if (-not ($authContext)) {
    $authContext = @{}
}
Publish-Dependencies `
    -settingsJSON $settingsJSON `
    -targetType "Test" `
    -authContext ([ref]$authContext)

Write-Done