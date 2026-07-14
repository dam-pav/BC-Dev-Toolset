Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/BackupMgt.ps1
. $scriptRoot/common/PublishApps.ps1
. $scriptRoot/common/TestMgt.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

$testSettingsJSON = Initialize-TestExecutionContainer `
    -scriptPath $scriptRoot `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON

if ($null -eq $testSettingsJSON) {
    Write-Done
    return
}

Invoke-PageScriptTests `
    -settingsJSON $testSettingsJSON `
    -targetType "Dev"

Write-Done
