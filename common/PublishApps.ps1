
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
        [bool] $runtime = $false,
        [switch] $skipMissing,
        [ref] $authContext
    )

    Write-Host "                      " -BackgroundColor Yellow
    Write-Host " !!! EXPERIMENTAL !!! " -ForegroundColor Green -BackgroundColor Yellow
    Write-Host "                      " -BackgroundColor Yellow

    $sortedApps = (Get-SortedApps -workspaceJSON $workspaceJSON)
    $rootFolder = (Get-Item $scriptPath).Parent
    $appList = @()

    foreach ($configuration in $($settingsJSON.remoteConfigurations | Where-Object targetType -eq $targetType)) {
        Write-Host "Deploying apps to '$($configuration.name)'." -ForegroundColor Blue
        ForEach ($App in $sortedApps) {
            Write-Host "Preparing '$($App.Name)' for deployment." -ForegroundColor Blue
            $packageName = ""
            $packagePath = ""
            Get-PackageParams `
                -settingsJSON $settingsJSON  `
                -appJSON $App `
                -runtime $runtime `
                -packageName ([ref]$packageName) `
                -packagePath ([ref]$packagePath)
            
            $appFile = $App.Path
            if (-not $appFile.Contains('\')) {
                $appFile = "$($rootFolder.Fullname)\$appFile"
            }
            $appFile += "\$packageName"
            $appReady = Test-Path $appFile
            if ($appReady -eq $false) {
                if ($skipMissing) {
                    Write-Host "$appFile does not exist. Deployment will be skipped." -ForegroundColor Red
                } else {
                    throw "$appFile does not exist. Please build all apps before attempting deployment."
                }
            }

            if ($appReady -eq $true) {
                #TODO: lots of testing    
                if ($configuration.serverType -eq 'OnPrem') {
                    Write-Host ""
                    Write-Host "Deploying $($App.name)" -ForegroundColor Gray
                    Publish-NAVApp -ServerInstance $ServerInstance -Path $package -SkipVerification -Scope Global
                    Sync-NAVApp -ServerInstance $ServerInstance -Name $App.name
                    Install-NAVApp -ServerInstance $ServerInstance -Name $App.name
                } else {
                    Write-Host "Adding '$appFile' to deployment list." -ForegroundColor Gray
                    $appList += $appFile
                }
            }
        }
        if (($configuration.serverType -ne 'OnPrem') -and ($appList.length -gt 0)) {
            if ($authContext.value.AccessToken) {
                $renewAuthContext = Confirm-Option "Do you want to renew the Authentication context?"
            } else {
                $renewAuthContext = $true
            }

            if ($renewAuthContext) {
                #get authenticated
                Start-Process "https://microsoft.com/devicelogin"
                $authContext.Value = New-BcAuthContext `
                    -includeDeviceLogin `
                    -tenantID $configuration.tenant `
                    -refreshToken $refreshToken
            }

            Publish-PerTenantExtensionApps `
                -bcAuthContext $authContext.Value `
                -environment $configuration.environmentName `
                -appFiles $appList
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
    Write-Host "                                     " -BackgroundColor Yellow
    Write-Host " !!! No functioning solution yet !!! " -ForegroundColor Green -BackgroundColor Yellow
    Write-Host "                                     " -BackgroundColor Yellow

    Write-Host ""
    Write-Host "See here:"
    Write-Host "https://github.com/microsoft/navcontainerhelper/issues/2808"
    Write-Host ""
    return

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
function Publish-Apps2Docker {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
        [bool] $runtime = $false,
        [switch] $skipMissing
    )


    $sortedApps = (Get-SortedApps -workspaceJSON $workspaceJSON)
    $rootFolder = (Get-Item $scriptPath).Parent
    $appList = @()

    ForEach ($App in $sortedApps) {
        Write-Host "Preparing '$($App.Name)' for deployment." -ForegroundColor Blue
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

        $appReady = Test-Path $appFile
        if ($appReady -eq $false) {
            if ($skipMissing) {
                Write-Host "$appFile does not exist. Deployment will be skipped." -ForegroundColor Red
            } else {
                throw "$appFile does not exist. Please build all apps before attempting deployment."
            }
        }

        if ($appReady -eq $true) {
            Write-Host "Adding '$appFile' to deployment list." -ForegroundColor Gray
            $appList += $appFile
        }
    }
    if ($appList.length -gt 0) {
        Write-Host "" -ForegroundColor Blue
        Write-Host "Deploying apps." -ForegroundColor Blue
        #Write-Host "Publish-BcContainerApp -containerName $($settingsJSON.containerName) -appFile $appFile -skipVerification -install -scope Tenant" -ForegroundColor Green
        Publish-BcContainerApp -containerName $settingsJSON.containerName -appFile $appList -skipVerification -install -scope Tenant
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
