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
    throw "The 'sqlBackupPath' setting is empty. Please set it in BC-Dev-Toolset/settings.json before creating a SQL backup."
}

$configurationFound = $false
foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
    $configurationFound = $true

    if ([System.IO.Path]::IsPathRooted($backupPathSetting)) {
        $exportRootPath = $backupPathSetting
    } else {
        $exportRootPath = Join-Path ((Get-Item $scriptRoot).Parent).FullName $backupPathSetting
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $sharedBackupPath = Join-Path $hostHelperFolder "Extensions\$($configuration.container)\SqlBackups\$timestamp"
    New-Item -ItemType Directory -Path $sharedBackupPath -Force | Out-Null
    New-Item -ItemType Directory -Path $exportRootPath -Force | Out-Null

    Write-Host ""
    Write-Host "Creating SQL backup set for container '$($configuration.container)'." -ForegroundColor Green
    Write-Host "Shared working folder: $sharedBackupPath" -ForegroundColor Gray
    Write-Host "Export folder: $exportRootPath" -ForegroundColor Gray

    Backup-BcContainerDatabases `
        -containerName $configuration.container `
        -bakFolder $sharedBackupPath

    Get-ChildItem -Path $exportRootPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force

    Get-ChildItem -Path $sharedBackupPath -Filter "*.bak" -File |
        Move-Item -Destination $exportRootPath -Force

    $restoreNotePath = Join-Path $exportRootPath "RESTORE_TARGET.txt"
    $restoreNote = @(
        "Backup set folder: $exportRootPath"
        "Source container: $($configuration.container)"
        ""
        "Restore target:"
        "Use this folder as a full BC container backup set."
        "app.bak is restored to the application database."
        "default.bak is restored to tenant 'default'."
        "Other tenant-name .bak files are restored to matching tenants."
    )
    $restoreNote | Set-Content -Path $restoreNotePath -Encoding UTF8

    Remove-Item -Path $sharedBackupPath -Force -Recurse

    Write-Host "SQL backup set exported for container '$($configuration.container)'." -ForegroundColor Green
    Write-Host "Restore target note: $restoreNotePath" -ForegroundColor Gray
}

if (-not $configurationFound) {
    Write-Host "No Docker configurations found." -ForegroundColor Red
}

Write-Done
