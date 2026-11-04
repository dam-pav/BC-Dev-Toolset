$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $scriptRoot 'common/WorkspaceMgt.ps1')
. (Join-Path $scriptRoot 'common/BcDataMgt.ps1')
$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context -scriptPath $scriptRoot -settingsJSON ([ref]$settingsJSON) -workspaceJSON ([ref]$workspaceJSON)
$configuration = Select-BcDataInitializationConfiguration -SettingsJSON $settingsJSON
$connectionId = $configuration.name
Assert-BcDataConfiguration -Configuration $configuration
if (-not (Confirm-Option -question "Initialize BC Data on '$connectionId'? Installs/upgrades only the companion and preserves newer compatible versions. Tool exposure remains separately configured." -defaultYes:$false -PromptId 'bcData.initialize' -Risk 'Installs or upgrades the BC Data companion on this selected configuration.')) { return }
Initialize-BcDataCompanion -ToolsetRoot $scriptRoot -Configuration $configuration -SettingsJSON $settingsJSON | Out-Null
Write-Done
