
function Get-OnPremDevelopmentPublishUri {
    param($Configuration)

    $server = $null
    if (-not [Uri]::TryCreate([string]$Configuration.server, [UriKind]::Absolute, [ref]$server) -or
        $server.Scheme -notin @('http', 'https') -or $server.UserInfo -or $server.Query -or $server.Fragment) {
        throw "OnPrem configuration '$($Configuration.name)' requires an HTTP(S) server URL without credentials, query or fragment."
    }
    $port = 0
    if (-not [int]::TryParse([string]$Configuration.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "OnPrem configuration '$($Configuration.name)' requires a developer-services port from 1 to 65535."
    }
    if ([string]::IsNullOrWhiteSpace($Configuration.serverInstance) -or $Configuration.serverInstance -match '[/\\?#]') {
        throw "OnPrem configuration '$($Configuration.name)' requires a valid serverInstance."
    }
    $builder = [UriBuilder]::new($server)
    $builder.Port = $port
    $builder.Path = '/' + [Uri]::EscapeDataString($Configuration.serverInstance) + '/dev/apps'
    $builder.Query = 'SchemaUpdateMode=synchronize&DependencyPublishingOption=ignore'
    if (-not [string]::IsNullOrWhiteSpace($Configuration.tenant)) {
        $builder.Query = $builder.Query.TrimStart('?') + '&tenant=' + [Uri]::EscapeDataString($Configuration.tenant)
    }
    return $builder.Uri
}

function Resolve-PublishingPackagePath {
    param([string] $Root, [string] $Path)

    # The root is explicitly authorized by the workspace app folder or package-output setting.
    $validatedRoot = [IO.Path]::GetFullPath($Root)
    $validatedPackagePath = [IO.Path]::GetFullPath($Path)
    $relative = [IO.Path]::GetRelativePath($validatedRoot, $validatedPackagePath)
    if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith('../') -or $relative.StartsWith('..\') -or
        [IO.Path]::GetExtension($validatedPackagePath) -ne '.app') {
        throw 'The publishing package must be an .app file inside its authorized package folder.'
    }
    return $validatedPackagePath
}

function Resolve-PublishingCredential {
    param($Configuration, [ValidateSet('bc', 'remote')] [string] $Kind)

    try {
        $credential = if ($Kind -eq 'bc') { Get-BcConfigurationCredential -configuration $Configuration }
            else { Get-ConfigurationCredential -configuration $Configuration -kind $Kind }
        if (-not $credential) { throw "No $Kind credential was found for '$($Configuration.name)'." }
        return [pscustomobject]@{ Credential=$credential; Prompted=$false }
    } catch {
        if (Test-RemotingAgentWorkflow) { throw }
        Write-Host "Could not load $Kind credentials for '$($Configuration.name)'. Enter credentials for this publishing run." -ForegroundColor Yellow
        $credential = Get-Credential -Message "Publishing $Kind credentials for '$($Configuration.name)'"
        if (-not $credential) { throw [OperationCanceledException]::new('Publishing cancelled: credentials were not supplied.') }
        return [pscustomobject]@{ Credential=$credential; Prompted=$true }
    }
}

function Publish-OnPremDevelopmentApps {
    param($Configuration, [array] $Packages)

    $uri = Get-OnPremDevelopmentPublishUri -Configuration $Configuration
    $parameters = @{ Uri=$uri; Method='Post'; ErrorAction='Stop'; MaximumRedirection=0 }
    $resolvedCredential = $null
    $credentialKind = 'bc'
    switch ($Configuration.authentication) {
        'Windows' {
            if ($Configuration.bcCredential -eq $true) {
                $resolvedCredential = Resolve-PublishingCredential -Configuration $Configuration -Kind bc
            } elseif ($Configuration.remoteCredential -eq $true) {
                $credentialKind = 'remote'
                $resolvedCredential = Resolve-PublishingCredential -Configuration $Configuration -Kind remote
            } else {
                $parameters.UseDefaultCredentials = $true
            }
            # The selected configuration explicitly uses Windows authentication over
            # HTTP. PowerShell requires this switch even for negotiated Windows auth.
            if ($uri.Scheme -eq 'http') { $parameters.AllowUnencryptedAuthentication = $true }
        }
        'UserPassword' {
            if ($uri.Scheme -ne 'https') { throw 'OnPrem UserPassword Dev publishing requires an HTTPS developer endpoint.' }
            $parameters.Authentication = 'Basic'
            $resolvedCredential = Resolve-PublishingCredential -Configuration $Configuration -Kind bc
        }
        default { throw "OnPrem Dev publishing requires Windows or UserPassword authentication for '$($Configuration.name)'." }
    }
    if ($resolvedCredential) { $parameters.Credential = $resolvedCredential.Credential }
    foreach ($package in $Packages) {
        # Root comes from the selected workspace app folder (or configured package output).
        # Confine the manifest-derived package name before accessing its file contents.
        $validatedPackagePath = Resolve-PublishingPackagePath -Root $package.Root -Path $package.Path
        $file = Get-Item -LiteralPath $validatedPackagePath -ErrorAction Stop
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The publishing package must be a regular .app file.'
        }
        Write-Host "Publishing '$($file.Name)' to '$uri'." -ForegroundColor Blue
        Invoke-WebRequest @parameters -Form @{ $file.Name = $file } | Out-Null
        Write-Host "Successfully published '$($file.Name)' to '$($Configuration.name)'." -ForegroundColor Green
    }
    if ($resolvedCredential.Prompted -and $Packages.Count -gt 0) {
        Offer-ConfigurationCredentialStorage -configuration $Configuration -kind $credentialKind -credential $resolvedCredential.Credential
    }
}

function Initialize-OnPremPublishingManagement {
    param($SettingsJSON, $Configuration, [switch] $Unpublish)

    $required = @('Get-NAVAppInfo', 'Uninstall-NAVApp', 'Unpublish-NAVApp')
    if (-not $Unpublish) { $required += @('Publish-NAVApp', 'Sync-NAVApp', 'Install-NAVApp') }
    $missing = @($required | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    if ($missing.Count -eq 0) { return }
    $modulePath = $SettingsJSON.loadOnPremMgtModule
    if ($modulePath -isnot [string] -or [string]::IsNullOrWhiteSpace($modulePath)) {
        throw "OnPrem administration for '$($Configuration.name)' requires BC management cmdlets on the BC service host. Load its administration shell or configure loadOnPremMgtModule with the absolute path to NavAdminTool.ps1. For Dev publishing, use Windows or UserPassword authentication with server, serverInstance and the developer-services port; no management module is needed."
    }
    # A management module can live outside the workspace. Authorize only an explicit
    # absolute .ps1 file at this configuration boundary, never an expression or command.
    if (-not [IO.Path]::IsPathFullyQualified($modulePath) -or $modulePath -match '[*?\x00-\x1f]' -or [IO.Path]::GetExtension($modulePath) -ne '.ps1') {
        throw 'loadOnPremMgtModule must be an absolute literal path to the BC administration .ps1 file.'
    }
    $validatedModulePath = [IO.Path]::GetFullPath($modulePath)
    if (-not (Test-Path -LiteralPath $validatedModulePath -PathType Leaf)) {
        throw "BC administration shell was not found at '$validatedModulePath'. Check loadOnPremMgtModule on the BC service host."
    }
    Import-Module -Name $validatedModulePath -Global -ErrorAction Stop | Out-Null
    $missing = @($required | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    if ($missing.Count -gt 0) { throw "BC administration shell did not expose required cmdlets: $($missing -join ', '). Check the BC version and PowerShell compatibility." }
}

function Select-PublishingConfiguration {
    param($SettingsJSON, [ValidateSet('Apps', 'Dependencies', 'Runtime', 'Unpublish')] [string] $Mode)

    $serverTypes = if ($Mode -in @('Runtime', 'Unpublish')) { @('Container', 'OnPrem') } else { @('Container', 'Cloud', 'OnPrem') }
    $configurations = @($SettingsJSON.configurations | Where-Object {
        $_.serverType -in $serverTypes -and $_.targetType -in @('Dev', 'Test', 'Production') -and
        -not [string]::IsNullOrWhiteSpace($_.name) -and
        (($_.serverType -eq 'Container' -and -not [string]::IsNullOrWhiteSpace($_.container)) -or
         ($_.serverType -eq 'Cloud' -and -not [string]::IsNullOrWhiteSpace($_.environmentName)) -or
         ($_.serverType -eq 'OnPrem' -and -not [string]::IsNullOrWhiteSpace($_.serverInstance)))
    })
    if ($configurations.Count -eq 0) { throw "No eligible configurations for $Mode. No target was changed." }
    foreach ($configuration in $configurations) {
        if (@($SettingsJSON.configurations | Where-Object name -eq $configuration.name).Count -ne 1) {
            throw 'Publishing requires unique configuration names. No target was changed.'
        }
    }
    $name = Request-BcDevToolsetMcpPrompt -PromptId 'publishing.configurationName' -Type 'choice' `
        -Question "Select the configuration for $Mode" -Choices @($configurations.name)
    if ($null -eq $name) {
        $index = Select-IndexFromList -Title "Select the configuration for ${Mode}:" `
            -Options @($configurations | ForEach-Object { "$($_.name) ($($_.serverType), $($_.targetType))" })
        if ($null -eq $index -or $index -lt 0 -or $index -ge $configurations.Count) { throw 'Configuration selection cancelled.' }
        return $configurations[$index]
    }
    $selected = @($configurations | Where-Object { $_.name -ceq $name })
    if ($selected.Count -ne 1) { throw 'Choose an exact eligible configuration name. No target was changed.' }
    return $selected[0]
}

function Invoke-SelectedPublishingOperation {
    param($scriptPath, $settingsJSON, $workspaceJSON,
        [ValidateSet('Apps', 'Dependencies', 'Runtime', 'Unpublish')] [string] $Mode)

    $configuration = Select-PublishingConfiguration -SettingsJSON $settingsJSON -Mode $Mode
    # Copy settings so readiness and deployment can only see the selected target.
    $selectedSettings = @{}
    if ($settingsJSON -is [System.Collections.IDictionary]) {
        foreach ($key in $settingsJSON.Keys) { $selectedSettings[$key] = $settingsJSON[$key] }
    } else {
        foreach ($property in $settingsJSON.PSObject.Properties) { $selectedSettings[$property.Name] = $property.Value }
    }
    $selectedSettings.configurations = @($configuration)
    $publishAsDev = $false
    if ($Mode -eq 'Apps' -and $configuration.targetType -ne 'Production') {
        $publishAsDev = -not (Confirm-Option -question 'Do you want to publish apps as normal apps (not Dev)?' `
            -PromptId 'publishing.publishAsNormalApps' -Risk 'Selects normal app publishing instead of the Dev endpoint.')
    }
    if ($configuration.serverType -eq 'Container') {
        Test-DockerProcess
        Ensure-ConfiguredContainers -SettingsJSON $selectedSettings -SkipMissing -SkipBcDataProvisioning
    }
    $authContext = @{}
    switch ($Mode) {
        'Dependencies' { Publish-Dependencies -settingsJSON $selectedSettings -authContext ([ref]$authContext) }
        'Unpublish' { Unpublish-Apps -scriptPath $scriptPath -settingsJSON $selectedSettings -workspaceJSON $workspaceJSON }
        default {
            Publish-Apps -scriptPath $scriptPath -settingsJSON $selectedSettings -workspaceJSON $workspaceJSON `
                -publishAsDev $publishAsDev -runtime ($Mode -eq 'Runtime') -skipMissing -authContext ([ref]$authContext)
        }
    }
}

function Test-BcContainerTenantAccessible {
    Param(
        [Parameter(Mandatory=$true)]
        [string] $containerName,
        [int] $maxAttempts = 12,
        [int] $delaySeconds = 10
    )

    if (-not $containerName) {
        Write-Host "No container name provided to Test-BcContainerTenantAccessible." -ForegroundColor Yellow
        return $false
    }

    if (-not (Test-DockerContainerExists -containerName $containerName)) {
        return $false
    }

    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            Get-BcContainerAppInfo -containerName $containerName -ErrorAction Stop | Out-Null
            if ($attempt -gt 1) { Write-Host "Container '$containerName' became accessible after $attempt attempt(s)." -ForegroundColor Green }
            return $true
        } catch {
            $msg = $_.Exception.Message
            Write-Host "Attempt $attempt/${maxAttempts}: container tenant check failed: $msg" -ForegroundColor Yellow
            if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds $delaySeconds }
        }
    }

    Write-Host "Container tenant for '$containerName' did not become accessible after $maxAttempts attempts." -ForegroundColor Red
    return $false
}

function Publish-Dependencies {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
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
        Write-Host "Looking for files in '$dependencyPath'." -ForegroundColor Blue
        # if the path is a zip file, verify that it exists then add it directly
        if ($dependencyPath.ToLower().EndsWith('.zip')) {
            if (Test-Path $dependencyPath) {
                Write-Host "  Adding zip file '$dependencyPath' to deployment list." -ForegroundColor Gray
                $appList += $dependencyPath
            } else {
                Write-Host "  Zip file '$dependencyPath' does not exist. Skipping." -ForegroundColor Yellow
            }
            continue
        }

        # if the path is a folder, process all files in it
        if (Test-Path $dependencyPath) {
            # List all files in the folder and filter by extension
            $filteredFiles = Get-ChildItem -Path $dependencyPath | Where-Object { $_.Extension -eq $filterExtension }
            if ($filteredFiles.Count -eq 0) {
                Write-Host "  No dependency files found." -ForegroundColor Red
            }
            foreach ($appFile in $filteredFiles) {
                Write-Host "  Adding '$appFile' to deployment list." -ForegroundColor Gray
                $appList += $appFile.FullName
            }
        } else {
            Write-Host "Dependency path '$dependencyPath' does not exist. Skipping." -ForegroundColor Yellow
        }
    }
    
    $targetConfigurations = @($settingsJSON.configurations)
    if (-not [string]::IsNullOrWhiteSpace($targetType)) {
        $targetConfigurations = @($targetConfigurations | Where-Object { $_.targetType -eq $targetType })
    }

    foreach ($configuration in $targetConfigurations) {
        $effectiveTargetType = if ([string]::IsNullOrWhiteSpace($targetType)) { $configuration.targetType } else { $targetType }
        Write-Host "Deploying dependencies to '$($configuration.name)'." -ForegroundColor Blue
        if ($appList.length -gt 0) {
            switch ($configuration.serverType) {
                'Cloud' { 
                    if ($authContext.value.AccessToken) {
                        $renewAuthContext = Confirm-Option `
                            -question "Do you want to request a new Authentication context?" `
                            -PromptId "publishApps.renewAuthenticationContext" `
                            -Risk "Requests a fresh authentication context after the current context failed."
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
                    if ($effectiveTargetType -eq 'Dev') {
                        $params.appFile = $appList
                        Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-BcContainerApp -ErrorAction SilentlyContinue @params
                    } else {
                        $params.appFiles = $appList
                        Write-Host "Publish-PerTenantExtensionApps" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-PerTenantExtensionApps -ErrorAction SilentlyContinue @params
                    }
                }
                'Container' {
                    if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
                        continue
                    }

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
                    
                    # Verify tenant/environment accessibility before attempting publish
                    Write-Host "Waiting for tenant/environment to become accessible before deploying to '$($configuration.name)'." -ForegroundColor Yellow
                    if (-not (Test-BcContainerTenantAccessible -containerName $configuration.container)) {
                        Write-Host "Skipping deployment to '$($configuration.container)' because tenant/environment is not accessible." -ForegroundColor Yellow
                        break
                    }

                    Write-Host ""
                    Write-Host "Running " -ForegroundColor green -NoNewline
                    Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                    Write-Host ":" -ForegroundColor green
                    Publish-BcContainerApp -ErrorAction SilentlyContinue @params
                    }
                'OnPrem' {
                    $managementHost = if (-not [string]::IsNullOrWhiteSpace($configuration.managementServer)) {
                        $configuration.managementServer
                    } else { Get-RemoteComputerNameFromServer -server $configuration.server }
                    if (-not (Test-IsLocalSqlServer -databaseServer $managementHost)) {
                        Publish-RemoteOnPremDependencies -Configuration $configuration -AppFiles $appList
                        break
                    }
                    Initialize-OnPremPublishingManagement -SettingsJSON $settingsJSON -Configuration $configuration
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
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType,
        [Parameter(Mandatory=$true)]
        [bool] $publishAsDev,
        [bool] $runtime = $false,
        [switch] $IncludeTestApps,
        [switch] $skipMissing,
        [ref] $authContext
    )

    $sortedApps = (Get-SortedApps -workspaceJSON $workspaceJSON)
    if (-not $IncludeTestApps) {
        $sortedApps = @($sortedApps | Where-Object {
            if (Test-AppHasTestDependencies -appJSON $_) {
                Write-Host "Skipping test app '$($_.Name)' during publishing." -ForegroundColor Gray
                return $false
            }
            return $true
        })
    }
    $appList = @()

    $targetConfigurations = @($settingsJSON.configurations)
    if (-not [string]::IsNullOrWhiteSpace($targetType)) {
        $targetConfigurations = @($targetConfigurations | Where-Object { $_.targetType -eq $targetType })
    }

    foreach ($configuration in $targetConfigurations) {
        $effectiveTargetType = if ([string]::IsNullOrWhiteSpace($targetType)) { $configuration.targetType } else { $targetType }
        if (($effectiveTargetType -eq 'Production') -and ($publishAsDev -eq $true)) {
            throw "Publishing as Dev is not supported for Production targets."
        }
        Write-Host "Deploying apps to '$($configuration.name)'." -ForegroundColor Blue
        $packages = @()
        foreach ($App in $sortedApps) {
            Write-Host "Preparing '$($App.Name)' for deployment." -ForegroundColor Blue
            $packageName = ""
            $packagePath = ""
            Get-PackageParams `
                -scriptPath $scriptPath `
                -settingsJSON $settingsJSON  `
                -appJSON $App `
                -runtime $runtime `
                -packageName ([ref]$packageName) `
                -packagePath ([ref]$packagePath)

            if ($packagePath -eq "") {
                $packagePath = Resolve-WorkspaceFolderPath -scriptPath $scriptPath -folderPath $App.Path
            }
            $appFile = Resolve-PublishingPackagePath -Root $packagePath -Path (Join-Path $packagePath $packageName)

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
                $packages += [pscustomobject]@{ Root=$packagePath; Path=$appFile }
            }
        }
        if ($appList.length -gt 0) {
            switch ($configuration.serverType) {
                'Cloud' { 
                    if ($authContext.value.AccessToken) {
                        $renewAuthContext = Confirm-Option `
                            -question "Do you want to request a new Authentication context?" `
                            -PromptId "publishApps.renewAuthenticationContext" `
                            -Risk "Requests a fresh authentication context after the current context failed."
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
                    if ($publishAsDev -eq $true) {
                        $params.appFile = $appList
                        $params.useDevEndpoint = $true
                        $params.replacePackageId = $true
                        Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-BcContainerApp -ErrorAction SilentlyContinue @params
                    } else {
                        $params.appFiles = $appList
                        Write-Host "Publish-PerTenantExtensionApps" -ForegroundColor Blue -NoNewline
                        Write-Host ":" -ForegroundColor green
                        Publish-PerTenantExtensionApps -ErrorAction SilentlyContinue @params
                    }
                }
                'Container' {
                    if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
                        continue
                    }

                    # Verify tenant/environment accessibility before attempting publish
                    Write-Host "Waiting for tenant/environment to become accessible before deploying to '$($configuration.name)'." -ForegroundColor Yellow
                    if (-not (Test-BcContainerTenantAccessible -containerName $configuration.container)) {
                        Write-Host "Skipping deployment to '$($configuration.container)' because tenant/environment is not accessible." -ForegroundColor Yellow
                        break
                    }

                    $params = @{
                        containerName = $configuration.container
                        appFile = $appList
                        skipVerification = $true
                        install = $true
                        scope = 'Tenant'
                        sync = $true
                    }

                    $resolvedCredential = $null
                    if ($publishAsDev -eq $true) {
                        $params.useDevEndpoint = $true
                        $params.replacePackageId = $true
                        if ($configuration.authentication -ne "Windows") {
                            $resolvedCredential = Resolve-PublishingCredential -Configuration $configuration -Kind bc
                            $params.credential = $resolvedCredential.Credential
                        }
                    }
                    
                    Write-Host ""
                    Write-Host "Running " -ForegroundColor green -NoNewline
                    Write-Host "Publish-BcContainerApp" -ForegroundColor Blue -NoNewline
                    Write-Host ":" -ForegroundColor green
                    Publish-BcContainerApp -ErrorAction Stop @params
                    if ($resolvedCredential.Prompted) {
                        Offer-ConfigurationCredentialStorage -configuration $configuration -kind bc -credential $resolvedCredential.Credential
                    }
                }
                'OnPrem' {
                    if ($publishAsDev) {
                        if ($runtime) { throw 'Runtime packages cannot be published through the OnPrem Dev endpoint.' }
                        Publish-OnPremDevelopmentApps -Configuration $configuration -Packages $packages
                        break
                    }
                    Initialize-OnPremPublishingManagement -SettingsJSON $settingsJSON -Configuration $configuration
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
function Initialize-RemoteOnPremManagement {
    param($Session, [string] $ServerInstance, [string[]] $RequiredCommands)
    Invoke-Command -Session $Session -ErrorAction Stop -ArgumentList @($ServerInstance, $RequiredCommands) -ScriptBlock {
        param($serverInstance, $requiredCommands)
            # Locate tools from the selected service, as remote backup discovery does.
            # A different local/installed BC version must never select the management tools.
            $serviceName = if ($serverInstance.StartsWith('MicrosoftDynamicsNavServer$', [StringComparison]::OrdinalIgnoreCase)) {
                $serverInstance
            } else { 'MicrosoftDynamicsNavServer$' + $serverInstance }
            $services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'MicrosoftDynamicsNavServer%'" -ErrorAction Stop |
                Where-Object { $_.Name -eq $serviceName })
            if ($services.Count -ne 1) { throw "BC service '$serviceName' was not found uniquely. Check serverInstance and managementServer." }
            $serviceCommand = $services[0].PathName.Trim()
            if ($serviceCommand -notmatch '^(?:"(?<exe>[A-Za-z]:\\[^"\r\n]+\\Microsoft\.Dynamics\.Nav\.Server\.exe)"|(?<exe>[A-Za-z]:\\[^"\r\n]+?\\Microsoft\.Dynamics\.Nav\.Server\.exe))(?:\s|$)') {
                throw "BC service '$serviceName' has an unsupported executable path. Cannot safely locate its administration shell."
            }
            # The administrator-managed service registration authorizes this installation
            # root. Access only its fixed administration-shell child after validation.
            $validatedServiceExecutable = [IO.Path]::GetFullPath($Matches['exe'])
            $validatedInstallationRoot = [IO.Path]::GetDirectoryName($validatedServiceExecutable)
            $validatedAdminToolPath = [IO.Path]::Combine($validatedInstallationRoot, 'NavAdminTool.ps1')
            if (-not (Test-Path -LiteralPath $validatedAdminToolPath -PathType Leaf)) { throw "BC administration shell was not found at '$validatedAdminToolPath'. Install or repair this service's administration tools." }
            Import-Module -Name $validatedAdminToolPath -Global -Force -ErrorAction Stop | Out-Null
            foreach ($command in $requiredCommands) {
                if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "BC administration shell did not expose $command. Check the service version and PowerShell compatibility." }
            }
    }
}

function Publish-RemoteOnPremDependencies {
    param($Configuration, [string[]] $AppFiles)

    $computerName = if (-not [string]::IsNullOrWhiteSpace($Configuration.managementServer)) {
        $Configuration.managementServer
    } else { Get-RemoteComputerNameFromServer -server $Configuration.server }
    if ([string]::IsNullOrWhiteSpace($computerName) -or $computerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$') {
        throw 'Remote dependency publishing requires a valid server or managementServer hostname.'
    }
    # Dependency files are explicitly configurable outside the workspace. Validate
    # each literal package path at this boundary before accessing or transferring it.
    $validatedFiles = @($AppFiles | ForEach-Object {
        $validatedPath = [IO.Path]::GetFullPath($_)
        if ([IO.Path]::GetExtension($validatedPath) -notin @('.app','.zip')) { throw 'Dependencies must be .app or .zip files.' }
        $file = Get-Item -LiteralPath $validatedPath -ErrorAction Stop
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Dependencies must be regular files.' }
        $validatedPath
    })
    if ($validatedFiles.Count -eq 0) { return }
    $tenant = if ([string]::IsNullOrWhiteSpace($Configuration.tenant)) { 'default' } else { $Configuration.tenant }
    $stageName = 'BCDevToolsetDependencies-' + [guid]::NewGuid().ToString('D')
    $session = New-RemoteBackupSession -computerName $computerName -configuration $Configuration -OperationName 'Dependency publishing'
    $stagingStarted = $false
    try {
        Initialize-RemoteOnPremManagement -Session $session -ServerInstance $Configuration.serverInstance `
            -RequiredCommands @('Get-NAVAppInfo','Publish-NAVApp','Sync-NAVApp','Install-NAVApp','Start-NAVAppDataUpgrade')
        $stagingStarted = $true
        $stage = Invoke-Command -Session $session -ErrorAction Stop -ArgumentList $stageName -ScriptBlock {
            param($stageName)
            if ($stageName -notmatch '^BCDevToolsetDependencies-[0-9a-f-]{36}$') { throw 'Invalid dependency staging name.' }
            $validatedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
            $validatedStage = [IO.Path]::GetFullPath([IO.Path]::Combine($validatedTempRoot, $stageName))
            if ([IO.Path]::GetDirectoryName($validatedStage).TrimEnd('\','/') -ine $validatedTempRoot.TrimEnd('\','/')) { throw 'Dependency staging escaped the temporary root.' }
            New-Item -ItemType Directory -Path $validatedStage -ErrorAction Stop | Out-Null
            [pscustomobject]@{Root=$validatedTempRoot;Path=$validatedStage}
        }
        # The remote callback may authorize only the generated child of its temp root.
        $validatedRemoteRoot = [IO.Path]::GetFullPath([string]$stage.Root)
        $validatedRemoteStage = [IO.Path]::GetFullPath([string]$stage.Path)
        if ([IO.Path]::GetRelativePath($validatedRemoteRoot, $validatedRemoteStage) -cne $stageName) { throw 'Invalid remote dependency staging location.' }
        for ($index=0; $index -lt $validatedFiles.Count; $index++) {
            $destination = [IO.Path]::Combine($validatedRemoteStage, "$index" + [IO.Path]::GetExtension($validatedFiles[$index]))
            Copy-Item -LiteralPath $validatedFiles[$index] -Destination $destination -ToSession $session -ErrorAction Stop
        }
        $results = @(Invoke-Command -Session $session -ErrorAction Stop -ArgumentList @($Configuration.serverInstance, $tenant, $stageName) -ScriptBlock {
            param($serverInstance, $tenant, $stageName)
            if ($stageName -notmatch '^BCDevToolsetDependencies-[0-9a-f-]{36}$') { throw 'Invalid dependency staging name.' }
            $validatedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
            $validatedStage = [IO.Path]::GetFullPath([IO.Path]::Combine($validatedTempRoot, $stageName))
            if ([IO.Path]::GetDirectoryName($validatedStage).TrimEnd('\','/') -ine $validatedTempRoot.TrimEnd('\','/')) { throw 'Dependency staging escaped the temporary root.' }
            $archives = @(Get-ChildItem -LiteralPath $validatedStage -Filter '*.zip' -File)
            if ($archives.Count -gt 0) { Add-Type -AssemblyName System.IO.Compression.FileSystem }
            foreach ($zip in $archives) {
                $archive = [IO.Compression.ZipFile]::OpenRead($zip.FullName)
                try {
                    foreach ($entry in $archive.Entries) {
                        if ([IO.Path]::GetExtension($entry.Name) -ne '.app') { continue }
                        # Never use an archive entry name as a filesystem path.
                        $destination = [IO.Path]::Combine($validatedStage, [guid]::NewGuid().ToString('D') + '.app')
                        $inputStream=$entry.Open()
                        try {
                            $outputStream=[IO.File]::Create($destination)
                            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
                        } finally { $inputStream.Dispose() }
                    }
                } finally { $archive.Dispose() }
            }
            $packages = @(Get-ChildItem -LiteralPath $validatedStage -Filter '*.app' -File | ForEach-Object {
                [pscustomobject]@{Path=$_.FullName;App=(Get-NAVAppInfo -Path $_.FullName -ErrorAction Stop)}
            })
            # Prefer the latest supplied version of each dependency and resolve its
            # prerequisites before making any changes on the selected service.
            $pending = @($packages | Group-Object { [string]$_.App.AppId } | ForEach-Object {
                $_.Group | Sort-Object { [version]$_.App.Version } -Descending | Select-Object -First 1
            })
            $ordered = @()
            while ($pending.Count -gt 0) {
                $ready = @($pending | Where-Object {
                    $dependencyIds = @($_.App.Dependencies | ForEach-Object { if ($_.AppId) { [string]$_.AppId } else { [string]$_.Id } })
                    @($pending | Where-Object { [string]$_.App.AppId -in $dependencyIds }).Count -eq 0
                })
                if ($ready.Count -eq 0) { throw 'Dependency packages contain a circular dependency. No dependencies were published.' }
                $ordered += $ready
                $pending = @($pending | Where-Object { $_.Path -notin $ready.Path })
            }
            $existing = @(Get-NAVAppInfo -ServerInstance $serverInstance -Tenant $tenant -TenantSpecificProperties -ErrorAction Stop)
            foreach ($package in $ordered) {
                $app=$package.App
                $sameApp = @($existing | Where-Object { [string]$_.AppId -eq [string]$app.AppId })
                $installed = @($sameApp | Where-Object IsInstalled)
                if (@($installed | Where-Object { [version]$_.Version -gt [version]$app.Version }).Count -gt 0) { throw "A newer version of '$($app.Name)' is installed. Dependency downgrades are not supported." }
                if (@($installed | Where-Object { [version]$_.Version -eq [version]$app.Version }).Count -gt 0) {
                    [pscustomobject]@{Name=$app.Name;Version=[string]$app.Version;Status='alreadyInstalled'}
                    continue
                }
                $identity=@{ServerInstance=$serverInstance;Name=$app.Name;Publisher=$app.Publisher;Version=$app.Version;Tenant=$tenant;ErrorAction='Stop'}
                if (@($sameApp | Where-Object { [version]$_.Version -eq [version]$app.Version }).Count -eq 0) {
                    Publish-NAVApp -ServerInstance $serverInstance -Path $package.Path -Scope Tenant -Tenant $tenant -SkipVerification -ErrorAction Stop | Out-Null
                }
                Sync-NAVApp @identity -Mode Add | Out-Null
                if ($installed.Count -gt 0) { Start-NAVAppDataUpgrade @identity | Out-Null }
                else { Install-NAVApp @identity | Out-Null }
                [pscustomobject]@{Name=$app.Name;Version=[string]$app.Version;Status='published'}
            }
        })
        foreach ($result in $results) {
            if ($result.Status -eq 'alreadyInstalled') {
                Write-Host "Dependency '$($result.Name)' version '$($result.Version)' is already installed on '$($Configuration.name)'." -ForegroundColor Green
            } else {
                Write-Host "Successfully published dependency '$($result.Name)' version '$($result.Version)' to '$($Configuration.name)'." -ForegroundColor Green
            }
        }
        if ($results.Count -eq 0) { Write-Host "No dependency app packages were found for '$($Configuration.name)'." -ForegroundColor Yellow }
    } finally {
        try {
            if ($stagingStarted) {
                Invoke-Command -Session $session -ErrorAction Stop -ArgumentList $stageName -ScriptBlock {
                    param($stageName)
                    if ($stageName -notmatch '^BCDevToolsetDependencies-[0-9a-f-]{36}$') { throw 'Invalid dependency staging name.' }
                    $validatedTempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
                    $validatedStage=[IO.Path]::GetFullPath([IO.Path]::Combine($validatedTempRoot,$stageName))
                    if ([IO.Path]::GetDirectoryName($validatedStage).TrimEnd('\','/') -ine $validatedTempRoot.TrimEnd('\','/')) { throw 'Dependency staging escaped the temporary root.' }
                    if (Test-Path -LiteralPath $validatedStage) { Remove-Item -LiteralPath $validatedStage -Recurse -Force -ErrorAction Stop }
                }
            }
        } catch { Write-Warning "Could not remove dependency staging files from '$computerName'." }
        finally { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
    }
}

function Unpublish-RemoteOnPremWorkspaceApps {
    param($Configuration, [array] $Apps)

    $computerName = if (-not [string]::IsNullOrWhiteSpace($Configuration.managementServer)) {
        $Configuration.managementServer
    } else { Get-RemoteComputerNameFromServer -server $Configuration.server }
    if ([string]::IsNullOrWhiteSpace($computerName) -or $computerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$') {
        throw 'Remote OnPrem unpublishing requires a valid server or managementServer hostname.'
    }
    $tenant = if ([string]::IsNullOrWhiteSpace($Configuration.tenant)) { 'default' } else { $Configuration.tenant }
    $session = New-RemoteBackupSession -computerName $computerName -configuration $Configuration -OperationName Unpublish
    try {
        Initialize-RemoteOnPremManagement -Session $session -ServerInstance $Configuration.serverInstance -RequiredCommands @('Get-NAVAppInfo','Uninstall-NAVApp','Unpublish-NAVApp')
        $results = @(Invoke-Command -Session $session -ErrorAction Stop -ArgumentList @($Configuration.serverInstance, $tenant, $Apps) -ScriptBlock {
            param($serverInstance, $tenant, $workspaceApps)

            $publishedApps = @(Get-NAVAppInfo -ServerInstance $serverInstance -Tenant $tenant -TenantSpecificProperties -ErrorAction Stop)
            foreach ($workspaceApp in @($workspaceApps | Sort-Object ProcessOrder -Descending)) {
                $matchingApps = @($publishedApps | Where-Object { [string]$_.AppId -eq [string]$workspaceApp.AppId -and $_.Name -eq $workspaceApp.Name })
                if ($matchingApps.Count -eq 0) {
                    [pscustomobject]@{Status='notPublished';Name=$workspaceApp.Name;Version=''}
                    continue
                }
                foreach ($app in $matchingApps) {
                    $identity = @{ServerInstance=$serverInstance;Name=$app.Name;Publisher=$app.Publisher;Version=$app.Version;ErrorAction='Stop'}
                    if ($app.IsInstalled) {
                        # The default uninstall saves extension data. Do not use
                        # DoNotSaveData, DoNotSaveSchema, or a destructive sync mode.
                        Uninstall-NAVApp @identity -Tenant $tenant | Out-Null
                    }
                    $unpublish = $identity.Clone()
                    if ([string]$app.Scope -eq 'Tenant') { $unpublish.Tenant=$tenant }
                    Unpublish-NAVApp @unpublish | Out-Null
                    [pscustomobject]@{Status='unpublished';Name=$app.Name;Version=[string]$app.Version}
                }
            }
        })
        foreach ($result in $results) {
            if ($result.Status -eq 'unpublished') {
                Write-Host "Successfully unpublished '$($result.Name)' version '$($result.Version)' from '$($Configuration.name)'." -ForegroundColor Green
            } else {
                Write-Host "'$($result.Name)' is not published on '$($Configuration.name)'; nothing to remove." -ForegroundColor Gray
            }
        }
    } finally { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}

function Unpublish-Apps {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
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
        foreach ($configuration in @($settingsJSON.configurations | Where-Object { [string]::IsNullOrWhiteSpace($targetType) -or $_.targetType -eq $targetType })) {
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
                    if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
                        continue
                    }

                    $installedApps = (Get-BcContainerAppInfo -containerName $configuration.container)
                    $removeAppData = (Confirm-Option -question "Do you want to REMOVE ALL EXTENSIONS' DATA AND SCHEMA from '$($configuration.name)'?" -PromptId "publishApps.removeExtensionData" -Risk "Removes extension data and schema from the target environment." -AgentAllowed $false -Destructive $true)
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
                    $managementHost = if (-not [string]::IsNullOrWhiteSpace($configuration.managementServer)) {
                        $configuration.managementServer
                    } else { Get-RemoteComputerNameFromServer -server $configuration.server }
                    if (-not (Test-IsLocalSqlServer -databaseServer $managementHost)) {
                        Unpublish-RemoteOnPremWorkspaceApps -Configuration $configuration -Apps @($sortedApps)
                        break
                    }
                    Initialize-OnPremPublishingManagement -SettingsJSON $settingsJSON -Configuration $configuration -Unpublish
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
