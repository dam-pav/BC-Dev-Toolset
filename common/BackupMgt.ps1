function Get-SqlBackupRootPath {
    Param (
        [Parameter(Mandatory=$false)]
        [string] $scriptPath = "",
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string] $sqlBackupPath
    )

    if ([string]::IsNullOrWhiteSpace($sqlBackupPath)) {
        return ""
    }

    if ([System.IO.Path]::IsPathRooted($sqlBackupPath)) {
        return $sqlBackupPath
    }

    $workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath
    return (Join-Path $workspaceRootPath.FullName $sqlBackupPath)
}

function Copy-SqlBackupSetToSharedFolder {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $containerName,
        [Parameter(Mandatory=$true)]
        [string] $backupRootPath,
        [Parameter(Mandatory=$true)]
        [string] $sharedFolderName
    )

    if (-not (Test-Path -Path $backupRootPath -PathType Container)) {
        throw "The SQL backup folder '$backupRootPath' does not exist."
    }

    $backupEntries = @(Get-SqlBackupSetEntries -backupRootPath $backupRootPath)
    if ($backupEntries.Count -eq 0) {
        throw "No compatible .bak files found in SQL backup folder '$backupRootPath'. Expected '<container>.<database>.app.bak', '<container>.<database>.tenant.bak', or '<container>.<database>.database.bak'."
    }

    $sharedBackupPath = Join-Path $hostHelperFolder "SqlBackupSets\$containerName\$sharedFolderName"
    New-Item -ItemType Directory -Path $sharedBackupPath -Force | Out-Null
    Get-ChildItem -Path $sharedBackupPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force

    foreach ($backupEntry in $backupEntries) {
        Copy-Item -Path $backupEntry.SourcePath -Destination (Join-Path $sharedBackupPath $backupEntry.HelperFileName) -Force
    }

    return $sharedBackupPath
}

function Assert-BackupDatabaseNameFileSafe {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $databaseName
    )

    if ([string]::IsNullOrWhiteSpace($databaseName)) {
        throw "Database name is empty and cannot be used for a backup file name."
    }

    $invalidChars = [System.IO.Path]::GetInvalidFileNameChars()
    if ($databaseName.IndexOfAny($invalidChars) -ge 0) {
        throw "Database name '$databaseName' contains characters that cannot be used in a backup file name."
    }
}

function Get-SqlBackupFileName {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $databaseName,
        [Parameter(Mandatory=$true)]
        [ValidateSet("app", "tenant", "database")]
        [string] $databaseRole
    )

    Assert-BackupDatabaseNameFileSafe -databaseName $databaseName
    return "$databaseName.$databaseRole.bak"
}

function Get-SqlBackupSetEntries {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $backupRootPath
    )

    $backupFiles = @(Get-ChildItem -Path $backupRootPath -Filter "*.bak" -File -ErrorAction SilentlyContinue)
    $classifiedFiles = @($backupFiles | ForEach-Object {
        if ($_.Name -match '^(?<databaseName>.+)\.(?<databaseRole>app|tenant|database)\.bak$') {
            [PSCustomObject]@{
                File = $_
                ExportedDatabaseName = $Matches.databaseName
                DatabaseRole = $Matches.databaseRole
            }
        }
        else {
            Write-Host "Ignoring backup file '$($_.Name)' because it does not follow the '<container>.<database>.app.bak', '<container>.<database>.tenant.bak', or '<container>.<database>.database.bak' naming convention." -ForegroundColor Yellow
        }
    })

    $containerPrefix = Get-SqlBackupSetContainerPrefix -classifiedFiles $classifiedFiles
    $entries = @()
    foreach ($classifiedFile in $classifiedFiles) {
        $backupFile = $classifiedFile.File
        $databaseName = $classifiedFile.ExportedDatabaseName
        if (-not [string]::IsNullOrEmpty($containerPrefix)) {
            $databaseName = $databaseName.Substring($containerPrefix.Length)
        }

        if ($classifiedFile.DatabaseRole -eq "app") {
            $entries += [PSCustomObject]@{
                SourcePath = $backupFile.FullName
                SourceFileName = $backupFile.Name
                DatabaseName = $databaseName
                DatabaseRole = "app"
                HelperFileName = "app.bak"
            }
            continue
        }

        if ($classifiedFile.DatabaseRole -eq "tenant") {
            $entries += [PSCustomObject]@{
                SourcePath = $backupFile.FullName
                SourceFileName = $backupFile.Name
                DatabaseName = $databaseName
                DatabaseRole = "tenant"
                HelperFileName = "$databaseName.bak"
            }
            continue
        }

        if ($classifiedFile.DatabaseRole -eq "database") {
            $entries += [PSCustomObject]@{
                SourcePath = $backupFile.FullName
                SourceFileName = $backupFile.Name
                DatabaseName = $databaseName
                DatabaseRole = "database"
                HelperFileName = "database.bak"
            }
        }
    }

    return $entries
}

function Get-SqlBackupSetContainerPrefix {
    Param (
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [array] $classifiedFiles
    )

    # Container exports contain an application (or single-tenant) backup and prefix every
    # database name with the same container name. Service backups do not share that prefix.
    $hasPrimaryDatabase = ($classifiedFiles.DatabaseRole -contains "app") -or ($classifiedFiles.DatabaseRole -contains "database")
    if ($classifiedFiles.Count -lt 2 -or -not $hasPrimaryDatabase) {
        return ""
    }

    $firstName = [string]$classifiedFiles[0].ExportedDatabaseName
    $containerPrefix = ""
    for ($index = 0; $index -lt $firstName.Length; $index++) {
        if ($firstName[$index] -ne '.') {
            continue
        }

        $candidatePrefix = $firstName.Substring(0, $index + 1)
        $allNamesMatch = @($classifiedFiles | Where-Object {
            $exportedName = [string]$_.ExportedDatabaseName
            $exportedName.Length -le $candidatePrefix.Length -or
                -not $exportedName.StartsWith($candidatePrefix, [System.StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 0
        if ($allNamesMatch) {
            $containerPrefix = $candidatePrefix
        }
    }

    return $containerPrefix
}

function Get-BcContainerSqlBackupRestoreParameters {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $containerName,
        [Parameter(Mandatory=$true)]
        [string] $bakFolder,
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [array] $backupEntries
    )

    $restoreParameters = @{
        containerName = $containerName
    }
    $databaseEntries = @($backupEntries | Where-Object { $_.DatabaseRole -eq "database" })
    if ($databaseEntries.Count -eq 1 -and $backupEntries.Count -eq 1) {
        # The bakFile path avoids BcContainerHelper calling Set-NavServerInstance -Stop
        # unconditionally. That command fails when a previous restore left the service stopped.
        $restoreParameters.bakFile = Join-Path $bakFolder $databaseEntries[0].HelperFileName
        $restoreParameters.databaseName = $databaseEntries[0].DatabaseName
        return $restoreParameters
    }

    $restoreParameters.bakFolder = $bakFolder
    $tenantIds = @($backupEntries |
        Where-Object { $_.DatabaseRole -eq "tenant" } |
        Select-Object -ExpandProperty DatabaseName -Unique)
    if ($tenantIds.Count -gt 0) {
        # Supplying tenant IDs avoids BcContainerHelper querying the BC service before
        # the restore. This allows retries when an earlier failed restore left it stopped.
        $restoreParameters.tenant = $tenantIds
    }

    return $restoreParameters
}

function Get-BcSystemApplicationUpgradeAssessment {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $platformVersion,
        [Parameter(Mandatory=$true)]
        [string] $databaseApplicationVersion,
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [array] $installedApps,
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [array] $packageApps
    )

    $requiredAppNames = @("System Application", "Base Application", "Application")
    $appStates = @()
    $reasons = @()

    try {
        $parsedPlatformVersion = [Version]$platformVersion
        $parsedDatabaseVersion = [Version]$databaseApplicationVersion
    }
    catch {
        return [PSCustomObject]@{
            SplitDetected = $false
            Viable = $false
            TargetVersion = ""
            Apps = @()
            Reason = "The container platform or database application version could not be parsed: $($_.Exception.Message)"
        }
    }

    foreach ($appName in $requiredAppNames) {
        $installedApp = @($installedApps | Where-Object { $_.Name -eq $appName } | Select-Object -First 1)
        $packageApp = @($packageApps | Where-Object { $_.Name -eq $appName } | Select-Object -First 1)
        if ($installedApp.Count -eq 0) {
            $reasons += "Installed app '$appName' was not found for the default tenant."
        }
        if ($packageApp.Count -eq 0) {
            $reasons += "Container package '$appName' was not found."
        }

        $appStates += [PSCustomObject]@{
            Name = $appName
            InstalledVersion = if ($installedApp.Count -eq 1) { [string]$installedApp[0].Version } else { "" }
            PackageVersion = if ($packageApp.Count -eq 1) { [string]$packageApp[0].Version } else { "" }
            PackagePath = if ($packageApp.Count -eq 1) { [string]$packageApp[0].Path } else { "" }
        }
    }

    $packageVersions = @($appStates | Where-Object { -not [string]::IsNullOrWhiteSpace($_.PackageVersion) } | Select-Object -ExpandProperty PackageVersion -Unique)
    if ($packageVersions.Count -ne 1) {
        $reasons += "The three Microsoft application packages do not have one matching version."
        $targetVersion = $null
    }
    else {
        try {
            $targetVersion = [Version]$packageVersions[0]
        }
        catch {
            $targetVersion = $null
            $reasons += "The Microsoft application package version '$($packageVersions[0])' could not be parsed."
        }
    }

    if ($null -ne $targetVersion) {
        if ($targetVersion.Major -ne $parsedPlatformVersion.Major) {
            $reasons += "Package major version '$($targetVersion.Major)' does not match container platform major version '$($parsedPlatformVersion.Major)'."
        }

        foreach ($appState in $appStates) {
            if ([string]::IsNullOrWhiteSpace($appState.InstalledVersion)) {
                continue
            }

            try {
                $installedVersion = [Version]$appState.InstalledVersion
                if ($installedVersion.Major -ne $targetVersion.Major) {
                    $reasons += "App '$($appState.Name)' is on major version '$($installedVersion.Major)', not '$($targetVersion.Major)'."
                }
                elseif ($installedVersion -gt $targetVersion) {
                    $reasons += "App '$($appState.Name)' version '$installedVersion' is newer than container package version '$targetVersion'."
                }
            }
            catch {
                $reasons += "Installed version '$($appState.InstalledVersion)' for app '$($appState.Name)' could not be parsed."
            }
        }

        if ($parsedDatabaseVersion.Major -ne $targetVersion.Major) {
            $reasons += "Database application major version '$($parsedDatabaseVersion.Major)' does not match '$($targetVersion.Major)'."
        }
        elseif ($parsedDatabaseVersion -gt $targetVersion) {
            $reasons += "Database application version '$parsedDatabaseVersion' is newer than container package version '$targetVersion'."
        }
    }

    $splitDetected = $false
    if ($null -ne $targetVersion) {
        $splitDetected = ($parsedDatabaseVersion -ne $targetVersion) -or
            (@($appStates | Where-Object { $_.InstalledVersion -ne [string]$targetVersion }).Count -gt 0)
    }

    if (-not $splitDetected -and $reasons.Count -eq 0) {
        $reasons += "The database and Microsoft system applications already match the container platform."
    }

    return [PSCustomObject]@{
        SplitDetected = $splitDetected
        Viable = $splitDetected -and $reasons.Count -eq 0
        TargetVersion = if ($null -ne $targetVersion) { [string]$targetVersion } else { "" }
        Apps = $appStates
        Reason = $reasons -join " "
    }
}

function Invoke-BcContainerSystemApplicationUpgradeAfterRestore {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $containerName
    )

    Write-Host "Evaluating restored database application versions in container '$containerName'." -ForegroundColor Green
    try {
        $state = Invoke-ScriptInBcContainer -containerName $containerName -ScriptBlock {
            $serverInstance = "BC"
            $tenant = "default"
            $packageDefinitions = @(
                @{ Name = "System Application"; Path = "C:\Applications\System Application\Source\Microsoft_System Application.app" },
                @{ Name = "Base Application"; Path = "C:\Applications\BaseApp\Source\Microsoft_Base Application.app" },
                @{ Name = "Application"; Path = "C:\Applications\Application\Source\Microsoft_Application.app" }
            )

            $serviceFolder = (Get-Item "C:\Program Files\Microsoft Dynamics NAV\*\Service" | Select-Object -First 1).FullName
            $platformVersion = (Get-Item (Join-Path $serviceFolder "Microsoft.Dynamics.Nav.Server.exe")).VersionInfo.FileVersion
            $databaseVersion = (Get-NAVApplication -ServerInstance $serverInstance).ApplicationVersion
            $tenantApps = @(Get-NAVAppInfo -ServerInstance $serverInstance -Tenant $tenant)
            $installedApps = @($packageDefinitions | ForEach-Object {
                $appName = $_.Name
                $app = @($tenantApps |
                    Where-Object { $_.Name -eq $appName -and $_.Publisher -eq "Microsoft" } |
                    Sort-Object Version -Descending |
                    Select-Object -First 1)
                if ($app.Count -eq 1) {
                    [PSCustomObject]@{ Name = $appName; Version = [string]$app[0].Version }
                }
            })
            $packageApps = @($packageDefinitions | ForEach-Object {
                if (Test-Path -LiteralPath $_.Path -PathType Leaf) {
                    $app = Get-NAVAppInfo -Path $_.Path
                    [PSCustomObject]@{ Name = [string]$app.Name; Version = [string]$app.Version; Path = $_.Path }
                }
            })

            [PSCustomObject]@{
                PlatformVersion = [string]$platformVersion
                DatabaseApplicationVersion = [string]$databaseVersion
                InstalledApps = $installedApps
                PackageApps = $packageApps
            }
        }
    }
    catch {
        Write-Host "Could not evaluate the restored database for a system application upgrade: $($_.Exception.Message)" -ForegroundColor Yellow
        return
    }

    $assessment = Get-BcSystemApplicationUpgradeAssessment `
        -platformVersion $state.PlatformVersion `
        -databaseApplicationVersion $state.DatabaseApplicationVersion `
        -installedApps @($state.InstalledApps) `
        -packageApps @($state.PackageApps)

    Write-Host "Platform/media: $($state.PlatformVersion)" -ForegroundColor Gray
    Write-Host "Database application version: $($state.DatabaseApplicationVersion)" -ForegroundColor Gray
    foreach ($app in $assessment.Apps) {
        Write-Host "$($app.Name): installed '$($app.InstalledVersion)', container package '$($app.PackageVersion)'" -ForegroundColor Gray
    }

    if (-not $assessment.SplitDetected) {
        Write-Host "No upgradable platform/application split was detected. $($assessment.Reason)" -ForegroundColor Gray
        return
    }
    if (-not $assessment.Viable) {
        Write-Host "A platform/application split was detected, but an automatic upgrade is not safe: $($assessment.Reason)" -ForegroundColor Yellow
        return
    }

    Write-Host "A viable split was detected. Upgrading Microsoft system applications to '$($assessment.TargetVersion)'." -ForegroundColor Yellow
    try {
        $upgradeResult = Invoke-ScriptInBcContainer -containerName $containerName -ScriptBlock {
            Param ($targetVersionText)

            $ErrorActionPreference = "Stop"
            $serverInstance = "BC"
            $tenant = "default"
            $targetVersion = [Version]$targetVersionText
            $apps = @(
                @{ Name = "System Application"; Path = "C:\Applications\System Application\Source\Microsoft_System Application.app" },
                @{ Name = "Base Application"; Path = "C:\Applications\BaseApp\Source\Microsoft_Base Application.app" },
                @{ Name = "Application"; Path = "C:\Applications\Application\Source\Microsoft_Application.app" }
            )

            $activeSessions = @(Get-NAVServerSession -ServerInstance $serverInstance -Tenant $tenant)
            if ($activeSessions.Count -gt 0) {
                Write-Host "Closing $($activeSessions.Count) active BC session(s) before the system application upgrade." -ForegroundColor Yellow
                foreach ($session in $activeSessions) {
                    Remove-NAVServerSession `
                        -ServerInstance $serverInstance `
                        -Tenant $tenant `
                        -SessionId $session.SessionId `
                        -Force `
                        -Confirm:$false
                }
            }

            foreach ($app in $apps) {
                Write-Host "Publishing $($app.Name) $targetVersion from '$($app.Path)'." -ForegroundColor Gray
                Publish-NAVApp `
                    -ServerInstance $serverInstance `
                    -Path $app.Path `
                    -SkipVerification `
                    -Force | Out-Null
            }

            foreach ($app in $apps) {
                Write-Host "Synchronizing and upgrading $($app.Name) $targetVersion." -ForegroundColor Gray
                Sync-NAVApp -ServerInstance $serverInstance -Tenant $tenant -Name $app.Name -Version $targetVersion -Mode Add | Out-Null
                Start-NAVAppDataUpgrade -ServerInstance $serverInstance -Tenant $tenant -Name $app.Name -Version $targetVersion | Out-Null
            }

            Write-Host "Setting database application version to $targetVersion." -ForegroundColor Gray
            Set-NAVApplication -ServerInstance $serverInstance -ApplicationVersion $targetVersion -Force -Confirm:$false | Out-Null
            Write-Host "Synchronizing tenant '$tenant'." -ForegroundColor Gray
            Sync-NAVTenant -ServerInstance $serverInstance -Tenant $tenant -Mode Sync -Force -Confirm:$false | Out-Null
            Write-Host "Starting database data upgrade for tenant '$tenant'." -ForegroundColor Gray
            Start-NAVDataUpgrade -ServerInstance $serverInstance -Tenant $tenant -FunctionExecutionMode Serial -Force -Confirm:$false | Out-Null

            $installedApps = @(Get-NAVAppInfo -ServerInstance $serverInstance -Tenant $tenant)
            [PSCustomObject]@{
                DatabaseApplicationVersion = [string](Get-NAVApplication -ServerInstance $serverInstance).ApplicationVersion
                Apps = @($apps | ForEach-Object {
                    $appName = $_.Name
                    $installedApp = @($installedApps |
                        Where-Object { $_.Name -eq $appName -and $_.Publisher -eq "Microsoft" } |
                        Sort-Object Version -Descending |
                        Select-Object -First 1)
                    [PSCustomObject]@{
                        Name = $appName
                        Version = if ($installedApp.Count -eq 1) { [string]$installedApp[0].Version } else { "" }
                    }
                })
            }
        } -ArgumentList $assessment.TargetVersion
    }
    catch {
        throw "System application upgrade after restoring container '$containerName' stopped on an error: $($_.Exception.Message)"
    }

    $verificationFailures = @($upgradeResult.Apps | Where-Object { $_.Version -ne $assessment.TargetVersion })
    if ($upgradeResult.DatabaseApplicationVersion -ne $assessment.TargetVersion -or $verificationFailures.Count -gt 0) {
        throw "System application upgrade completed, but version verification failed. Expected '$($assessment.TargetVersion)'."
    }

    Write-Host "System Application, Base Application, Application, and the database application version are now '$($assessment.TargetVersion)'." -ForegroundColor Green
}

function Restore-BcContainerSqlBackupEntries {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $containerName,
        [Parameter(Mandatory=$true)]
        [string] $bakFolder,
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [array] $backupEntries
    )

    $restoreParameters = Get-BcContainerSqlBackupRestoreParameters `
        -containerName $containerName `
        -bakFolder $bakFolder `
        -backupEntries $backupEntries

    if ($restoreParameters.ContainsKey("bakFile")) {
        $restoreParameters.databaseName = Invoke-ScriptInBcContainer -containerName $containerName -ScriptBlock {
            $customConfigFile = Join-Path (Get-Item "C:\Program Files\Microsoft Dynamics NAV\*\Service").FullName "CustomSettings.config"
            [xml]$customConfig = [System.IO.File]::ReadAllText($customConfigFile)
            $server = Get-NAVServerInstance -ServerInstance BC
            if ($server.State -ne "Stopped") {
                Set-NAVServerInstance -ServerInstance BC -Stop | Out-Null
            }
            return $customConfig.SelectSingleNode("//appSettings/add[@key='DatabaseName']").Value
        }
    }

    Restore-DatabasesInBcContainer @restoreParameters

    if ($restoreParameters.ContainsKey("bakFile")) {
        Invoke-ScriptInBcContainer -containerName $containerName -ScriptBlock {
            Set-NAVServerInstance -ServerInstance BC -Start
        }
    }

    Invoke-BcContainerSystemApplicationUpgradeAfterRestore -containerName $containerName
}

function Get-BcContainerDatabaseBackupMap {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $containerName
    )

    $backupMap = Invoke-ScriptInBcContainer -containerName $containerName -usesession:$false -usepwsh:$false -ScriptBlock {
        $customConfigFile = Join-Path (Get-Item "C:\Program Files\Microsoft Dynamics NAV\*\Service").FullName "CustomSettings.config"
        [xml]$customConfig = [System.IO.File]::ReadAllText($customConfigFile)
        $multitenant = ($customConfig.SelectSingleNode("//appSettings/add[@key='Multitenant']").Value -eq "true")
        $databaseName = $customConfig.SelectSingleNode("//appSettings/add[@key='DatabaseName']").Value

        if ($multitenant) {
            $map = @([PSCustomObject]@{
                HelperFileName = "app.bak"
                ExportFileName = "$databaseName.app.bak"
            })

            $map += @(Get-NAVTenant -ServerInstance BC | ForEach-Object {
                [PSCustomObject]@{
                    HelperFileName = "$($_.Id).bak"
                    ExportFileName = "$($_.Id).tenant.bak"
                }
            })

            $map += [PSCustomObject]@{
                HelperFileName = "tenant.bak"
                ExportFileName = "tenant.tenant.bak"
            }

            return $map
        }

        return @([PSCustomObject]@{
            HelperFileName = "database.bak"
            ExportFileName = "$databaseName.database.bak"
        })
    }

    # Prefix export file names with the container name to avoid collisions
    # when multiple containers share the same internal database names.
    foreach ($item in $backupMap) {
        $item | Add-Member -NotePropertyName "ExportFileName" -NotePropertyValue "$containerName.$($item.ExportFileName)" -Force
    }

    return $backupMap
}

function Assert-SqlBackupPath {
    Param (
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string] $sqlBackupPath,
        [Parameter(Mandatory=$true)]
        [string] $operationName,
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string] $configurationName = ""
    )

    if ([string]::IsNullOrWhiteSpace($sqlBackupPath)) {
        if ([string]::IsNullOrWhiteSpace($configurationName)) {
            throw "The 'sqlBackupPath' setting is empty. Please set it on the target configuration before $operationName."
        }

        throw "The 'sqlBackupPath' setting is empty for configuration '$configurationName'. Please set it on that configuration before $operationName."
    }
}

function Get-ContainerSqlBackupConfigurations {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    return @($settingsJSON.configurations | Where-Object {
        $_.serverType -eq "Container" -and -not [string]::IsNullOrWhiteSpace($_.sqlBackupPath)
    })
}

function Test-DockerContainerRunning {
    Param (
        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string] $containerName
    )

    if (-not (Test-DockerContainerExists -containerName $containerName)) {
        return $false
    }

    $running = docker container inspect --format "{{.State.Running}}" $containerName 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($running) -or $running.Trim() -ne "true") {
        Write-Host "Docker container '$containerName' is not running. Skipping this configuration." -ForegroundColor Yellow
        return $false
    }

    return $true
}

function Select-ContainerSqlBackupConfigurations {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [string] $operationName,
        [Parameter(Mandatory=$false)]
        [switch] $IncludeAllOption
    )

    $qualifiedConfigurations = @(Get-ContainerSqlBackupConfigurations -settingsJSON $settingsJSON)
    if ($qualifiedConfigurations.Count -eq 0) {
        Write-Host "No Container configurations with a non-empty sqlBackupPath found." -ForegroundColor Red
        return @()
    }

    if ($qualifiedConfigurations.Count -eq 1) {
        return @($qualifiedConfigurations[0])
    }

    $options = @()
    foreach ($configuration in $qualifiedConfigurations) {
        $options += "$($configuration.name) ($($configuration.container)) -> $($configuration.sqlBackupPath)"
    }

    if ($IncludeAllOption) {
        $options += "All qualified containers"
    }

    $selectedIndex = Select-IndexFromList `
        -Title "Select container for $($operationName):" `
        -Options $options `
        -DefaultIndex 0

    if ($IncludeAllOption -and $selectedIndex -eq ($options.Count - 1)) {
        return $qualifiedConfigurations
    }

    return @($qualifiedConfigurations[$selectedIndex])
}

function Get-ContainerSqlBackupRootPaths {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $backupRootPaths = @()
    foreach ($configuration in @(Get-ContainerSqlBackupConfigurations -settingsJSON $settingsJSON)) {
        $backupRootPath = Get-SqlBackupRootPath `
            -scriptPath $scriptPath `
            -sqlBackupPath $configuration.sqlBackupPath
        if (-not [string]::IsNullOrWhiteSpace($backupRootPath) -and $backupRootPaths -notcontains $backupRootPath) {
            $backupRootPaths += $backupRootPath
        }
    }

    return $backupRootPaths
}

function Export-BcContainerSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $selectedConfigurations = @(Select-ContainerSqlBackupConfigurations `
        -settingsJSON $settingsJSON `
        -operationName "SQL backup export" `
        -IncludeAllOption)

    foreach ($configuration in $selectedConfigurations) {
        if (-not (Test-DockerContainerRunning -containerName $configuration.container)) {
            continue
        }

        Assert-SqlBackupPath `
            -sqlBackupPath $configuration.sqlBackupPath `
            -operationName "creating a SQL backup" `
            -configurationName $configuration.name

        $exportRootPath = Get-SqlBackupRootPath `
            -scriptPath $scriptPath `
            -sqlBackupPath $configuration.sqlBackupPath

        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $sharedBackupPath = Join-Path $hostHelperFolder "Extensions\$($configuration.container)\SqlBackups\$timestamp"
        New-Item -ItemType Directory -Path $sharedBackupPath -Force | Out-Null
        New-Item -ItemType Directory -Path $exportRootPath -Force | Out-Null

        Write-Host ""
        Write-Host "Creating SQL backup set for container '$($configuration.container)'." -ForegroundColor Green
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

        Write-Host "SQL backup set exported for container '$($configuration.container)'." -ForegroundColor Green
    }
}

function Restore-BcContainerSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $selectedConfigurations = @(Select-ContainerSqlBackupConfigurations `
        -settingsJSON $settingsJSON `
        -operationName "SQL backup restore")

    foreach ($configuration in $selectedConfigurations) {
        if (-not (Test-DockerContainerRunning -containerName $configuration.container)) {
            continue
        }

        Assert-SqlBackupPath `
            -sqlBackupPath $configuration.sqlBackupPath `
            -operationName "restoring a SQL backup" `
            -configurationName $configuration.name

        $backupRootPath = Get-SqlBackupRootPath `
            -scriptPath $scriptPath `
            -sqlBackupPath $configuration.sqlBackupPath

        if (-not (Test-Path -Path $backupRootPath -PathType Container)) {
            throw "The sqlBackupPath folder '$backupRootPath' does not exist."
        }

        $backupEntries = @(Get-SqlBackupSetEntries -backupRootPath $backupRootPath)
        if ($backupEntries.Count -eq 0) {
            throw "No compatible .bak files found at sqlBackupPath '$backupRootPath'. Expected '<container>.<database>.app.bak', '<container>.<database>.tenant.bak', or '<container>.<database>.database.bak'."
        }

        $sharedRestorePath = Copy-SqlBackupSetToSharedFolder `
            -containerName $configuration.container `
            -backupRootPath $backupRootPath `
            -sharedFolderName "SqlRestore"

        Write-Host ""
        Write-Host "Preparing to restore SQL backup set to container '$($configuration.container)'." -ForegroundColor Green
        Write-Host "Backup folder: $backupRootPath" -ForegroundColor Gray
        Write-Host "Shared restore folder: $sharedRestorePath" -ForegroundColor Gray
        Write-Host "Files:" -ForegroundColor Gray
        $backupEntries | ForEach-Object {
            Write-Host " - $($_.SourceFileName) -> $($_.DatabaseRole) database '$($_.DatabaseName)'" -ForegroundColor Gray
        }
        Write-Host "This will replace the matching application and tenant databases in the container." -ForegroundColor Yellow

        if (-not (Confirm-Option -question "Do you want to restore the backup set from '$backupRootPath' to container '$($configuration.container)'?" -PromptId "backup.restoreBackupSet" -Risk "Restores database backups into the selected container." -AgentAllowed $false -Destructive $true)) {
            Write-Host "Restore skipped for container '$($configuration.container)'." -ForegroundColor Blue
            continue
        }

        Restore-BcContainerSqlBackupEntries `
            -containerName $configuration.container `
            -bakFolder $sharedRestorePath `
            -backupEntries $backupEntries

        Write-Host "SQL backup set restored to container '$($configuration.container)'." -ForegroundColor Green
    }
}

function Import-BcServiceBackupDiscoveryModules {
    if (-not (Get-Command Get-NAVServerConfiguration -ErrorAction SilentlyContinue)) {
        Import-Module Microsoft.Dynamics.Nav.Management -ErrorAction SilentlyContinue
    }
}

function Get-BcServerConfigValue {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $serverInstance,
        [Parameter(Mandatory=$true)]
        [string] $keyName
    )

    $configValue = Get-NAVServerConfiguration -ServerInstance $serverInstance -KeyName $keyName
    if ($configValue.PSObject.Properties.Name -contains "Value") {
        return $configValue.Value
    }
    if ($configValue.PSObject.Properties.Name -contains "KeyValue") {
        return $configValue.KeyValue
    }
    return [string]$configValue
}

function Get-RemoteComputerNameFromServer {
    Param (
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string] $server
    )

    if ([string]::IsNullOrWhiteSpace($server)) {
        return "localhost"
    }

    $serverValue = $server.Trim()
    if ($serverValue -match '^https?://') {
        return ([Uri]$serverValue).Host
    }

    return (($serverValue -split '/')[0] -split ':')[0]
}

function Test-LocalBcManagementAvailable {
    return ((Get-Command Get-NAVServerConfiguration -ErrorAction SilentlyContinue) -and (Get-Command Get-NAVTenant -ErrorAction SilentlyContinue))
}

function Get-BcServiceDatabaseInfoLocal {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $serverInstance
    )

    $databaseServer = Get-BcServerConfigValue -serverInstance $serverInstance -keyName "DatabaseServer"
    $databaseInstance = Get-BcServerConfigValue -serverInstance $serverInstance -keyName "DatabaseInstance"
    $databaseName = Get-BcServerConfigValue -serverInstance $serverInstance -keyName "DatabaseName"
    $multitenant = ((Get-BcServerConfigValue -serverInstance $serverInstance -keyName "Multitenant") -eq "true")
    $tenants = @()
    if ($multitenant) {
        $tenants = @(Get-NAVTenant -ServerInstance $serverInstance | ForEach-Object {
            [PSCustomObject]@{
                Id = $_.Id
                DatabaseName = $_.DatabaseName
            }
        })
    }

    [PSCustomObject]@{
        DatabaseServer = $databaseServer
        DatabaseInstance = $databaseInstance
        DatabaseName = $databaseName
        Multitenant = $multitenant
        Tenants = $tenants
    }
}

function Get-BcServiceDatabaseInfoRemote {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $computerName,
        [Parameter(Mandatory=$true)]
        [string] $serverInstance,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    $session = New-RemoteBackupSession `
        -computerName $computerName `
        -configuration $configuration

    try {
        Invoke-Command -Session $session -ScriptBlock {
            Param($serverInstance)

            if (-not (Get-Command Get-NAVServerConfiguration -ErrorAction SilentlyContinue)) {
                Import-Module Microsoft.Dynamics.Nav.Management -ErrorAction SilentlyContinue
            }
            if (-not (Get-Command Get-NAVServerConfiguration -ErrorAction SilentlyContinue)) {
                throw "Get-NAVServerConfiguration was not found on BC service host '$env:COMPUTERNAME'."
            }
            if (-not (Get-Command Get-NAVTenant -ErrorAction SilentlyContinue)) {
                throw "Get-NAVTenant was not found on BC service host '$env:COMPUTERNAME'."
            }

            function Get-BcServerConfigValueRemote {
                Param (
                    [Parameter(Mandatory=$true)]
                    [string] $serverInstance,
                    [Parameter(Mandatory=$true)]
                    [string] $keyName
                )

                $configValue = Get-NAVServerConfiguration -ServerInstance $serverInstance -KeyName $keyName
                if ($configValue.PSObject.Properties.Name -contains "Value") {
                    return $configValue.Value
                }
                if ($configValue.PSObject.Properties.Name -contains "KeyValue") {
                    return $configValue.KeyValue
                }
                return [string]$configValue
            }

            $databaseServer = Get-BcServerConfigValueRemote -serverInstance $serverInstance -keyName "DatabaseServer"
            $databaseInstance = Get-BcServerConfigValueRemote -serverInstance $serverInstance -keyName "DatabaseInstance"
            $databaseName = Get-BcServerConfigValueRemote -serverInstance $serverInstance -keyName "DatabaseName"
            $multitenant = ((Get-BcServerConfigValueRemote -serverInstance $serverInstance -keyName "Multitenant") -eq "true")
            $tenants = @()
            if ($multitenant) {
                $tenants = @(Get-NAVTenant -ServerInstance $serverInstance | ForEach-Object {
                    [PSCustomObject]@{
                        Id = $_.Id
                        DatabaseName = $_.DatabaseName
                    }
                })
            }

            [PSCustomObject]@{
                DatabaseServer = $databaseServer
                DatabaseInstance = $databaseInstance
                DatabaseName = $databaseName
                Multitenant = $multitenant
                Tenants = $tenants
            }
        } -ArgumentList $serverInstance
    }
    finally {
        if ($session) {
            Remove-PSSession $session
        }
    }
}

function Get-BcServiceDatabaseInfo {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration,
        [Parameter(Mandatory=$true)]
        [string] $serverInstance
    )

    if (Test-LocalBcManagementAvailable) {
        return (Get-BcServiceDatabaseInfoLocal -serverInstance $serverInstance)
    }

    $managementServer = ""
    if ($configuration.PSObject.Properties.Name -contains "managementServer" -and -not [string]::IsNullOrWhiteSpace($configuration.managementServer)) {
        $managementServer = $configuration.managementServer
    } else {
        $managementServer = Get-RemoteComputerNameFromServer -server $configuration.server
    }

    Write-Host "BC management cmdlets not available locally. Discovering service databases through PowerShell remoting on '$managementServer'." -ForegroundColor Yellow
    return (Get-BcServiceDatabaseInfoRemote `
        -computerName $managementServer `
        -serverInstance $serverInstance `
        -configuration $configuration)
}

function Backup-RegularSqlDatabase {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $databaseServerInstance,
        [Parameter(Mandatory=$true)]
        [string] $databaseName,
        [Parameter(Mandatory=$true)]
        [string] $backupFile,
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        [PSCredential] $sqlCredential
    )

    if (Test-Path -Path $backupFile -PathType Leaf) {
        Remove-Item -Path $backupFile -Force
    }

    Write-Host "Backing up SQL database '$databaseName' to '$backupFile'." -ForegroundColor Gray

    if (-not (Get-Command Backup-SqlDatabase -ErrorAction SilentlyContinue)) {
        Import-Module SqlServer -ErrorAction SilentlyContinue
    }
    if (-not (Get-Command Backup-SqlDatabase -ErrorAction SilentlyContinue)) {
        Import-Module SQLPS -DisableNameChecking -ErrorAction SilentlyContinue
    }
    if (-not (Get-Command Backup-SqlDatabase -ErrorAction SilentlyContinue)) {
        throw "Backup-SqlDatabase was not found locally. Install/import the SqlServer PowerShell module or run this backup on the SQL host through remoting."
    }

    $backupParameters = @{
        ServerInstance = $databaseServerInstance
        Database = $databaseName
        BackupFile = $backupFile
        CopyOnly = $true
        Initialize = $true
    }
    if ($sqlCredential) {
        $backupParameters["SqlCredential"] = $sqlCredential
    }

    Backup-SqlDatabase @backupParameters
}

function Test-IsLocalSqlServer {
    Param (
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string] $databaseServer
    )

    if ([string]::IsNullOrWhiteSpace($databaseServer)) {
        return $true
    }

    $normalizedServer = $databaseServer.Trim().ToLowerInvariant()
    if ($normalizedServer -in @("localhost", ".", "(local)", $env:COMPUTERNAME.ToLowerInvariant())) {
        return $true
    }

    try {
        $fqdn = [System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName.ToLowerInvariant()
        if ($normalizedServer -eq $fqdn) {
            return $true
        }
    }
    catch {
    }

    return $false
}

function New-RemoteBackupSession {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $computerName,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
    )

    $sessionParameters = @{
        ComputerName = $computerName
        ErrorAction = "Stop"
    }

    if ($configuration.PSObject.Properties.Name -contains "remoteUser" -and -not [string]::IsNullOrWhiteSpace($configuration.remoteUser)) {
        $securePassword = ConvertTo-SecureString -String $configuration.remotePassword -AsPlainText -Force
        $sessionParameters.Credential = New-Object pscredential $configuration.remoteUser, $securePassword
    }

    try {
        New-PSSession @sessionParameters
    }
    catch {
        throw "Could not open a PowerShell remoting session to '$computerName'. Enable/configure WinRM remoting, or add the host to TrustedHosts when Kerberos/domain authentication is not available. Original error: $($_.Exception.Message)"
    }
}

function Assert-BcServiceDatabaseInfo {
    Param (
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        [PSObject] $serviceDatabaseInfo,
        [Parameter(Mandatory=$true)]
        [string] $serverInstance
    )

    if ($null -eq $serviceDatabaseInfo) {
        throw "Could not discover database information for BC service instance '$serverInstance'."
    }
    if ([string]::IsNullOrWhiteSpace($serviceDatabaseInfo.DatabaseName)) {
        throw "Could not discover the application database name for BC service instance '$serverInstance'."
    }
    if ($serviceDatabaseInfo.Multitenant -and @($serviceDatabaseInfo.Tenants).Count -eq 0) {
        throw "BC service instance '$serverInstance' is multitenant, but no tenants were discovered."
    }
    foreach ($tenant in @($serviceDatabaseInfo.Tenants)) {
        if ([string]::IsNullOrWhiteSpace($tenant.Id) -or [string]::IsNullOrWhiteSpace($tenant.DatabaseName)) {
            throw "BC service instance '$serverInstance' has a tenant with missing Id or DatabaseName."
        }
    }
}

function Backup-RemoteSqlDatabases {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $computerName,
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string] $databaseInstance,
        [Parameter(Mandatory=$true)]
        [array] $backupRequests,
        [Parameter(Mandatory=$true)]
        [string] $localExportPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration,
        [Parameter(Mandatory=$false)]
        [AllowNull()]
        [PSCredential] $sqlCredential
    )

    $safeFolderName = ($configuration.serverInstance -replace '[\\/:*?"<>|]', '_')
    $remoteBackupPath = Join-Path "C:\ProgramData\BC-Dev-Toolset\SqlBackups" $safeFolderName
    $remoteServerInstance = "localhost"
    if (-not [string]::IsNullOrWhiteSpace($databaseInstance)) {
        $remoteServerInstance = ".\$databaseInstance"
    }

    $session = New-RemoteBackupSession `
        -computerName $computerName `
        -configuration $configuration

    try {
        Invoke-Command -Session $session -ScriptBlock {
            Param($remoteBackupPath, $remoteServerInstance, $backupRequests, $sqlCredential)

            if (-not (Get-Command Backup-SqlDatabase -ErrorAction SilentlyContinue)) {
                Import-Module SqlServer -ErrorAction SilentlyContinue
            }
            if (-not (Get-Command Backup-SqlDatabase -ErrorAction SilentlyContinue)) {
                Import-Module SQLPS -DisableNameChecking -ErrorAction SilentlyContinue
            }
            if (-not (Get-Command Backup-SqlDatabase -ErrorAction SilentlyContinue)) {
                throw "Backup-SqlDatabase was not found on remote SQL host '$env:COMPUTERNAME'. Install/import the SqlServer PowerShell module there."
            }

            New-Item -ItemType Directory -Path $remoteBackupPath -Force | Out-Null
            Get-ChildItem -Path $remoteBackupPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
                Remove-Item -Force

            foreach ($request in $backupRequests) {
                $backupFile = Join-Path $remoteBackupPath $request.FileName
                Write-Host "Backing up SQL database '$($request.DatabaseName)' to '$backupFile' on remote SQL host."
                $backupParameters = @{
                    ServerInstance = $remoteServerInstance
                    Database = $request.DatabaseName
                    BackupFile = $backupFile
                    CopyOnly = $true
                    Initialize = $true
                }
                if ($sqlCredential) {
                    $backupParameters["SqlCredential"] = $sqlCredential
                }
                Backup-SqlDatabase @backupParameters
            }
        } -ArgumentList $remoteBackupPath, $remoteServerInstance, $backupRequests, $sqlCredential

        Get-ChildItem -Path $localExportPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
            Remove-Item -Force

        Copy-Item `
            -FromSession $session `
            -Path (Join-Path $remoteBackupPath "*.bak") `
            -Destination $localExportPath `
            -Force

        Invoke-Command -Session $session -ScriptBlock {
            Param($remoteBackupPath)
            Remove-Item -Path $remoteBackupPath -Force -Recurse -ErrorAction SilentlyContinue
        } -ArgumentList $remoteBackupPath
    }
    finally {
        if ($session) {
            Remove-PSSession $session
        }
    }
}

function Get-BcServiceSqlBackupRequests {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $serviceDatabaseInfo,
        [Parameter(Mandatory=$true)]
        [string] $serverInstance
    )

    if (-not $serviceDatabaseInfo.Multitenant) {
        return @([PSCustomObject]@{
            DatabaseName = $serviceDatabaseInfo.DatabaseName
            FileName = (Get-SqlBackupFileName -databaseName $serviceDatabaseInfo.DatabaseName -databaseRole "database")
        })
    }

    $backupRequests = @([PSCustomObject]@{
        DatabaseName = $serviceDatabaseInfo.DatabaseName
        FileName = (Get-SqlBackupFileName -databaseName $serviceDatabaseInfo.DatabaseName -databaseRole "app")
    })
    $tenants = @($serviceDatabaseInfo.Tenants)
    if ($tenants.Count -eq 0) {
        throw "No tenants found for multitenant service instance '$serverInstance'."
    }

    foreach ($tenant in $tenants) {
        $backupRequests += [PSCustomObject]@{
            DatabaseName = $tenant.DatabaseName
            FileName = (Get-SqlBackupFileName -databaseName $tenant.Id -databaseRole "tenant")
        }
    }

    return $backupRequests
}

function Export-BcServiceSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    Import-BcServiceBackupDiscoveryModules
    $exportRootPaths = @(Get-ContainerSqlBackupRootPaths `
        -scriptPath $scriptPath `
        -settingsJSON $settingsJSON)

    if ($exportRootPaths.Count -eq 0) {
        throw "No container configuration has a 'sqlBackupPath' setting. Please set it on at least one Container configuration before creating a SQL backup from a BC service."
    }

    $configurationFound = $false
    foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "OnPrem")) {
        if ([string]::IsNullOrWhiteSpace($configuration.serverInstance)) {
            Write-Host "Skipping OnPrem configuration '$($configuration.name)' because serverInstance is empty." -ForegroundColor Yellow
            continue
        }

        $configurationFound = $true
        $serverInstance = $configuration.serverInstance

        Write-Host ""
        Write-Host "Creating SQL backup set for BC service instance '$serverInstance'." -ForegroundColor Green
        Write-Host "Export folders:" -ForegroundColor Gray
        foreach ($exportRootPath in $exportRootPaths) {
            Write-Host " - $exportRootPath" -ForegroundColor Gray
        }

        $serviceDatabaseInfo = Get-BcServiceDatabaseInfo `
            -configuration $configuration `
            -serverInstance $serverInstance
        Assert-BcServiceDatabaseInfo `
            -serviceDatabaseInfo $serviceDatabaseInfo `
            -serverInstance $serverInstance

        $databaseServer = $serviceDatabaseInfo.DatabaseServer
        $databaseInstance = $serviceDatabaseInfo.DatabaseInstance
        $databaseName = $serviceDatabaseInfo.DatabaseName

        if ([string]::IsNullOrWhiteSpace($databaseServer)) {
            $databaseServer = "localhost"
        }
        $databaseServerInstance = $databaseServer
        if (-not [string]::IsNullOrWhiteSpace($databaseInstance)) {
            $databaseServerInstance = "$databaseServer\$databaseInstance"
        }

        $sqlCredential = $null
        if ($configuration.PSObject.Properties.Name -contains "databaseUser" -and -not [string]::IsNullOrWhiteSpace($configuration.databaseUser)) {
            $securePassword = ConvertTo-SecureString -String $configuration.databasePassword -AsPlainText -Force
            $sqlCredential = New-Object pscredential $configuration.databaseUser, $securePassword
        }

        $backupRequests = @(Get-BcServiceSqlBackupRequests `
            -serviceDatabaseInfo $serviceDatabaseInfo `
            -serverInstance $serverInstance)

        foreach ($exportRootPath in $exportRootPaths) {
            New-Item -ItemType Directory -Path $exportRootPath -Force | Out-Null
            Get-ChildItem -Path $exportRootPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
                Remove-Item -Force

            if (Test-IsLocalSqlServer -databaseServer $databaseServer) {
                foreach ($request in $backupRequests) {
                    Backup-RegularSqlDatabase `
                        -databaseServerInstance $databaseServerInstance `
                        -databaseName $request.DatabaseName `
                        -backupFile (Join-Path $exportRootPath $request.FileName) `
                        -sqlCredential $sqlCredential
                }
            } else {
                Write-Host "Remote SQL Server detected. Backups will be created on '$databaseServer' and copied back to '$exportRootPath'." -ForegroundColor Yellow
                Backup-RemoteSqlDatabases `
                    -computerName $databaseServer `
                    -databaseInstance $databaseInstance `
                    -backupRequests $backupRequests `
                    -localExportPath $exportRootPath `
                    -configuration $configuration `
                    -sqlCredential $sqlCredential
            }
        }

        Write-Host "SQL backup set exported for BC service instance '$serverInstance'." -ForegroundColor Green
    }

    if (-not $configurationFound) {
        Write-Host "No OnPrem configurations found." -ForegroundColor Red
    }
}
