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
    - .NET SDK and MSDyn365BC.AL.Runner for standalone AL tests
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
    [switch]$SkipNode,
    [switch]$SkipAlRunner
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

function Update-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $pathParts = @($machinePath, $userPath) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.TrimEnd(';') }
    $env:PATH = $pathParts -join ';'
}

function Confirm-Upgrade {
    param(
        [string]$Name,
        [string]$CurrentVersion,
        [string]$LatestVersion
    )

    do {
        $answer = Read-Host -Prompt "Update $Name from $CurrentVersion to ${LatestVersion}? [y/N]"
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
        (Join-Path $programFiles "Docker\Docker\Docker Desktop.exe")
        (Join-Path $programFiles "Docker\Docker\DockerCli.exe")
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

function ConvertTo-GitComparableVersion {
    param([Parameter(Mandatory)][string]$VersionText)

    # Git for Windows reports, for example, 2.55.0.windows.4 while the
    # release installer uses 2.55.0.4. Normalize both to System.Version.
    if ($VersionText -match '(?i)(?<base>[0-9]+\.[0-9]+\.[0-9]+)\.windows\.(?<revision>[0-9]+)') {
        return [version]"$($matches.base).$($matches.revision)"
    }

    if ($VersionText -match '(?<![0-9])(?<version>[0-9]+\.[0-9]+(?:\.[0-9]+){0,2})(?![0-9.])') {
        return [version]$matches.version
    }

    return $null
}

function Get-GitInstalledVersion {
    $gitPath = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitPath) {
        return $null
    }

    $gitVersionOutput = & $gitPath.Source --version 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitVersionOutput)) {
        return $null
    }

    return ConvertTo-GitComparableVersion -VersionText ([string]$gitVersionOutput)
}

function Get-LatestGitForWindowsRelease {
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "64-bit" }
    $release = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" `
        -Headers @{ "User-Agent" = "BC-Dev-Toolset" } `
        -ErrorAction Stop
    $version = ConvertTo-GitComparableVersion -VersionText ([string]$release.tag_name)
    if (-not $version) {
        throw "Could not parse Git for Windows release version '$($release.tag_name)'."
    }

    $installerAsset = $release.assets |
        Where-Object { $_.name -match "^Git-[0-9].*-$architecture\.exe$" } |
        Select-Object -First 1
    if (-not $installerAsset) {
        throw "Could not find the Git for Windows $architecture installer in the latest release."
    }

    return [PSCustomObject]@{
        Version      = $version
        TagName      = [string]$release.tag_name
        InstallerUrl = [string]$installerAsset.browser_download_url
    }
}

function Install-Git {
    param(
        [bool]$IsUpgrade,
        [Parameter(Mandatory)]$Release
    )

    $action = if ($IsUpgrade) { "Updating" } else { "Installing" }
    Write-Host "$action Git for Windows from the official release..."

    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    $installerPath = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot "bc-dev-toolset-git-installer.exe"))
    if ([System.IO.Path]::GetDirectoryName($installerPath) -ne $temporaryRoot) {
        throw "The temporary Git installer path escaped the operating system temporary directory."
    }

    try {
        Write-Host "Downloading Git for Windows from: $($Release.InstallerUrl)"
        Invoke-WebRequest -Uri $Release.InstallerUrl -OutFile $installerPath -UseBasicParsing -ErrorAction Stop
        $installerProcess = Start-Process -FilePath $installerPath -ArgumentList @(
            "/VERYSILENT",
            "/NORESTART",
            "/NOCANCEL",
            "/SP-"
        ) -Wait -PassThru -ErrorAction Stop
        if ($installerProcess.ExitCode -ne 0) {
            throw "The Git for Windows installer exited with code $($installerProcess.ExitCode)."
        }
    }
    finally {
        if (Test-Path -LiteralPath $installerPath -PathType Leaf) {
            Remove-Item -LiteralPath $installerPath -Force
        }
    }

    Update-ProcessPath
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

function Install-NodeJs24 {
    param([bool]$IsUpgrade)

    $wingetCommand = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCommand) {
        $wingetAction = if ($IsUpgrade) { "upgrade" } else { "install" }
        $wingetDescription = if ($IsUpgrade) { "Updating" } else { "Installing" }
        Write-Host "$wingetDescription Node.js via WinGet..."
        & $wingetCommand.Source $wingetAction -e --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -eq 0) {
            Update-ProcessPath
            return
        }

        Write-Warning "WinGet could not install Node.js (exit code $LASTEXITCODE). Trying the official Node.js installer."
    }
    else {
        Write-Warning "WinGet is not available. Using the official Node.js installer instead."
    }

    $nodeReleaseUrl = "https://nodejs.org/dist/latest-v24.x/"
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $releasePage = Invoke-WebRequest -Uri $nodeReleaseUrl -UseBasicParsing -ErrorAction Stop
    $installerLink = $releasePage.Links |
        Where-Object { (Split-Path $_.href -Leaf) -match "^node-v([0-9]+(?:\.[0-9]+)*)-$architecture\.msi$" } |
        ForEach-Object {
            $installerFileName = Split-Path $_.href -Leaf
            if ($installerFileName -match "^node-v([0-9]+(?:\.[0-9]+)*)-$architecture\.msi$") {
                [PSCustomObject]@{
                    FileName = $installerFileName
                    Url = [Uri]::new([Uri]$nodeReleaseUrl, $_.href).AbsoluteUri
                    Version = [version]$matches[1]
                }
            }
        } |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if (-not $installerLink) {
        throw "Could not find the Node.js 24 $architecture MSI on $nodeReleaseUrl"
    }

    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    $installerPath = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot "bc-dev-toolset-$($installerLink.FileName)"))
    if ([System.IO.Path]::GetDirectoryName($installerPath) -ne $temporaryRoot) {
        throw "The temporary Node.js installer path escaped the operating system temporary directory."
    }

    try {
        Write-Host "Downloading Node.js v$($installerLink.Version) from: $($installerLink.Url)"
        Invoke-WebRequest -Uri $installerLink.Url -OutFile $installerPath -UseBasicParsing -ErrorAction Stop
        $installerProcess = Start-Process -FilePath "msiexec.exe" -ArgumentList @(
            "/i",
            "`"$installerPath`"",
            "/qn",
            "/norestart"
        ) -Wait -PassThru -ErrorAction Stop

        if ($installerProcess.ExitCode -notin @(0, 1641, 3010)) {
            throw "The Node.js installer exited with code $($installerProcess.ExitCode)."
        }

        if ($installerProcess.ExitCode -in @(1641, 3010)) {
            Write-Warning "Node.js was installed and requires a system restart."
        }
    }
    finally {
        if (Test-Path -LiteralPath $installerPath -PathType Leaf) {
            Remove-Item -LiteralPath $installerPath -Force
        }
    }

    Update-ProcessPath
}

function Get-LatestBcContainerHelperVersion {
    $module = Find-Module -Name BcContainerHelper -ErrorAction Stop
    return [version]$module.Version
}

function Get-CompatibleDotNetSdkVersions {
    $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
    if (-not $dotnetCommand) {
        return @()
    }

    $sdkOutput = @(& $dotnetCommand.Source --list-sdks 2>$null)
    if ($LASTEXITCODE -ne 0) {
        return @()
    }

    return @($sdkOutput | ForEach-Object {
        if ([string]$_ -match '^(?<version>[0-9]+(?:\.[0-9]+){2,3})\s') {
            try { [version]$matches.version } catch { }
        }
    } | Where-Object { $_.Major -in @(9, 10) })
}

function Install-DotNetSdk10 {
    $wingetCommand = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCommand) {
        Write-Host 'Installing .NET SDK 10 via WinGet...'
        & $wingetCommand.Source install -e --id Microsoft.DotNet.SDK.10 --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -eq 0) {
            Update-ProcessPath
            return
        }

        Write-Warning "WinGet could not install .NET SDK 10 (exit code $LASTEXITCODE). Trying the official dotnet-install script."
    } else {
        Write-Warning 'WinGet is not available. Using the official dotnet-install script instead.'
    }

    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    $installerPath = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot 'bc-dev-toolset-dotnet-install.ps1'))
    if ([System.IO.Path]::GetDirectoryName($installerPath) -ne $temporaryRoot) {
        throw 'The temporary .NET installer path escaped the operating system temporary directory.'
    }

    $dotnetInstallPath = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'dotnet'
    try {
        Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installerPath -UseBasicParsing -ErrorAction Stop
        & $installerPath -Channel '10.0' -InstallDir $dotnetInstallPath -NoPath
        if ($LASTEXITCODE -ne 0) {
            throw "dotnet-install.ps1 exited with code $LASTEXITCODE."
        }
    } finally {
        if (Test-Path -LiteralPath $installerPath -PathType Leaf) {
            Remove-Item -LiteralPath $installerPath -Force
        }
    }

    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $machinePathEntries = @($machinePath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($machinePathEntries -notcontains $dotnetInstallPath) {
        [Environment]::SetEnvironmentVariable('PATH', (($machinePathEntries + $dotnetInstallPath) -join ';'), 'Machine')
    }
    Update-ProcessPath
}

function Install-OrUpdateAlRunner {
    $dotnetCommand = Get-Command dotnet -ErrorAction Stop
    $installedTools = @(& $dotnetCommand.Source tool list --global 2>$null)
    $runnerInstalled = $LASTEXITCODE -eq 0 -and ($installedTools -match '(?im)^msdyn365bc\.al\.runner\s+')
    $toolAction = if ($runnerInstalled) { 'update' } else { 'install' }
    $actionDescription = if ($runnerInstalled) { 'Updating' } else { 'Installing' }

    Write-Host "$actionDescription MSDyn365BC.AL.Runner as a global .NET tool..."
    & $dotnetCommand.Source tool $toolAction --global MSDyn365BC.AL.Runner
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet tool $toolAction failed for MSDyn365BC.AL.Runner (exit code $LASTEXITCODE)."
    }

    $globalToolPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dotnet\tools'
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $userPathEntries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($userPathEntries -notcontains $globalToolPath) {
        [Environment]::SetEnvironmentVariable('PATH', (($userPathEntries + $globalToolPath) -join ';'), 'User')
    }
    Update-ProcessPath
}

function Get-AlRunnerApplicationControlEvent {
    param([Parameter(Mandatory=$true)] [datetime] $StartTime)

    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $event = Get-WinEvent -FilterHashtable @{
                LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
                # Code Integrity event timestamps have coarser precision than Get-Date.
                StartTime = $StartTime.AddSeconds(-5)
            } -ErrorAction Stop |
                Where-Object {
                    $_.Id -in @(3033, 3077) -and
                    $_.Message -match '(?i)al-runner(?:\.dll|\.exe)?'
                } |
                Select-Object -First 1
            if ($event) { return $event }
        } catch { }

        Start-Sleep -Milliseconds 200
    }

    return $null
}

function Test-AlRunnerLaunch {
    $runnerCommand = Get-Command al-runner -ErrorAction Stop
    $launchStartedAt = Get-Date
    & $runnerCommand.Source --help *> $null
    $launchExitCode = $LASTEXITCODE
    if ($launchExitCode -in @(0, 1, 2, 3)) {
        return
    }

    $applicationControlEvent = Get-AlRunnerApplicationControlEvent -StartTime $launchStartedAt
    if ($applicationControlEvent) {
        throw "Windows Smart App Control or another Code Integrity policy blocked the upstream AL Runner payload (event $($applicationControlEvent.Id)). BC Dev Toolset will not disable or bypass application-control policy. Use a signed AL Runner release when one is available, or report the unsigned published binary to https://github.com/StefanMaron/BusinessCentral.AL.Runner."
    }

    throw "AL Runner was installed but could not start (exit code $launchExitCode)."
}

# Verify admin privileges
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

Write-Header "BC Dev Toolset Prerequisites Installation"
$installationFailures = [System.Collections.Generic.List[string]]::new()

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
        $installationFailures.Add("Docker Engine installation")
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
$windowsFeaturesReady = $true
if (-not $SkipWindowsFeatures) {
    Write-Header "2. Enabling Windows Features"

    function Test-IsWindowsServer {
        $operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $installationType = [string](Get-ItemPropertyValue `
            -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" `
            -Name "InstallationType" `
            -ErrorAction SilentlyContinue)
        $isServer = [int]$operatingSystem.ProductType -in @(2, 3) -or
            [string]$operatingSystem.Caption -match "Windows Server" -or
            $installationType -match "Server"

        $platformDescription = if ($isServer) { "Windows Server" } else { "Windows client" }
        Write-Host "Detected ${platformDescription}: $($operatingSystem.Caption) (ProductType $($operatingSystem.ProductType), InstallationType '$installationType')"
        return $isServer
    }

    function Enable-ServerFeatureNonInteractive {
        param([string]$FeatureName)

        $getWindowsFeatureCommand = Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue
        $installWindowsFeatureCommand = Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue
        if (-not $getWindowsFeatureCommand -or -not $installWindowsFeatureCommand) {
            throw "Windows Server feature management cmdlets are unavailable. Install or enable the ServerManager PowerShell module."
        }

        $feature = Get-WindowsFeature -Name $FeatureName -ErrorAction Stop
        if (-not $feature) {
            throw "Windows Server feature '$FeatureName' is not available on this operating system."
        }

        if ($feature.InstallState -eq "Installed") {
            Write-Success "Feature '$FeatureName' is already enabled"
            return
        }

        Write-Host "Enabling Windows Server feature: $FeatureName..."
        Write-Host "This may take several minutes. Please wait."
        $featureResult = Install-WindowsFeature -Name $FeatureName -IncludeAllSubFeature -IncludeManagementTools -ErrorAction Stop
        if (-not $featureResult.Success) {
            throw "Windows Server feature '$FeatureName' did not install successfully. Exit code: $($featureResult.ExitCode)"
        }

        if ($featureResult.RestartNeeded -eq "Yes") {
            Write-Warning "Feature '$FeatureName' enabled; a system restart is required"
        }
        else {
            Write-Success "Feature '$FeatureName' enabled"
        }
    }
    
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
        $dismExitCode = $LASTEXITCODE
        if ($dismExitCode -in @(0, 3010)) {
            if ($dismExitCode -eq 3010) {
                Write-Warning "Feature '$FeatureName' enabled; a system restart is required"
            }
            else {
                Write-Success "Feature '$FeatureName' enabled"
            }
            return $true
        }

        Write-Warning "DISM failed to enable feature '$FeatureName' (exit code $dismExitCode). Falling back to Enable-WindowsOptionalFeature."
        Write-Host $dismOutput

        $featureResult = Enable-WindowsOptionalFeature -Online -FeatureName $FeatureName -All -NoRestart -ErrorAction Stop
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
        if (Test-IsWindowsServer) {
            foreach ($feature in @("Containers", "Hyper-V")) {
                Enable-ServerFeatureNonInteractive -FeatureName $feature
            }
        }
        else {
            foreach ($feature in @("Containers", "Microsoft-Hyper-V-All")) {
                if (Test-WindowsFeatureEnabled -FeatureName $feature) {
                    Write-Success "Feature '$feature' is already enabled"
                }
                else {
                    Enable-FeatureNonInteractive -FeatureName $feature | Out-Null
                }
            }
        }

        Write-Warning "You may need to restart your computer for changes to take effect"
    }
    catch {
        $windowsFeaturesReady = $false
        $installationFailures.Add("Windows feature enablement")
        Write-Error "Failed to enable Windows features: $_"
    }
}
else {
    Write-Host "Skipping Windows Features (--SkipWindowsFeatures flag set)"
}

if (-not $windowsFeaturesReady) {
    Write-Error "Required Windows container features could not be enabled. Remaining prerequisite installation steps will be skipped."
    Write-Warning "Any prerequisites from an earlier run remain installed unless you choose the guarded cleanup flow."

    $cleanupAnswer = Read-Host -Prompt "Open the Uninstall prerequisites flow now? [y/N]"
    if ($cleanupAnswer -match '^(?i:y|yes)$') {
        $uninstallScript = Join-Path $PSScriptRoot "uninstallPrerequisites.ps1"
        if (Test-Path -LiteralPath $uninstallScript -PathType Leaf) {
            & $uninstallScript -DockerPath $DockerPath -NoPause
        }
        else {
            Write-Error "Uninstall prerequisites script was not found at '$uninstallScript'."
        }
    }

    Read-Host -Prompt 'Press Enter to close this window and finish the script' | Out-Null
    exit 1
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
        $installationFailures.Add("Docker PATH configuration")
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
            if (-not $existingService) {
                # Create the service
                $binaryPath = "$dockerdPath --run-service --config-file $daemonJsonPath"
                New-Service -Name "Docker" `
                    -BinaryPathName $binaryPath `
                    -DisplayName "Docker Engine" `
                    -StartupType "Automatic" | Out-Null
                
                Write-Success "Docker service created"
            }
            else {
                Write-Warning "Docker service already exists, skipping creation"
            }

            $dockerService = Get-Service -Name "Docker" -ErrorAction Stop
            if ($dockerService.Status -ne "Running") {
                try {
                    Start-Service -Name "Docker" -ErrorAction Stop
                    $dockerService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
                    $dockerService.Refresh()
                    if ($dockerService.Status -ne "Running") {
                        throw "Docker service did not reach the Running state."
                    }

                    Write-Success "Docker service started"
                }
                catch {
                    Write-Warning "Docker service is installed but could not start. Restart Windows to finish enabling the container features, then start the Docker service. $($_.Exception.Message)"
                }
            }
            else {
                Write-Success "Docker service started"
            }
        }
    }
    catch {
        $installationFailures.Add("Docker service installation")
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
        $latestGitRelease = Get-LatestGitForWindowsRelease

        if ($gitVersion) {
            Write-Warning "Git already installed: v$gitVersion"
            Write-Host "Latest official Git for Windows: v$($latestGitRelease.Version)"

            if ($gitVersion -lt $latestGitRelease.Version) {
                if (Confirm-Upgrade -Name "Git" -CurrentVersion "v$gitVersion" -LatestVersion "v$($latestGitRelease.Version)") {
                    Install-Git -IsUpgrade $true -Release $latestGitRelease
                    $updatedGitVersion = Get-GitInstalledVersion
                    if ($updatedGitVersion -and $updatedGitVersion -ge $latestGitRelease.Version) {
                        Write-Success "Git updated successfully: v$updatedGitVersion"
                    }
                    else {
                        Write-Warning "Git was updated, but the new version may require restarting PowerShell before it is detected."
                    }
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
            Install-Git -IsUpgrade $false -Release $latestGitRelease
            
            # Verify installation
            $installedGitVersion = Get-GitInstalledVersion
            if ($installedGitVersion) {
                Write-Success "Git installed successfully: v$installedGitVersion"
            }
            else {
                throw "Git installation completed, but git.exe was not found in PATH. Restart PowerShell and verify the installation."
            }
        }
    }
    catch {
        $installationFailures.Add("Git installation")
        Write-Error "Failed to install Git: $_"
        Write-Host "Install Git manually from https://gitforwindows.org/ if automatic installation continues to fail."
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

            Install-NodeJs24 -IsUpgrade ($null -ne $nodeVersion)

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
            & npm install -g @microsoft/bc-replay@latest
            if ($LASTEXITCODE -ne 0) {
                throw "npm failed to install @microsoft/bc-replay (exit code $LASTEXITCODE)."
            }
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
        $installationFailures.Add("Node.js or BC Replay installation")
        Write-Error "Failed to install Node.js or @microsoft/bc-replay: $_"
        Write-Host "Install Node.js 24 or newer from https://nodejs.org/ if automatic installation continues to fail."
        Write-Host "Then run: npm install -g @microsoft/bc-replay@latest"
    }
}
else {
    Write-Host "Skipping Node.js and BC Replay installation (--SkipNode flag set)"
}

# ============================================================================
# 7. INSTALL .NET SDK AND AL RUNNER
# ============================================================================
if (-not $SkipAlRunner) {
    Write-Header '7. Installing or Updating .NET SDK and AL Runner'

    try {
        $compatibleSdkVersions = @(Get-CompatibleDotNetSdkVersions)
        if ($compatibleSdkVersions.Count -eq 0) {
            Write-Warning '.NET SDK 9 or 10 is not installed or not available in PATH.'
            Install-DotNetSdk10
            $compatibleSdkVersions = @(Get-CompatibleDotNetSdkVersions)
        }

        if ($compatibleSdkVersions.Count -eq 0) {
            throw '.NET SDK 9 or 10 could not be found after installation. Restart PowerShell and run prerequisites again.'
        }

        $latestCompatibleSdk = $compatibleSdkVersions | Sort-Object -Descending | Select-Object -First 1
        Write-Success "Compatible .NET SDK is available: v$latestCompatibleSdk"
        Install-OrUpdateAlRunner

        if (Get-Command al-runner -ErrorAction SilentlyContinue) {
            Test-AlRunnerLaunch
            Write-Success 'MSDyn365BC.AL.Runner is available'
        } else {
            Write-Warning "MSDyn365BC.AL.Runner was installed, but 'al-runner' is not available in PATH. Restart PowerShell and run prerequisites again if needed."
        }
    } catch {
        $installationFailures.Add('.NET SDK or AL Runner installation')
        Write-Error "Failed to install .NET SDK or MSDyn365BC.AL.Runner: $_"
        Write-Host 'Install .NET SDK 9 or 10 from https://dotnet.microsoft.com/download if automatic installation continues to fail.'
        Write-Host 'Then run: dotnet tool install --global MSDyn365BC.AL.Runner'
    }
} else {
    Write-Host 'Skipping .NET SDK and AL Runner installation (--SkipAlRunner flag set)'
}

# ============================================================================
# 8. INSTALL BCCONTAINERHELPER MODULE
# ============================================================================
if (-not $SkipBcContainerHelper) {
    Write-Header "8. Installing or Updating BcContainerHelper PowerShell Module"
    
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
        $installationFailures.Add("BcContainerHelper installation")
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

if ($installationFailures.Count -eq 0) {
    Write-Success "Prerequisites installation/update pass completed without errors."
}
else {
    Write-Error "Prerequisites installation/update pass finished with $($installationFailures.Count) error(s):"
    foreach ($installationFailure in $installationFailures) {
        Write-Host "- $installationFailure" -ForegroundColor $colors.Error
    }
}

Write-Host @"
Next steps:
1. Review the configuration in: $DockerPath\daemon.json
2. Restart your computer for Windows features to take effect
3. After restart, Docker service should start automatically
4. Restart PowerShell to use git commands
5. Restart PowerShell to use node/npm commands if Node.js was installed or updated
6. Restart PowerShell to use dotnet/al-runner commands if .NET SDK or AL Runner was installed or updated
7. Review the BC-Dev-Toolset README.md for additional configuration

For troubleshooting, see:
- Docker Engine: https://download.docker.com/win/static/stable/x86_64/
- BcContainerHelper: https://github.com/microsoft/navcontainerhelper
"@

Read-Host -Prompt 'Press Enter to close this window and finish the script' | Out-Null

if ($installationFailures.Count -gt 0) {
    exit 1
}
