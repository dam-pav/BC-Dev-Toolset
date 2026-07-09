#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Automates the installation and update of BC Dev Toolset prerequisites
.DESCRIPTION
    This script installs, updates, and configures:
    - Docker Engine (latest version)
    - Windows Features (Containers, Hyper-V)
    - Git
    - BcContainerHelper PowerShell Module
    - Node.js and @microsoft/bc-replay for page script tests
.NOTES
    Requires Administrator privileges
    Requires Windows Pro or Enterprise edition for Hyper-V
#>

param(
    [string]$DockerPath = "c:\docker",
    [switch]$SkipDockerInstall,
    [switch]$SkipWindowsFeatures,
    [switch]$SkipGit,
    [switch]$SkipBcContainerHelper,
    [switch]$SkipNode
)

# Colors for output
$colors = @{
    Success = "Green"
    Warning = "Yellow"
    Error   = "Red"
    Info    = "Cyan"
}

function Write-Header {
    param([string]$Message)
    Write-Host "`n" + ("=" * 80) -ForegroundColor $colors.Info
    Write-Host $Message -ForegroundColor $colors.Info
    Write-Host ("=" * 80) -ForegroundColor $colors.Info
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor $colors.Success
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor $colors.Warning
}

function Write-Error {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor $colors.Error
}

function Confirm-Upgrade {
    param(
        [string]$Name,
        [string]$CurrentVersion,
        [string]$LatestVersion
    )

    do {
        $answer = Read-Host -Prompt "Update $Name from $CurrentVersion to $LatestVersion? [y/N]"
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $false
        }
    } while ($answer -notmatch '^(?i:y|yes|n|no)$')

    return $answer -match '^(?i:y|yes)$'
}

function Get-DockerInstalledVersion {
    param([string]$DockerPath)

    $dockerExe = Join-Path $DockerPath "docker.exe"
    if (-not (Test-Path $dockerExe)) {
        $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
        if ($dockerCommand) {
            $dockerExe = $dockerCommand.Source
        }
    }

    if (-not (Test-Path $dockerExe)) {
        return $null
    }

    $versionOutput = & $dockerExe --version 2>$null
    if ($versionOutput -match 'version\s+([0-9]+(?:\.[0-9]+)*)') {
        return [version]$matches[1]
    }

    return $null
}

function Get-DockerDesktopInstallation {
    $programFiles = [Environment]::GetFolderPath("ProgramFiles")
    $candidatePaths = @(
        Join-Path $programFiles "Docker\Docker\Docker Desktop.exe",
        Join-Path $programFiles "Docker\Docker\DockerCli.exe"
    )

    foreach ($candidatePath in $candidatePaths) {
        if (Test-Path $candidatePath) {
            return [PSCustomObject]@{
                Source      = "file"
                Description = $candidatePath
            }
        }
    }

    $dockerDesktopService = Get-Service -Name "com.docker.service" -ErrorAction SilentlyContinue
    if ($dockerDesktopService) {
        return [PSCustomObject]@{
            Source      = "service"
            Description = $dockerDesktopService.DisplayName
        }
    }

    $uninstallRegistryPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )

    foreach ($uninstallRegistryPath in $uninstallRegistryPaths) {
        $dockerDesktopRegistryEntry = Get-ItemProperty -Path $uninstallRegistryPath -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -eq "Docker Desktop" } |
            Select-Object -First 1

        if ($dockerDesktopRegistryEntry) {
            return [PSCustomObject]@{
                Source      = "registry"
                Description = $dockerDesktopRegistryEntry.DisplayName
            }
        }
    }

    return $null
}

function Get-LatestDockerRelease {
    Write-Host "Fetching latest Docker Engine release..."
    $releasesUrl = "https://download.docker.com/win/static/stable/x86_64/"
    $response = Invoke-WebRequest -Uri $releasesUrl -UseBasicParsing
    $links = $response.Links | Where-Object { $_.href -match "\.zip$" }

    if ($links.Count -eq 0) {
        throw "No Docker Engine releases found"
    }

    $downloads = $links | ForEach-Object {
        $href = $_.href
        if ($href -match 'docker-([0-9]+(?:\.[0-9]+)*)(?:-[^/]+)?\.zip$') {
            [PSCustomObject]@{
                Href    = $href
                Version = [version]$matches[1]
            }
        }
    }

    if (-not $downloads) {
        throw "No valid Docker Engine release versions found"
    }

    $latestRelease = $downloads | Sort-Object -Property Version -Descending | Select-Object -First 1
    $latestRelease | Add-Member -MemberType NoteProperty -Name Url -Value ($releasesUrl + $latestRelease.Href)
    return $latestRelease
}

function Get-ProcessesUsingPath {
    param([string]$Path)

    $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') + '\'

    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -and
            [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($resolvedPath, [System.StringComparison]::OrdinalIgnoreCase)
        }
}

function Stop-ProcessesUsingPath {
    param([string]$Path)

    $processes = @(Get-ProcessesUsingPath -Path $Path)
    foreach ($process in $processes) {
        Write-Host "Stopping process using Docker Engine files: $($process.Name) (PID $($process.ProcessId))"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $timeoutAt = (Get-Date).AddSeconds(30)
    do {
        $remainingProcesses = @(Get-ProcessesUsingPath -Path $Path)
        if ($remainingProcesses.Count -eq 0) {
            return
        }

        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $timeoutAt)

    $processList = ($remainingProcesses | ForEach-Object { "$($_.Name) (PID $($_.ProcessId))" }) -join ", "
    throw "Timed out waiting for processes to release Docker Engine files: $processList"
}

function Copy-DockerEngineFiles {
    param(
        [string]$SourcePath,
        [string]$DockerPath
    )

    $timeoutAt = (Get-Date).AddSeconds(90)
    $lastError = $null

    do {
        try {
            Copy-Item -Path (Join-Path $SourcePath "*") -Destination $DockerPath -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            $lastError = $_
            Write-Warning "Docker Engine files are still locked; retrying..."
            Stop-ProcessesUsingPath -Path $DockerPath
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $timeoutAt)

    throw "Failed to replace Docker Engine files in '$DockerPath'. Close Docker CLI sessions and any process using files in that folder, then run the prerequisites operation again. Original error: $($lastError.Exception.Message)"
}

function Install-DockerEngine {
    param(
        [string]$DockerPath,
        [string]$DownloadUrl
    )

    if (-not (Test-Path $DockerPath)) {
        Write-Host "Creating directory: $DockerPath"
        New-Item -ItemType Directory -Path $DockerPath -Force | Out-Null
        Write-Success "Directory created"
    }

    $fileName = Split-Path $DownloadUrl -Leaf
    $downloadPath = Join-Path $DockerPath $fileName

    Write-Host "Latest release: $fileName"
    Write-Host "Downloading from: $DownloadUrl"

    $oldProgressPreference = $ProgressPreference
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $downloadPath
    }
    finally {
        $ProgressPreference = $oldProgressPreference
    }

    if (-not (Test-Path $downloadPath)) {
        throw "Failed to download Docker Engine"
    }

    Write-Success "Docker Engine downloaded to: $downloadPath"
    Write-Host "Extracting Docker Engine..."
    $tempExtractPath = Join-Path $env:TEMP "docker-extract-$([System.IO.Path]::GetRandomFileName())"
    New-Item -ItemType Directory -Path $tempExtractPath -Force | Out-Null

    $serviceWasRunning = $false

    try {
        Expand-Archive -Path $downloadPath -DestinationPath $tempExtractPath -Force
        $sourcePath = Join-Path $tempExtractPath "docker"
        if (-not (Test-Path $sourcePath)) {
            $sourcePath = $tempExtractPath
        }

        $existingService = Get-Service -Name "Docker" -ErrorAction SilentlyContinue
        if ($existingService -and $existingService.Status -eq "Running") {
            $serviceWasRunning = $true
            Write-Host "Stopping Docker service before replacing binaries..."
            Stop-Service -Name "Docker" -Force -ErrorAction Stop
            $existingService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60))
            $existingService.Refresh()

            if ($existingService.Status -ne "Stopped") {
                throw "Docker service did not stop within 60 seconds"
            }

            Stop-ProcessesUsingPath -Path $DockerPath
        }

        Copy-DockerEngineFiles -SourcePath $sourcePath -DockerPath $DockerPath
        Write-Success "Docker Engine extracted to: $DockerPath"
    }
    finally {
        if ($serviceWasRunning) {
            try {
                $dockerService = Get-Service -Name "Docker" -ErrorAction SilentlyContinue
                if ($dockerService -and $dockerService.Status -ne "Running") {
                    Write-Host "Restarting Docker service..."
                    Start-Service -Name "Docker" -ErrorAction Stop
                    Write-Success "Docker service restarted"
                }
            }
            catch {
                Write-Warning "Failed to restart Docker service: $($_.Exception.Message)"
            }
        }

        if (Test-Path $tempExtractPath) {
            Remove-Item $tempExtractPath -Force -Recurse
        }
        if (Test-Path $downloadPath) {
            Remove-Item $downloadPath -Force
        }
    }

    $daemonJsonPath = Join-Path $DockerPath "daemon.json"
    if (-not (Test-Path $daemonJsonPath)) {
        $daemonConfig = @{
            "group" = "Users"
        } | ConvertTo-Json

        $daemonConfig | Out-File -FilePath $daemonJsonPath -Encoding UTF8
        Write-Success "Created daemon.json configuration at: $daemonJsonPath"
    }
    else {
        Write-Warning "daemon.json already exists, leaving current configuration unchanged"
    }
}

function Get-GitInstalledVersion {
    $gitPath = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitPath) {
        return $null
    }

    $gitVersion = git --version
    if ($gitVersion -match '([0-9]+(?:\.[0-9]+)+)') {
        return [version]$matches[1]
    }

    return $null
}

function Get-WinGetPackageVersion {
    param([string]$PackageId)

    $wingetPath = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $wingetPath) {
        return $null
    }

    $showOutput = & winget show -e --id $PackageId --disable-interactivity 2>$null
    $versionLine = $showOutput | Where-Object { $_ -match '^\s*Version:\s*(.+?)\s*$' } | Select-Object -First 1
    if ($versionLine -and $versionLine -match '^\s*Version:\s*(.+?)\s*$') {
        return $matches[1].Trim()
    }

    return $null
}

function Get-NodeInstalledVersion {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        return $null
    }

    $nodeVersionOutput = node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersionOutput)) {
        return $null
    }

    try {
        return [version]($nodeVersionOutput.Trim() -replace "^v", "")
    }
    catch {
        return $null
    }
}

function Get-LatestBcContainerHelperVersion {
    $module = Find-Module -Name BcContainerHelper -ErrorAction Stop
    return [version]$module.Version
}

# Verify admin privileges
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

Write-Header "BC Dev Toolset Prerequisites Installation"

$dockerDesktopInstallation = Get-DockerDesktopInstallation
$skipDockerEngineSteps = $null -ne $dockerDesktopInstallation

# ============================================================================
# 1. DOCKER ENGINE INSTALLATION
# ============================================================================
if (-not $SkipDockerInstall -and -not $skipDockerEngineSteps) {
    Write-Header "1. Installing or Updating Docker Engine"
    
    try {
        $installedVersion = Get-DockerInstalledVersion -DockerPath $DockerPath
        $latestRelease = Get-LatestDockerRelease

        if ($installedVersion) {
            Write-Warning "Docker Engine already installed: v$installedVersion"
            Write-Host "Latest available Docker Engine: v$($latestRelease.Version)"

            if ($installedVersion -lt $latestRelease.Version) {
                if (Confirm-Upgrade -Name "Docker Engine" -CurrentVersion "v$installedVersion" -LatestVersion "v$($latestRelease.Version)") {
                    Install-DockerEngine -DockerPath $DockerPath -DownloadUrl $latestRelease.Url
                }
                else {
                    Write-Host "Skipping Docker Engine update"
                }
            }
            else {
                Write-Success "Docker Engine is up to date"
            }
        }
        else {
            Write-Host "Docker Engine is not installed"
            Install-DockerEngine -DockerPath $DockerPath -DownloadUrl $latestRelease.Url
        }
    }
    catch {
        Write-Error "Docker installation failed: $_"
        Write-Host "You can manually download from: https://download.docker.com/win/static/stable/x86_64/"
    }
}
elseif ($skipDockerEngineSteps) {
    Write-Host "Skipping Docker Engine installation (Docker Desktop detected)"
}
else {
    Write-Host "Skipping Docker Engine installation (--SkipDockerInstall flag set)"
}

# ============================================================================
# 2. ENABLE WINDOWS FEATURES
# ============================================================================
if (-not $SkipWindowsFeatures) {
    Write-Header "2. Enabling Windows Features"
    
    function Enable-FeatureNonInteractive {
        param(
            [string]$FeatureName
        )

        Write-Host "Enabling feature: $FeatureName..."
        Write-Host "This may take several minutes. Please wait."

        $dismCommand = @(
            "/online",
            "/enable-feature",
            "/featurename:$FeatureName",
            "/all",
            "/norestart"
        )

        $dismOutput = & dism.exe @dismCommand 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Feature '$FeatureName' enabled"
            return $true
        }

        Write-Warning "DISM failed to enable feature '$FeatureName' (exit code $LASTEXITCODE). Falling back to Enable-WindowsOptionalFeature."
        Write-Host $dismOutput

        $featureResult = Enable-WindowsOptionalFeature -Online -FeatureName $FeatureName -All -NoRestart -Confirm:$false -ErrorAction Stop
        if ($featureResult.RestartNeeded) {
            Write-Warning "Feature '$FeatureName' requires system restart"
        }
        else {
            Write-Success "Feature '$FeatureName' enabled"
        }

        return $true
    }

    function Test-WindowsFeatureEnabled {
        param(
            [string]$FeatureName
        )

        $dismOutput = & dism.exe /online /get-featureinfo /featurename:$FeatureName /English 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not determine current state for feature '$FeatureName' (DISM exit code $LASTEXITCODE)."
            return $false
        }

        return ($dismOutput | Where-Object { $_ -match '^\s*State\s*:\s*Enabled\s*$' }).Count -gt 0
    }

    try {
        $features = @("Containers", "Microsoft-Hyper-V-All")

        foreach ($feature in $features) {
            if (Test-WindowsFeatureEnabled -FeatureName $feature) {
                Write-Success "Feature '$feature' is already enabled"
            }
            else {
                Enable-FeatureNonInteractive -FeatureName $feature | Out-Null
            }
        }

        Write-Warning "You may need to restart your computer for changes to take effect"
    }
    catch {
        Write-Error "Failed to enable Windows features: $_"
    }
}
else {
    Write-Host "Skipping Windows Features (--SkipWindowsFeatures flag set)"
}

# ============================================================================
# 3. ADD DOCKER TO PATH
# ============================================================================
if (-not $skipDockerEngineSteps) {
    Write-Header "3. Adding Docker to PATH"

    try {
        $currentPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
        
        # Check if Docker path already in PATH
        if ($currentPath -like "*$DockerPath*") {
            Write-Warning "Docker path already in system PATH"
        }
        else {
            # Add to PATH
            $newPath = "$currentPath;$DockerPath"
            
            # Check if PATH will exceed typical limits
            if ($newPath.Length -gt 2048) {
                Write-Warning "System PATH is approaching or exceeds recommended length (2048 chars)"
                Write-Warning "Current: $($newPath.Length) chars"
            }
            
            [Environment]::SetEnvironmentVariable("PATH", $newPath, "Machine")
            Write-Success "Docker path added to system PATH"
        }
    }
    catch {
        Write-Error "Failed to add Docker to PATH: $_"
    }
}
else {
    Write-Host "Skipping Docker Engine PATH update (Docker Desktop detected)"
}

# ============================================================================
# 4. INSTALL DOCKER SERVICE
# ============================================================================
if (-not $SkipDockerInstall -and -not $skipDockerEngineSteps) {
    Write-Header "4. Installing Docker as Windows Service"
    
    try {
        $dockerdPath = Join-Path $DockerPath "dockerd.exe"
        $daemonJsonPath = Join-Path $DockerPath "daemon.json"
        
        if (-not (Test-Path $dockerdPath)) {
            Write-Error "dockerd.exe not found at: $dockerdPath"
            Write-Host "Make sure Docker Engine was extracted successfully"
        }
        else {
            # Check if service already exists
            $existingService = Get-Service -Name "Docker" -ErrorAction SilentlyContinue
            if ($existingService) {
                Write-Warning "Docker service already exists, skipping creation"
            }
            else {
                # Create the service
                $binaryPath = "$dockerdPath --run-service --config-file $daemonJsonPath"
                New-Service -Name "Docker" `
                    -BinaryPathName $binaryPath `
                    -DisplayName "Docker Engine" `
                    -StartupType "Automatic" | Out-Null
                
                Write-Success "Docker service created"
                
                # Start the service
                Start-Service -Name "Docker"
                Write-Success "Docker service started"
            }
        }
    }
    catch {
        Write-Error "Failed to install Docker service: $_"
        Write-Host "You may need to create the service manually"
    }
}
elseif ($skipDockerEngineSteps) {
    Write-Host "Skipping Docker Engine service installation (Docker Desktop detected)"
}

# ============================================================================
# 5. INSTALL GIT
# ============================================================================
if (-not $SkipGit) {
    Write-Header "5. Installing or Updating Git"
    
    try {
        $gitVersion = Get-GitInstalledVersion
        $latestGitVersion = Get-WinGetPackageVersion -PackageId "Git.Git"

        if ($gitVersion) {
            Write-Warning "Git already installed: v$gitVersion"

            if ($latestGitVersion) {
                Write-Host "Latest available Git: v$latestGitVersion"
                $latestGitSemanticVersion = $null
                if ($latestGitVersion -match '^([0-9]+(?:\.[0-9]+)+)') {
                    $latestGitSemanticVersion = [version]$matches[1]
                }

                if (-not $latestGitSemanticVersion) {
                    Write-Warning "Could not compare Git versions automatically"
                }
                elseif ($gitVersion -lt $latestGitSemanticVersion) {
                    if (Confirm-Upgrade -Name "Git" -CurrentVersion "v$gitVersion" -LatestVersion "v$latestGitVersion") {
                        Write-Host "Updating Git via WinGet..."
                        & winget upgrade -e --id Git.Git --accept-package-agreements --accept-source-agreements
                        Write-Warning "Please restart your PowerShell session to use the updated git commands"
                    }
                    else {
                        Write-Host "Skipping Git update"
                    }
                }
                else {
                    Write-Success "Git is up to date"
                }
            }
            else {
                Write-Warning "Could not determine latest Git version with WinGet"
            }
        }
        else {
            Write-Host "Installing Git via WinGet..."
            & winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
            
            # Verify installation
            if (Get-Command git -ErrorAction SilentlyContinue) {
                Write-Success "Git installed successfully"
                Write-Warning "Please restart your PowerShell session to use git commands"
            }
            else {
                Write-Error "Git installation failed or not found in PATH"
            }
        }
    }
    catch {
        Write-Error "Failed to install Git: $_"
        Write-Host "You can install manually: winget install -e --id Git.Git"
    }
}
else {
    Write-Host "Skipping Git installation (--SkipGit flag set)"
}

# ============================================================================
# 6. INSTALL NODE.JS AND BC-REPLAY
# ============================================================================
if (-not $SkipNode) {
    Write-Header "6. Installing or Updating Node.js and BC Replay"

    try {
        $nodeVersion = Get-NodeInstalledVersion
        if ($nodeVersion -and $nodeVersion.Major -ge 24) {
            Write-Success "Node.js is installed: v$nodeVersion"
        }
        else {
            if ($nodeVersion) {
                Write-Warning "Node.js v$nodeVersion is installed, but page script tests require v24 or newer"
            }
            else {
                Write-Warning "Node.js is not installed or not available in PATH"
            }

            if ($nodeVersion) {
                Write-Host "Updating Node.js via WinGet..."
                & winget upgrade -e --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements
            }
            else {
                Write-Host "Installing Node.js via WinGet..."
                & winget install -e --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements
            }

            $nodeVersion = Get-NodeInstalledVersion
            if ($nodeVersion -and $nodeVersion.Major -ge 24) {
                Write-Success "Node.js installed successfully: v$nodeVersion"
            }
            else {
                Write-Warning "Node.js installation may require restarting PowerShell before node/npm are available"
            }
        }

        if (Get-Command npm -ErrorAction SilentlyContinue) {
            Write-Host "Installing/Updating @microsoft/bc-replay globally..."
            npm install -g @microsoft/bc-replay@latest
            if (Get-Command replay -ErrorAction SilentlyContinue) {
                Write-Success "@microsoft/bc-replay is available"
            }
            else {
                Write-Warning "@microsoft/bc-replay was installed, but the replay command is not available in PATH. Restart PowerShell and run prerequisites again if needed."
            }
        }
        else {
            Write-Warning "npm is not available. Restart PowerShell and run prerequisites again to install @microsoft/bc-replay."
        }
    }
    catch {
        Write-Error "Failed to install Node.js or @microsoft/bc-replay: $_"
        Write-Host "Try running: winget install -e --id OpenJS.NodeJS"
        Write-Host "Then run: npm install -g @microsoft/bc-replay@latest"
    }
}
else {
    Write-Host "Skipping Node.js and BC Replay installation (--SkipNode flag set)"
}

# ============================================================================
# 7. INSTALL BCCONTAINERHELPER MODULE
# ============================================================================
if (-not $SkipBcContainerHelper) {
    Write-Header "7. Installing or Updating BcContainerHelper PowerShell Module"
    
    try {
        Write-Host "Checking if BcContainerHelper is already installed..."
        $module = Get-Module -Name BcContainerHelper -ListAvailable -ErrorAction SilentlyContinue | Sort-Object -Property Version -Descending | Select-Object -First 1
        
        if ($module) {
            Write-Warning "BcContainerHelper already installed: v$($module.Version)"

            try {
                $latestModuleVersion = Get-LatestBcContainerHelperVersion
                Write-Host "Latest available BcContainerHelper: v$latestModuleVersion"

                if ([version]$module.Version -lt $latestModuleVersion) {
                    if (Confirm-Upgrade -Name "BcContainerHelper" -CurrentVersion "v$($module.Version)" -LatestVersion "v$latestModuleVersion") {
                        Write-Host "Updating BcContainerHelper..."
                        Update-Module -Name BcContainerHelper -Force
                        Write-Success "BcContainerHelper updated successfully"
                    }
                    else {
                        Write-Host "Skipping BcContainerHelper update"
                    }
                }
                else {
                    Write-Success "BcContainerHelper is up to date"
                }
            }
            catch {
                Write-Warning "Could not determine latest BcContainerHelper version: $_"
            }
        }
        else {
            Write-Host "Installing BcContainerHelper..."
            Install-Module -Name BcContainerHelper -Force -Scope AllUsers
            
            if (Get-Module -Name BcContainerHelper -ListAvailable -ErrorAction SilentlyContinue) {
                Write-Success "BcContainerHelper installed successfully"
            }
            else {
                throw "Installation completed but module not found"
            }
        }
    }
    catch {
        Write-Error "Failed to install BcContainerHelper: $_"
        Write-Host "Try running: Install-Module BcContainerHelper -force"
        Write-Host "If PowerShell Gallery is unavailable, use the alternative script:"
        Write-Host "https://github.com/BusinessCentralApps/HelloWorld/blob/master/scripts/Install-BcContainerHelper.ps1"
    }
}
else {
    Write-Host "Skipping BcContainerHelper installation (--SkipBcContainerHelper flag set)"
}

# ============================================================================
# SUMMARY
# ============================================================================
Write-Header "Installation Summary"

Write-Host @"
Prerequisites installation/update complete!

Next steps:
1. Review the configuration in: $DockerPath\daemon.json
2. Restart your computer for Windows features to take effect
3. After restart, Docker service should start automatically
4. Restart PowerShell to use git commands
5. Restart PowerShell to use node/npm commands if Node.js was installed or updated
6. Review the BC-Dev-Toolset README.md for additional configuration

For troubleshooting, see:
- Docker Engine: https://download.docker.com/win/static/stable/x86_64/
- BcContainerHelper: https://github.com/microsoft/navcontainerhelper
"@

Write-Success "`nPrerequisites installation/update script completed!"

Read-Host -Prompt 'Press Enter to close this window and finish the script' | Out-Null
