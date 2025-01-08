# default toolset folder name
$toolsetFolderName = 'BC-Dev-Toolset'
$hostHelperFolder = 'C:\ProgramData\BcContainerHelper'
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

    # Find & Manage Remote Launcher
    foreach ($remote in $settingsJSON.configurations) {
        $configurationValid = $true
        if ($remote.name -eq "") {
            $configurationValid = $false
            Write-Host "settings.json: please supply the mandatory value for 'configurations' attribute 'name'." -ForegroundColor Red
        }
        if (-not ($remote.serverType -in ("Container","Cloud","OnPrem"))) {
            $configurationValid = $false
            if ($remote.name -ne "sample") {
                Write-Host "settings.json: please supply the mandatory value for 'configurations' attribute 'serverType'. Valid values are: Container, Cloud and OnPrem." -ForegroundColor Red
            }
        }
        if ($configurationValid) {
            $setupFound = $false
            $remoteConfigurationName = "$($remote.name)"
            if ($remote.targetType) {
                $remoteConfigurationName += " $($remote.targetType)"
            }
            $remoteConfigurationName += " $($remote.serverType)"
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
                if ($configuration.PSObject.Properties['environmentType']) {
                    $configuration.PSObject.Properties.Remove('environmentType')
                }
				$setupFound = $true
			}
		
			if ($setupFound -eq $false) {
				Write-Host "Setup for '$remoteConfigurationName' NOT found, creating with default values." -ForegroundColor Blue
				$newConfiguration = [PSCustomObject]@{}
				$newConfiguration | Add-Member -MemberType NoteProperty -Name name -Value $remoteConfigurationName
				$newConfiguration | Add-Member -MemberType NoteProperty -Name request -Value "launch"
				$newConfiguration | Add-Member -MemberType NoteProperty -Name type -Value "al"

                $launchJSON.configurations = $launchJSON.configurations + $newConfiguration
			}

			foreach ($configuration in $($launchJSON.configurations | Where-Object Name -eq $remoteConfigurationName)) {
				Write-Host "Replacing values for setup '$($configuration.name)'." -ForegroundColor Blue
                switch ($remote.serverType) {
                    "Container" { 
                        if ($remote.PSObject.Properties['server']) {
                            Write-Host "'server' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
                        }
                        if ($remote.PSObject.Properties['serverInstance']) {
                            Write-Host "'serverInstance' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
                        }
                        if ($remote.PSObject.Properties['tenant']) {
                            Write-Host "'tenant' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
                        }
                        if ($remote.environmentType -eq "OnPrem") {
                            $configuration | Add-Member -MemberType NoteProperty -Name environmentType -Value $remote.environmentType
                        } else {
                            $configuration | Add-Member -MemberType NoteProperty -Name environmentType -Value "Sandbox"
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name server -Value "http://$($remote.container)"
                        if (($configuration.environmentType -eq "OnPrem" -and $appJSON.application -ge [Version]"18.0.0.0") -or ($appJSON.application -ge [Version]"19.0.0.0")) {
                            $configuration | Add-Member -MemberType NoteProperty -Name serverInstance -Value "BC"
                            $configuration | Add-Member -MemberType NoteProperty -Name tenant -Value "default"
                        } else {
                            $configuration | Add-Member -MemberType NoteProperty -Name serverInstance -Value "NAV"
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name authentication -Value $remote.authentication
                    }
                    "Cloud" { 
                        if ($remote.PSObject.Properties['server']) {
                            Write-Host "'server' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
                        }
                        if ($remote.PSObject.Properties['serverInstance']) {
                            Write-Host "'serverInstance' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
                        }
                        if ($remote.PSObject.Properties['authentication']) {
                            Write-Host "'authentication' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
                        }
                        if (($remote.environmentType -eq "Sandbox") -or (-not $remote.environmentType)) {
                            $configuration | Add-Member -MemberType NoteProperty -Name environmentType -Value "Sandbox"
                        } else {
                            Write-Host "'environmentType' attribute's only valid value is 'Sandbox'. The value '$($remote.environmentType)' is not valid." -ForegroundColor Red
                        }
                        $configuration | Add-Member -MemberType NoteProperty -Name environmentName -Value $remote.environmentName
                        $configuration | Add-Member -MemberType NoteProperty -Name tenant -Value $remote.tenant
                    }
                    "OnPrem" { 
                        if ($configuration.PSObject.Properties['environmentName']) {
                            Write-Host "'environmentName' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
                        }
                        if ($remote.PSObject.Properties['environmentType']) {
                            Write-Host "'environmentType' attribute is ignored for 'serverType'='$($remote.serverType)'." -ForegroundColor Red
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
                        Write-Host "settings.json: valid values for 'remoteConfiguration' attribute 'serverType' are Container, Cloud and OnPrem." -ForegroundColor Red
                    }
                }
            }
			if ($setupFound -eq $false) {
				$configuration | Add-Member -MemberType NoteProperty -Name startupObjectId -Value 22
				$configuration | Add-Member -MemberType NoteProperty -Name startupObjectType -Value "Page"
				$configuration | Add-Member -MemberType NoteProperty -Name breakOnError -Value "All"
				$configuration | Add-Member -MemberType NoteProperty -Name launchBrowser -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name enableLongRunningSqlStatements -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name enableSqlInformationDebugger -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name usePublicURLFromServer -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name schemaUpdateMode -Value "ForceSync"
				$configuration | Add-Member -MemberType NoteProperty -Name forceUpgrade -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name breakOnRecordWrite -Value "None"
				$configuration | Add-Member -MemberType NoteProperty -Name longRunningSqlStatementsThreshold -Value 500
				$configuration | Add-Member -MemberType NoteProperty -Name numberOfSqlStatements -Value 10
			}
        }
	}
    
    
    # Write launch.json
    Write-Host "Writing $launchFilename..." -ForegroundColor Blue
    $launchJSON | ConvertTo-Json -Depth 10 | Format-Json | Set-Content -Path $launchFilename -Force
}

function Show-Menu {
    param (
        [string]$Title = 'Please select an option:',
        [string]$NoTypeTitle = 'Or type your selection:',
        [array]$Options
    )

    if (-not $Options) {
        Write-Host "No options provided for the menu." -ForegroundColor Red
        return
    }

    $selectionIndex = 0
    $done = $false

    # Function to display the menu in-place
    function Display-Menu {
        Write-Host $Title.PadRight(50) -ForegroundColor Blue
        
        # Iterate through each option and print it
        $padlength = $([string]$($Options.Length)).Length
        for ($i = 0; $i -lt $Options.Length; $i++) {
            $seq = [string]$($i+1)
            $seq = $seq.PadLeft($padlength)
            if ($i -eq $selectionIndex) {
                Write-Host "-> [$seq] $($Options[$i].Text)" -ForegroundColor Green
            } else {
                Write-Host "   [$seq] $($Options[$i].Text)"
            }
        }
    }

    # Capture the starting position before drawing the menu
    $startingPosition = [Console]::GetCursorPosition().Item2
    $manualOptionNo = ''

    # Main loop to handle key input
    while (-not $done) {
        # Validate manual numbering
        $intValue = [int]$manualOptionNo
        $manualOptionValid = (($intValue -ge 1) -and ($intValue -le $Options.Length))
        if ($manualOptionValid -eq $true) {
            $selectionIndex = $intValue - 1
        }

        # Restore the cursor position to the start of the menu
        [Console]::SetCursorPosition(0, $startingPosition)
        Display-Menu

        Write-Host $NoTypeTitle -NoNewline
        if ($manualOptionValid) {
            Write-Host $manualOptionNo -NoNewline -ForegroundColor Green
        }
        else {
            Write-Host $manualOptionNo -NoNewline -ForegroundColor Red
        }
        Write-Host "".PadRight(50)

        $startingPosition = [Console]::GetCursorPosition().Item2 - $Options.Length - 2
        if ($startingPosition -lt 0) {
            $startingPosition = 0
        }

        $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

        #Write-Host $key
        #$startingPosition = $startingPosition - 1

        switch ($key.VirtualKeyCode) {
            8 { # Backspace
                if ($manualOptionNo.Length -gt 0) {
                    $manualOptionNo = $manualOptionNo.Substring(0, $manualOptionNo.Length - 1)
                }
             }
            27 { #Esc key
                Write-Host "Selection canceled." -ForegroundColor Green
                $done = $true  # Exit the loop
            }
            38 { # Up arrow
                $selectionIndex = ($selectionIndex - 1 + $Options.Length) % $Options.Length
                $manualOptionNo = ''
            }
            40 { # Down arrow
                $selectionIndex = ($selectionIndex + 1) % $Options.Length
                $manualOptionNo = ''
            }
            {($_ -ge 48) -and ($_ -le 57) } { # keys 0 - 9
                $manualOptionNo += "$($_-48)"
            }
            13 { # Enter key
                # Ensure to avoid overwriting menu when showing selection output
                # Move cursor to a clear line after menu display for result output
                [Console]::SetCursorPosition(0, $startingPosition + $Options.Length + 2 )
                Write-Host "You selected: $($Options[$selectionIndex].Text)"
                $scriptPath = $Options[$selectionIndex].ScriptPath
                if (Test-Path $scriptPath) {
                    Write-Host "Running script: $scriptPath"
                    & $scriptPath
                } else {
                    Write-Host "Script not found at path: $scriptPath" -ForegroundColor Red
                }
                $done = $true  # Exit the loop
            }
        }
    }
}
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

# Formats JSON in a nicer format than the built-in ConvertTo-Json does.
function Format-Json([Parameter(Mandatory, ValueFromPipeline)][String] $json) {
    $indent = 0;
    ($json -Split "`n" | ForEach-Object {
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

function Build-Settings {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $settingsPath,
        [Parameter(Mandatory=$true)]
        [string] $workspaceName
    )

    # Check if settings.json file exists
    if (-not (Test-Path -Path $settingsPath)) {
        Write-Host ""
        Write-Host "Creating $settingsPath..." -ForegroundColor Gray

        # File doesn't exist, create with default values
        $defaultSettings = [PSCustomObject]@{}
        $defaultSettings | Add-Member -MemberType NoteProperty -Name licenseFile -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name certificateFile -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name packageOutputPath -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name dependenciesPath -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name shortcuts -Value "None"
        $defaultSettings | Add-Member -MemberType NoteProperty -Name configurations -Value @()

        # add container configuration
        $remoteConfiguration = [PSCustomObject]@{}
        #$remoteConfiguration | Add-Member -MemberType NoteProperty -Name name -Value "$workspaceName Default"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name name -Value "Local"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverType -Value "Container"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name targetType -Value "Dev"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name container -Value $workspaceName.Replace(' ','-')
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name environmentType -Value "Sandbox"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name authentication -Value "UserPassword"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name admin -Value "admin"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name password -Value "P@ssw0rd"
        $defaultSettings.configurations += $remoteConfiguration

        # add sample configuration
        $remoteConfiguration = [PSCustomObject]@{}
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name name -Value "sample"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverType -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name targetType -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name server -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverInstance -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name container -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name port -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name environmentType -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name environmentName -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name tenant -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name authentication -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name admin -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name password -Value ""
        $defaultSettings.configurations += $remoteConfiguration

        $defaultSettings | ConvertTo-Json -Depth 10 | Format-Json | Out-File -FilePath $settingsPath -Force
        Write-Host "$settingsPath created." -ForegroundColor Green
        }
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
    Build-Settings $settingsPath $workspaceName

    # Read settings.json
    $settingsJSONvalue = Get-Content -Path $settingsPath | ConvertFrom-Json

    # Add country from code-workspace
    $country = ''
    if ($workspaceJSON.value.settings.bcdevtoolset.country) {
        $country = $workspaceJSON.value.settings.bcdevtoolset.country
    }
    if ($country -eq '') {
        $country = "w1"
    }

    $settingsJSONvalue | Add-Member -MemberType NoteProperty -Name country -Value $country

    # Add missing defaults
    if ($null -eq $settingsJSONvalue.shortcuts) {
        $settingsJSONvalue | Add-Member -MemberType NoteProperty -Name shortcuts -Value "None"
    }
    
    # Add configurations from code-workspace
    foreach ($remote in $workspaceJSON.value.settings.bcdevtoolset.configurations) {
        $settingsJSONvalue.configurations = $settingsJSONvalue.configurations + $remote
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
        [Parameter(Mandatory=$true)]
        [string] $containerName,
        [Parameter(Mandatory=$true)]
        [string] $appName,
        [Parameter(Mandatory=$true)]
        [string] $packageFileName,
        [Parameter(Mandatory=$true)]
        [string] $packageFilePath,
        [string] $certificateFile        
    )

    $containerPackageFile = Join-Path $hostHelperFolder "Extensions\$containerName\my\$packageFileName"
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
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [string] $selectArtifact
    )
    
    $configurationFound = $false
    foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
        $configurationFound = $true

        # No mutex for the time being, we do it manually
        $securePassword = ConvertTo-SecureString -String $configuration.password -AsPlainText -Force
        $credential = New-Object pscredential $configuration.admin, $securePassword
        $auth = $configuration.authentication

        if ($appJSON.application -eq "") {
            throw "Artifact URL could not be determined based on $appPath\app.json. Processing aborted."
        } else {
            if ($selectArtifact -eq 'Closest') {
                Write-Host "Retrieving artifact URL for $($configuration.environmentType) app version $($appJSON.application)."
            } else {
                Write-Host "Retrieving $selectArtifact artifact URL."
            }
        }

        if (-not $testmode) {
            $Parameters = @{
                type = $configuration.environmentType
                country = $settingsJSON.country
                select = $selectArtifact
            }
            if ($selectArtifact -eq 'Closest') {
                $Parameters.version = $appJSON.application
            }
            $artifactUrl = Get-BcArtifactUrl @Parameters
            if ("$artifactUrl" -eq "") {
                throw "Artifact URL could not be determined for $($configuration.environmentType) app version $($appJSON.application). Processing aborted."
            } else {
                Write-Host "Using artifact URL $artifactUrl."
            }
        }

        $Parameters = @{
            accept_eula = $true
            assignPremiumPlan = $true
            updateHosts = $true
            containerName = $configuration.container
            credential = $credential
            auth = $auth
            artifactUrl = $artifactUrl
            shortcuts = $settingsJSON.shortcuts
        }

        if ($configuration.environmentType -eq "OnPrem" -and $appJSON.application -ge [Version]"18.0.0.0") {
                $Parameters.runSandboxAsOnPrem = $true
            }

        if ($settingsJSON.licenseFile -ne "") {
            $Parameters.licenseFile = $settingsJSON.licenseFile
        }
            
        if (-not $testmode) {
            New-BcContainer @Parameters
        }

        Write-Host "The docker instance $($configuration.container) should be ready." -ForegroundColor Green
        Write-Host ""
    }

    if (-not $configurationFound) {
        Write-Host "No Docker configurations found." -ForegroundColor Red
        $false
        return
    }

    $true
}

function Update-Gitignore {
    Write-Host ""

    # Specify the file path
    $filePath = ".gitignore"

    # Verify that this is a repository # NOT the folder where the script is located but from where it is ran
    if (-not (Test-Path '.git')) {
        Write-Host "This is not a repository. A '$filePath' is not required." -ForegroundColor Green
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

    if ($Global:workspaceRootPath -eq '') {
        $Global:workspaceRootPath = $(Get-Item $filePath).Directory
    }
}

function Add-Subfolders{
    Param (
        [Parameter(Mandatory=$true)]
        [ref] $workspaceJSON,
        [Parameter(Mandatory=$true)]
        [string] $basePath,
        [Parameter(Mandatory=$true)]
        [string] $appPath
    )
    
    $filteredFolders = Get-ChildItem -Path $appPath -Directory
    foreach ($folder in $filteredFolders) {
        if (Test-Path $(Join-Path $folder 'app.json')) {
            $relativePath = Resolve-Path -Path $folder -Relative -RelativeBasePath $basePath
            $workspaceJSON.value.folders = $workspaceJSON.value.folders + [PSCustomObject]@{
                path = $relativePath
            }
        }
        Add-Subfolders ([ref]$workspaceJSON.value) $basePath $folder
    }

}
function Update-Workspace {
    Write-Host ""
    Write-Host "Updating the .code-workspace file..." -ForegroundColor Gray

    # Workspace
    $filterExtension = ".code-workspace"  # Replace with the file extension you want to filter by
    
    # List all files in the folder and filter by extension
    if ((-not $Global:workspaceRootPath) -or ($Global:workspaceRootPath -eq '')) {
        $Global:workspaceRootPath = Get-Item '.' # NOT the folder where the script is located but from where it is ran
    }
    $filteredFiles = Get-ChildItem -Path $Global:workspaceRootPath.FullName | Where-Object { $_.Extension -eq $filterExtension }
    
    # Check if there are any matching files
    if ($filteredFiles.Count -eq 0) {
        # throw "No $filterExtension files found in the folder."
        # there IS no workspace
        $workspaceJSON = [PSCustomObject]@{}
        $workspaceJSON | Add-Member -MemberType NoteProperty -Name folders -Value @()

        # detect any apps in any of the subfolders
        Add-Subfolders ([ref]$workspaceJSON) $Global:workspaceRootPath $Global:workspaceRootPath

        $workspacePath = $Global:workspaceRootPath
        $workspaceName = $workspacePath.Name

        Write-Host "Workspace definition not found, creating workspace $workspaceName." -ForegroundColor Gray
        $workspacePath = $workspaceName + $filterExtension
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
        $bcdevtoolset | Add-Member -MemberType NoteProperty -Name selectArtifact -Value "Closest"
        $bcdevtoolset | Add-Member -MemberType NoteProperty -Name configurations -Value @($remoteConfiguration)

        $workspaceJSON.settings | Add-Member -MemberType NoteProperty -Name bcdevtoolset -Value @($bcdevtoolset)
    }

    # finally, save the updated workspace file
    $workspaceJSON | ConvertTo-Json -Depth 10 | Format-Json | Out-File -Encoding utf8 -FilePath $workspacePath -Force
    Write-Host "Workspace file updated: $workspacePath" -ForegroundColor Green

    # initialize settings.json
    Build-Settings (Join-Path $toolsetFolderName "settings.json") $workspaceName
}

function Install-FontsToContainer {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
        [Parameter(Mandatory=$true)]
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType
    )

    $fontFolder = ".\src\report\" # TODO: make into setting
    $ex = @()

    foreach ($configuration in $($settingsJSON.configurations | Where-Object  { $_.targetType -eq $targetType })) {
        Write-Host "Deploying apps to '$($configuration.name)'." -ForegroundColor Blue
        switch ($configuration.serverType) {
            'Container' {
                $params = @{
                    containerName = $configuration.container
                    path = $fontFolder
                }
                Write-Host ""
                Write-Host "Running " -ForegroundColor green -NoNewline
                Write-Host "Add-FontsToBcContainer" -ForegroundColor Blue -NoNewline
                Write-Host ":" -ForegroundColor green
                Add-FontsToBcContainer -ErrorAction SilentlyContinue -ErrorVariable ex @params
                if ($ex.length -gt 0) {
                    Write-Host "There was an error." -ForegroundColor Red
                    #Write-Host $ex.Exception -ForegroundColor Red
                }
            }
            Default {
                Write-Host "Cannot install fonts to serverType $serverType." -ForegroundColor Blue
            }
        }
    }
}

function Get-Symbols {
    Param(
        [Parameter(Mandatory=$false)]
        [string]$SourcePath = (Get-Location),
        [Parameter(Mandatory=$false)]
        [string]$ContainerName = (Get-ContainerFromLaunchJson),
        # optionally download the test symbols
        [Parameter(Mandatory=$false)]
        [switch]
        $includeTestSymbols
    )

    $PackagesPath = Join-Path $SourcePath '.alpackages'

    if (!(Test-Path $PackagesPath)) {
        Create-EmptyDirectory $PackagesPath
    }

    $SymbolsDownloaded = $false

    # since BC15, system layer is defined in dependencies
    $Dependencies = Get-AppKeyValue -SourcePath $SourcePath -KeyName 'dependencies'
    $Headers = Build-Headers

    foreach ($Dependency in $Dependencies) {
        if ($Dependency.publisher -eq 'Microsoft') {
            $Uri = 'http://{0}:7049/bc/dev/packages?publisher={1}&appName={2}&versionText={3}' -f $ContainerName, $Dependency.publisher, $Dependency.name, $Dependency.version
            Write-Host $Uri
            Invoke-WebRequest -Uri $Uri -Headers ($Headers) -OutFile (Join-Path $PackagesPath ('{0}_{1}_{2}.app' -f $Dependency.publisher, $Dependency.name, $Dependency.version))
            $SymbolsDownloaded = $true            
        }
    }

    if ($SymbolsDownloaded) {
        $Uri = 'http://{0}:7049/bc/dev/packages?publisher=Microsoft&appName=System&versionText={1}' -f $ContainerName, (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'platform')
        Write-Host $Uri
        Invoke-WebRequest -Uri $Uri -Headers ($Headers) -OutFile (Join-Path $PackagesPath ('Microsoft_System_{0}.app' -f (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'platform')))
    }
    # prior to BC15, system layer defined through properties in app.json
    else {
        $Uri = 'http://{0}:7049/nav/dev/packages?publisher=Microsoft&appName=Application&versionText={1}' -f $ContainerName, (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'application')
        Write-Host $Uri
        Invoke-WebRequest -Uri $Uri -Headers ($Headers) -OutFile (Join-Path $PackagesPath ('Microsoft_Application_{0}.app' -f (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'application')))
        
        $Uri = 'http://{0}:7049/nav/dev/packages?publisher=Microsoft&appName=System&versionText={1}' -f $ContainerName, (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'platform')
        Write-Host $Uri
        Invoke-WebRequest -Uri $Uri -Headers ($Headers) -OutFile (Join-Path $PackagesPath ('Microsoft_System_{0}.app' -f (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'platform')))
        
        if ($includeTestSymbols.IsPresent) {
            $Uri = 'http://{0}:7049/nav/dev/packages?publisher=Microsoft&appName=Test&versionText={1}' -f $ContainerName, (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'test')
            Write-Host $Uri
            Invoke-WebRequest -Uri $Uri -Headers ($Headers) -OutFile (Join-Path $PackagesPath ('Microsoft_Test_{0}.app' -f (Get-AppKeyValue -SourcePath $SourcePath -KeyName 'test')))
        }
    }
}

function Build-Headers
{
    Param(
        [Parameter(Mandatory=$true)]
        [string]$username,
        [Parameter(Mandatory=$true)]
        [string]$password
    )
    $ba = '{0}:{1}' -f $username, $password
    $ba = [System.Text.Encoding]::UTF8.GetBytes($ba)
    $ba = [System.Convert]::ToBase64String($ba)
    $h = @{Authorization=("Basic {0}" -f $ba);'Accept-Encoding'='gzip,deflate'}   
    $h
}