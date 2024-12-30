Clear-Host

$scriptPath = (get-item $PSScriptRoot).Parent
. $scriptPath/common/WorkspaceMgt.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptPath  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)


$replaceJSON = Confirm-Option -question "Do you want to clear existing launch.json files so that only new settings remain?"
if ($replaceJSON -eq $true) {
    Write-Host "Launch.json setup will be replaced." -ForegroundColor Blue
} else {
    Write-Host "Launch.json setup will be kept and extended, if necessary." -ForegroundColor Blue
}

foreach ($appPath in $workspaceJSON.folders.path) {
    Write-LaunchJSON `
    -scriptPath $scriptPath `
    -appPath $appPath `
    -settingsJSON $settingsJSON `
    -replaceJSON $replaceJSON
}

Write-Done
