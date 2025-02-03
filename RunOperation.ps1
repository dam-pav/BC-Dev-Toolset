$scriptPath = $PSScriptRoot
. $scriptPath/common/WorkspaceMgt.ps1
$operations = 'operations'
$visualization = 'visualization'

# Operation list
$menuOptions = @(
    @{ Text = "Create/Overwrite Docker container based on the first app.json found in the workspace"; ScriptPath = Join-Path $scriptPath $operations 'NewDockerContainer.ps1' }
    @{ Text = "Update launch.json files in all apps in the workspace"; ScriptPath = Join-Path $scriptPath $operations 'UpdateLaunchJson.ps1' }
    #@{ Text = "Install fonts from the configuration to the existing container"; ScriptPath = Join-Path $scriptPath $operations 'InstallFontsToContainer.ps1' }
    @{ Text = "Publish dependencies from the configuration to the existing container"; ScriptPath = Join-Path $scriptPath $operations 'PublishDependencies2Docker.ps1' }
    @{ Text = "Publish dependencies from the configuration to test environments"; ScriptPath = Join-Path $scriptPath $operations 'PublishDependencies2Test.ps1' }
    @{ Text = "Publish all apps in the workspace to Docker container"; ScriptPath = Join-Path $scriptPath $operations 'PublishApps2Docker.ps1' }
    @{ Text = "Publish all apps in the workspace to production environments"; ScriptPath = Join-Path $scriptPath $operations 'PublishApps2Production.ps1' }
    @{ Text = "Publish all apps in the workspace to test environments"; ScriptPath = Join-Path $scriptPath $operations 'PublishApps2Test.ps1' }
    @{ Text = "Create runtime packages for all apps in the workspace"; ScriptPath = Join-Path $scriptPath $operations 'CreateRuntimePackage.ps1' }
    @{ Text = "Publish runtime packages (stored) to the existing container"; ScriptPath = Join-Path $scriptPath $operations 'PublishRuntimeApps2Docker.ps1' }
    @{ Text = "Publish runtime packages (stored) to production environments"; ScriptPath = Join-Path $scriptPath $operations 'PublishRuntimeApps2Production.ps1' }
    @{ Text = "Publish runtime packages (stored) to test environments"; ScriptPath = Join-Path $scriptPath $operations 'PublishRuntimeApps2Test.ps1' }
    @{ Text = "Unpublish all workspace apps from Docker container"; ScriptPath = Join-Path $scriptPath $operations 'UnpublishDockerApps.ps1' }
    @{ Text = "Unpublish all workspace apps from test environments"; ScriptPath = Join-Path $scriptPath $operations 'UnpublishTestApps.ps1' }
    @{ Text = "Prepare object id range data for visualization"; ScriptPath = Join-Path $scriptPath $visualization 'DataUpdate.ps1' }
    @{ Text = "Update BcContainerHelper module"; ScriptPath = Join-Path $scriptPath $operations 'UpdateBcContainerHelper.ps1' }
)

# Call the function with custom options
Show-Menu -Title "Select a script to run [press Enter to select, ESC to abort selection]:" -Options $menuOptions