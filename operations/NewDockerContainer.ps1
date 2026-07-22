Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/PublishApps.ps1

# Initialize context
$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

Remove-RedundantAppRegionSettings `
    -scriptPath $scriptRoot `
    -workspaceJSON $workspaceJSON

# Validate all apps before prompting for, or making, container changes.
$appJSON = @{}
if (-not (Test-WorkspaceApplicationVersions `
    -scriptPath $scriptRoot `
    -workspaceJSON $workspaceJSON `
    -appJSON ([ref]$appJSON))) {
    return
}

# Make sure Docker is running
Test-DockerProcess

# Not exactly related, but can help when switching between builds with different names. Expect prompts.
Clear-Artifacts -scriptPath $scriptRoot -workspaceJSON $workspaceJSON

# Ask whether to pull full artifacts
$pullFullArtifact = (Confirm-Option -question "Do you want to perform a complete pull of all artifacts? This will take longer but ensure you have the latest base image and artifacts. Do this if your previous pull attempt resulted in errors during container deployment, such as version mismatches between data and components." -defaultYes:$false -PromptId "newDockerContainer.pullFullArtifact" -Risk "Downloads fresh artifacts and can significantly increase container creation time.")
if ($pullFullArtifact) {
    Write-Host "All artifacts will be pulled." -ForegroundColor Blue
}

# Build a new container
$selectArtifact = "Latest"
if ($workspaceJSON.settings."dam-pav.bcdevtoolset".selectArtifact) {
    $selectArtifact = $workspaceJSON.settings."dam-pav.bcdevtoolset".selectArtifact
}
$success = $false
$success = New-DockerContainer `
    -testMode $false `
    -scriptPath $scriptRoot `
    -appJSON $appJSON `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON `
    -selectArtifact $selectArtifact `
    -pullFullArtifact $pullFullArtifact


if ($success -eq $true) {
    # Apply server configuration
    Write-Host ""
    Write-Host "Applying server configuration to the new container." -ForegroundColor Green
    Update-ContainerServerConfiguration `
        -settingsJSON $settingsJSON

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
