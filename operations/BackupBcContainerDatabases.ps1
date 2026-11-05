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

$readyContainers = @()
Ensure-ConfiguredContainers -SettingsJSON $settingsJSON -SkipMissing -SkipUnavailable -ReadyContainerNames ([ref]$readyContainers)

# Only ready targets may reach the picker, including its "all" option.
$availableConfigurations = @($settingsJSON.configurations | Where-Object {
    $_.serverType -eq 'Container' -and ([string]$_.container).Trim() -in $readyContainers
})
if ($availableConfigurations.Count -eq 0) {
    Write-Error 'No available containers for SQL backup export. No backup was started. Recover a configured container and retry.' -ErrorAction Stop
}

Export-BcContainerSqlBackupSet `
    -scriptPath $scriptRoot `
    -settingsJSON @{ configurations = $availableConfigurations }

Write-Done
