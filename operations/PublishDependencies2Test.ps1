Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
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