
function Publish-Dependencies2Docker {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )
    Write-Host "" -ForegroundColor Blue
    Write-Host "Deploying dependencies." -ForegroundColor Blue
    $filterExtension = ".app"  # Replace with the file extension you want to filter by
    $appList = @()
    
    if ($settingsJSON.dependenciesPath -ne '') {
        # List all files in the folder and filter by extension
        $filteredFiles = Get-ChildItem -Path $settingsJSON.dependenciesPath | Where-Object { $_.Extension -eq $filterExtension }
        foreach ($appFile in $filteredFiles) {
            Write-Host "Adding '$appFile' to deployment list." -ForegroundColor Gray
            $appList += $appFile.FullName
        }
    }
    
    if ($appList.length -gt 0) {
        foreach ($configuration in $($settingsJSON.configurations | Where-Object { $_.targetType -eq "Dev" -and $_.serverType -eq "Container" })) {
            Write-Host "Deploying dependencies to '$($configuration.name)'." -ForegroundColor Blue
            #Write-Host "Publish-BcContainerApp -containerName $($configuration.container) -appFile $appFile -skipVerification -install -scope Tenant" -ForegroundColor Green
            Publish-BcContainerApp -ErrorAction SilentlyContinue -containerName $configuration.container -appFile $appList -skipVerification -install -scope Tenant -sync
        }
        Write-Host "Dependencies deployed." -ForegroundColor Green
    } else {
        Write-Host "No dependencies to deploy." -ForegroundColor Green
    }
}

function Publish-Apps {
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

    $sortedApps = (Get-SortedApps -workspaceJSON $workspaceJSON)
    $rootFolder = (Get-Item $scriptPath).Parent
    $appList = @()

    foreach ($configuration in $($settingsJSON.configurations | Where-Object  { $_.targetType -eq $targetType })) {
        Write-Host "Deploying apps to '$($configuration.name)'." -ForegroundColor Blue
        foreach ($App in $sortedApps) {
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
                $packagePath = $App.Path
                if (-not $packagePath.Contains('\')) {
                    $packagePath = (Join-Path $rootFolder.Fullname $packagePath)
                }
            }
            $appFile = (Join-Path $packagePath $packageName)

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
            switch ($configuration.serverType) {
                'Cloud' { 
                    if ($authContext.value.AccessToken) {
                        $renewAuthContext = Confirm-Option "Do you want to request a new Authentication context?"
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
                    
                    $params = @{
                        bcAuthContext = $authContext.Value
                        environment = $configuration.environmentName
                        appFiles = $appList
                    }

                    if ($targetType = 'Dev') {
                        Publish-BcContainerApp @params
                    } else {
                        Publish-PerTenantExtensionApps @params
                    }
                }
                'Container' {
                    $params = @{
                        containerName = $configuration.container
                        appFile = $appList
                        skipVerification = $true
                        install = $true
                        scope = 'Tenant'
                        sync = $true
                    }
                    Publish-BcContainerApp -ErrorAction SilentlyContinue -ErrorVariable ex @params
                    if ($ex) {
                        Write-Host "An error occurred:" -ForegroundColor Red
                        Write-Host $ex.Exception -ForegroundColor Red
                    }
                }
                'OnPrem' {
                    foreach ($appFile in $appList) {
                        $App = Get-NAVAppInfo -Path $appFile
                        Write-Host "Deploying $($App.name)" -ForegroundColor Gray
                        Publish-NAVApp -ServerInstance $configuration.serverInstance -Path $appFile -SkipVerification -Scope Global
                        Sync-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name
                        Install-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name
                    }
                }
                Default {
                    Write-Host "Deploying to serverType $serverType is not yet supported." -ForegroundColor Blue
                }
            }
        }
    }
}
function Unpublish-Apps {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
        [Parameter(Mandatory=$true)]
        [string] $targetType
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
    if ($sortedApps.length -gt 0) {
        foreach ($configuration in $($settingsJSON.configurations | Where-Object { $_.targetType -eq $targetType })) {
            Write-Host "Removing apps from '$($configuration.name)'." -ForegroundColor Blue
            switch ($configuration.serverType) {
                'Cloud' {
                    Write-Host "                       " -BackgroundColor Yellow
                    Write-Host " !!! Not available !!! " -ForegroundColor Green -BackgroundColor Yellow
                    Write-Host "                       " -BackgroundColor Yellow
                
                    Write-Host ""
                    Write-Host "See here:"
                    Write-Host "https://github.com/microsoft/navcontainerhelper/issues/2808"
                    Write-Host ""
                }
                'Container' {
                    $installedApps = (Get-BcContainerAppInfo -containerName $configuration.container)
        
                    ForEach ($App in ($sortedApps|Sort-Object -Property ProcessOrder -Descending)) {
                        Write-Host "Try removing $($App.Name) (Order: $($App.ProcessOrder))"
                        $installedApps | Where-Object { $_.Name -eq $App.Name -and $_.AppId -eq $App.AppId } | ForEach-Object{
                            $params = @{
                                containerName = $configuration.container
                                Name = $App.Name
                                Force = $true
                                doNotSaveData = $true
                                doNotSaveSchema = $true
                            }
                            UnInstall-BcContainerApp @params           
                            
                            $params = @{
                                containerName = $configuration.container
                                appName = $App.Name
                                Force = $true
                            }
                            Sync-BcContainerApp @params
                            
                            $params = @{
                                containerName = $configuration.container
                                Name = $App.Name
                                Force = $true
                            }
                            Unpublish-BcContainerApp @params
                        }
                    }
                }
                'OnPrem' {
                    $installedApps = (Get-NAVAppInfo -ServerInstance $configuration.serverInstance)

                    ForEach ($App in ($sortedApps|Sort-Object -Property ProcessOrder -Descending)) {
                        $installedApps | Where-Object { $_.Name -eq $App.Name -and $_.AppId -eq $App.AppId } | ForEach-Object{
                            Write-Host "Try removing '$($App.name) (Order: $($App.ProcessOrder))'" -ForegroundColor Gray
                            Uninstall-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name 
                            Unpublish-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name
                            Write-Host "'$($App.name)' removed." -ForegroundColor Green
                        }    
                    }
                }
                Default {
                    Write-Host "Deploying to serverType $serverType is not yet supported." -ForegroundColor Blue
                }
            }
        }
    }
}
