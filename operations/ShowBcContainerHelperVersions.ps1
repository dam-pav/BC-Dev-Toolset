Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1

Write-Host ""
Write-Host "Current installed BcContainerHelper version:" -ForegroundColor Green
$currentModule = Get-Module BcContainerHelper -ListAvailable | Select-Object -First 1
if ($currentModule) {
    Write-Host "  Name: $($currentModule.Name)" -ForegroundColor White
    Write-Host "  Version: $($currentModule.Version)" -ForegroundColor White
} else {
    Write-Host "  BcContainerHelper is not installed." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Available BcContainerHelper versions (latest 20):" -ForegroundColor Green
Find-Module BcContainerHelper -AllVersions | Select-Object -First 20 Name, Version, PublishedDate | Format-Table -AutoSize

Write-Done
