Clear-Host

$scriptPath = $PSScriptRoot
. $scriptPath/common/WorkspaceMgt.ps1

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptPath  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

foreach ($appPath in $workspaceJSON.folders.path) {
    $appJSON = @{}
    Get-AppJSON `
        -scriptPath $scriptPath `
        -appPath $appPath  `
        -appJSON ([ref]$appJSON)
    
    if ($null -ne $appJSON.application) {
        $packageName = ""
        $packagePath = ""
        Get-PackageParams `
            -settingsJSON $settingsJSON  `
            -appJSON $appJSON `
            -packageName ([ref]$packageName) `
            -packagePath ([ref]$packagePath)
        
        # Extract the package from Docker
        Export-BcContainerRuntimePackage -containerName $settingsJSON.containerName -appName $appJSON.name -packageFileName $packageName -packageFilePath $packagePath -certificateFile  $settingsJSON.certificateFile
    }
}

Write-Done