function Get-BcConfigurationCredentialValues {
    param(
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    if ($configuration.PSObject.Properties['bcUser'] -and $configuration.PSObject.Properties['bcPassword']) {
        return [PSCustomObject]@{
            User = $configuration.bcUser
            Password = $configuration.bcPassword
        }
    }

    return [PSCustomObject]@{
        User = $configuration.admin
        Password = $configuration.password
    }
}

function Copy-BcDevToolsetPsObject {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $InputObject
    )

    $copy = [PSCustomObject]@{}
    foreach ($property in $InputObject.PSObject.Properties) {
        $copy | Add-Member -MemberType NoteProperty -Name $property.Name -Value $property.Value
    }
    return $copy
}

function Get-TestContainerConfigurations {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    return @($settingsJSON.configurations | Where-Object {
        $_.serverType -eq "Container" -and $_.includeTestToolkit -eq "true" -and -not [string]::IsNullOrWhiteSpace($_.container)
    })
}

function Get-ExecuteTestsInContainerName {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    if ($settingsJSON.PSObject.Properties['executeTestsInContainerName'] -and -not [string]::IsNullOrWhiteSpace($settingsJSON.executeTestsInContainerName)) {
        return ([string]$settingsJSON.executeTestsInContainerName).Trim()
    }

    return ""
}

function Select-TestContainerConfiguration {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $configurations = @(Get-TestContainerConfigurations -settingsJSON $settingsJSON)
    if ($configurations.Count -eq 0) {
        throw "No Container configurations with includeTestToolkit set to true and a non-empty container value found. Cannot execute tests."
    }

    $configuredContainerName = Get-ExecuteTestsInContainerName -settingsJSON $settingsJSON
    if ($configurations.Count -eq 1) {
        $configuration = $configurations[0]
        if ([string]::IsNullOrWhiteSpace($configuredContainerName)) {
            Write-Host "Only one container configuration is available and executeTestsInContainerName is empty. Tests will run in '$($configuration.container)' without backup restore or app deployment." -ForegroundColor Blue
            return [PSCustomObject]@{
                Configuration = $configuration
                PrepareContainer = $false
            }
        }

        if ($configuration.container -ne $configuredContainerName) {
            Write-Host "The configured executeTestsInContainerName value '$configuredContainerName' was not found among Container configurations with includeTestToolkit set to true." -ForegroundColor Red
        }

        return [PSCustomObject]@{
            Configuration = $configuration
            PrepareContainer = $true
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($configuredContainerName)) {
        $matchingConfigurations = @($configurations | Where-Object { $_.container -eq $configuredContainerName })
        if ($matchingConfigurations.Count -eq 1) {
            return [PSCustomObject]@{
                Configuration = $matchingConfigurations[0]
                PrepareContainer = $true
            }
        }

        Write-Host "The configured executeTestsInContainerName value '$configuredContainerName' was not found among Container configurations with includeTestToolkit set to true." -ForegroundColor Red
    }

    $options = @()
    foreach ($configuration in $configurations) {
        $options += "$($configuration.name) ($($configuration.container))"
    }

    $selectedIndex = Select-IndexFromList `
        -Title "Select the container configuration to execute tests in:" `
        -Options $options `
        -DefaultIndex 0

    return [PSCustomObject]@{
        Configuration = $configurations[$selectedIndex]
        PrepareContainer = $true
    }
}

function New-TestExecutionSettings {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    $testSettings = Copy-BcDevToolsetPsObject -InputObject $settingsJSON
    $testSettings.configurations = @($configuration)
    return $testSettings
}

function Restore-TestContainerBackupIfExists {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    if (-not $configuration.PSObject.Properties['sqlBackupPath'] -or [string]::IsNullOrWhiteSpace($configuration.sqlBackupPath)) {
        Write-Host "No sqlBackupPath is configured for '$($configuration.name)'. Skipping database restore." -ForegroundColor Gray
        return
    }

    $backupRootPath = Get-SqlBackupRootPath `
        -scriptPath $scriptPath `
        -sqlBackupPath $configuration.sqlBackupPath

    if ([string]::IsNullOrWhiteSpace($backupRootPath) -or -not (Test-Path -Path $backupRootPath -PathType Container)) {
        Write-Host "No SQL backup set folder found for '$($configuration.name)'. Skipping database restore." -ForegroundColor Gray
        return
    }

    $backupEntries = @(Get-SqlBackupSetEntries -backupRootPath $backupRootPath)
    if ($backupEntries.Count -eq 0) {
        Write-Host "No compatible .bak files found in '$backupRootPath'. Skipping database restore." -ForegroundColor Gray
        return
    }

    $sharedRestorePath = Copy-SqlBackupSetToSharedFolder `
        -containerName $configuration.container `
        -backupRootPath $backupRootPath `
        -sharedFolderName "TestRestore"

    Write-Host ""
    Write-Host "Restoring SQL backup set to container '$($configuration.container)'." -ForegroundColor Green
    Write-Host "Backup folder: $backupRootPath" -ForegroundColor Gray
    $restoreParameters = Get-BcContainerSqlBackupRestoreParameters `
        -containerName $configuration.container `
        -bakFolder $sharedRestorePath `
        -backupEntries $backupEntries
    Restore-DatabasesInBcContainer @restoreParameters

    Write-Host "SQL backup set restored to container '$($configuration.container)'." -ForegroundColor Green
}

function Get-TestWorkspaceAppJson {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON
    )

    $appJSON = @{}
    foreach ($appPath in $workspaceJSON.folders.path) {
        Get-AppJSON `
            -scriptPath $scriptPath `
            -appPath $appPath `
            -appJSON ([ref]$appJSON)

        if ($appJSON.application) {
            return $appJSON
        }
    }

    throw "Artifact URL could not be determined because no app.json with an application version was found."
}

function Get-TestSelectArtifact {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON
    )

    if ($workspaceJSON.settings."dam-pav.bcdevtoolset".selectArtifact) {
        return $workspaceJSON.settings."dam-pav.bcdevtoolset".selectArtifact
    }

    return "Latest"
}

function Export-TestContainerBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    Assert-SqlBackupPath `
        -sqlBackupPath $configuration.sqlBackupPath `
        -operationName "creating an initial test container SQL backup" `
        -configurationName $configuration.name

    $exportRootPath = Get-SqlBackupRootPath `
        -scriptPath $scriptPath `
        -sqlBackupPath $configuration.sqlBackupPath

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $sharedBackupPath = Join-Path $hostHelperFolder "Extensions\$($configuration.container)\SqlBackups\$timestamp"
    New-Item -ItemType Directory -Path $sharedBackupPath -Force | Out-Null
    New-Item -ItemType Directory -Path $exportRootPath -Force | Out-Null

    Write-Host ""
    Write-Host "Creating initial SQL backup set for container '$($configuration.container)'." -ForegroundColor Green
    Write-Host "Shared working folder: $sharedBackupPath" -ForegroundColor Gray
    Write-Host "Export folder: $exportRootPath" -ForegroundColor Gray

    Backup-BcContainerDatabases `
        -containerName $configuration.container `
        -bakFolder $sharedBackupPath

    Get-ChildItem -Path $exportRootPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force

    $backupMap = @(Get-BcContainerDatabaseBackupMap -containerName $configuration.container)
    foreach ($backupItem in $backupMap) {
        $sourceFile = Join-Path $sharedBackupPath $backupItem.HelperFileName
        if (-not (Test-Path -Path $sourceFile -PathType Leaf)) {
            Write-Host "Expected backup file '$sourceFile' was not created; skipping." -ForegroundColor Yellow
            continue
        }
        Move-Item -Path $sourceFile -Destination (Join-Path $exportRootPath $backupItem.ExportFileName) -Force
    }

    Remove-Item -Path $sharedBackupPath -Force -Recurse

    Write-Host "Initial SQL backup set exported for container '$($configuration.container)'." -ForegroundColor Green
}

function New-TestExecutionContainerIfMissing {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $testSettings,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    $null = docker container inspect $configuration.container 2>$null
    if ($LASTEXITCODE -eq 0) {
        return $false
    }

    Write-Host "Container '$($configuration.container)' does not exist. Creating it before executing tests." -ForegroundColor Yellow

    Remove-RedundantAppRegionSettings `
        -scriptPath $scriptPath `
        -workspaceJSON $workspaceJSON

    Clear-Artifacts -scriptPath $scriptPath -workspaceJSON $workspaceJSON

    $pullFullArtifact = (Confirm-Option `
        -question "Do you want to perform a complete pull of all artifacts? This will take longer but ensure you have the latest base image and artifacts. Do this if your previous pull attempt resulted in errors during container deployment, such as version mismatches between data and components." `
        -defaultYes:$false `
        -PromptId "tests.createMissingContainer.pullFullArtifact" `
        -Risk "Downloads fresh artifacts and can significantly increase container creation time.")
    if ($pullFullArtifact) {
        Write-Host "All artifacts will be pulled." -ForegroundColor Blue
    }

    $appJSON = Get-TestWorkspaceAppJson `
        -scriptPath $scriptPath `
        -workspaceJSON $workspaceJSON

    $selectArtifact = Get-TestSelectArtifact -workspaceJSON $workspaceJSON

    $success = New-DockerContainer `
        -testMode $false `
        -scriptPath $scriptPath `
        -appJSON $appJSON `
        -settingsJSON $testSettings `
        -workspaceJSON $workspaceJSON `
        -selectArtifact $selectArtifact `
        -pullFullArtifact $pullFullArtifact `
        -honorAutoRestoreBackup $true

    if ($success -ne $true) {
        throw "Container '$($configuration.container)' could not be created."
    }

    Write-Host ""
    Write-Host "Applying server configuration to the new test container." -ForegroundColor Green
    Update-ContainerServerConfiguration `
        -settingsJSON $testSettings

    if (-not (Test-DockerContainerRunning -containerName $configuration.container)) {
        throw "Container '$($configuration.container)' was created but is not running."
    }

    Export-TestContainerBackupSet `
        -scriptPath $scriptPath `
        -configuration $configuration

    return $true
}

function Initialize-TestExecutionContainer {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON
    )

    $selection = Select-TestContainerConfiguration -settingsJSON $settingsJSON
    $configuration = $selection.Configuration
    $containerName = $configuration.container

    if (-not (Confirm-Option `
        -question "Do you want to execute tests in the '$containerName' container?" `
        -PromptId "tests.executeInContainer" `
        -Risk "Creates the container and an initial backup if missing, restores a configured SQL backup set if present, publishes dependencies and all workspace apps, then executes tests in the selected container." `
        -AgentAllowed $true `
        -Destructive $true)) {
        Write-Host "Test execution aborted." -ForegroundColor Yellow
        return $null
    }

    $testSettings = New-TestExecutionSettings `
        -settingsJSON $settingsJSON `
        -configuration $configuration

    $containerWasCreated = New-TestExecutionContainerIfMissing `
        -scriptPath $scriptPath `
        -settingsJSON $settingsJSON `
        -workspaceJSON $workspaceJSON `
        -testSettings $testSettings `
        -configuration $configuration

    if (-not (Test-DockerContainerRunning -containerName $containerName)) {
        throw "Container '$containerName' exists but is not running."
    }

    if (-not $selection.PrepareContainer) {
        return $testSettings
    }

    if (-not (Test-AutoRestoreBackup -configuration $configuration)) {
        Write-Host "Skipping automatic SQL backup restore because autoRestoreBackup is false for '$containerName'." -ForegroundColor Gray
    } elseif ($containerWasCreated) {
        Write-Host "Skipping SQL backup restore because the backup set was just created from the new container." -ForegroundColor Gray
    } else {
        Restore-TestContainerBackupIfExists `
            -scriptPath $scriptPath `
            -configuration $configuration
    }

    Write-Host ""
    Write-Host "Deploying dependencies to '$containerName'." -ForegroundColor Green
    Publish-Dependencies `
        -settingsJSON $testSettings `
        -targetType "Dev"

    Write-Host ""
    Write-Host "Deploying all workspace apps to '$containerName'." -ForegroundColor Green
    Publish-Apps `
        -scriptPath $scriptPath `
        -settingsJSON $testSettings `
        -workspaceJSON $workspaceJSON `
        -targetType "Dev" `
        -publishAsDev $true

    return $testSettings
}

function Invoke-Tests {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType
    )

    foreach ($configuration in $($settingsJSON.configurations | Where-Object  { $_.targetType -eq $targetType })) {
        Write-Host "Running tests on '$($configuration.name)'." -ForegroundColor Blue
        switch ($configuration.serverType) {
            'Container' {
                if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
                    continue
                }

                $bcCredentials = Get-BcConfigurationCredentialValues -configuration $configuration
                $params = @{
                    containerName = $configuration.container
                    credential = (New-Object System.Management.Automation.PSCredential ($bcCredentials.User, (ConvertTo-SecureString -String $bcCredentials.Password -AsPlainText -Force)))
                    detailed = $true
                }
                # if $configuration.testSuite has a value, add it to the parameters
                if ($configuration.testSuite -and $configuration.testSuite -ne "") {
                    $params.testSuite = $configuration.testSuite
                }                    

                Write-Host ""
                Write-Host "Running " -ForegroundColor green -NoNewline
                Write-Host "Run-TestsInBcContainer" -ForegroundColor Blue -NoNewline
                Write-Host ":" -ForegroundColor green
                Run-TestsInBcContainer -ErrorAction SilentlyContinue @params
            }
            Default {
                Write-Host "Cannot run tests on serverType $serverType." -ForegroundColor Blue
            }
        }
    }
}

function Invoke-PageScriptTests {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType
    )

    # Verify recordings path exists
    $recordingsPath = $settingsJSON.recordingsPath
    if (-not (Test-Path $recordingsPath)) {
        Write-Host "No recordings folder found at $recordingsPath." -ForegroundColor Red
        return
    }

    # Verify recordingPath contains .yml files
    $ymlFiles = Get-ChildItem -Path $recordingsPath -Filter *.yml -ErrorAction SilentlyContinue
    if (-not $ymlFiles -or $ymlFiles.Count -eq 0) {
        Write-Host "No .yml recording files found in $recordingsPath." -ForegroundColor Red
        return
    }

    # Verify pageScriptTestResultsPath exists
    $testResultsPath = $settingsJSON.pageScriptTestResultsPath
    if (-not (Test-Path $testResultsPath)) {
        Write-Host "No test results folder found at $testResultsPath." -ForegroundColor Red
        return
    }

    # Check if node/npm is available
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "npm is not installed or not in PATH. Run the 'Install prerequisites' operation, restart PowerShell if needed, and try again." -ForegroundColor Red
        return
    }

    # Check minimum version for node.js is 24
    $nodeVersionOutput = node --version
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to get Node.js version. Run the 'Install prerequisites' operation, restart PowerShell if needed, and try again." -ForegroundColor Red
        return
    }
    $nodeVersion = [version]($nodeVersionOutput.Trim() -replace "^v", "")
    if ($nodeVersion.Major -lt 24) {
        Write-Host "Node.js version 24 or higher is required. Current version: $nodeVersion. Run the 'Install prerequisites' operation, restart PowerShell if needed, and try again." -ForegroundColor Red
        return
    }

    if (-not (Get-Command replay -ErrorAction SilentlyContinue)) {
        Write-Host "@microsoft/bc-replay is not installed or the replay command is not in PATH. Run the 'Install prerequisites' operation, restart PowerShell if needed, and try again." -ForegroundColor Red
        return
    }

    foreach ($configuration in $($settingsJSON.configurations | Where-Object  { $_.targetType -eq $targetType })) {
        Write-Host "Running page script tests on '$($configuration.name)'." -ForegroundColor Blue
        
        $baseUrl = $null
        $user = ""
        $password = ""

        switch ($configuration.serverType) {
            'Container' {
                if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
                    continue
                }

                if (Get-Command Get-BcContainerUrl -ErrorAction SilentlyContinue) {
                     try {
                        $baseUrl = Get-BcContainerUrl -containerName $configuration.container -ErrorAction Stop
                     } catch {
                        Write-Host "Get-BcContainerUrl failed: $_" -ForegroundColor Yellow
                     }
                }
                
                if (-not $baseUrl) {
                     # Fallback logic
                     $baseUrl = "http://$($configuration.container)/BC/" 
                }
            }
            Default {
                # Try to construct from config if fields exist
                if ($configuration.server -and $configuration.serverInstance) {
                    # e.g. http://server:port/instance/
                    # This is a guess, might need refinement for SaaS/OnPrem
                    $portPart = ""
                    if ($configuration.port) { $portPart = ":$($configuration.port)" }
                    $baseUrl = "http://$($configuration.server)$($portPart)/$($configuration.serverInstance)/"
                }
            }
        }
        
        if (-not $baseUrl) {
            Write-Host "Could not determine Base URL for configuration $($configuration.name)" -ForegroundColor Red
            continue
        }

        # Ensure trailing slash and web client path
        if (-not $baseUrl.EndsWith("/BC") -and -not $baseUrl.EndsWith("/BC/")) {
             $baseUrl = $baseUrl.TrimEnd('/') + "/BC/"
        } elseif (-not $baseUrl.EndsWith("/")) {
             $baseUrl = $baseUrl + "/"
        }

        # For Container, ensure tenant parameter is present
        if ($configuration.serverType -eq 'Container' -and $baseUrl -notmatch "tenant=") {
             $baseUrl = $baseUrl + "?tenant=default"
        }

        $bcCredentials = Get-BcConfigurationCredentialValues -configuration $configuration
        $user = $bcCredentials.User
        $password = $bcCredentials.Password

        # Env vars for credentials
        $env:BC_USER = $user
        $env:BC_PASSWORD = $password

        Write-Host "Running tests against $baseUrl" -ForegroundColor Cyan
        
        # Use relative path for tests to match manual execution success and ensure globbing works
        $relativeRecPath = Resolve-Path $recordingsPath -Relative
        $testPattern = Join-Path $relativeRecPath "*.yml"

        $replayArgs = @(
            "-Tests", $testPattern,
            "-StartAddress", $baseUrl,
            "-Authentication", "UserPassword",
            "-UserNameKey", "BC_USER",
            "-PasswordKey", "BC_PASSWORD",
            "-ResultDir", $testResultsPath
        )

        if ($settingsJSON.pageScriptTestHeaded) {
            $replayArgs += "-Headed"
        }

        & replay @replayArgs
    }
}
