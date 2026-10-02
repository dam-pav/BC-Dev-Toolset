$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $scriptRoot 'common/WorkspaceMgt.ps1')
. (Join-Path $scriptRoot 'common/ContainerLifecycle.ps1')

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context -scriptPath $scriptRoot -settingsJSON ([ref]$settingsJSON) -workspaceJSON ([ref]$workspaceJSON)
Ensure-ConfiguredContainers -SettingsJSON $settingsJSON
Write-Done
