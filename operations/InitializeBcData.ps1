$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $scriptRoot 'common/WorkspaceMgt.ps1')
. (Join-Path $scriptRoot 'common/BcDataMgt.ps1')
$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context -scriptPath $scriptRoot -settingsJSON ([ref]$settingsJSON) -workspaceJSON ([ref]$workspaceJSON)
$connectionId = Request-BcDevToolsetMcpPrompt -PromptId 'bcData.connectionId' -Type 'text' -Question 'Exact configuration name of the Dev/Test container to initialize'
if ($null -eq $connectionId) { $connectionId = Read-Host 'Exact configuration name of the Dev/Test container to initialize' }
$matches = @($settingsJSON.configurations | Where-Object name -eq $connectionId)
if ($matches.Count -ne 1 -or $matches[0].name -cne $connectionId) { throw 'Choose an exact unique configuration name. No target was changed.' }
Assert-BcDataConfiguration -Configuration $matches[0]
if (-not (Confirm-Option -question "Initialize BC Data on '$connectionId'? Installs/upgrades only the companion and preserves newer compatible versions. Tool exposure remains separately configured." -defaultYes:$false -PromptId 'bcData.initialize' -Risk 'Installs or upgrades the BC Data companion on this one development container.')) { return }
Initialize-BcDataCompanion -ToolsetRoot $scriptRoot -Configuration $matches[0] | Out-Null
Write-Done
