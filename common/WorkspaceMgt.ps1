. (Join-Path $PSScriptRoot 'BackupMgt.ps1')

function Get-HostHelperFolder {
    param(
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $defaultPath = 'C:\ProgramData\BcContainerHelper'
    if (-not [string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_HOST_HELPER_FOLDER)) {
        return $env:BCDEVTOOLSET_HOST_HELPER_FOLDER
    }

    if ($null -ne $settingsJSON.hostHelperFolder -and -not [string]::IsNullOrWhiteSpace($settingsJSON.hostHelperFolder)) {
        return $settingsJSON.hostHelperFolder
    }

    return $defaultPath
}

function Get-ShortcutMode {
    param(
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $defaultMode = 'None'
    if (-not [string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_SHORTCUTS)) {
        return $env:BCDEVTOOLSET_SHORTCUTS
    }

    if ($null -ne $settingsJSON.shortcuts -and -not [string]::IsNullOrWhiteSpace($settingsJSON.shortcuts)) {
        return $settingsJSON.shortcuts
    }

    return $defaultMode
}

function Get-BcConfigurationCredential {
    param(
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    if ($configuration.PSObject.Properties['bcUser'] -and $configuration.PSObject.Properties['bcPassword']) {
        $securePassword = ConvertTo-SecureString -String $configuration.bcPassword -AsPlainText -Force
        return New-Object pscredential $configuration.bcUser, $securePassword
    }

    $securePassword = ConvertTo-SecureString -String $configuration.password -AsPlainText -Force
    return New-Object pscredential $configuration.admin, $securePassword
}

function Get-WorkspaceRootPath {
    param(
        [Parameter(Mandatory=$false)]
        [string] $scriptPath = '',
        [Parameter(Mandatory=$false)]
        [string] $WorkspacePath = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($WorkspacePath)) {
        return Get-Item -LiteralPath $WorkspacePath
    }

    if ($Script:bcDevToolsetWorkspaceRootPath) {
        return Get-Item -LiteralPath $Script:bcDevToolsetWorkspaceRootPath
    }

    return Get-Item -LiteralPath (Get-Location).Path
}

function Get-OperationDefinitions {
    param(
        [Parameter(Mandatory=$true)]
        [string] $ScriptPath
    )

    $metadataPath = Join-Path (Join-Path $ScriptPath 'operations') 'operations.json'
    if (-not (Test-Path -LiteralPath $metadataPath)) {
        throw "Operation metadata file not found: $metadataPath"
    }

    $operations = @((Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json) | ForEach-Object { $_ })
    foreach ($operation in $operations) {
        if (-not [string]::IsNullOrWhiteSpace($operation.script)) {
            $operationPath = Join-Path $ScriptPath $operation.script
            if ($operation.PSObject.Properties['ScriptPath']) {
                $operation.ScriptPath = $operationPath
            } else {
                $operation | Add-Member -MemberType NoteProperty -Name ScriptPath -Value $operationPath
            }
        }

        if (-not $operation.PSObject.Properties['Text']) {
            $operation | Add-Member -MemberType NoteProperty -Name Text -Value $operation.title
        }
    }

    return $operations
}

function Resolve-SettingsPath {
    param(
        [Parameter(Mandatory=$true)]
        [string] $workspaceRootPath,
        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string] $settingsPath
    )

    if ([string]::IsNullOrWhiteSpace($settingsPath)) {
        return ''
    }

    if ([System.IO.Path]::IsPathRooted($settingsPath)) {
        return $settingsPath
    }

    return Join-Path $workspaceRootPath $settingsPath
}

function Merge-Settings {
    param(
        [Parameter(Mandatory=$true)]
        [PSObject] $target,
        [Parameter(Mandatory=$true)]
        [PSObject] $source
    )

    foreach ($property in $source.PSObject.Properties) {
        if ($property.Name -eq 'configurations') {
            if ($null -eq $target.configurations) {
                $target | Add-Member -MemberType NoteProperty -Name configurations -Value @() -Force
            }
            foreach ($configuration in $property.Value) {
                $target.configurations = $target.configurations + $configuration
            }
        } else {
            $target | Add-Member -MemberType NoteProperty -Name $property.Name -Value $property.Value -Force
        }
    }
}

function Merge-SettingsFile {
    param(
        [Parameter(Mandatory=$true)]
        [PSObject] $target,
        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string] $settingsPath
    )

    if ([string]::IsNullOrWhiteSpace($settingsPath) -or -not (Test-Path -LiteralPath $settingsPath)) {
        return
    }

    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    Merge-Settings -target $target -source $settings
}

function Resolve-WorkspaceFolderPath {
    param(
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string] $folderPath
    )

    if ([string]::IsNullOrWhiteSpace($folderPath)) {
        return $folderPath
    }

    if ([System.IO.Path]::IsPathRooted($folderPath)) {
        return $folderPath
    }

    $workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath
    return Join-Path $workspaceRootPath.FullName $folderPath
}

function Test-DockerContainerExists {
    param(
        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string] $containerName
    )

    if ([string]::IsNullOrWhiteSpace($containerName)) {
        Write-Host "Container name is empty. Skipping this configuration." -ForegroundColor Red
        return $false
    }

    $null = docker container inspect $containerName 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Docker container '$containerName' was not found. Skipping this configuration." -ForegroundColor Yellow
        return $false
    }

    return $true
}

function Get-DockerNetworkPresetDriver {
    param(
        [Parameter(Mandatory=$true)]
        [string] $network
    )

    $driversByPreset = @{
        nat = 'nat'
        transparent = 'transparent'
        l2bridge = 'l2bridge'
        l2tunnel = 'l2tunnel'
        overlay = 'overlay'
        none = 'null'
    }

    $networkKey = $network.ToLowerInvariant()
    if ($driversByPreset.ContainsKey($networkKey)) {
        return $driversByPreset[$networkKey]
    }

    return $null
}

function Get-DockerNetworkInfo {
    param(
        [Parameter(Mandatory=$true)]
        [string] $network
    )

    $networkJson = docker network inspect $network 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($networkJson)) {
        return $null
    }

    return ($networkJson | ConvertFrom-Json | Select-Object -First 1)
}

function Get-DockerNetworkInfoByPreset {
    param(
        [Parameter(Mandatory=$true)]
        [string] $network
    )

    $networkInfo = Get-DockerNetworkInfo -network $network
    if ($null -ne $networkInfo) {
        return $networkInfo
    }

    $networkKey = $network.ToLowerInvariant()
    $networkList = docker network ls --format '{{.Name}}' 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to list Docker networks. Verify that Docker is running and accessible."
    }

    $matchingNetworkName = @($networkList | Where-Object { $_.ToLowerInvariant() -eq $networkKey } | Select-Object -First 1)
    if ($matchingNetworkName.Count -eq 0) {
        return $null
    }

    return Get-DockerNetworkInfo -network $matchingNetworkName[0]
}

function Ensure-DockerNetwork {
    param(
        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string] $network
    )

    if ([string]::IsNullOrWhiteSpace($network)) {
        return ''
    }

    $expectedDriver = Get-DockerNetworkPresetDriver -network $network
    if ($null -eq $expectedDriver) {
        Write-Host "Docker network '$network' is a custom network. Skipping automatic network verification." -ForegroundColor Gray
        return $network
    }

    $networkInfo = Get-DockerNetworkInfoByPreset -network $network
    if ($null -eq $networkInfo) {
        if ($expectedDriver -eq 'null') {
            throw "Docker network '$network' was requested, but no built-in '$network' network exists on this Docker host."
        }

        Write-Host "Docker network '$network' was not found. Creating it with driver '$expectedDriver'." -ForegroundColor Yellow
        docker network create -d $expectedDriver $network | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create Docker network '$network' with driver '$expectedDriver'. Create or repair the network manually and retry."
        }

        $networkInfo = Get-DockerNetworkInfo -network $network
    }

    if ($null -eq $networkInfo) {
        throw "Docker network '$network' could not be inspected after verification."
    }

    if ($networkInfo.Driver -ne $expectedDriver) {
        throw "Docker network '$($networkInfo.Name)' uses driver '$($networkInfo.Driver)', but preset '$network' requires driver '$expectedDriver'. Remove or recreate the network before creating the container."
    }

    Write-Host "Docker network '$($networkInfo.Name)' verified with driver '$($networkInfo.Driver)'." -ForegroundColor Gray
    return $networkInfo.Name
}

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
    Write-Host ""    
    if ($replaceJSON -eq $true) {
        Write-Host "Replacing launch.json for '$appPath'." -ForegroundColor Green
    } else {
        Write-Host "Updating launch.json for '$appPath'." -ForegroundColor Green
    }

    # Read launch.json
    $appPath = Resolve-WorkspaceFolderPath -scriptPath $scriptPath -folderPath $appPath

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
                [Version] $appRuntime = $null
                $breakOnError = "All"
                if ($appJSON.PSObject.Properties['runtime'] -and [Version]::TryParse([string]$appJSON.runtime, [ref]$appRuntime) -and $appRuntime -ge [Version]"10.0") {
                    $breakOnError = "ExcludeTry"
                }
				$configuration | Add-Member -MemberType NoteProperty -Name startupObjectId -Value 22
				$configuration | Add-Member -MemberType NoteProperty -Name startupObjectType -Value "Page"
				$configuration | Add-Member -MemberType NoteProperty -Name breakOnError -Value $breakOnError
				$configuration | Add-Member -MemberType NoteProperty -Name launchBrowser -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name enableLongRunningSqlStatements -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name enableSqlInformationDebugger -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name usePublicURLFromServer -Value $true
				$configuration | Add-Member -MemberType NoteProperty -Name schemaUpdateMode -Value "ForceSync"
				$configuration | Add-Member -MemberType NoteProperty -Name breakOnRecordWrite -Value "None"
				$configuration | Add-Member -MemberType NoteProperty -Name longRunningSqlStatementsThreshold -Value 500
				$configuration | Add-Member -MemberType NoteProperty -Name numberOfSqlStatements -Value 10
			}
        }
	}
    
    
    # Write launch.json
    Write-Host "Writing $launchFilename..." -ForegroundColor Blue
    $launchFolder = Split-Path -Path $launchFilename -Parent
    if (-not (Test-Path -Path $launchFolder)) {
        New-Item -Path $launchFolder -ItemType Directory -Force | Out-Null
    }
    $launchJSON | ConvertTo-Json -Depth 10 | Format-Json | Set-Content -Path $launchFilename -Force
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
        [bool] $defaultYes = $false,
        [Parameter(Mandatory=$false)]
        [string] $PromptId = '',
        [Parameter(Mandatory=$false)]
        [string] $Risk = '',
        [Parameter(Mandatory=$false)]
        [bool] $AgentAllowed = $true,
        [Parameter(Mandatory=$false)]
        [bool] $Destructive = $false,
        [Parameter(Mandatory=$false)]
        [bool] $Sensitive = $false
    )

    if ($defaultYes -eq $true) {
        $answerYes = $answerYes.ToUpper()
        $answerNo = $answerNo.ToLower()
    } else {
        $answerYes = $answerYes.ToLower()
        $answerNo = $answerNo.ToUpper()
    }

    $Confirm = $answerNo
    $mcpAnswer = Request-BcDevToolsetMcpConfirm -Question $question -DefaultYes:($defaultYes -eq $true) -PromptId $PromptId -Risk $Risk -AgentAllowed $AgentAllowed -Destructive $Destructive -Sensitive $Sensitive
    if ($null -ne $mcpAnswer) {
        return $mcpAnswer
    }

    Write-Host "$question [$answerYes/$answerNo]: " -NoNewline -ForegroundColor Green
    $Confirm = Read-Host
    if ([string]::IsNullOrWhiteSpace($Confirm)) {
        $Confirm = $answerNo
    }
        
    return($Confirm.ToUpper() -eq $answerYes.ToUpper())
}

function Request-BcDevToolsetMcpConfirm {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $Question,
        [Parameter(Mandatory=$false)]
        [bool] $DefaultYes = $false,
        [Parameter(Mandatory=$false)]
        [string] $PromptId = '',
        [Parameter(Mandatory=$false)]
        [string] $Risk = '',
        [Parameter(Mandatory=$false)]
        [bool] $AgentAllowed = $true,
        [Parameter(Mandatory=$false)]
        [bool] $Destructive = $false,
        [Parameter(Mandatory=$false)]
        [bool] $Sensitive = $false
    )

    $answer = Request-BcDevToolsetMcpPrompt `
        -PromptId $PromptId `
        -Type 'confirm' `
        -Question $Question `
        -DefaultValue $(if ($DefaultYes) { 'yes' } else { 'no' }) `
        -Choices @('yes', 'no') `
        -Risk $Risk `
        -AgentAllowed $AgentAllowed `
        -Destructive $Destructive `
        -Sensitive $Sensitive

    if ($null -eq $answer) {
        return $null
    }

    try {
        $normalizedAnswer = $answer.Trim().ToLowerInvariant()
        if ($normalizedAnswer -in @('true', 'yes', 'y', '1')) {
            Write-Host "Answer received through MCP: Yes" -ForegroundColor Green
            return $true
        }
        if ($normalizedAnswer -in @('false', 'no', 'n', '0')) {
            Write-Host "Answer received through MCP: No" -ForegroundColor Green
            return $false
        }

        throw "Unsupported MCP answer '$answer'. Expected yes or no."
    } catch {
        Write-Host "MCP prompt handling failed: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}

function Request-BcDevToolsetMcpPrompt {
    Param (
        [Parameter(Mandatory=$false)]
        [string] $PromptId = '',
        [Parameter(Mandatory=$true)]
        [string] $Type,
        [Parameter(Mandatory=$true)]
        [string] $Question,
        [Parameter(Mandatory=$false)]
        [string] $DefaultValue = '',
        [Parameter(Mandatory=$false)]
        [array] $Choices = @(),
        [Parameter(Mandatory=$false)]
        [string] $Risk = '',
        [Parameter(Mandatory=$false)]
        [bool] $AgentAllowed = $true,
        [Parameter(Mandatory=$false)]
        [bool] $Destructive = $false,
        [Parameter(Mandatory=$false)]
        [bool] $Sensitive = $false
    )

    $promptUrl = $env:BCDEVTOOLSET_MCP_PROMPT_URL
    $promptToken = $env:BCDEVTOOLSET_MCP_PROMPT_TOKEN
    $sessionId = $env:BCDEVTOOLSET_MCP_SESSION_ID
    if ([string]::IsNullOrWhiteSpace($promptUrl) -or [string]::IsNullOrWhiteSpace($promptToken) -or [string]::IsNullOrWhiteSpace($sessionId)) {
        return $null
    }

    $effectivePromptId = $PromptId
    if ([string]::IsNullOrWhiteSpace($effectivePromptId)) {
        $hashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Question))
        $effectivePromptId = -join ($hashBytes[0..5] | ForEach-Object { $_.ToString('x2') })
    }

    $body = @{
        sessionId = $sessionId
        prompt = @{
            id = $effectivePromptId
            type = $Type
            question = $Question
            default = $DefaultValue
            choices = $Choices
            agentAllowed = $AgentAllowed
            destructive = $Destructive
            sensitive = $Sensitive
            risk = $Risk
        }
    } | ConvertTo-Json -Depth 8

    Write-Host "Waiting for MCP agent/user answer..." -ForegroundColor Yellow

    try {
        $headers = @{ Authorization = "Bearer $promptToken" }
        $response = Invoke-RestMethod -Method Post -Uri $promptUrl -Headers $headers -Body $body -ContentType 'application/json'
        $answer = [string]$response.answer
        if ([string]::IsNullOrWhiteSpace($answer)) {
            $answer = [string]$response.value
        }
        if ([string]::IsNullOrWhiteSpace($answer)) {
            $answer = $DefaultValue
        }

        return $answer
    } catch {
        Write-Host "MCP prompt handling failed, falling back to terminal input: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

# Formats JSON in a nicer format than the built-in ConvertTo-Json does.
function Format-Json([Parameter(Mandatory, ValueFromPipeline)][String] $json) {
    $indent = 0;
    ($json -Split "`n" | ForEach-Object {
        if (($_.TrimEnd().Substring(0, $_.TrimEnd().Length - 1)) -match '[\{\[]') {
            # This line contains but does not end with [ or {, increment the indentation level
            $indent++
        }
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

        $settingsFolder = Split-Path -Parent $settingsPath
        if (-not [string]::IsNullOrWhiteSpace($settingsFolder) -and -not (Test-Path -LiteralPath $settingsFolder)) {
            New-Item -ItemType Directory -Path $settingsFolder -Force | Out-Null
        }

        # File doesn't exist, create with default values
        $defaultSettings = [PSCustomObject]@{}
        $defaultSettings | Add-Member -MemberType NoteProperty -Name licenseFile -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name certificateFile -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name packageOutputPath -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name dependenciesPaths -Value @()
        $defaultSettings | Add-Member -MemberType NoteProperty -Name recordingsPath -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name pageScriptTestResultsPath -Value ""
        $defaultSettings | Add-Member -MemberType NoteProperty -Name pageScriptTestHeaded -Value "false"
        $defaultSettings | Add-Member -MemberType NoteProperty -Name configurations -Value @()

        # add container configuration
        $remoteConfiguration = [PSCustomObject]@{}
        #$remoteConfiguration | Add-Member -MemberType NoteProperty -Name name -Value "$workspaceName Default"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name name -Value "Local"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name serverType -Value "Container"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name targetType -Value "Dev"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name container -Value $workspaceName.Replace(' ','-')
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name environmentType -Value "Sandbox"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name includeTestToolkit -Value "false"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name authentication -Value "UserPassword"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name bcUser -Value "admin"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name bcPassword -Value "P@ssw0rd"
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name sqlBackupPath -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name network -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name hostIP -Value ""
        $remoteConfiguration | Add-Member -MemberType NoteProperty -Name updateHosts -Value $true
        $defaultSettings.configurations += $remoteConfiguration

        $defaultSettings | ConvertTo-Json -Depth 10 | Format-Json | Out-File -FilePath $settingsPath -Force
        Write-Host "$settingsPath created." -ForegroundColor Green
        }
}
function Select-IndexFromList {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $Title,
        [Parameter(Mandatory=$true)]
        [array] $Options,
        [Parameter(Mandatory=$false)]
        [int] $DefaultIndex = 0
    )

    if (-not $Options -or $Options.Count -eq 0) {
        throw "No options provided for selection."
    }

    if ($DefaultIndex -lt 0 -or $DefaultIndex -ge $Options.Count) {
        $DefaultIndex = 0
    }

    Write-Host ""; Write-Host $Title -ForegroundColor Blue
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $marker = if ($i -eq $DefaultIndex) { '*' } else { ' ' }
        Write-Host ("[{0}] {1} {2}" -f ($i+1), $Options[$i], $marker)
    }

    while ($true) {
        $prompt = "Select an option [1..{0}] (Enter={1}): " -f $Options.Count, ($DefaultIndex+1)
        $selection = Request-BcDevToolsetMcpPrompt -PromptId "selectIndex.$($Title -replace '[^A-Za-z0-9]+', '.')" -Type 'choice' -Question $prompt -DefaultValue "$($DefaultIndex + 1)" -Choices @(1..$Options.Count | ForEach-Object { "$_" }) -Risk "Selects one of the displayed options."
        if ($null -eq $selection) {
            $selection = Read-Host -Prompt $prompt
        } else {
            Write-Host "Answer received through MCP: $selection" -ForegroundColor Green
        }
        if ([string]::IsNullOrWhiteSpace($selection)) { return $DefaultIndex }

        $n = 0
        if ([int]::TryParse($selection, [ref]$n)) {
            if ($n -ge 1 -and $n -le $Options.Count) {
                return ($n - 1)
            }
        }
        Write-Host "Invalid selection. Please enter a number between 1 and $($Options.Count)." -ForegroundColor Red
    }
}
function Initialize-Context {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [ref] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [ref] $workspaceJSON,
        [Parameter(Mandatory=$false)]
        [string] $WorkspacePath = $env:BCDEVTOOLSET_WORKSPACE_PATH,
        [Parameter(Mandatory=$false)]
        [string] $WorkspaceFile = $env:BCDEVTOOLSET_WORKSPACE_FILE,
        [Parameter(Mandatory=$false)]
        [string] $ProjectSettingsPath = $env:BCDEVTOOLSET_PROJECT_SETTINGS_PATH,
        [Parameter(Mandatory=$false)]
        [string] $LocalSettingsPath = $env:BCDEVTOOLSET_LOCAL_SETTINGS_PATH,
        [Parameter(Mandatory=$false)]
        [string] $SettingsPath = $env:BCDEVTOOLSET_SETTINGS_PATH
    )

    # Workspace
    $workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath -WorkspacePath $WorkspacePath
    $Script:bcDevToolsetWorkspaceRootPath = $workspaceRootPath.FullName

    $selectedFile = Resolve-BcDevToolsetWorkspaceFile -WorkspaceRootPath $workspaceRootPath.FullName -WorkspaceFile $WorkspaceFile

    if ($null -ne $selectedFile) {
        # Read selected *.code-workspace
        $workspaceJSON.Value = Get-Content -Path $selectedFile.FullName | ConvertFrom-Json
        $workspaceName = $selectedFile.Name
        $workspaceName = $workspaceName -split '\.' | Select-Object -First 1
        $workspaceRootPath = Get-Item -LiteralPath $selectedFile.DirectoryName
        $Script:bcDevToolsetWorkspaceRootPath = $workspaceRootPath.FullName
    } else {
        # throw "No $filterExtension files found in the folder."
        # there IS no workspace
        $workspaceJSON.value = [PSCustomObject]@{
            folders = @([PSCustomObject]@{
                path = $workspaceRootPath.FullName
            })
        }
        $workspaceName = $workspaceRootPath.Name
    }

    Write-Host "Toolset root is: $scriptPath" -ForegroundColor Gray
    Write-Host "Root folder is: $workspaceRootPath" -ForegroundColor Gray
    Write-Host "Workspace Name is: $workspaceName" -ForegroundColor Gray
    
    # Set the path for settings.json
    $localSettingsMergedAsBase = $false
    if ([string]::IsNullOrWhiteSpace($SettingsPath) -and [string]::IsNullOrWhiteSpace($LocalSettingsPath)) {
        $LocalSettingsPath = Join-Path $workspaceRootPath.FullName '.bcdevtoolset' 'settings.json'
    }

    if ([string]::IsNullOrWhiteSpace($SettingsPath) -and -not [string]::IsNullOrWhiteSpace($LocalSettingsPath)) {
        $settingsPath = Resolve-SettingsPath -workspaceRootPath $workspaceRootPath.FullName -settingsPath $LocalSettingsPath
        $localSettingsMergedAsBase = $true
    } elseif ([string]::IsNullOrWhiteSpace($SettingsPath)) {
        $settingsPath = Join-Path $workspaceRootPath.FullName '.bcdevtoolset\settings.json'
        $localSettingsMergedAsBase = $true
    } elseif ([System.IO.Path]::IsPathRooted($SettingsPath)) {
        $settingsPath = $SettingsPath
    } else {
        $settingsPath = Join-Path $workspaceRootPath.FullName $SettingsPath
    }
    Build-Settings $settingsPath $workspaceName

    # Read settings.json
    $settingsJSONvalue = Get-Content -Path $settingsPath | ConvertFrom-Json

    $resolvedProjectSettingsPath = Resolve-SettingsPath -workspaceRootPath $workspaceRootPath.FullName -settingsPath $ProjectSettingsPath
    Merge-SettingsFile -target $settingsJSONvalue -settingsPath $resolvedProjectSettingsPath

    if (-not $localSettingsMergedAsBase) {
        $resolvedLocalSettingsPath = Resolve-SettingsPath -workspaceRootPath $workspaceRootPath.FullName -settingsPath $LocalSettingsPath
        Merge-SettingsFile -target $settingsJSONvalue -settingsPath $resolvedLocalSettingsPath
    }

    # Initialize host helper folder from settings, with default fallback
    Set-Variable -Name hostHelperFolder -Value (Get-HostHelperFolder $settingsJSONvalue) -Scope Script

    # Add country from code-workspace
    $country = ''
    if ($workspaceJSON.value.settings."dam-pav.bcdevtoolset".country) {
        $country = $workspaceJSON.value.settings."dam-pav.bcdevtoolset".country
    }
    if ($country -eq '') {
        $country = "w1"
    }

    $settingsJSONvalue | Add-Member -MemberType NoteProperty -Name country -Value $country -Force

    # Add missing defaults
    if ($null -eq $settingsJSONvalue.shortcuts) {
        $settingsJSONvalue | Add-Member -MemberType NoteProperty -Name shortcuts -Value (Get-ShortcutMode $settingsJSONvalue)
    } else {
        $settingsJSONvalue.shortcuts = Get-ShortcutMode $settingsJSONvalue
    }
    # Add configurations from code-workspace
    foreach ($remote in $workspaceJSON.value.settings."dam-pav.bcdevtoolset".configurations) {
        $settingsJSONvalue.configurations = $settingsJSONvalue.configurations + $remote
    }

    foreach ($configuration in $settingsJSONvalue.configurations) {
        if ($configuration.serverType -eq "Container") {
            if ($null -eq $configuration.sqlBackupPath) {
                $configuration | Add-Member -MemberType NoteProperty -Name sqlBackupPath -Value ""
            }
        }
    }
    # finally, pass the object
    $settingsJSON.Value = $settingsJSONvalue
}

function Resolve-BcDevToolsetWorkspaceFile {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $WorkspaceRootPath,
        [Parameter(Mandatory=$false)]
        [string] $WorkspaceFile
    )

    if (-not [string]::IsNullOrWhiteSpace($WorkspaceFile)) {
        $workspaceFilePath = if ([System.IO.Path]::IsPathRooted($WorkspaceFile)) {
            $WorkspaceFile
        } else {
            Join-Path $WorkspaceRootPath $WorkspaceFile
        }

        if (-not (Test-Path -LiteralPath $workspaceFilePath -PathType Leaf)) {
            throw "Workspace file not found: $workspaceFilePath"
        }

        return Get-Item -LiteralPath $workspaceFilePath
    }

    if ($env:BCDEVTOOLSET_ALLOW_WORKSPACE_FILE_DISCOVERY -ne 'true') {
        return $null
    }

    $workspaceFiles = @(Get-ChildItem -Path $WorkspaceRootPath -Filter '*.code-workspace' -File)
    if ($workspaceFiles.Count -eq 0) {
        return $null
    }

    if ($workspaceFiles.Count -eq 1) {
        return $workspaceFiles[0]
    }

    $options = @()
    foreach ($workspaceFileCandidate in $workspaceFiles) {
        $options += $workspaceFileCandidate.Name
    }

    $idx = Select-IndexFromList -Title "Multiple workspace files found. Please select one:" -Options $options -DefaultIndex 0
    return $workspaceFiles[$idx]
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
    $appPath = Resolve-WorkspaceFolderPath -scriptPath $scriptPath -folderPath $appPath
    $appName = Split-Path -Path $appPath -Leaf
    if ($appName -eq '.bcdevtoolset') {
        # this is not an app folder
        $appJSON.Value = [PSCustomObject]@{}
        return
    }
    
    # Read app.json
    $appFilename = "$appPath\app.json"

    if (Test-Path $appFilename) {
        $appJSON.Value = Get-Content -Path $appFilename | ConvertFrom-Json
        Write-Host "'$appFilename' loaded." -ForegroundColor Blue
    } else {
        $appJSON.Value = [PSCustomObject]@{}
        Write-Host "'$appPath' is not an app folder; app.json was not found." -ForegroundColor Gray
    }
}

function Get-PackageParams {
    Param (
        [Parameter(Mandatory=$false)]
        [string] $scriptPath = "",
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
            $packagePath.Value = Resolve-WorkspaceFolderPath -scriptPath $scriptPath -folderPath $($settingsJSON.packageOutputPath)
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

    if (-not (Test-DockerContainerExists -containerName $containerName)) {
        return
    }

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
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON
    )
    $workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath

    if (Confirm-Option -question "Do you want to clear the translation files?" -PromptId "clearArtifacts.translationFiles" -Risk "Deletes generated translation files from the workspace.") {
        foreach ($appPath in $workspaceJSON.folders.path) {
            # Read app.json
            $appPath = Resolve-WorkspaceFolderPath -scriptPath $scriptPath -folderPath $appPath

            # Confirm it is an app folder
            if (Test-Path $(Join-Path $appPath "app.json")) {
                Get-ChildItem -Path $appPath -Include *.g.xlf -Recurse | Remove-Item
            }
        }
        Write-Host "Translation files cleared." -ForegroundColor Blue
    }
    
    if (Confirm-Option -question "Do you want to clear all APP files? You will need to download symbols for all projects." -PromptId "clearArtifacts.appFiles" -Risk "Deletes APP files and requires downloading symbols again.") {
        foreach ($appPath in $workspaceJSON.folders.path) {
            # Read app.json
            $appPath = Resolve-WorkspaceFolderPath -scriptPath $scriptPath -folderPath $appPath

            # Confirm it is an app folder
            if (Test-Path $(Join-Path $appPath "app.json")) {
                Get-ChildItem -Path $appPath -Include *.app -Recurse | Remove-Item
            }
        }
        Write-Host "APP files cleared." -ForegroundColor Blue
    }
}

function Test-HostsFileWritable {
    $hostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
    try {
        $file = [System.IO.File]::Open($hostsFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
        $file.Close()
        return $true
    }
    catch {
        return $false
    }
}

function Repair-HostsFilePermissions {
    if (Test-HostsFileWritable) {
        return $true
    }

    Write-Host "Hosts file is not writable. Running Check-BcContainerHelperPermissions -Fix to enable container hostname updates." -ForegroundColor Yellow
    Check-BcContainerHelperPermissions -Fix

    return (Test-HostsFileWritable)
}

function Get-QualifiedDockerContainerConfigurations {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    return @($settingsJSON.configurations | Where-Object {
        $_.serverType -eq "Container" -and -not [string]::IsNullOrWhiteSpace($_.container)
    })
}

function Test-UniqueDockerContainerConfigurationNames {
    Param (
        [Parameter(Mandatory=$true)]
        [array] $configurations
    )

    $duplicates = @($configurations |
        Group-Object -Property { ([string]$_.container).Trim().ToLowerInvariant() } |
        Where-Object { $_.Count -gt 1 })

    if ($duplicates.Count -eq 0) {
        return $true
    }

    Write-Host "Create container operation stopped." -ForegroundColor Red
    Write-Host "Each Container configuration must specify a unique 'container' value." -ForegroundColor Red
    Write-Host "Duplicate container values found:" -ForegroundColor Red

    foreach ($duplicate in $duplicates) {
        $containerName = $duplicate.Group[0].container
        $configurationNames = @($duplicate.Group | ForEach-Object { $_.name }) -join "', '"
        Write-Host " - '$containerName' is used by configurations '$configurationNames'." -ForegroundColor Red
    }

    Write-Host "Update the duplicate configuration entries and run the operation again." -ForegroundColor Yellow
    return $false
}

function Select-DockerContainerConfigurations {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [string] $operationName
    )

    $qualifiedConfigurations = @(Get-QualifiedDockerContainerConfigurations -settingsJSON $settingsJSON)
    if ($qualifiedConfigurations.Count -eq 0) {
        Write-Host "No Container configurations with a non-empty container value found." -ForegroundColor Red
        return @()
    }

    if (-not (Test-UniqueDockerContainerConfigurationNames -configurations $qualifiedConfigurations)) {
        return @()
    }

    if ($qualifiedConfigurations.Count -eq 1) {
        return @($qualifiedConfigurations[0])
    }

    $options = @()
    foreach ($configuration in $qualifiedConfigurations) {
        $options += "$($configuration.name) ($($configuration.container))"
    }
    $options += "All qualified containers"

    $selectedIndex = Select-IndexFromList `
        -Title "Select container configuration for $($operationName):" `
        -Options $options `
        -DefaultIndex 0

    if ($selectedIndex -eq ($options.Count - 1)) {
        return $qualifiedConfigurations
    }

    return @($qualifiedConfigurations[$selectedIndex])
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
        [string] $selectArtifact,
        [Parameter(Mandatory=$true)]
        [bool] $pullFullArtifact
    )
    
    $selectedConfigurations = @(Select-DockerContainerConfigurations `
        -settingsJSON $settingsJSON `
        -operationName "container creation")

    if ($selectedConfigurations.Count -eq 0) {
        $false
        return
    }

    foreach ($configuration in $selectedConfigurations) {

        # No mutex for the time being, we do it manually
        $credential = Get-BcConfigurationCredential -configuration $configuration
        $auth = $configuration.authentication

        if ($appJSON.application -eq "") {
            throw "Artifact URL could not be determined based on $appPath\app.json. Processing aborted."
        } else {
            $appJSONapplication = $appJSON.application
            if ($selectArtifact -eq 'Closest') {
                Write-Host "Retrieving artifact URL for $($configuration.environmentType) app version $($appJSON.application)."
            } else {
                $versionParts = $appJSONapplication -split '\.'
                $cleanVersion = @()
                for ($i = $versionParts.Length - 1; $i -ge 0; $i--) {
                    if ($versionParts[$i] -ne "0" -or $cleanVersion.Count -gt 0) {
                        $cleanVersion = ,$versionParts[$i] + $cleanVersion
                    }
                }
                $appJSONapplication = $cleanVersion -join '.'
                Write-Host "Retrieving $selectArtifact artifact URL for version $appJSONapplication."
            }
        }

        if (-not $testmode) {
            $Parameters = @{
                type = $configuration.environmentType
                country = $settingsJSON.country
                version = $appJSONapplication
                select = $selectArtifact
            }
            $artifactUrl = Get-BcArtifactUrl @Parameters
            if ("$artifactUrl" -eq "") {
                throw "Artifact URL could not be determined for $($configuration.environmentType) app version $($appJSON.application). Processing aborted."
            } else {
                Write-Host "Using artifact URL $artifactUrl."
            }
        }

        <# AVAILABLE PARAMETERS
        [switch] $accept_eula,
        [switch] $accept_insiderEula,
        [switch] $accept_outdated = $true,
        [string] $containerName = $bcContainerHelperConfig.defaultContainerName,
        [string] $imageName = "",
        [string] $artifactUrl = "", 
        [Alias('navDvdPath')]
        [string] $dvdPath = "", 
        [Alias('navDvdCountry')]
        [string] $dvdCountry = "",
        [Alias('navDvdVersion')]
        [string] $dvdVersion = "",
        [Alias('navDvdPlatform')]
        [string] $dvdPlatform = "",
        [string] $locale = "",
        [switch] $setServiceTierUserLocale,
        [string] $licenseFile = "",
        [PSCredential] $Credential = $null,
        [string] $authenticationEMail = "",
        [string] $AadTenant = "",
        [string] $AadAppId = "",
        [string] $AadAppIdUri = "",
        [string] $memoryLimit = "",
        [string] $sqlMemoryLimit = "",
        [ValidateSet('','process','hyperv')]
        [string] $isolation = "",
        [string] $databaseServer = "",
        [string] $databaseInstance = "",
        [string] $databasePrefix = "",
        [string] $databaseName = "",
        [switch] $replaceExternalDatabases,
        [string] $bakFile = "",
        [string] $bakFolder = "",
        [PSCredential] $databaseCredential = $null,
        [ValidateSet('None','Desktop','StartMenu','CommonStartMenu','CommonDesktop','DesktopFolder','CommonDesktopFolder')]
        [string] $shortcuts='Desktop',
        [switch] $updateHosts,
        [switch] $useSSL,
        [switch] $installCertificateOnHost,
        [switch] $includeAL,
        [string] $runTxt2AlInContainer = $containerName,
        [switch] $includeCSide,
        [switch] $enableSymbolLoading,
        [switch] $enableTaskScheduler,
        [switch] $doNotExportObjectsToText,
        [switch] $alwaysPull,
        [switch] $forceRebuild,
        [switch] $useBestContainerOS,
        [string] $useGenericImage,
        [switch] $assignPremiumPlan,
        [switch] $multitenant,
        [switch] $filesOnly,
        [string[]] $addFontsFromPath = @(""),
        [hashtable] $featureKeys = $null,
        [switch] $clickonce,
        [switch] $includeTestToolkit,
        [switch] $includeTestLibrariesOnly,
        [switch] $includeTestFrameworkOnly,
        [switch] $includePerformanceToolkit,
        [ValidateSet('no','on-failure','unless-stopped','always')]
        [string] $restart='unless-stopped',
        [ValidateSet('Windows','NavUserPassword','UserPassword','AAD')]
        [string] $auth='Windows',
        [int] $timeout = 1800,
        [int] $sqlTimeout = 300,
        [string[]] $additionalParameters = @(),
        $myScripts = @(),
        [string] $TimeZoneId = $null,
        [int] $WebClientPort,
        [int] $FileSharePort,
        [int] $ManagementServicesPort,
        [int] $ClientServicesPort,
        [int] $SoapServicesPort,
        [int] $ODataServicesPort,
        [int] $DeveloperServicesPort,
        [int[]] $PublishPorts = @(),
        [string] $PublicDnsName,
        [string] $network = "",
        [string] $hostIP = "",
        [string] $macAddress = "",
        [string] $IP = "",
        [string] $dns = "",
        [switch] $useTraefik,
        [switch] $useCleanDatabase,
        [switch] $useNewDatabase,
        [switch] $runSandboxAsOnPrem,
        [switch] $doNotCopyEntitlements,
        [string[]] $copyTables = @(),
        [switch] $dumpEventLog,
        [switch] $doNotCheckHealth,
        [switch] $doNotUseRuntimePackages = $true,
        [string] $vsixFile = "",
        [string] $applicationInsightsKey,
        [scriptblock] $finalizeDatabasesScriptBlock,
        [switch] $useSqlServerModule = $bcContainerHelperConfig.useSqlServerModule
        #>

        $Parameters = @{
            accept_eula = $true
            assignPremiumPlan = $true
            containerName = $configuration.container
            credential = $credential
            auth = $auth
            artifactUrl = $artifactUrl
            shortcuts = $settingsJSON.shortcuts
            }

        $updateHosts = -not ($configuration.PSObject.Properties['updateHosts'] -and ([string]$configuration.updateHosts).Trim().ToLowerInvariant() -eq 'false')
        if ($updateHosts) {
            if (Repair-HostsFilePermissions) {
                $Parameters.updateHosts = $true
            } else {
                throw "Hosts file is not writable after running Check-BcContainerHelperPermissions -Fix. Container hostname resolution is required, so create-container processing cannot continue."
            }
        }

        if ($configuration.environmentType -eq "OnPrem" -and $appJSON.application -ge [Version]"18.0.0.0") {
                $Parameters.runSandboxAsOnPrem = $true
            }

        if ($pullFullArtifact) {
            $Parameters.alwaysPull = $true
        }

        $licenseFile = ""
        if ($settingsJSON.licenseFile -ne "") {
            if (-not (Test-Path -Path $settingsJSON.licenseFile)) {
                Write-Host "WARNING: The license file '$($settingsJSON.licenseFile)' could not be found. Verify and install the license as a separate step." -ForegroundColor Red
            }
            else {
                $licenseFile = (Resolve-Path -Path $settingsJSON.licenseFile).Path
                $Parameters.licenseFile = $licenseFile
            }
        }

        if ($configuration.includeTestToolkit -eq 'true') {
            $Parameters.includeTestToolkit = $true
        }

        foreach ($parameterName in @('network', 'hostIP', 'macAddress', 'IP', 'dns')) {
            if ($configuration.PSObject.Properties[$parameterName] -and -not [string]::IsNullOrWhiteSpace($configuration.$parameterName)) {
                if ($parameterName -eq 'network' -and -not $testmode) {
                    $Parameters[$parameterName] = Ensure-DockerNetwork -network ([string]$configuration.$parameterName)
                } else {
                    $Parameters[$parameterName] = [string]$configuration.$parameterName
                }
            }
        }
            
        if (-not $testmode) {
            $backupRootPath = Get-SqlBackupRootPath `
                -scriptPath $scriptPath `
                -sqlBackupPath $configuration.sqlBackupPath

            if (-not [string]::IsNullOrWhiteSpace($backupRootPath) -and (Test-Path -Path $backupRootPath -PathType Container)) {
                $backupEntries = @(Get-SqlBackupSetEntries -backupRootPath $backupRootPath)
                $appBackupEntries = @($backupEntries | Where-Object { $_.DatabaseRole -eq 'app' })
                $databaseBackupEntries = @($backupEntries | Where-Object { $_.DatabaseRole -eq 'database' })
                if ($appBackupEntries.Count -gt 0) {
                    $Parameters.bakFolder = Copy-SqlBackupSetToSharedFolder `
                        -containerName $configuration.container `
                        -backupRootPath $backupRootPath `
                        -sharedFolderName "NewContainer"

                    Write-Host "New container will be initialized from SQL backup set '$backupRootPath'." -ForegroundColor Green
                } elseif ($databaseBackupEntries.Count -gt 0) {
                    $Parameters.bakFolder = Copy-SqlBackupSetToSharedFolder `
                        -containerName $configuration.container `
                        -backupRootPath $backupRootPath `
                        -sharedFolderName "NewContainer"
                    $Parameters.multitenant = $false

                    Write-Host "New single-tenant container will be initialized from SQL backup set '$backupRootPath'." -ForegroundColor Green
                } elseif ($backupEntries.Count -gt 0) {
                    Write-Host "SQL backup folder '$backupRootPath' contains tenant backups but no application (*.app.bak) or single-tenant database (*.database.bak) backup. Container will use a fresh database." -ForegroundColor Yellow
                } else {
                    Write-Host "No SQL backup set found. Container will use a fresh database." -ForegroundColor Gray
                }
            } else {
                Write-Host "No SQL backup set found. Container will use a fresh database." -ForegroundColor Gray
            }

            if ($Parameters.ContainsKey('bakFolder') -and -not [string]::IsNullOrWhiteSpace($licenseFile)) {
                $licenseFileName = Split-Path -Path $licenseFile -Leaf
                $containerLicenseFile = "c:\run\my\$licenseFileName"
                $escapedContainerLicenseFile = $containerLicenseFile.Replace("'", "''")
                $Parameters.myScripts = @(
                    $licenseFile
                    @{
                        "SetupNavUsers.ps1" = @"
Write-Host "Importing License $escapedContainerLicenseFile before creating users"
Import-NAVServerLicense -LicenseFile '$escapedContainerLicenseFile' -ServerInstance `$ServerInstance -Database NavDatabase -WarningAction SilentlyContinue
. "c:\run\SetupNavUsers.ps1"
"@
                    }
                )
                Write-Host "SQL backup restore detected. The license will be imported before NAV user setup because BcContainerHelper skips -licenseFile for restored bakFolder databases." -ForegroundColor Yellow
            }

            New-BcContainer @Parameters
        }

        Write-Host "The docker instance $($configuration.container) should be ready." -ForegroundColor Green
        Write-Host ""
    }

    $true
}

function Update-ContainerServerConfiguration {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )
    
    $configurationFound = $false
    foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
        $configurationFound = $true
        if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
            continue
        }

        Invoke-ScriptInNavContainer -containername $configuration.container -scriptblock {
            Param($settings)

            if ($settings.serverConfiguration) {
                foreach ($config in $settings.serverConfiguration) {
                    Write-Host "Verifying: the old value for $($config.KeyName) is $(Get-NavServerConfiguration -ServerInstance BC -KeyName $config.KeyName)" -ForegroundColor Gray
                    Write-Host "Setting $($config.KeyName) to $($config.KeyValue)" -ForegroundColor Gray
                    Set-NavServerConfiguration -ServerInstance BC -KeyName $config.KeyName -KeyValue $config.KeyValue -ApplyTo ConfigFile #possible ApplyTo options: ConfigFile,Memory,All
                    Write-Host "Verifying: the new value for $($config.KeyName) is $(Get-NavServerConfiguration -ServerInstance BC -KeyName $config.KeyName)" -ForegroundColor Gray
                }
            }

            Set-NavServerInstance -ServerInstance BC -restart
        } -ArgumentList $configuration

        Write-Host "The docker instance $($configuration.container) should now have the configuration updated." -ForegroundColor Green
        Write-Host ""
    }

    if (-not $configurationFound) {
        Write-Host "No Docker configurations found." -ForegroundColor Red
    }
}

function Update-BcLicense {
    Param (
        [bool] $testMode = $false,
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )
    
    $configurationFound = $false
    foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
        $configurationFound = $true
        if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
            continue
        }

        if ($settingsJSON.licenseFile -eq "") {
            throw "A license file is not specified in Settings. Processing aborted."
        }
            
        $Parameters = @{
            restart = $true
            containerName = $configuration.container
            licenseFile = $settingsJSON.licenseFile
        }

        if (-not $testmode) {
            Import-BcContainerLicense @Parameters
        }

        Write-Host "The docker instance $($configuration.container) should have the new license installed." -ForegroundColor Green
        Write-Host ""
    }

    if (-not $configurationFound) {
        Write-Host "No Docker configurations found." -ForegroundColor Red
        $false
        return
    }

    $true
}

function Show-ActiveBcContainerLicenses {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $configurationFound = $false
    foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
        $configurationFound = $true
        if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
            continue
        }

        Write-Host ""
        Write-Host "Active license information for container '$($configuration.container)':" -ForegroundColor Green
        try {
            $licenseInformation = Get-BcContainerLicenseInformation -ContainerName $configuration.container -ErrorAction Stop
            if ($null -eq $licenseInformation) {
                Write-Host "No license information returned." -ForegroundColor Yellow
            } else {
                $licenseInformation | Out-Host
            }
        } catch {
            Write-Host "Failed to get license information for container '$($configuration.container)'." -ForegroundColor Red
            Write-Host $_.Exception.Message -ForegroundColor Red
        }
    }

    if (-not $configurationFound) {
        Write-Host "No Docker configurations found." -ForegroundColor Red
        $false
        return
    }

    $true
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
                if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
                    continue
                }

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


