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
    Restore-BcContainerSqlBackupEntries `
        -containerName $configuration.container `
        -bakFolder $sharedRestorePath `
        -backupEntries $backupEntries

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
        -honorAutoRestoreBackup $true `
        -deferInitialBackupExport $true

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

    if (Test-ShouldExportInitialTestContainerBackup `
        -configuration $configuration `
        -creationTriggeredByTestOperation $true) {
        Export-InitialTestContainerSqlBackupSet `
            -scriptPath $scriptPath `
            -configuration $configuration
    }

    return $true
}

function Request-TestExecutionContainerSelection {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $selection = Select-TestContainerConfiguration -settingsJSON $settingsJSON
    $containerName = $selection.Configuration.container
    if (-not (Confirm-Option `
        -question "Do you want to execute tests in the '$containerName' container?" `
        -PromptId "tests.executeInContainer" `
        -Risk "Creates the container and an initial backup if missing, restores a configured SQL backup set if present, publishes dependencies and all workspace apps, then executes tests in the selected container." `
        -AgentAllowed $true `
        -Destructive $true)) {
        Write-Host "Test execution aborted." -ForegroundColor Yellow
        return $null
    }

    return $selection
}

function Initialize-TestExecutionContainer {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [PSObject] $workspaceJSON,
        [switch] $BuildAppsBeforeDeployment,
        [PSObject] $Selection
    )

    $selection = $Selection
    if ($null -eq $selection) {
        $selection = Request-TestExecutionContainerSelection -settingsJSON $settingsJSON
    }
    if ($null -eq $selection) {
        return $null
    }
    $configuration = $selection.Configuration
    $containerName = $configuration.container

    if ($BuildAppsBeforeDeployment) {
        Write-Host ""
        Write-Host "Building all workspace apps before preparing the test container." -ForegroundColor Green
        & (Join-Path $scriptPath 'operations/BuildAllApps.ps1') -SkipOperationUI
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
        Write-Host "Skipping SQL backup restore because the container was just created." -ForegroundColor Gray
    } else {
        Restore-TestContainerBackupIfExists `
            -scriptPath $scriptPath `
            -configuration $configuration
    }

    Write-Host ""
    Write-Host "Deploying dependencies to '$containerName'." -ForegroundColor Green
    Publish-Dependencies `
        -settingsJSON $testSettings

    Write-Host ""
    Write-Host "Deploying all workspace apps to '$containerName'." -ForegroundColor Green
    Publish-Apps `
        -scriptPath $scriptPath `
        -settingsJSON $testSettings `
        -workspaceJSON $workspaceJSON `
        -publishAsDev $true

    return $testSettings
}

function Get-BcDevToolsetTestResultDirectory {
    $configuredHostHelperFolder = [string]$env:BCDEVTOOLSET_HOST_HELPER_FOLDER
    if ([string]::IsNullOrWhiteSpace($configuredHostHelperFolder)) {
        throw "BC Dev Toolset host helper folder is unavailable; JUnit test results cannot be captured."
    }

    # The extension validates and supplies the configurable host-helper root. Only a fixed child is used here.
    $authorizedRoot = [System.IO.Path]::GetFullPath($configuredHostHelperFolder).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar)
    $resultDirectory = [System.IO.Path]::GetFullPath((Join-Path $authorizedRoot 'bc-dev-toolset-test-results'))
    $authorizedPrefix = $authorizedRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resultDirectory.StartsWith($authorizedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The test-result directory escaped the configured host helper folder."
    }

    New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
    return $resultDirectory
}

function ConvertFrom-BcDevToolsetJUnitResult {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $ResultPath,
        [Parameter(Mandatory=$true)]
        [string] $AppName
    )

    if (-not (Test-Path -LiteralPath $ResultPath -PathType Leaf)) {
        throw "Run-TestsInBcContainer did not create the expected JUnit result for '$AppName'."
    }

    [xml]$resultDocument = Get-Content -LiteralPath $ResultPath -Raw
    $testSuites = @($resultDocument.SelectNodes('//testsuite'))
    $failures = @()
    $total = 0
    $failed = 0
    $skipped = 0
    $durationSeconds = 0.0

    foreach ($testSuite in $testSuites) {
        $total += [int]$testSuite.GetAttribute('tests')
        $failed += [int]$testSuite.GetAttribute('failures') + [int]$testSuite.GetAttribute('errors')
        $skipped += [int]$testSuite.GetAttribute('skipped')
        $suiteDuration = 0.0
        if ([double]::TryParse(
            $testSuite.GetAttribute('time'),
            [System.Globalization.NumberStyles]::Float,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [ref]$suiteDuration)) {
            $durationSeconds += $suiteDuration
        }

        foreach ($testCase in @($testSuite.SelectNodes('./testcase[failure or error]'))) {
            $failureNode = $testCase.SelectSingleNode('./failure | ./error')
            $failures += [pscustomobject]@{
                app = $AppName
                codeunit = [string]$testCase.GetAttribute('classname')
                method = [string]$testCase.GetAttribute('name')
                message = [string]$failureNode.GetAttribute('message')
                stackTrace = ([string]$failureNode.InnerText).Trim()
            }
        }
    }

    return [pscustomobject]@{
        total = $total
        passed = $total - $failed - $skipped
        failed = $failed
        skipped = $skipped
        durationSeconds = [Math]::Round($durationSeconds, 3)
        failures = @($failures)
    }
}

function Invoke-Tests {
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

    $workspaceApps = @(Get-SortedApps -workspaceJSON $workspaceJSON)
    if ($workspaceApps.Count -eq 0) {
        throw "No workspace apps were found for AL test discovery."
    }

    $targetConfigurations = @($settingsJSON.configurations)
    if (-not [string]::IsNullOrWhiteSpace($targetType)) {
        $targetConfigurations = @($targetConfigurations | Where-Object { $_.targetType -eq $targetType })
    }

    $resultDirectory = Get-BcDevToolsetTestResultDirectory
    $compiledResult = [ordered]@{
        applicationCount = 0
        total = 0
        passed = 0
        failed = 0
        skipped = 0
        durationSeconds = 0.0
        failures = @()
        omittedFailureCount = 0
        allPassed = $true
    }
    $maximumFailureDetails = 20

    foreach ($configuration in $targetConfigurations) {
        Write-Host "Running tests on '$($configuration.name)'." -ForegroundColor Blue
        switch ($configuration.serverType) {
            'Container' {
                if (-not (Test-DockerContainerExists -containerName $configuration.container)) {
                    continue
                }

                $bcCredentials = Get-BcConfigurationCredentialValues -configuration $configuration
                $credential = New-Object System.Management.Automation.PSCredential (
                    $bcCredentials.User,
                    (ConvertTo-SecureString -String $bcCredentials.Password -AsPlainText -Force)
                )
                $installedApps = @(Get-BcContainerAppInfo `
                    -containerName $configuration.container `
                    -installedOnly)

                foreach ($workspaceApp in $workspaceApps) {
                    $installedApp = @($installedApps | Where-Object {
                        [string]$_.AppId -eq [string]$workspaceApp.AppId
                    } | Select-Object -First 1)
                    if ($installedApp.Count -eq 0) {
                        throw "Workspace app '$($workspaceApp.Name)' ($($workspaceApp.AppId)) is not installed in container '$($configuration.container)'; tests cannot be discovered."
                    }

                    $resultPath = Join-Path $resultDirectory "$([guid]::NewGuid().ToString('N')).junit.xml"
                    $params = @{
                        containerName = $configuration.container
                        credential = $credential
                        extensionId = [string]$workspaceApp.AppId
                        appName = [string]$installedApp[0].Name
                        JUnitResultFileName = $resultPath
                        returnTrueIfAllPassed = $true
                        detailed = $true
                    }

                    Write-Host ""
                    Write-Host "Discovering and running tests in '$($workspaceApp.Name)' ($($workspaceApp.AppId))." -ForegroundColor Green
                    Write-Host "Running " -ForegroundColor Green -NoNewline
                    Write-Host "Run-TestsInBcContainer" -ForegroundColor Blue -NoNewline
                    Write-Host " with extension-scoped test discovery:" -ForegroundColor Green
                    try {
                        $appPassed = Run-TestsInBcContainer -ErrorAction SilentlyContinue @params
                        $appResult = ConvertFrom-BcDevToolsetJUnitResult `
                            -ResultPath $resultPath `
                            -AppName ([string]$workspaceApp.Name)
                        $compiledResult.applicationCount++
                        $compiledResult.total += $appResult.total
                        $compiledResult.passed += $appResult.passed
                        $compiledResult.failed += $appResult.failed
                        $compiledResult.skipped += $appResult.skipped
                        $compiledResult.durationSeconds += $appResult.durationSeconds
                        $compiledResult.allPassed = $compiledResult.allPassed -and ($appPassed -eq $true) -and ($appResult.failed -eq 0)

                        foreach ($failure in @($appResult.failures)) {
                            if ($compiledResult.failures.Count -lt $maximumFailureDetails) {
                                $compiledResult.failures += $failure
                            } else {
                                $compiledResult.omittedFailureCount++
                            }
                        }
                    } finally {
                        Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
                    }
                }
            }
            Default {
                Write-Host "Cannot run tests on serverType $serverType." -ForegroundColor Blue
            }
        }
    }

    $compiledResult.durationSeconds = [Math]::Round($compiledResult.durationSeconds, 3)
    return [pscustomobject]$compiledResult
}

function Invoke-PageScriptTests {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
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

    $targetConfigurations = @($settingsJSON.configurations)
    if (-not [string]::IsNullOrWhiteSpace($targetType)) {
        $targetConfigurations = @($targetConfigurations | Where-Object { $_.targetType -eq $targetType })
    }

    foreach ($configuration in $targetConfigurations) {
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
