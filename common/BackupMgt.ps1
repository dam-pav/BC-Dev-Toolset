function Get-SqlBackupRootPath {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
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

    return (Join-Path ((Get-Item $scriptPath).Parent).FullName $sqlBackupPath)
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
        throw "No compatible .bak files found in SQL backup folder '$backupRootPath'. Expected '<database>.app.bak', '<database>.tenant.bak', or '<database>.database.bak'."
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

    $entries = @()
    foreach ($backupFile in @(Get-ChildItem -Path $backupRootPath -Filter "*.bak" -File -ErrorAction SilentlyContinue)) {
        if ($backupFile.Name -match '^(?<databaseName>.+)\.app\.bak$') {
            $entries += [PSCustomObject]@{
                SourcePath = $backupFile.FullName
                SourceFileName = $backupFile.Name
                DatabaseName = $Matches.databaseName
                DatabaseRole = "app"
                HelperFileName = "app.bak"
            }
            continue
        }

        if ($backupFile.Name -match '^(?<databaseName>.+)\.tenant\.bak$') {
            $entries += [PSCustomObject]@{
                SourcePath = $backupFile.FullName
                SourceFileName = $backupFile.Name
                DatabaseName = $Matches.databaseName
                DatabaseRole = "tenant"
                HelperFileName = "$($Matches.databaseName).bak"
            }
            continue
        }

        if ($backupFile.Name -match '^(?<databaseName>.+)\.database\.bak$') {
            $entries += [PSCustomObject]@{
                SourcePath = $backupFile.FullName
                SourceFileName = $backupFile.Name
                DatabaseName = $Matches.databaseName
                DatabaseRole = "database"
                HelperFileName = "database.bak"
            }
            continue
        }

        Write-Host "Ignoring backup file '$($backupFile.Name)' because it does not follow the '<database>.app.bak', '<database>.tenant.bak', or '<database>.database.bak' naming convention." -ForegroundColor Yellow
    }

    return $entries
}

function Get-BcContainerDatabaseBackupMap {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $containerName
    )

    Invoke-ScriptInBcContainer -containerName $containerName -usesession:$false -usepwsh:$false -ScriptBlock {
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
                    ExportFileName = "$($_.DatabaseName).tenant.bak"
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
}

function Assert-SqlBackupPath {
    Param (
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string] $sqlBackupPath,
        [Parameter(Mandatory=$true)]
        [string] $operationName
    )

    if ([string]::IsNullOrWhiteSpace($sqlBackupPath)) {
        throw "The 'sqlBackupPath' setting is empty. Please set it in BC-Dev-Toolset/settings.json before $operationName."
    }
}

function Export-BcContainerSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    Assert-SqlBackupPath `
        -sqlBackupPath $settingsJSON.sqlBackupPath `
        -operationName "creating a SQL backup"

    $configurationFound = $false
    foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
        $configurationFound = $true

        $exportRootPath = Get-SqlBackupRootPath `
            -scriptPath $scriptPath `
            -sqlBackupPath $settingsJSON.sqlBackupPath

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

    if (-not $configurationFound) {
        Write-Host "No Docker configurations found." -ForegroundColor Red
    }
}

function Restore-BcContainerSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    Assert-SqlBackupPath `
        -sqlBackupPath $settingsJSON.sqlBackupPath `
        -operationName "restoring a SQL backup"

    $configurationFound = $false
    foreach ($configuration in $($settingsJSON.configurations | Where-Object serverType -eq "Container")) {
        $configurationFound = $true

        $backupRootPath = Get-SqlBackupRootPath `
            -scriptPath $scriptPath `
            -sqlBackupPath $settingsJSON.sqlBackupPath

        if (-not (Test-Path -Path $backupRootPath -PathType Container)) {
            throw "The sqlBackupPath folder '$backupRootPath' does not exist."
        }

        $backupEntries = @(Get-SqlBackupSetEntries -backupRootPath $backupRootPath)
        if ($backupEntries.Count -eq 0) {
            throw "No compatible .bak files found at sqlBackupPath '$backupRootPath'. Expected '<database>.app.bak', '<database>.tenant.bak', or '<database>.database.bak'."
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

        if (-not (Confirm-Option -question "Do you want to restore the backup set from '$backupRootPath' to container '$($configuration.container)'?")) {
            Write-Host "Restore skipped for container '$($configuration.container)'." -ForegroundColor Blue
            continue
        }

        Restore-DatabasesInBcContainer `
            -containerName $configuration.container `
            -bakFolder $sharedRestorePath

        Write-Host "SQL backup set restored to container '$($configuration.container)'." -ForegroundColor Green
    }

    if (-not $configurationFound) {
        Write-Host "No Docker configurations found." -ForegroundColor Red
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

function Export-BcServiceSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    Assert-SqlBackupPath `
        -sqlBackupPath $settingsJSON.sqlBackupPath `
        -operationName "creating a SQL backup"

    Import-BcServiceBackupDiscoveryModules

    $exportRootPath = Get-SqlBackupRootPath `
        -scriptPath $scriptPath `
        -sqlBackupPath $settingsJSON.sqlBackupPath
    New-Item -ItemType Directory -Path $exportRootPath -Force | Out-Null

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
        Write-Host "Export folder: $exportRootPath" -ForegroundColor Gray

        $serviceDatabaseInfo = Get-BcServiceDatabaseInfo `
            -configuration $configuration `
            -serverInstance $serverInstance
        Assert-BcServiceDatabaseInfo `
            -serviceDatabaseInfo $serviceDatabaseInfo `
            -serverInstance $serverInstance

        $databaseServer = $serviceDatabaseInfo.DatabaseServer
        $databaseInstance = $serviceDatabaseInfo.DatabaseInstance
        $databaseName = $serviceDatabaseInfo.DatabaseName
        $multitenant = $serviceDatabaseInfo.Multitenant

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

        $backupRequests = @()

        if ($multitenant) {
            $backupRequests += [PSCustomObject]@{
                DatabaseName = $databaseName
                FileName = (Get-SqlBackupFileName -databaseName $databaseName -databaseRole "app")
            }

            $tenants = @($serviceDatabaseInfo.Tenants)
            if ($tenants.Count -eq 0) {
                throw "No tenants found for multitenant service instance '$serverInstance'."
            }

            foreach ($tenant in $tenants) {
                $backupRequests += [PSCustomObject]@{
                    DatabaseName = $tenant.DatabaseName
                    FileName = (Get-SqlBackupFileName -databaseName $tenant.DatabaseName -databaseRole "tenant")
                }
            }
        } else {
            $backupRequests += [PSCustomObject]@{
                DatabaseName = $databaseName
                FileName = (Get-SqlBackupFileName -databaseName $databaseName -databaseRole "database")
            }
        }

        if (Test-IsLocalSqlServer -databaseServer $databaseServer) {
            Get-ChildItem -Path $exportRootPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
                Remove-Item -Force

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

        Write-Host "SQL backup set exported for BC service instance '$serverInstance'." -ForegroundColor Green
    }

    if (-not $configurationFound) {
        Write-Host "No OnPrem configurations found." -ForegroundColor Red
    }
}
