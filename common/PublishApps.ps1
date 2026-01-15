
function Publish-Dependencies {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType,
        [ref] $authContext
    )
    #Write-Host "" -ForegroundColor Blue
    #Write-Host "Deploying dependencies." -ForegroundColor Blue
    $filterExtension = ".app"  # Replace with the file extension you want to filter by
    $appList = @()
    
    # Support both legacy dependenciesPath (single string) and new dependenciesPaths (array)
    $pathsToProcess = @()
    
    # Add paths from dependenciesPaths array if it exists
    if ($null -ne $settingsJSON.dependenciesPaths -and $settingsJSON.dependenciesPaths.Count -gt 0) {
        $pathsToProcess += $settingsJSON.dependenciesPaths
    }
    
    # Add legacy dependenciesPath if it exists
    if ($settingsJSON.dependenciesPath -ne '' -and $null -ne $settingsJSON.dependenciesPath) {
        $pathsToProcess += $settingsJSON.dependenciesPath
    }
    
    foreach ($dependencyPath in $pathsToProcess) {
        if (Test-Path $dependencyPath) {
            # List all files in the folder and filter by extension
            $filteredFiles = Get-ChildItem -Path $dependencyPath | Where-Object { $_.Extension -eq $filterExtension }
            foreach ($appFile in $filteredFiles) {
                Write-Host "Adding '$appFile' to deployment list." -ForegroundColor Gray
                $appList += $appFile.FullName
            }
        } else {
            Write-Host "Dependency path '$dependencyPath' does not exist. Skipping." -ForegroundColor Yellow
        }
    }
    
    foreach ($configuration in $($settingsJSON.configurations | Where-Object { $_.targetType -eq $targetType })) {
        Write-Host "Deploying dependencies to '$($configuration.name)'." -ForegroundColor Blue
        if ($appList.length -gt 0) {
            switch ($configuration.serverType) {
                'Cloud' { 
                    if ($authContext.value.AccessToken) {
                        $renewAuthContext = Confirm-Option "Do you want to request a new Authentication context?"
                    } else {
                        $renewAuthContext = $true
                    }
    
                    if ($renewAuthContext -eq $true) {
                        #get authenticated
                        $authContext.Value = New-BcAuthContext `
                            -includeDeviceLogin `
                            -tenantID $configuration.tenant `
                            -refreshToken $refreshToken
                        #$continue = Confirm-Option "Continue?" -defaultYes $true
                        #if ($continue -eq $false) {
                        #    throw "Deployment aborted."
                        #}
                        #Start-Process "https://microsoft.com/devicelogin"
                    }
                    
                    $params = @{
                        bcAuthContext = $authContext.Value
                        environment = $configuration.environmentName
                    }

                    Write-Host ""
                    Write-Host "Running " -ForegroundColor green -NoNewline
                    if ($targetType -eq 'Dev') {
                        $params.appFile = $appList
                        Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-BcContainerApp -ErrorAction SilentlyContinue -ErrorVariable ex @params
                    } else {
                        $params.appFiles = $appList
                        Write-Host "Publish-PerTenantExtensionApps" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-PerTenantExtensionApps -ErrorAction SilentlyContinue -ErrorVariable ex @params
                    }
                    if ($ex.length -gt 0) {
                        Write-Host "There was an error." -ForegroundColor Red
                    }
                }
                'Container' {
                    $params = @{
                        containerName = $configuration.container
                        appFile = $appList
                        skipVerification = $true
                        ignoreIfAppExists = $true
                        install = $true
                        upgrade = $true
                        scope = 'Tenant'
                        sync = $true
                    }
                    Write-Host ""
                    Write-Host "Running " -ForegroundColor green -NoNewline
                    Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                    Write-Host ":" -ForegroundColor green
                    Publish-BcContainerApp -ErrorAction SilentlyContinue -ErrorVariable ex @params
                    }
                'OnPrem' {
                    #Import-Module $settingsJSON.loadOnPremMgtModule
                    . $settingsJSON.loadOnPremMgtModule
                    foreach ($appFile in $appList) {
                        $App = Get-NAVAppInfo -Path $appFile
                        Write-Host "Removing '$($App.name)'" -ForegroundColor Green
                        Uninstall-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name 
                        Unpublish-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name
                        Write-Host "Deploying $($App.name)" -ForegroundColor Green
                        Publish-NAVApp -ServerInstance $configuration.serverInstance -Path $appFile -SkipVerification -Scope Global
                        Sync-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name -Version $App.Version
                        Install-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name -Version $App.Version
                    }
                }
            }
            Write-Host "Dependency deployment is done. Please verify the outcome." -ForegroundColor Green
        } else {
            Write-Host "No dependencies to deploy." -ForegroundColor Green
        }
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
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType,
        [bool] $runtime = $false,
        [switch] $skipMissing,
        [ref] $authContext
    )

    $sortedApps = (Get-SortedApps -workspaceJSON $workspaceJSON)
    $rootFolder = (Get-Item $scriptPath).Parent
    $appList = @()
    $ex = @()

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
                    Write-Host "$appFile does not exist. Deployment will be skipped." -ForegroundColor Gray
                } else {
                    throw "$appFile does not exist. Please build all apps before attempting deployment."
                }
            }

            if ($appReady -eq $true) {
                Write-Host "Adding '$appFile' to deployment list." -ForegroundColor Green
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
    
                    if ($renewAuthContext -eq $true) {
                        #get authenticated
                        $authContext.Value = New-BcAuthContext `
                            -includeDeviceLogin `
                            -tenantID $configuration.tenant `
                            -refreshToken $refreshToken
                        #$continue = Confirm-Option "Continue?" -defaultYes $true
                        #if ($continue -eq $false) {
                        #    throw "Deployment aborted."
                        #}
                        #Start-Process "https://microsoft.com/devicelogin"
                    }
                    
                    $params = @{
                        bcAuthContext = $authContext.Value
                        environment = $configuration.environmentName
                    }

                    Write-Host ""
                    Write-Host "Running " -ForegroundColor green -NoNewline
                    if ($targetType -eq 'Dev') {
                        $params.appFile = $appList
                        Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-BcContainerApp -ErrorAction SilentlyContinue -ErrorVariable ex @params
                    } else {
                        $params.appFiles = $appList
                        Write-Host "Publish-PerTenantExtensionApps" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-PerTenantExtensionApps -ErrorAction SilentlyContinue -ErrorVariable ex @params
                    }
                    if ($ex.length -gt 0) {
                        Write-Host "There was an error." -ForegroundColor Red
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
                    Write-Host ""
                    Write-Host "Running " -ForegroundColor green -NoNewline
                    Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                    Write-Host ":" -ForegroundColor green
                    Publish-BcContainerApp -ErrorAction SilentlyContinue -ErrorVariable ex @params
                    if ($ex.length -gt 0) {
                        Write-Host "There was an error." -ForegroundColor Red
                        #Write-Host $ex.Exception -ForegroundColor Red
                    }
                }
                'OnPrem' {
                    #Import-Module $settingsJSON.loadOnPremMgtModule
                    . $settingsJSON.loadOnPremMgtModule
                    foreach ($appFile in $appList) {
                        $App = Get-NAVAppInfo -Path $appFile
                        Write-Host "Removing '$($App.name)'" -ForegroundColor Green
                        Uninstall-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name 
                        Unpublish-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name
                        Write-Host "Deploying $($App.name)" -ForegroundColor Gray
                        Publish-NAVApp -ServerInstance $configuration.serverInstance -Path $appFile -SkipVerification -Scope Global
                        Sync-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name -Version $App.Version
                        Install-NAVApp -ServerInstance $configuration.serverInstance -Name $App.name -Version $App.Version
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
        [ValidateSet("Dev", "Test", "Production")]
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
                    $removeAppData = (Confirm-Option -question "Do you want to REMOVE ALL EXTENSIONS' DATA AND SCHEMA from '$($configuration.name)'?")
                    ForEach ($App in ($sortedApps|Sort-Object -Property ProcessOrder -Descending)) {
                        Write-Host "Try removing $($App.Name) (Order: $($App.ProcessOrder))"
                        $installedApps | Where-Object { $_.Name -eq $App.Name -and $_.AppId -eq $App.AppId } | ForEach-Object{
                            $params = @{
                                containerName = $configuration.container
                                Name = $App.Name
                                Force = $true
                                doNotSaveData = $removeAppData
                                doNotSaveSchema = $removeAppData
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
