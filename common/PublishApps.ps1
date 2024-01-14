
function Publish-Apps2Remote {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
        [Parameter(Mandatory=$true)]
        [string] $targetType,
        [bool] $runtime = $false
    )

    Write-Host "                      " -BackgroundColor Yellow
    Write-Host " !!! EXPERIMENTAL !!! " -ForegroundColor Green -BackgroundColor Yellow
    Write-Host "                      " -BackgroundColor Yellow

    $sortedApps = (Get-SortedApps -workspaceJSON $workspaceJSON)
    $rootFolder = (Get-Item $scriptPath).Parent

    foreach ($configuration in $($settingsJSON.remoteConfigurations | Where-Object targetType -eq $targetType)) {
        Write-Host "Deploying apps to '$($configuration.name)'." -ForegroundColor Blue
        ForEach ($App in $sortedApps) {
                $packageName = ""
                $packagePath = ""
                Get-PackageParams `
                    -settingsJSON $settingsJSON  `
                    -appJSON $App `
                    -runtime $runtime `
                    -packageName ([ref]$packageName) `
                    -packagePath ([ref]$packagePath)
                
                # Do it
                #Write-Host "Publish-BcContainerApp -containerName $($settingsJSON.containerName) -appFile $(Join-Path $packagePath $packageName)" -ForegroundColor Green
                #Publish-BcContainerApp -containerName $settingsJSON.containerName -appFile $(Join-Path $packagePath $packageName) -skipVerification -install -scope Tenant
                $appFile = $App.Path
                if (-not $appFile.Contains('\')) {
                    $appFile = "$($rootFolder.Fullname)\$appFile"
                }
                $appFile += "\$packageName"
                Write-Host "Publishing '$appFile'." -ForegroundColor Blue
                $authContext = New-BcAuthContext -refreshToken $refreshToken
                Publish-PerTenantExtensionApps `
                    -bcAuthContext $authContext `
                    -environment $settingsJSON.environmentType `
                    -appFiles $appFile
                
                #TODO: lots of testing    
                #if ($onprem) {
                #    Write-Host ""
                #    Write-Host "Deploying $($App.name)" -ForegroundColor Green
                #    Publish-NAVApp -ServerInstance $ServerInstance -Path $package -SkipVerification -Scope Global
                #    Sync-NAVApp -ServerInstance $ServerInstance -Name $App.name
                #    Install-NAVApp -ServerInstance $ServerInstance -Name $App.name
                #}
            }
    }
}

function Publish-Apps2Docker {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
        [bool] $runtime = $false
    )


    $sortedApps = (Get-SortedApps -workspaceJSON $workspaceJSON)
    $rootFolder = (Get-Item $scriptPath).Parent

    ForEach ($App in $sortedApps) {
            $packageName = ""
            $packagePath = ""
            Get-PackageParams `
                -settingsJSON $settingsJSON  `
                -appJSON $App `
                -runtime $runtime `
                -packageName ([ref]$packageName) `
                -packagePath ([ref]$packagePath)

            if ($packagePath -eq "") {
                $appFile = $App.Path
                if (-not $appFile.Contains('\')) {
                    $appFile = "$($rootFolder.Fullname)\$appFile"
                }
                $appFile += "\$packageName"
            } else {
                $appFile = (Join-Path $packagePath $packageName)
            }
            Write-Host "" -ForegroundColor Blue
            Write-Host "Publishing '$($App.name)'." -ForegroundColor Blue
                
            # Do it
            try {
                Write-Host "Publish-BcContainerApp -containerName $($settingsJSON.containerName) -appFile $appFile -skipVerification -install -scope Tenant" -ForegroundColor Green
                Publish-BcContainerApp -containerName $settingsJSON.containerName -appFile $appFile -skipVerification -install -scope Tenant
                }
            catch {
                Write-Host "Publishing '$($App.name)' failed." -ForegroundColor Blue
            }
    }
}

function Unpublish-Docker {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON
    )

    $appList = @()    
    foreach ($appPath in $workspaceJSON.folders.path) {
        $appJSON = @{}
        Get-AppJSON `
            -scriptPath $scriptPath `
            -appPath $appPath  `
            -appJSON ([ref]$appJSON)
            
        if ($null -ne $appJSON.application) {
            $appList = $appList + @($appJSON)
        } 
    }
    
    $sortedApps = (Get-AppDependencies($appList) | Sort-Object ProcessOrder)
    $installedApps = (Get-BcContainerAppInfo -containerName $settingsJSON.containerName)
    
    ForEach ($App in ($sortedApps|Sort-Object -Property ProcessOrder -Descending)) {
        Write-Host "Try removing $($App.Name) (Order: $($App.ProcessOrder))"
        $installedApps | Where-Object { $_.Name -eq $App.Name -and $_.AppId -eq $App.AppId } | ForEach-Object{
            $params = @{
                containerName = $settingsJSON.containerName
                Name = $App.Name
                force = $true
                doNotSaveData = $true
                doNotSaveSchema = $true
            }
            UnInstall-NavContainerApp @params           
            $params = @{
                containerName = $settingsJSON.containerName
                Name = $App.Name
                force = $true
            }
            Unpublish-BcContainerApp @params
        }
    }
}

function Unpublish-Remote {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON
    )
    Write-Host "                      " -BackgroundColor Yellow
    Write-Host " !!! EXPERIMENTAL !!! " -ForegroundColor Green -BackgroundColor Yellow
    Write-Host "                      " -BackgroundColor Yellow

    $appList = @()    
    foreach ($appPath in $workspaceJSON.folders.path) {
        $appJSON = @{}
        Get-AppJSON `
            -scriptPath $scriptPath `
            -appPath $appPath  `
            -appJSON ([ref]$appJSON)
                
        if ($null -ne $appJSON.application) {
            $appList = $appList + @($appJSON)
        } 
    }
    
    $sortedApps = (Get-AppDependencies($appList) | Sort-Object ProcessOrder)
    $installedApps = (Get-BcContainerAppInfo -containerName $settingsJSON.containerName)
    

    foreach ($configuration in $($settingsJSON.remoteConfigurations | Where-Object targetType -eq $targetType)) {
        Write-Host "Removing apps from '$($configuration.name)'." -ForegroundColor Blue
        ForEach ($App in ($sortedApps|Sort-Object -Property ProcessOrder -Descending)) {
            Write-Host "Try removing $($App.Name) (Order: $($App.ProcessOrder))"
            $installedApps | Where-Object { $_.Name -eq $App.Name -and $_.AppId -eq $App.AppId } | ForEach-Object{
                #Write-Host "UnInstall-BcContainerApp -containerName $($settingsJSON.containerName) -Name $($App.Name) -Version $($_.Version)"
                UnInstall-NavContainerApp -containerName $settingsJSON.containerName -Name $App.Name -force            
                #Write-Host "Unpublish-BcContainerApp -containerName $($settingsJSON.containerName) -Name $($App.Name) -Version $($_.Version)"
                Unpublish-BcContainerApp -containerName $settingsJSON.containerName -Name $App.Name -force            

                
                #TODO: lots of testing    
                #if ($onprem) {
                #    Write-Host ""
                #    Write-Host "Removing $($App.name)" -ForegroundColor Green
                #    Uninstall-NAVApp -ServerInstance $ServerInstance -Name $App.name
                #    Unpublish-NAVApp -ServerInstance $ServerInstance -Name $App.name
                #}
            }
        }
    }
}