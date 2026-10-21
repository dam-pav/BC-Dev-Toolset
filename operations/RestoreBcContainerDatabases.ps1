$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/ContainerLifecycle.ps1
. $scriptRoot/common/PublishApps.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

# A failed restore can leave BC unhealthy with its database absent. Require the
# container to run so SQL recovery can proceed; do not require BC to be healthy
# or provision apps before restoring the database it depends on.
Ensure-ConfiguredContainers -SettingsJSON $settingsJSON -SkipMissing -RequireRunningOnly

Restore-BcContainerSqlBackupSet `
    -scriptPath $scriptRoot `
    -settingsJSON $settingsJSON

Write-Done
