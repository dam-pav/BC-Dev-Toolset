Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

$backupPathSetting = $settingsJSON.sqlBackupPath
if ([string]::IsNullOrWhiteSpace($backupPathSetting)) {
    throw "The 'sqlBackupPath' setting is empty. Please set it in BC-Dev-Toolset/settings.json before restoring a SQL backup."
}

$configurationFound = $false
foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
    $configurationFound = $true

    $backupRootPath = Get-SqlBackupRootPath `
        -scriptPath $scriptRoot `
        -sqlBackupPath $backupPathSetting

    if (-not (Test-Path -Path $backupRootPath -PathType Container)) {
        throw "The sqlBackupPath folder '$backupRootPath' does not exist."
    }

    $backupFiles = @(Get-ChildItem -Path $backupRootPath -Filter "*.bak" -File -ErrorAction SilentlyContinue)
    if ($backupFiles.Count -eq 0) {
        throw "No .bak files found at sqlBackupPath '$backupRootPath'."
    }

    $sharedRestorePath = Copy-SqlBackupSetToSharedFolder `
        -containerName $configuration.container `
        -backupRootPath $backupRootPath `
        -sharedFolderName "SqlRestore"

    Write-Host ""
    Write-Host "Preparing to restore SQL backup set to container '$($configuration.container)'." -ForegroundColor Green
    Write-Host "Backup folder: $backupRootPath" -ForegroundColor Gray
    Write-Host "Shared restore folder: $sharedRestorePath" -ForegroundColor Gray
    Write-Host "Files:" -ForegroundColor Gray
    Get-ChildItem -Path $sharedRestorePath -Filter "*.bak" -File | ForEach-Object {
        Write-Host " - $($_.Name)" -ForegroundColor Gray
    }
    Write-Host "This will replace the matching application and tenant databases in the container." -ForegroundColor Yellow

    if (-not (Confirm-Option -question "Do you want to restore the backup set from '$backupRootPath' to container '$($configuration.container)'?")) {
        Write-Host "Restore skipped for container '$($configuration.container)'." -ForegroundColor Blue
        continue
    }

    Restore-DatabasesInBcContainer `
        -containerName $configuration.container `
        -bakFolder $sharedRestorePath

    Write-Host "SQL backup set restored to container '$($configuration.container)'." -ForegroundColor Green
}

if (-not $configurationFound) {
    Write-Host "No Docker configurations found." -ForegroundColor Red
}

Write-Done
