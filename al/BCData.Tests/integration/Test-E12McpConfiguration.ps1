$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'E12McpConfiguration.ps1')
$runId = '12345678-1234-4234-8234-123456789abc'
$original = [pscustomobject]@{name='Original';bcCredential=$true;custom='preserved'}
$settings = [pscustomobject]@{configurations=@($original)}
$users = @(Get-E12McpAliases 'bcdata23test' $runId | ForEach-Object {
    [pscustomobject]@{kind=$_.kind;username=$_.username;password='synthetic-only'}
})
Add-E12McpAliases $settings 'bcdata23test' $runId $users
if ($settings.configurations.Count -ne 5 -or $settings.configurations[0] -ne $original) { throw 'Original settings changed.' }
if (@($settings.configurations | Where-Object { $_.name -ne 'Original' -and ($_.bcData.provisioningEnabled -ne $false -or $_.bcCredential -ne $false) }).Count) { throw 'Fixture flags are incorrect.' }
$caught = $false
try { Add-E12McpAliases $settings 'bcdata23test' $runId $users } catch { $caught = $true }
if (-not $caught -or $settings.configurations.Count -ne 5) { throw 'Collision was not rejected atomically.' }
$settings.configurations[1].bcUser = 'changed'
$caught = $false
try { Remove-E12McpAliases $settings 'bcdata23test' $runId } catch { $caught = $true }
if (-not $caught -or $settings.configurations.Count -ne 5) { throw 'Changed ownership was not preserved.' }
$settings.configurations[1].bcUser = $users[0].username
$unrelated = [pscustomobject]@{name='Added during qualification'}
$settings.configurations += $unrelated
Remove-E12McpAliases $settings 'bcdata23test' $runId
if ($settings.configurations.Count -ne 2 -or $settings.configurations[0] -ne $original -or $settings.configurations[1] -ne $unrelated) { throw 'Cleanup did not preserve unrelated settings.' }
Remove-E12McpAliases $settings 'bcdata23test' $runId
Write-Host 'E12 MCP configuration checks passed: scope, collision, ownership, original/unrelated preservation, idempotent cleanup.'
