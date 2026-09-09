Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

try {
    Export-BcServiceSqlBackupSet `
        -scriptPath $scriptRoot `
        -settingsJSON $settingsJSON
}
catch {
    if ($_.Exception.Data['BackupRemotingCancelled']) {
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        return
    }
    throw
}

Write-Done
