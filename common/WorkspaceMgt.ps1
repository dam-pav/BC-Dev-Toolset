# default toolset folder name
$toolsetFolderName = 'BC-Dev-Toolset'

function Write-LaunchJSON {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [string] $appPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$false)]
        [bool] $replaceJSON = $false
    )
    $appName = $appPath -split '\.' | Select-Object -First 1
    if ($appName -eq $toolsetFolderName) {
        return
    }

    Write-Host ""    
    if ($replaceJSON -eq $true) {
        Write-Host "Replacing launch.json for '$appPath'." -ForegroundColor Green
    } else {
        Write-Host "Updating launch.json for '$appPath'." -ForegroundColor Green
    }

    # Read launch.json
    if (-not $appPath.Contains('\')) {
        $workspaceRootPath = (get-item $scriptPath).Parent
        $appPath = "$($workspaceRootPath.Fullname)\$appPath"
    }

    $appFilename = "$appPath\app.json"
    if (-not (Test-Path $appFilename)) {
        Write-Host "'$appFilename' not found." -ForegroundColor Red
        return
    } else {
        $appJSON = Get-Content -Path $appFilename | ConvertFrom-Json
    }

    $launchFilename = "$appPath\.vscode\launch.json"
    if  (-not $replaceJSON -eq $true) {
        if (Test-Path $launchFilename) {
            $launchJSON = Get-Content -Path $launchFilename | ConvertFrom-Json
            Write-Host "'$launchFilename' loaded." -ForegroundColor Blue
        } else {
            Write-Host "'$launchFilename' not found." -ForegroundColor Blue
            $replaceJSON = $true
        }
    }

    if ($replaceJSON -eq $true) {
        Write-Host "A new '$launchFilename' will be created." -ForegroundColor Blue
        $launchJSON = [PSCustomObject]@{}
        $launchJSON | Add-Member -MemberType NoteProperty -Name version -Value "0.2.0"
        $launchJSON | Add-Member -MemberType NoteProperty -Name configurations -Value @()
    }

    # Find & Manage Docker Launcher
    $dockerConfigurationName = "$($settingsJSON.containerName) Docker $($settingsJSON.environmentType)"
    $setupFound = $false
    foreach ($configuration in $($launchJSON.configurations | Where-Object Name -eq "$dockerConfigurationName")) {
        Write-Host "Existing setup for '$($configuration.name)' found." -ForegroundColor Blue
        $configuration.authentication = $settingsJSON.authentication
        $setupFound = $true
    }

    if ($setupFound -eq $false) {
        Write-Host "Setup for '$dockerConfigurationName' NOT found, creating with default values." -ForegroundColor Blue
        $newConfiguration = [PSCustomObject]@{}
        $newConfiguration | Add-Member -MemberType NoteProperty -Name name -Value $dockerConfigurationName
        $newConfiguration | Add-Member -MemberType NoteProperty -Name environmentType -Value $settingsJSON.environmentType
        $newConfiguration | Add-Member -MemberType NoteProperty -Name server -Value "http://$($settingsJSON.containerName)"
        if (($settingsJSON.environmentType -eq "OnPrem" -and $appJSON.application -ge [Version]"18.0.0.0") -or ($appJSON.application -ge [Version]"19.0.0.0")) {
            $newConfiguration | Add-Member -MemberType NoteProperty -Name serverInstance -Value "BC"
        } else {
            $newConfiguration | Add-Member -MemberType NoteProperty -Name serverInstance -Value "NAV"
        }
        $newConfiguration | Add-Member -MemberType NoteProperty -Name tenant -Value "default"
        $newConfiguration | Add-Member -MemberType NoteProperty -Name authentication -Value $settingsJSON.authentication
        $newConfiguration | Add-Member -MemberType NoteProperty -Name request -Value "launch"
        $newConfiguration | Add-Member -MemberType NoteProperty -Name type -Value "al"
        $newConfiguration | Add-Member -MemberType NoteProperty -Name startupObjectId -Value 22
        $newConfiguration | Add-Member -MemberType NoteProperty -Name startupObjectType -Value "Page"
        $newConfiguration | Add-Member -MemberType NoteProperty -Name breakOnError -Value "All"
        $newConfiguration | Add-Member -MemberType NoteProperty -Name launchBrowser -Value $true
        $newConfiguration | Add-Member -MemberType NoteProperty -Name enableLongRunningSqlStatements -Value $true
        $newConfiguration | Add-Member -MemberType NoteProperty -Name enableSqlInformationDebugger -Value $true
        $newConfiguration | Add-Member -MemberType NoteProperty -Name usePublicURLFromServer -Value $true
        $newConfiguration | Add-Member -MemberType NoteProperty -Name schemaUpdateMode -Value "ForceSync"
        $newConfiguration | Add-Member -MemberType NoteProperty -Name forceUpgrade -Value $true
        $newConfiguration | Add-Member -MemberType NoteProperty -Name breakOnRecordWrite -Value "None"
        $newConfiguration | Add-Member -MemberType NoteProperty -Name longRunningSqlStatementsThreshold -Value 500
        $newConfiguration | Add-Member -MemberType NoteProperty -Name numberOfSqlStatements -Value 10
        
        $launchJSON.configurations = $launchJSON.configurations + $newConfiguration
    }
    
    # Find & Manage Remote Launcher
    foreach ($remote in $settingsJSON.remoteConfigurations) {
        $configurationValid = $true
        if ($remote.name -eq "") {
            $configurationValid = $false
            Write-Host "settings.json: please supply the mandatory value for 'remoteConfigurations' attribute 'name'." -ForegroundColor Red
        }
        if (-not ($remote.serverType -in ("Cloud","SelfHosted","OnPrem"))) {
            $configurationValid = $false
            if ($remote.name -ne "sample") {
                Write-Host "settings.json: please supply the mandatory value for 'remoteConfigurations' attribute 'serverType'. Valid values are: Cloud, SelfHosted and OnPrem." -ForegroundColor Red
            }
        }
        if ($configurationValid) {
            $setupFound = $false
            $remoteConfigurationName = "$($remote.name) $($remote.serverType)"
			foreach ($configuration in $($launchJSON.configurations | Where-Object Name -eq $remoteConfigurationName)) {
				Write-Host "Existing setup for '$($configuration.name)' found." -ForegroundColor Blue
                if ($configuration.PSObject.Properties['environmentName']) {
                    $configuration.PSObject.Properties.Remove('environmentName')
                }
                if ($configuration.PSObject.Properties['server']) {
                    $configuration.PSObject.Properties.Remove('server')
                }
                if ($configuration.PSObject.Properties['serverInstance']) {
                    $configuration.PSObject.Properties.Remove('serverInstance')
                }
                if ($configuration.PSObject.Properties['port']) {
                    $configuration.PSObject.Properties.Remove('port')
                }
                if ($configuration.PSObject.Properties['authentication']) {
                    $configuration.PSObject.Properties.Remove('authentication')
                }
                if ($configuration.PSObject.Properties['tenant']) {
                    $configuration.PSObject.Properties.Remove('tenant')
                }
				$setupFound = $true
			}
		
			if ($setupFound -eq $false) {
				Write-Host "Setup for '$($remote.name) $($settingsJSON.environmentType)' NOT found, creating with default values." -ForegroundColor Blue
				$newConfiguration = [PSCustomObject]@{}
				$newConfiguration | Add-Member -MemberType NoteProperty -Name name -Value $remoteConfigurationName
                if ($remote.serverType -eq "OnPrem") {
                    $newConfiguration | Add-Member -MemberType NoteProperty -Name environmentType -Value "OnPrem"
                } else {
                    $newConfiguration | Add-Member -MemberType NoteProperty -Name environmentType -Value "Sandbox"
                }
				$newConfiguration | Add-Member -MemberType NoteProperty -Name request -Value "launch"
				$newConfiguration | Add-Member -MemberType NoteProperty -Name type -Value "al"
				$newConfiguration | Add-Member -MemberType NoteProperty -Name startupObjectId -Value 22
				$newConfiguration | Add-Member -MemberType NoteProperty -Name startupObjectType -Value "Page"
				$newConfiguration | Add-Member -MemberType NoteProperty -Name breakOnError -Value "All"
				$newConfiguration | Add-Member -MemberType NoteProperty -Name launchBrowser -Value $true
				$newConfiguration | Add-Member -MemberType NoteProperty -Name enableLongRunningSqlStatements -Value $true
				$newConfiguration | Add-Member -MemberType NoteProperty -Name enableSqlInformationDebugger -Value $true
				$newConfiguration | Add-Member -MemberType NoteProperty -Name usePublicURLFromServer -Value $true
				$newConfiguration | Add-Member -MemberType NoteProperty -Name schemaUpdateMode -Value "ForceSync"
				$newConfiguration | Add-Member -MemberType NoteProperty -Name forceUpgrade -Value $true
				$newConfiguration | Add-Member -MemberType NoteProperty -Name breakOnRecordWrite -Value "None"
				$newConfiguration | Add-Member -MemberType NoteProperty -Name longRunningSqlStatementsThreshold -Value 500
				$newConfiguration | Add-Member -MemberType NoteProperty -Name numberOfSqlStatements -Value 10

                $launchJSON.configurations = $launchJSON.configurations + $newConfiguration
			}

			foreach ($configuration in $($launchJSON.configurations | Where-Object Name -eq $remoteConfigurationName)) {
				Write-Host "Replacing values for setup '$($configuration.name)'." -ForegroundColor Blue
                switch ($remote.serverType) {
                    "Cloud" { 
                        if ($configuration.PSObject.Properties['server']) {
                            Write-Host "'server' attribute is ignored for 'serverType'='Cloud'." -ForegroundColor Red
                        }
                        if ($configuration.PSObject.Properties['serverInstance']) {
                            Write-Host "'serverInstance' attribute is ignored for 'serverType'='Cloud'." -ForegroundColor Red
                        }
                        if ($configuration.PSObject.Properties['authentication']) {
                            Write-Host "'authentication' attribute is ignored for 'serverType'='Cloud'." -ForegroundColor Red
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name environmentName -Value $remote.environmentName
                        $configuration | Add-Member -MemberType NoteProperty -Name tenant -Value $remote.tenant
                    }
                    "SelfHosted" { 
                        if ($configuration.PSObject.Properties['serverInstance']) {
                            Write-Host "'serverInstance' attribute is ignored for 'serverType'='SelfHosted'." -ForegroundColor Red
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name environmentName -Value $remote.environmentName
                        $configuration | Add-Member -MemberType NoteProperty -Name server -Value $remote.server
                        $configuration | Add-Member -MemberType NoteProperty -Name authentication -Value $remote.authentication
                        if (($remote.tenant -eq "") -or -not ($remote.tenant))  {
                            $remoteTenant = "default"
                        } else {
                            $remoteTenant = $remote.tenant
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name tenant -Value $remoteTenant
                    }
                    "OnPrem" { 
                        if ($configuration.PSObject.Properties['environmentName']) {
                            Write-Host "'environmentName' attribute is ignored for 'serverType'='OnPrem'." -ForegroundColor Red
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name server -Value $remote.server
                        $configuration | Add-Member -MemberType NoteProperty -Name serverInstance -Value $remote.serverInstance
                        $configuration | Add-Member -MemberType NoteProperty -Name port -Value $remote.port
                        $configuration | Add-Member -MemberType NoteProperty -Name authentication -Value $remote.authentication
                        if (($remote.tenant -eq "") -or -not ($remote.tenant))  {
                            $remoteTenant = "default"
                        } else {
                            $remoteTenant = $remote.tenant
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name tenant -Value $remoteTenant
                    }
                    Default {
                        Write-Host "settings.json: valid values for 'remoteConfiguration' attribute 'serverType' are Cloud, SelfHosted and OnPrem." -ForegroundColor Red
                    }
                }
            }
        }
	}
    
    
    # Write launch.json
    Write-Host "Writing $launchFilename..." -ForegroundColor Blue
    $launchJSON | ConvertTo-Json -Depth 10 | Format-Json | Set-Content -Path $launchFilename -Force
}

# Formats JSON in a nicer format than the built-in ConvertTo-Json does.
function Confirm-Option {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $question,
        [Parameter(Mandatory=$false)]
        [string] $answerYes = 'y',
        [Parameter(Mandatory=$false)]
        [string] $answerNo = 'n',
        [Parameter(Mandatory=$false)]
        [string] $defaultYes = $false
    )

    if ($defaultYes -eq $true) {
        $answerYes = $answerYes.ToUpper()
        $answerNo = $answerNo.ToLower()
    } else {
        $answerYes = $answerYes.ToLower()
        $answerNo = $answerNo.ToUpper()
    }

    $Confirm = $answerNo
    Write-Host "$question [$answerYes/$answerNo]: " -NoNewline -ForegroundColor Green
    $Confirm = Read-Host
    if ([string]::IsNullOrWhiteSpace($Confirm)) {
        $Confirm = $answerNo
    }
        
    return($Confirm.ToUpper() -eq $answerYes.ToUpper())
}

function Format-Json([Parameter(Mandatory, ValueFromPipeline)][String] $json) {
    $indent = 0;
    ($json -Split "`n" | % {
        if ($_ -match '[\}\]]\s*,?\s*$') {
            # This line ends with ] or }, decrement the indentation level
            $indent--
        }
        $line = ('  ' * $indent) + $($_.TrimStart() -replace '":  (["{[])', '": $1' -replace ':  ', ': ')
        if ($_ -match '[\{\[]\s*$') {
            # This line ends with [ or {, increment the indentation level
            $indent++
        }
        $line
    }) -Join "`n"
}

function Initialize-Context {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [ref] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [ref] $workspaceJSON
    )

    # Workspace
    $workspaceRootPath = (get-item $scriptPath).parent
    $filterExtension = ".code-workspace"  # Replace with the file extension you want to filter by
    
    # List all files in the folder and filter by extension
    $filteredFiles = Get-ChildItem -Path $workspaceRootPath.FullName | Where-Object { $_.Extension -eq $filterExtension }
    
    # Check if there are any matching files
    if ($filteredFiles.Count -gt 0) {
        # Read *.code-workspace
        $workspaceJSON.Value = Get-Content -Path $filteredFiles[0].FullName | ConvertFrom-Json
        $workspaceName = $filteredFiles[0].Name
        $workspaceName = $workspaceName -split '\.' | Select-Object -First 1
    } else {
        # throw "No $filterExtension files found in the folder."
        # there IS no workspace
        $workspaceJSON.value = @{
            folders = @{
                path = $workspaceRootPath
            }
        }
        $workspaceName = $workspaceRootPath.Name
    }

    Write-Host "Running from: $scriptPath" -ForegroundColor Gray
    Write-Host "Root folder is: $workspaceRootPath" -ForegroundColor Gray
    Write-Host "Workspace Name is: $workspaceName" -ForegroundColor Gray
    
    # Set the path for settings.json
    $settingsPath = "$scriptPath\settings.json"

    # Check if settings.json file exists
    if (-not (Test-Path -Path $settingsPath)) {
        # File doesn't exist, create with default values
        $remoteConfiguration = [PSCustomObject]@{}
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name name -Value "sample"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverType -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name targetType -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name server -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverInstance -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name port -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name environmentName -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name tenant -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name authentication -Value ""

        $defaultSettings = [PSCustomObject]@{}
        $defaultSettings | Add-Member -MemberType NoteProperty -Name authentication -Value "UserPassword"
        $defaultSettings | Add-Member -MemberType NoteProperty -Name admin -Value "admin"
        $defaultSettings | Add-Member -MemberType NoteProperty -Name password -Value "P@ssw0rd"
        $defaultSettings | Add-Member -MemberType NoteProperty -Name containerName -Value $workspaceName.Replace(' ','-')
        $defaultSettings | Add-Member -MemberType NoteProperty -Name environmentType -Value "Sandbox"
        $defaultSettings | Add-Member -MemberType NoteProperty -Name licenseFile -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name certificateFile -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name packageOutputPath -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name remoteConfigurations -Value @($remoteConfiguration)

        $defaultSettings | ConvertTo-Json -Depth 10 | Format-Json | Out-File -FilePath $settingsPath -Force
    }

    # Read settings.json
    $settingsJSONvalue = Get-Content -Path $settingsPath | ConvertFrom-Json

    # Add remoteConfigurations from code-workspace
    $country = ''
    if ($workspaceJSON.value.settings.bcdevtoolset.country) {
        $country = $workspaceJSON.value.settings.bcdevtoolset.country
    }
    if ($country -eq '') {
        $country = "w1"
    }

    $settingsJSONvalue | Add-Member -MemberType NoteProperty -Name country -Value $country
    foreach ($remoteConfiguration in $workspaceJSON.value.settings.bcdevtoolset.remoteConfigurations) {
        $settingsJSONvalue.remoteConfigurations = $settingsJSONvalue.remoteConfigurations + $remoteConfiguration
    }
    # finally, pass the object
    $settingsJSON.Value = $settingsJSONvalue
}

function Get-AppJSON {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [string] $appPath,
        [Parameter(Mandatory=$true)]
        [ref] $appJSON
    )
    $appName = $appPath -split '\.' | Select-Object -First 1
    if ($appName -eq $toolsetFolderName) {
        # this is not an app folder
        $appJSON.Value = [PSCustomObject]@{}
        return
    }
    
    # Read app.json
    if (-not $appPath.Contains('\')) {
        $workspaceRootPath = (get-item $scriptPath).Parent
        $appPath = "$($workspaceRootPath.Fullname)\$appPath"
    }
    $appFilename = "$appPath\app.json"

    if (Test-Path $appFilename) {
        $appJSON.Value = Get-Content -Path $appFilename | ConvertFrom-Json
        Write-Host "'$appFilename' loaded." -ForegroundColor Blue
    } else {
        $appJSON.Value = [PSCustomObject]@{}
        Write-Host "'$appFilename' cannot be found." -ForegroundColor Red
    }
}

function Get-PackageParams {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $appJSON,
        [Parameter(Mandatory=$true)]
        [ref] $packageName,
        [Parameter(Mandatory=$true)]
        [ref] $packagePath,
        [Parameter(Mandatory=$false)]
        [bool] $runtime = $false

    )
    $packName = $($appJSON.publisher) + "_" + $($appJSON.name) + "_" + $($appJSON.version)
    if ($runtime) {
        if ("$($settingsJSON.packageOutputPath)" -eq "") {
            throw "For deployment of Runtime packages please specify a valid path in 'packageOutputPath' of settings.json"
        } else {
            $packagePath.Value = $($settingsJSON.packageOutputPath)
        }
        $packageName.Value = $packName + "_runtime.app"
    } else {
        $packagePath.Value = ""
        $packageName.Value = $packName + ".app"
    }
}

function Export-BcContainerRuntimePackage {
    Param (
        [string] $containerName = $bcContainerHelperConfig.defaultContainerName,
        [Parameter(Mandatory=$true)]
        [string] $appName,
        [Parameter(Mandatory=$true)]
        [string] $packageFileName,
        [Parameter(Mandatory=$true)]
        [string] $packageFilePath,
        [string] $certificateFile        
    )

    $containerPackageFile = Join-Path $bcContainerHelperConfig.hostHelperFolder "Extensions\$containerName\my\$packageFileName"
    $PackageFile = Join-Path $packageFilePath $packageFileName
    
    # Extract the package
    Invoke-ScriptInBcContainer -containerName $containerName -ScriptBlock { Param($packageFile, $appName)

        Write-Host "Exporting App $appName into Package $packageFile" -ForegroundColor Gray
        Get-NAVAppRuntimePackage -ServerInstance $ServerInstance -Tenant default -AppName $appName -Path $packageFile
    
    }  -ArgumentList (Get-BcContainerPath -ContainerName $containerName -Path $containerPackageFile), $appName

    # Sign the package, maybe
    if ("$certificateFile" -ne "") {
        Write-Host ""
        Write-Host "Please type in the Certificate Password." -ForegroundColor Green
        $certificatepass = Read-Host "Password" -AsSecureString
        Sign-BcContainerApp -containerName $containerName -appFile $containerPackageFile -pfxFile $certificateFile -pfxPassword $certificatepass
    }

    # Export the package
    if ($containerPackageFile -ne $packageFile) {
        Write-Host "Copying package file '$packagefile' from container" -ForegroundColor Gray
        Copy-Item -Path $containerpackageFile -Destination $packageFile -Force
    }
}

function Test-DockerProcess {
    # verify Docker process is running
    $dockerProcess = (Get-Process "dockerd" -ErrorAction Ignore)
    if (!($dockerProcess)) {
        Write-Host -ForegroundColor Red "Dockerd process not found. Docker might not be started, not installed or not running Windows Containers."
    }

    $dockerVersion = docker version -f "{{.Server.Os}}/{{.Client.Version}}/{{.Server.Version}}"
    $dockerOS = $dockerVersion.Split('/')[0]
    $dockerClientVersion = $dockerVersion.Split('/')[1]
    $dockerServerVersion = $dockerVersion.Split('/')[2]

    if ("$dockerOS" -eq "") {
        throw "Docker service is not yet ready."
    }
    elseif ($dockerOS -ne "Windows") {
        throw "Docker is running $dockerOS containers, you need to switch to Windows containers."
   	}
    Write-Host "Docker Client Version is $dockerClientVersion" -ForegroundColor Gray
    Write-Host "Docker Server Version is $dockerServerVersion" -ForegroundColor Gray
}

function Get-AppDependencies {
    [CmdletBinding()]
    param(            
        $AllAppFiles = @()   
    )    

    $AllApps = @()
    foreach ($App in $AllAppFiles) {
        if ($App.AppId) {
            $AppId = $App.AppId
        } else {
            $AppId = $App.id
        }

        #Write-Host "ExecutionContext.SessionState.LanguageMode = '$($ExecutionContext.SessionState.LanguageMode)'."
        #$ExecutionContext.SessionState.LanguageMode = 'FullLanguage' #because PS7.4 is broken, this would also solve the issue but only locally
        #$AllApps += [PSCustomObject]@{ #broken with PS7.4 #TODO: revisit after PS7.4.1 deployment
        $AllApps += New-Object -TypeName psobject -Property @{
            AppId        = $AppId
            Version      = $App.Version
            Name         = $App.Name
            Publisher    = $App.Publisher
            ProcessOrder = 0                            
            Dependencies = $App.Dependencies
            Path         = $App.path
        }
    }
    
    $FinalResult = @()

    $AllApps | ForEach-Object {    
        $FinalResult = Add-ToDependencyTree `
            -App $_ `
            -DependencyArray $FinalResult `
            -AppCollection $AllApps `
            -Order $AllApps.Count
    }

    $FinalResult
}

function Add-ToDependencyTree() {
    param(
        [PSObject] $App,
        [PSObject[]] $DependencyArray,
        [PSObject[]] $AppCollection,
        [Int] $Order = 1
    )   

    foreach ($Dependency in $App.Dependencies) {
        if ($Dependency.AppId) {
            $DepAppId = $Dependency.AppId
        } else {
            $DepAppId = $Dependency.id
        }
        $DependencyArray = Add-ToDependencyTree `
            -App ($AppCollection | Where-Object AppId -eq $DepAppId) `
            -DependencyArray $DependencyArray `
            -AppCollection $AppCollection `
            -Order ($Order - 1)
    }

    if (-not($DependencyArray | Where-Object AppId -eq $App.AppId)) {
        $DependencyArray += $App
        try {
            ($DependencyArray | Where-Object AppId -eq $App.AppId).ProcessOrder = $Order
        }
        catch { }
    }
    else {
        if (($DependencyArray | Where-Object AppId -eq $App.AppId).ProcessOrder -gt $Order) {
            ($DependencyArray | Where-Object AppId -eq $App.AppId).ProcessOrder = $Order
        } 
    }
    $DependencyArray
}

function Get-SortedApps {
    Param (
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
            $appJSON | Add-Member -MemberType NoteProperty -Name path -Value $appPath
            $appList = $appList + @($appJSON)
        } 
    }
    (Get-AppDependencies($appList) | Sort-Object ProcessOrder)
}    

function Write-Done() {
    Write-Host ""
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!" -ForegroundColor Green
    Write-Host "!!!!     DONE     !!!!" -ForegroundColor Green
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!" -ForegroundColor Green
    Write-Host ""
}

function Clear-Artifacts {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath
    )
    $workspaceRootPath = (Get-Item $scriptPath).Parent
    
    if (Confirm-Option -question "Do you want to clear the translation files?") {
        Get-ChildItem -Path $workspaceRootPath.FullName -Include *.g.xlf -Recurse | Remove-Item
        Write-Host "Translation files cleared." -ForegroundColor Blue
    }
    
    if (Confirm-Option -question "Do you want to clear all APP files? You will need to download symbols for all projects.") {
        Get-ChildItem -Path $workspaceRootPath.FullName -Include *.app -Recurse | Remove-Item
        Write-Host "APP files cleared." -ForegroundColor Blue
    }
}

function New-DockerContainer {
    Param (
        [bool] $testMode = $false,
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $appJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )
    
    # No mutex for the time being, we do it manually
    $securePassword = ConvertTo-SecureString -String $settingsJSON.password -AsPlainText -Force
    $credential = New-Object pscredential $settingsJSON.admin, $securePassword
    $auth = $settingsJSON.authentication

    if ($appJSON.application -eq "") {
        throw "Artifact URL could not be determined based on $appPath\app.json. Processing aborted."
    } else {
        Write-Host "Retrieving artifact URL for $($settingsJSON.environmentType) app version $($appJSON.application)."
    }

    Write-Host "Get-BcArtifactUrl -version $($appJSON.application) -type $($settingsJSON.environmentType) -country $($settingsJSON.country) -select 'Closest'" -ForegroundColor Green
    if (-not $testmode) {
        $artifactUrl = Get-BcArtifactUrl -version $appJSON.application -type $settingsJSON.environmentType -country $settingsJSON.country -select 'Closest'
        if ("$artifactUrl" -eq "") {
            throw "Artifact URL could not be determined for $($settingsJSON.environmentType) app version $($appJSON.application). Processing aborted."
        } else {
            Write-Host "Using artifact URL $artifactUrl."
        }
    }

    $Parameters = @{
        accept_eula = $true
        assignPremiumPlan = $true
        updateHosts = $true
        containerName = $settingsJSON.containerName
        credential = $credential
        auth = $auth
        artifactUrl = $artifactUrl
    }

    if ($settingsJSON.environmentType -eq "OnPrem" -and $appJSON.application -ge [Version]"18.0.0.0") {
            $Parameters.runSandboxAsOnPrem = $true
        }

    if ($settingsJSON.licenseFile -ne "") {
        $Parameters.licenseFile = $settingsJSON.licenseFile
    }
        
    if (-not $testmode) {
        New-BcContainer @Parameters
    }

    Write-Host "The docker instance $($settingsJSON.containerName) should be ready." -ForegroundColor Green
    Write-Host ""
}

function Update-Gitignore {
    # Specify the file path
    $filePath = ".gitignore"

    # Verify that this is a repository
    if (-not (Test-Path '.git')) {
        Write-Host "This is not a repository. A '$filePath' is not required." -ForegroundColor Gray
        return
    }

    # Specify the lines to be added
    $linesToAdd = @(
        "*.app"
        "*.flf"
        "*.bclicense"
        "*.g.xlf"
        ".DS_Store"
        "Thumbs.db"
        "TestResults*.xml"
        "bcptTestResults*.json"
        "BuildOutput.txt"
        "rad.json"
        ".output/"
        ".dependencies/"
        ".buildartifacts/"
        ".alpackages/"
        ".packages/"
        ".alcache/"
        ".altemplates/"
        ".snapshots/"
        "cache_*"
        "~$*"
        "$toolsetFolderName/"
        "launch.json"
    )

    if (Test-Path $filePath) {
        # Read the file into an array
        Write-Host "Loading $filePath" -ForegroundColor Gray
        $lines = @(Get-Content $filePath)
    } else {
        Write-Host "'$filePath' not found. A new file will be created." -ForegroundColor Gray
        $lines = @()
    }


    Write-Host "Updating $filePath" -ForegroundColor Gray
    # Check if each line to be added already exists
    foreach ($line in $linesToAdd) {
        if ($lines -notcontains $line) {
            Write-Host "Adding $line" -ForegroundColor Gray
            $lines += $line
        }
    }

    # Overwrite the original file with the updated lines
    $lines | Set-Content $filePath -Encoding UTF8

    Write-Host "$filePath updated." -ForegroundColor Green
    Write-Host ""
}

function Update-Workspace {
    Write-Host "Updating the .code-workspace file..." -ForegroundColor Gray

    # Workspace
    $filterExtension = ".code-workspace"  # Replace with the file extension you want to filter by
    
    # List all files in the folder and filter by extension
    $filteredFiles = Get-ChildItem -Path $workspaceRootPath.FullName | Where-Object { $_.Extension -eq $filterExtension }
    
    # Check if there are any matching files
    if ($filteredFiles.Count -eq 0) {
        # throw "No $filterExtension files found in the folder."
        # there IS no workspace
        $workspaceJSON = [PSCustomObject]@{}
        $workspaceJSON | Add-Member -MemberType NoteProperty -Name folders -Value @()
        $workspaceJSON.folders = $workspaceJSON.folders + [PSCustomObject]@{
            path = '.'
        }
        $workspacePath = $(Get-Item $PSScriptRoot).Parent.Parent
        $workspaceName = $workspacePath -split '\.' | Select-Object -First 1
        Write-Host "Workspace definition not found, creating workspace $workspaceName." -ForegroundColor Red
        $workspacePath = "$workspaceName.code-workspace"
    } else {
        # Read *.code-workspace
        $workspaceJSON = Get-Content -Path $filteredFiles[0].FullName | ConvertFrom-Json
        $workspacePath = $filteredFiles[0].Name
        $workspaceName = $workspacePath -split '\.' | Select-Object -First 1
        Write-Host "Workspace found: $workspaceName" -ForegroundColor Gray
    }

    $filteredFolders = $workspaceJSON.folders | Where-Object { $_.path -eq $toolsetFolderName }
    if ($filteredFolders.Count -eq 0) {
        $workspaceJSON.folders = $workspaceJSON.folders + [PSCustomObject]@{
            path = $toolsetFolderName
        }
    }

    # Check if settings exists
    if (-not ($workspaceJSON.settings)) {
        $workspaceJSON | Add-Member -MemberType NoteProperty -Name settings -Value $([PSCustomObject]@{})
    }

    # Check if bcdevtoolset exists
    if (-not ($workspaceJSON.settings.bcdevtoolset)) {
        # Add bcdevtoolset with a sample remoteConfiguration to code-workspace
        $remoteConfiguration = [PSCustomObject]@{}
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name name -Value "sample"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverType -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name targetType -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name server -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverInstance -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name port -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name environmentName -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name tenant -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name authentication -Value ""

        $bcdevtoolset = [PSCustomObject]@{}
        $bcdevtoolset | Add-Member -MemberType NoteProperty -Name country -Value "w1"
        $bcdevtoolset | Add-Member -MemberType NoteProperty -Name remoteConfigurations -Value @($remoteConfiguration)

        $workspaceJSON.settings | Add-Member -MemberType NoteProperty -Name bcdevtoolset -Value @($bcdevtoolset)
    }

    # finally, save the updated workspace file
    $workspaceJSON | ConvertTo-Json -Depth 10 | Format-Json | Out-File -Encoding utf8 -FilePath $workspacePath -Force
    Write-Host "Workspace file updated: $workspacePath" -ForegroundColor Green
    Write-Host ""
}
