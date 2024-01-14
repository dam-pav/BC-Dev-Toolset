Clear-Host

$scriptPath = $PSScriptRoot
. $scriptPath/common/WorkspaceMgt.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptPath  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

foreach ($appPath in $workspaceJSON.folders.path) {
    Write-LaunchJSON `
    -scriptPath $scriptPath `
    -appPath $appPath `
    -settingsJSON $settingsJSON
}

Write-Done