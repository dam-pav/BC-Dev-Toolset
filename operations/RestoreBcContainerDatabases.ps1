$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/ContainerLifecycle.ps1
. $scriptRoot/common/PublishApps.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

Restore-BcContainerSqlBackupSet `
    -scriptPath $scriptRoot `
    -settingsJSON $settingsJSON

Write-Done
