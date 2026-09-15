. (Join-Path $PSScriptRoot 'CredentialMgt.ps1')
. (Join-Path $PSScriptRoot 'RemotingMgt.ps1')

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
        return [System.IO.Path]::GetFullPath($sqlBackupPath)
    }

    $workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath
    # Normalize without Resolve-Path so missing backup folders can still be diagnosed.
    return [System.IO.Path]::GetFullPath((Join-Path $workspaceRootPath.FullName $sqlBackupPath))
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

function Get-BcRestoreWindowsNetworkAccount {
    # Query the outbound SSPI credential, not WindowsIdentity/whoami: /netonly
    # preserves the local token while replacing the credentials used on the network.
    if (-not ('BcDevToolset.RestoreNetworkIdentity' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace BcDevToolset {
    public static class RestoreNetworkIdentity {
        [StructLayout(LayoutKind.Sequential)]
        private struct SecHandle { public IntPtr Lower; public IntPtr Upper; }
        [DllImport("secur32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int AcquireCredentialsHandleW(string principal, string package,
            uint usage, IntPtr logonId, IntPtr authData, IntPtr getKey, IntPtr keyArgument,
            out SecHandle credential, out long expiry);
        [DllImport("secur32.dll", ExactSpelling = true)]
        private static extern int QueryCredentialsAttributesW(ref SecHandle credential,
            uint attribute, out IntPtr name);
        [DllImport("secur32.dll", ExactSpelling = true)]
        private static extern int FreeCredentialsHandle(ref SecHandle credential);
        [DllImport("secur32.dll", ExactSpelling = true)]
        private static extern int FreeContextBuffer(IntPtr buffer);
        public static string GetAccount() {
            SecHandle credential;
            long expiry;
            int status = AcquireCredentialsHandleW(null, "Negotiate", 2,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out credential, out expiry);
            if (status != 0) throw new InvalidOperationException("Cannot acquire outbound Windows credentials: " + status);
            try {
                IntPtr name;
                status = QueryCredentialsAttributesW(ref credential, 1, out name);
                if (status != 0) throw new InvalidOperationException("Cannot query outbound Windows identity: " + status);
                try {
                    string account = Marshal.PtrToStringUni(name);
                    if (String.IsNullOrWhiteSpace(account)) throw new InvalidOperationException("Outbound Windows identity is empty.");
                    return account;
                }
                finally { if (name != IntPtr.Zero) FreeContextBuffer(name); }
            }
            finally { FreeCredentialsHandle(ref credential); }
        }
    }
}
'@ -ErrorAction Stop
    }
    return [BcDevToolset.RestoreNetworkIdentity]::GetAccount()
}

function Repair-BcContainerAdministratorAfterRestore {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration,
        [Parameter(Mandatory=$true)]
        [string[]] $tenants
    )

    $authentication = [string]$configuration.authentication
    $credential = $null
    $windowsAccount = ""
    switch ($authentication) {
        "Windows" { $windowsAccount = Get-BcRestoreWindowsNetworkAccount }
        { $_ -in @("UserPassword", "NavUserPassword") } {
            $credential = Get-BcConfigurationCredential -configuration $configuration
        }
        default { throw "Post-restore administrator repair does not support authentication '$authentication'. Configure Windows or UserPassword authentication for the target container." }
    }

    foreach ($tenant in ($tenants | Select-Object -Unique)) {
        try {
            Invoke-ScriptInBcContainer -containerName $configuration.container -ScriptBlock {
                Param ($tenant, $credential, $windowsAccount)
                $ErrorActionPreference = "Stop"
                # -KeyName can return the value directly instead of a settings object.
                # Keep this conversion inside the container script; host helpers are not available here.
                $authenticationSetting = Get-NAVServerConfiguration -ServerInstance $ServerInstance -KeyName ClientServicesCredentialType
                $actualAuthentication = if ($authenticationSetting -is [string]) {
                    $authenticationSetting
                }
                elseif ($null -ne $authenticationSetting -and $authenticationSetting.PSObject.Properties['Value']) {
                    [string]$authenticationSetting.Value
                }
                elseif ($null -ne $authenticationSetting -and $authenticationSetting.PSObject.Properties['KeyValue']) {
                    [string]$authenticationSetting.KeyValue
                }
                else { "" }
                if ([string]::IsNullOrWhiteSpace($actualAuthentication)) {
                    throw "Could not read ClientServicesCredentialType from Get-NAVServerConfiguration for server instance '$ServerInstance'. No administrator changes were made in this tenant."
                }
                $actualAuthentication = $actualAuthentication.Trim()
                $expectedAuthentication = if ($windowsAccount) { "Windows" } else { "NavUserPassword" }
                if ($actualAuthentication -ne $expectedAuthentication) {
                    throw "Container authentication '$actualAuthentication' does not match configured '$expectedAuthentication'. Correct the container configuration before repairing access."
                }
                $userParameters = @{ ServerInstance = $ServerInstance; Tenant = $tenant }
                $users = @(Get-NAVServerUser @userParameters)
                if ($windowsAccount) {
                    # Resolve in the target environment and match SID to handle renamed
                    # accounts and alternate domain/UPN spellings without duplicates.
                    $account = New-Object System.Security.Principal.NTAccount($windowsAccount)
                    $sid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
                    $user = @($users | Where-Object { [string]$_.WindowsSecurityId -eq $sid })
                    $userParameters.WindowsAccount = $windowsAccount
                    $displayName = $windowsAccount
                }
                else {
                    $user = @($users | Where-Object { $_.UserName -eq $credential.UserName })
                    $userParameters.UserName = $credential.UserName
                    $displayName = $credential.UserName
                }
                if ($user.Count -gt 1) { throw "Multiple users match the target administrator '$displayName'." }
                if ($user.Count -eq 0) {
                    Write-Host "Creating restored-database administrator '$displayName' in tenant '$tenant'." -ForegroundColor Green
                    $newParameters = $userParameters.Clone()
                    if ($credential) {
                        $newParameters.Password = $credential.Password
                        $newParameters.ChangePasswordAtNextLogOn = $false
                    }
                    New-NAVServerUser @newParameters -State Enabled -ExpiryDate ([datetime]::MinValue) | Out-Null
                }
                # Restored password hashes cannot be compared to the local credential.
                # Reapply the configured password to guarantee target-container access.
                $updateParameters = $userParameters.Clone()
                if ($credential) {
                    $updateParameters.Password = $credential.Password
                    $updateParameters.ChangePasswordAtNextLogOn = $false
                }
                if ($user.Count -eq 1 -and ($credential -or
                    $user[0].State -ne "Enabled" -or $user[0].ExpiryDate -gt [datetime]::MinValue)) {
                    Set-NAVServerUser @updateParameters -State Enabled -ExpiryDate ([datetime]::MinValue) -Force | Out-Null
                }
                $permissions = @(Get-NAVServerUserPermissionSet @userParameters)
                $super = @($permissions | Where-Object {
                    $_.PermissionSetId -eq "SUPER" -and [string]::IsNullOrEmpty([string]$_.CompanyName)
                })
                if ($super.Count -eq 0) {
                    New-NAVServerUserPermissionSet @userParameters -PermissionSetId SUPER | Out-Null
                }
                Write-Host "Administrator '$displayName' is enabled with SUPER access in tenant '$tenant'." -ForegroundColor Green
            } -ArgumentList $tenant, $credential, $windowsAccount -ErrorAction Stop
        }
        catch {
            throw "Database restore completed, but administrator setup failed in container '$($configuration.container)', tenant '$tenant': $($_.Exception.Message) If an extension blocks User table validation/events, disable it (or uninstall it) at the source before taking the backup, then enable or reinstall it in the restored target."
        }
    }
}

function Restore-BcContainerSqlBackupEntries {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $containerName,
        [Parameter(Mandatory=$true)]
        [string] $bakFolder,
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [array] $backupEntries,
        [Parameter(Mandatory=$true)]
        [PSObject] $configuration
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
    $tenants = @($backupEntries | Where-Object DatabaseRole -eq "tenant" | Select-Object -ExpandProperty DatabaseName)
    if ($tenants.Count -eq 0) { $tenants = @("default") }
    else {
        $mountedTenantIds = @(Invoke-ScriptInBcContainer -containerName $containerName -ScriptBlock {
            $ErrorActionPreference = "Stop"
            Get-NAVTenant -ServerInstance $ServerInstance -ErrorAction Stop | Select-Object -ExpandProperty Id
        } -ErrorAction Stop)
        # BcContainerHelper also backs up the unmounted template database as tenant.bak.
        # Restore it, but only repair its users if a tenant with that ID actually exists.
        $tenants = @($tenants | Where-Object { $_ -ne "tenant" -or $_ -in $mountedTenantIds })
        $missingTenants = @($tenants | Where-Object { $_ -notin $mountedTenantIds })
        if ($missingTenants.Count -gt 0) {
            throw "Database restore completed, but restored tenants are not mounted in container '$containerName': $($missingTenants -join ', '). Check tenant mounting before repairing administrator access."
        }
        if ($tenants.Count -eq 0) {
            throw "Database restore completed, but no restored tenants are mounted in container '$containerName'. Check tenant mounting before repairing administrator access."
        }
    }
    Repair-BcContainerAdministratorAfterRestore -configuration $configuration -tenants $tenants
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
        [Parameter(Mandatory=$false)]
        [string] $scriptPath = "",
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
        $backupRootPath = Get-SqlBackupRootPath -scriptPath $scriptPath -sqlBackupPath $configuration.sqlBackupPath
        $options += "$($configuration.name) ($($configuration.container)) -> $backupRootPath"
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

function Export-InitialTestContainerSqlBackupSet {
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

function Export-BcContainerSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $selectedConfigurations = @(Select-ContainerSqlBackupConfigurations `
        -scriptPath $scriptPath `
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
        -scriptPath $scriptPath `
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
            -backupEntries $backupEntries `
            -configuration $configuration

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
        Invoke-Command -Session $session -ErrorAction Stop -ScriptBlock {
            Param($serverInstance)

            if (-not (Get-Command Get-NAVServerConfiguration -ErrorAction SilentlyContinue)) {
                # Use the selected Windows service's installation, not the newest installed BC version.
                $serviceName = if ($serverInstance.StartsWith('MicrosoftDynamicsNavServer$', [StringComparison]::OrdinalIgnoreCase)) {
                    $serverInstance
                } else { 'MicrosoftDynamicsNavServer$' + $serverInstance }
                $services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'MicrosoftDynamicsNavServer%'" -ErrorAction Stop | Where-Object { $_.Name -eq $serviceName })
                if ($services.Count -ne 1) {
                    throw "BC service '$serviceName' was not found uniquely on '$env:COMPUTERNAME'. Check serverInstance and managementServer; managementServer must be the BC service host, not just the SQL host."
                }

                # The administrator-managed service registration authorizes a configurable installation root.
                # Validate its executable at this boundary; access only a fixed child of that root below.
                $serviceCommand = $services[0].PathName.Trim()
                if ($serviceCommand -notmatch '^(?:"(?<exe>[A-Za-z]:\\[^"\r\n]+\\Microsoft\.Dynamics\.Nav\.Server\.exe)"|(?<exe>[A-Za-z]:\\[^"\r\n]+?\\Microsoft\.Dynamics\.Nav\.Server\.exe))(?:\s|$)') {
                    throw "BC service '$serviceName' has an unsupported executable path. Cannot safely locate its administration shell."
                }
                $validatedServiceExecutable = [IO.Path]::GetFullPath($Matches['exe'])
                $validatedInstallationRoot = [IO.Path]::GetDirectoryName($validatedServiceExecutable)
                $validatedAdminToolPath = [IO.Path]::Combine($validatedInstallationRoot, 'NavAdminTool.ps1')
                if (-not (Test-Path -LiteralPath $validatedAdminToolPath -PathType Leaf)) {
                    throw "BC administration shell was not found at '$validatedAdminToolPath' for service '$serviceName'. Install or repair the administration tools for this BC server version."
                }
                try {
                    Import-Module -Name $validatedAdminToolPath -ErrorAction Stop | Out-Null
                } catch {
                    throw "Could not load BC administration shell '$validatedAdminToolPath' in PowerShell $($PSVersionTable.PSVersion). Check this BC version's PowerShell requirements and administration-tool installation. Cause: $($_.Exception.Message)"
                }
                if (-not (Get-Command Get-NAVServerConfiguration -ErrorAction SilentlyContinue)) {
                    throw "BC administration shell '$validatedAdminToolPath' loaded but did not expose Get-NAVServerConfiguration. Check the installed administration tools and PowerShell compatibility."
                }
            }

            function Get-BcServerConfigValueRemote {
                Param (
                    [Parameter(Mandatory=$true)]
                    [string] $serverInstance,
                    [Parameter(Mandatory=$true)]
                    [string] $keyName
                )

                $configValue = Get-NAVServerConfiguration -ServerInstance $serverInstance -KeyName $keyName -ErrorAction Stop
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
                if (-not (Get-Command Get-NAVTenant -ErrorAction SilentlyContinue)) {
                    throw "Get-NAVTenant is unavailable for multitenant service '$serverInstance'. Check its BC administration-tool installation."
                }
                $tenants = @(Get-NAVTenant -ServerInstance $serverInstance -ErrorAction Stop | ForEach-Object {
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
    $databaseInfo = Get-BcServiceDatabaseInfoRemote `
        -computerName $managementServer `
        -serverInstance $serverInstance `
        -configuration $configuration
    if ([string]::IsNullOrWhiteSpace($databaseInfo.DatabaseServer) -or $databaseInfo.DatabaseServer -in @('.', '(local)', 'localhost')) {
        $databaseInfo.DatabaseServer = $managementServer
    }
    return $databaseInfo
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

    try { Backup-SqlDatabase @backupParameters -ErrorAction Stop }
    catch { throw "SQL backup failed for '$databaseName' on '$databaseServerInstance'. Cause: $($_.Exception.Message)" }
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

    $promptedCredential = $null
    $resolvingCredential = $true
    try {
        $context = $script:backupCredentialContext
        $configuredCredential = if ($context -and [object]::ReferenceEquals($context.Configuration, $configuration) -and $context.Remote) {
            $context.Remote
        } else { Get-ConfigurationCredential -configuration $configuration -kind remote }
        if ($configuredCredential) { $sessionParameters.Credential = $configuredCredential }
        $resolvingCredential = $false
        return (New-PSSession @sessionParameters)
    }
    catch {
        $connectionError = $_.Exception.Message
        if (Test-RemotingAgentWorkflow) {
            if ($resolvingCredential) { throw }
            $reason = if ($connectionError -match 'TrustedHosts|Kerberos') { 'WinRM trust/authentication failed' } elseif ($connectionError -match 'Access is denied|AccessDenied|logon failure') { 'Windows credentials or remoting permissions were rejected' } else { 'the WinRM endpoint could not be reached; check server remoting, DNS and firewall access' }
            throw "Backup stopped: PowerShell remoting to '$computerName' failed. Use bc_dev_toolset_configure_win_rm with computerName='$computerName' and addTrustedHost=true for trust errors (false for local WinRM only), execute=true, confirm=true; then retry the backup. Ensure remoteUser/remotePassword are configured for non-domain authentication. Cause: $reason."
        }
        :recovery while ($true) {
            Write-Host "Cannot connect to '$computerName' through PowerShell remoting." -ForegroundColor Yellow
            Write-Host "[T] Trust this host  [W] Configure local WinRM  [C] Enter Windows credentials"
            Write-Host "[R] Retry  [D] Error details  [Enter] Cancel backup"
            try { $choice = Read-Host -Prompt 'Remoting recovery' } catch { $choice = '' }
            try {
                switch ($choice.Trim().ToUpperInvariant()) {
                    'D' { Write-Host $connectionError -ForegroundColor DarkYellow; continue recovery }
                    'R' { }
                    'C' {
                        $credential = Get-Credential -Message "Windows remoting credentials for $computerName"
                        if (-not $credential) { continue recovery }
                        $sessionParameters.Credential = $credential
                        $promptedCredential = $credential
                    }
                    { $_ -in 'T', 'W' } {
                        $addHost = $_ -eq 'T'
                        $prompt = if ($addHost) {
                            "Start local WinRM and add '$computerName' to TrustedHosts? Existing entries are preserved; server identity is not verified. [y/N]"
                        } else {
                            'Start local WinRM and set startup to Automatic? This does not enable remoting on the remote server. [y/N]'
                        }
                        if ((Read-Host -Prompt $prompt) -notmatch '^(y|yes)$') { continue recovery }
                        Invoke-WinRmConfiguration -computerName $computerName -addTrustedHost $addHost
                        if ($addHost -and -not $sessionParameters.Credential) {
                            $credential = Get-Credential -Message "Windows remoting credentials for $computerName"
                            if (-not $credential) { continue recovery }
                            $sessionParameters.Credential = $credential
                            $promptedCredential = $credential
                        }
                    }
                    default {
                        $cancelled = [System.OperationCanceledException]::new("Backup cancelled: remoting to '$computerName' is unavailable.")
                        $cancelled.Data['BackupRemotingCancelled'] = $true
                        throw $cancelled
                    }
                }
                Write-Host 'Retrying connection...' -ForegroundColor Gray
                $connectedSession = New-PSSession @sessionParameters
                if ($promptedCredential -and $context -and [object]::ReferenceEquals($context.Configuration, $configuration)) {
                    $context.Remote = $promptedCredential
                }
                return $connectedSession
            }
            catch {
                if ($_.Exception.Data['BackupRemotingCancelled']) { throw }
                $connectionError = $_.Exception.Message
                Write-Host 'Connection or repair did not succeed. Choose D for details.' -ForegroundColor Yellow
            }
        }
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

    $ErrorActionPreference = 'Stop'
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
        Invoke-Command -Session $session -ErrorAction Stop -ScriptBlock {
            Param($remoteBackupPath, $remoteServerInstance, $backupRequests, $sqlCredential)

            $ErrorActionPreference = 'Stop'

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
                try {
                    Backup-SqlDatabase @backupParameters -ErrorAction Stop
                } catch {
                    # SMO commonly wraps the useful SQL connection error in nested exceptions.
                    $causes = @()
                    $cause = $_.Exception
                    while ($null -ne $cause) {
                        if ($cause.Message -and $cause.Message -notin $causes) { $causes += $cause.Message }
                        $cause = $cause.InnerException
                    }
                    $authentication = if ($sqlCredential) { 'configured SQL credentials (databaseUser/databasePassword)' } else { 'Windows authentication from the remote session' }
                    throw "SQL backup failed for '$($request.DatabaseName)' on '$remoteServerInstance' at '$env:COMPUTERNAME', using $authentication. Cause: $($causes -join ' --> ')"
                }
                if (-not (Test-Path -LiteralPath $backupFile -PathType Leaf)) {
                    throw "SQL backup returned without creating '$backupFile'. No files will be exported."
                }
            }
        } -ArgumentList $remoteBackupPath, $remoteServerInstance, $backupRequests, $sqlCredential

        Get-ChildItem -Path $localExportPath -Filter "*.bak" -File -ErrorAction SilentlyContinue |
            Remove-Item -Force

        Copy-Item `
            -FromSession $session `
            -Path (Join-Path $remoteBackupPath "*.bak") `
            -Destination $localExportPath `
            -Force -ErrorAction Stop

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

function Select-BcServiceSqlBackupConfigurations {
    Param ([Parameter(Mandatory=$true)][PSObject] $settingsJSON)

    $sources = @($settingsJSON.configurations | Where-Object { $_.serverType -eq 'OnPrem' -and -not [string]::IsNullOrWhiteSpace($_.serverInstance) })
    $destinations = @(Get-ContainerSqlBackupConfigurations -settingsJSON $settingsJSON)
    if ($sources.Count -eq 0) { throw 'No OnPrem source configurations with a serverInstance found.' }
    if ($destinations.Count -eq 0) { throw 'No Container destination configurations with a sqlBackupPath found.' }

    if (Test-RemotingAgentWorkflow) {
        if ([string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_SERVICE_BACKUP_INPUTS)) {
            throw 'Supply sourceConfiguration and destinationConfiguration names upfront to bc_dev_toolset_backup_bc_service_databases with execute=true. No backup was started.'
        }
        $inputs = $env:BCDEVTOOLSET_SERVICE_BACKUP_INPUTS | ConvertFrom-Json -ErrorAction Stop
        $selectedSources = @($sources | Where-Object { $_.name -eq $inputs.'serviceBackup.source' })
        $selectedDestinations = @($destinations | Where-Object { $_.name -eq $inputs.'serviceBackup.destination' })
        if ([string]::IsNullOrWhiteSpace($inputs.'serviceBackup.source') -or [string]::IsNullOrWhiteSpace($inputs.'serviceBackup.destination') -or $selectedSources.Count -ne 1 -or $selectedDestinations.Count -ne 1) {
            throw "Select unique eligible configuration names. Sources: $($sources.name -join ', '). Destinations: $($destinations.name -join ', '). No backup was started."
        }
        return [pscustomobject]@{ Source=$selectedSources[0]; Destination=$selectedDestinations[0] }
    }

    $sourceIndex = 0
    if ($sources.Count -gt 1) {
        $sourceIndex = Select-IndexFromList -Title 'Select source configuration for BC service SQL backup:' -Options @($sources | ForEach-Object { "$($_.name) -> $($_.server) / $($_.serverInstance)" })
    }
    # Always ask for the destination, including when only one is eligible.
    $destinationIndex = Select-IndexFromList -Title 'Select destination configuration for BC service SQL backup (existing .bak files will be replaced):' -Options @($destinations | ForEach-Object { "$($_.name) -> $($_.sqlBackupPath)" })
    return [pscustomobject]@{ Source=$sources[$sourceIndex]; Destination=$destinations[$destinationIndex] }
}

function Get-BcConfiguredDatabaseInfo {
    param([PSObject] $configuration)
    if ([string]::IsNullOrWhiteSpace($configuration.databaseServerHost)) { return $null }
    if ($configuration.databaseServerHost -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$') { throw 'databaseServerHost must be a hostname or IP address, without a URL, port separator comma, or SQL instance suffix.' }
    if ([string]::IsNullOrWhiteSpace($configuration.databaseName)) {
        throw 'databaseName is required when databaseServerHost is set. Set databaseInstance for a named SQL instance, and databaseTenants for a multitenant BC service. BC discovery was skipped.'
    }
    $multitenant = $null -ne $configuration.PSObject.Properties['databaseTenants']
    $tenants = @()
    if ($multitenant) {
        if ($configuration.databaseTenants -isnot [array] -or $configuration.databaseTenants.Count -eq 0) {
            throw 'databaseTenants must be a non-empty array of {id, databaseName} entries. Omit it for a single-tenant database.'
        }
        $seenIds = @()
        foreach ($tenant in $configuration.databaseTenants) {
            if ([string]::IsNullOrWhiteSpace($tenant.id) -or [string]::IsNullOrWhiteSpace($tenant.databaseName) -or $tenant.id -in $seenIds) {
                throw 'Each databaseTenants entry needs a unique id and a databaseName.'
            }
            $seenIds += $tenant.id
            $tenants += [pscustomobject]@{ Id=$tenant.id; DatabaseName=$tenant.databaseName }
        }
    }
    return [pscustomobject]@{
        DatabaseServer=$configuration.databaseServerHost
        DatabaseInstance=[string]$configuration.databaseInstance
        DatabaseName=$configuration.databaseName
        Multitenant=$multitenant
        Tenants=$tenants
    }
}

function Save-BcDatabaseServerHost {
    param([PSObject] $configuration, [string] $databaseServerHost, [PSObject] $serviceDatabaseInfo)
    if (-not [string]::IsNullOrWhiteSpace($configuration.databaseServerHost)) { return }
    if ([string]::IsNullOrWhiteSpace($databaseServerHost)) { throw 'Discovered SQL host is empty.' }
    $match = Find-BcConfigurationDocument -configuration $configuration
    # Respect an explicit host added by the developer while the backup was running.
    if (-not [string]::IsNullOrWhiteSpace($match.Configuration.databaseServerHost)) { return }
    $mapping = @{
        databaseServerHost=$databaseServerHost
        databaseInstance=[string]$serviceDatabaseInfo.DatabaseInstance
        databaseName=$serviceDatabaseInfo.DatabaseName
    }
    if ($serviceDatabaseInfo.Multitenant) {
        $mapping.databaseTenants = @($serviceDatabaseInfo.Tenants | ForEach-Object { [pscustomobject]@{ id=$_.Id; databaseName=$_.DatabaseName } })
    }
    foreach ($field in $mapping.Keys) { $match.Configuration | Add-Member NoteProperty $field $mapping[$field] -Force }
    if (-not $serviceDatabaseInfo.Multitenant) { $match.Configuration.PSObject.Properties.Remove('databaseTenants') }
    if ([IO.File]::ReadAllText($match.Path) -cne $match.Text) { throw 'Configuration changed while saving the SQL host. No settings were changed.' }
    [IO.File]::WriteAllText($match.Path, ($match.Document | ConvertTo-Json -Depth 100) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    foreach ($field in $mapping.Keys) { $configuration | Add-Member NoteProperty $field $mapping[$field] -Force }
    if (-not $serviceDatabaseInfo.Multitenant) { $configuration.PSObject.Properties.Remove('databaseTenants') }
    Write-Host "Saved SQL host and database mapping for '$($configuration.name)'; future backups will skip BC discovery." -ForegroundColor Gray
}

function Export-BcServiceSqlBackupSet {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $scriptPath,
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON
    )

    $ErrorActionPreference = 'Stop'
    $selection = Select-BcServiceSqlBackupConfigurations -settingsJSON $settingsJSON
    $configuration = $selection.Source
    $previousCredentialContext = $script:backupCredentialContext
    $script:backupCredentialContext = [pscustomobject]@{ Configuration=$configuration; Remote=$null }
    try {
        $serverInstance = $configuration.serverInstance
        $exportRootPath = Get-SqlBackupRootPath -scriptPath $scriptPath -sqlBackupPath $selection.Destination.sqlBackupPath
        Write-Host "Creating SQL backup set from '$($configuration.name)' (BC service '$serverInstance')." -ForegroundColor Green
        Write-Host "Destination: '$($selection.Destination.name)' -> $exportRootPath (existing .bak files will be replaced)." -ForegroundColor Yellow

        $serviceDatabaseInfo = Get-BcConfiguredDatabaseInfo -configuration $configuration
        if ($null -eq $serviceDatabaseInfo) {
            Import-BcServiceBackupDiscoveryModules
            $serviceDatabaseInfo = Get-BcServiceDatabaseInfo -configuration $configuration -serverInstance $serverInstance
        } else {
            Write-Host "Using configured SQL mapping for '$($configuration.databaseServerHost)'; BC service discovery skipped." -ForegroundColor Gray
        }
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

        $promptedSqlCredential = $null
        try { $sqlCredential = Get-ConfigurationCredential -configuration $configuration -kind database }
        catch {
            if (Test-RemotingAgentWorkflow) { throw }
            Write-Host $_.Exception.Message -ForegroundColor Yellow
            $sqlCredential = Get-Credential -Message "SQL credentials for '$($configuration.name)'"
            if (-not $sqlCredential) { throw 'SQL credential entry cancelled.' }
            $promptedSqlCredential = $sqlCredential
        }

        $backupRequests = @(Get-BcServiceSqlBackupRequests `
            -serviceDatabaseInfo $serviceDatabaseInfo `
            -serverInstance $serverInstance)

        New-Item -ItemType Directory -Path $exportRootPath -Force | Out-Null

        while ($true) {
            try {
                if (Test-IsLocalSqlServer -databaseServer $databaseServer) {
                    Get-ChildItem -Path $exportRootPath -Filter "*.bak" -File -ErrorAction Stop |
                        Remove-Item -Force -ErrorAction Stop
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
                break
            } catch {
                if ((Test-RemotingAgentWorkflow) -or $_.Exception.Message -notmatch 'SQL backup failed') { throw }
                Write-Host $_.Exception.Message -ForegroundColor Yellow
                if ((Read-Host 'Enter different SQL credentials and retry? [y/N]') -notmatch '^(y|yes)$') { throw }
                $sqlCredential = Get-Credential -Message "SQL credentials for '$($configuration.name)'"
                if (-not $sqlCredential) { throw 'SQL credential entry cancelled.' }
                $promptedSqlCredential = $sqlCredential
            }
        }
        if ($script:backupCredentialContext.Remote) {
            Offer-ConfigurationCredentialStorage -configuration $configuration -kind remote -credential $script:backupCredentialContext.Remote
        }
        if ($promptedSqlCredential) {
            Offer-ConfigurationCredentialStorage -configuration $configuration -kind database -credential $promptedSqlCredential
        }

        try { Save-BcDatabaseServerHost -configuration $configuration -databaseServerHost $databaseServer -serviceDatabaseInfo $serviceDatabaseInfo }
        catch { Write-Host "Backup succeeded, but the SQL host could not be saved: $($_.Exception.Message)" -ForegroundColor Yellow }
        Write-Host "SQL backup set exported from '$($configuration.name)' to '$($selection.Destination.name)'." -ForegroundColor Green
    } finally {
        $script:backupCredentialContext.Remote = $null
        $script:backupCredentialContext = $previousCredentialContext
    }

}
