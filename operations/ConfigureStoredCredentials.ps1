. (Join-Path (Split-Path $PSScriptRoot -Parent) 'common/WorkspaceMgt.ps1')

if (Test-RemotingAgentWorkflow) {
    throw 'Stored credential setup requires the human Configure stored credentials operation. Passwords cannot be supplied through MCP. Agent operations can use already stored credentials.'
}
$settings = @{}
$workspace = @{}
Initialize-Context -scriptPath (Split-Path $PSScriptRoot -Parent) -settingsJSON ([ref]$settings) -workspaceJSON ([ref]$workspace)
$configurations = @($settings.configurations | Where-Object { $_.name -ne 'sample' })
if ($configurations.Count -eq 0) { throw 'No eligible configurations found (sample is excluded).' }
$index = Select-IndexFromList -Title 'Select configuration for stored credentials:' -Options @($configurations | ForEach-Object { "$($_.name) ($($_.serverType))" })
$configuration = $configurations[$index]
$kinds = if ($configuration.serverType -eq 'Container') { @('bc','remote','database') } else { @('remote','database') }
$kindIndex = Select-IndexFromList -Title 'Select credential purpose:' -Options $kinds
$kind = $kinds[$kindIndex]
$credential = Get-Credential -Message "Store $kind credentials for '$($configuration.name)' and enable ${kind}Credential in its configuration"
if (-not $credential) { Write-Host 'Credential setup cancelled.'; return }
Save-ConfigurationCredential -configuration $configuration -kind $kind -credential $credential
