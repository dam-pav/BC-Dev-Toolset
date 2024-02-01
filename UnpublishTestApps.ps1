Clear-Host

$scriptPath = $PSScriptRoot
. $scriptPath/common/WorkspaceMgt.ps1
. $scriptPath/common/PublishApps.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptPath  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)


Unpublish-Apps `
    -scriptPath $scriptPath `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON `
    -targetType "Test"

Write-Done