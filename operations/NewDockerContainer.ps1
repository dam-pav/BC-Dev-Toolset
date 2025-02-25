Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

# Make sure Docker is running
Test-DockerProcess

# Not exactly related, but can help when switching between builds with different names. Expect prompts.
Clear-Artifacts -scriptPath $scriptRoot

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

# Find the first extension setup. Assume all extensions require the same platform version.
$appJSON = @{}
foreach ($appPath in $workspaceJSON.folders.path) {
    Get-AppJSON `
        -scriptPath $scriptRoot `
        -appPath $appPath  `
        -appJSON ([ref]$appJSON)

    if ($appJSON.application) {
        break
    } 
}

# Build a new container
$selectArtifact = "Closest"
if ($workspaceJSON.settings."dam-pav.bcdevtoolset".selectArtifact) {
    $selectArtifact = $workspaceJSON.settings."dam-pav.bcdevtoolset".selectArtifact
}
$success = $false
$success = New-DockerContainer `
    -testMode $false `
    -scriptPath $scriptRoot `
    -appJSON $appJSON `
    -settingsJSON $settingsJSON `
    -selectArtifact $selectArtifact


if ($success -eq $true) {
    # Deploy external apps
    Write-Host ""
    Write-Host "Deploying apps with dependencies to the new container." -ForegroundColor Green
    Publish-Dependencies `
        -settingsJSON $settingsJSON `
        -targetType "Dev"

    # Update environments
    Write-Host ""
    Write-Host "Updating launch.json for all apps." -ForegroundColor Green
    foreach ($appPath in $workspaceJSON.folders.path) {
        Write-LaunchJSON `
        -scriptPath $scriptRoot `
        -appPath $appPath `
        -settingsJSON $settingsJSON
    }
}

Write-Done    