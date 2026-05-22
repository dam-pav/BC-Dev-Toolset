#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Automates the installation of BC Dev Toolset prerequisites
.DESCRIPTION
    This script installs and configures:
    - Docker Engine (latest version)
    - Windows Features (Containers, Hyper-V)
    - Git
    - BcContainerHelper PowerShell Module
.NOTES
    Requires Administrator privileges
    Requires Windows Pro or Enterprise edition for Hyper-V
#>

param(
    [string]$DockerPath = "c:\docker",
    [switch]$SkipDockerInstall,
    [switch]$SkipWindowsFeatures,
    [switch]$SkipGit,
    [switch]$SkipBcContainerHelper
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

# Verify admin privileges
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

Write-Header "BC Dev Toolset Prerequisites Installation"

# ============================================================================
# 1. DOCKER ENGINE INSTALLATION
# ============================================================================
if (-not $SkipDockerInstall) {
    Write-Header "1. Installing Docker Engine"
    
    try {
        # Create docker directory if it doesn't exist
        if (-not (Test-Path $DockerPath)) {
            Write-Host "Creating directory: $DockerPath"
            New-Item -ItemType Directory -Path $DockerPath -Force | Out-Null
            Write-Success "Directory created"
        }

        # Fetch latest Docker Engine release
        Write-Host "Fetching latest Docker Engine release..."
        $releasesUrl = "https://download.docker.com/win/static/stable/x86_64/"
        
        # Get list of available releases using curl/Invoke-WebRequest
        try {
            $response = Invoke-WebRequest -Uri $releasesUrl -UseBasicParsing
            $links = $response.Links | Where-Object { $_.href -match "\.zip$" }
            
            if ($links.Count -eq 0) {
                throw "No Docker Engine releases found"
            }

            $downloads = $links | ForEach-Object {
                $href = $_.href
                if ($href -match 'docker-([0-9]+(?:\.[0-9]+)*)(?:-[^/]+)?\.zip$') {
                    [PSCustomObject]@{
                        Link = $_
                        Version = [version]$matches[1]
                    }
                }
            }

            if (-not $downloads) {
                throw "No valid Docker Engine release versions found"
            }

            $latestRelease = $downloads | Sort-Object -Property Version -Descending | Select-Object -First 1 | Select-Object -ExpandProperty Link

            $downloadUrl = $releasesUrl + $latestRelease.href
            $fileName = Split-Path $downloadUrl -Leaf
            $downloadPath = Join-Path $DockerPath $fileName

            Write-Host "Latest release: $fileName"
            Write-Host "Downloading from: $downloadUrl"

            # Download Docker Engine
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $downloadUrl -OutFile $downloadPath
            $ProgressPreference = 'Continue'

            if (Test-Path $downloadPath) {
                Write-Success "Docker Engine downloaded to: $downloadPath"

                # Extract the zip file to a temporary location
                Write-Host "Extracting Docker Engine..."
                $tempExtractPath = Join-Path $env:TEMP "docker-extract-$([System.IO.Path]::GetRandomFileName())"
                New-Item -ItemType Directory -Path $tempExtractPath -Force | Out-Null
                
                Expand-Archive -Path $downloadPath -DestinationPath $tempExtractPath -Force
                
                # Move extracted files to target directory
                # The zip contains a 'docker' folder, so we move its contents to $DockerPath
                $extractedDockerPath = Join-Path $tempExtractPath "docker"
                if (Test-Path $extractedDockerPath) {
                    Get-ChildItem -Path $extractedDockerPath | ForEach-Object {
                        Move-Item -Path $_.FullName -Destination $DockerPath -Force
                    }
                }
                else {
                    # If no 'docker' subfolder, move everything from temp
                    Get-ChildItem -Path $tempExtractPath | ForEach-Object {
                        Move-Item -Path $_.FullName -Destination $DockerPath -Force
                    }
                }
                
                # Cleanup
                Remove-Item $tempExtractPath -Force -Recurse
                Remove-Item $downloadPath -Force
                Write-Success "Docker Engine extracted to: $DockerPath"

                # Create daemon.json configuration
                $daemonJsonPath = Join-Path $DockerPath "daemon.json"
                $daemonConfig = @{
                    "group" = "Users"
                } | ConvertTo-Json

                $daemonConfig | Out-File -FilePath $daemonJsonPath -Encoding UTF8
                Write-Success "Created daemon.json configuration at: $daemonJsonPath"
            }
            else {
                throw "Failed to download Docker Engine"
            }
        }
        catch {
            Write-Error "Failed to fetch Docker releases: $_"
            Write-Host "You can manually download from: https://download.docker.com/win/static/stable/x86_64/"
        }
    }
    catch {
        Write-Error "Docker installation failed: $_"
    }
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

    try {
        $features = @("Containers", "Microsoft-Hyper-V-All")

        foreach ($feature in $features) {
            Enable-FeatureNonInteractive -FeatureName $feature | Out-Null
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

# ============================================================================
# 4. INSTALL DOCKER SERVICE
# ============================================================================
if (-not $SkipDockerInstall) {
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

# ============================================================================
# 5. INSTALL GIT
# ============================================================================
if (-not $SkipGit) {
    Write-Header "5. Installing Git"
    
    try {
        # Check if git is already installed
        $gitPath = Get-Command git -ErrorAction SilentlyContinue
        if ($gitPath) {
            $gitVersion = git --version
            Write-Warning "Git already installed: $gitVersion"
        }
        else {
            Write-Host "Installing Git via WinGet..."
            & winget install -e --id Git.Git
            
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
# 6. INSTALL BCCONTAINERHELPER MODULE
# ============================================================================
if (-not $SkipBcContainerHelper) {
    Write-Header "6. Installing BcContainerHelper PowerShell Module"
    
    try {
        Write-Host "Checking if BcContainerHelper is already installed..."
        $module = Get-Module -Name BcContainerHelper -ListAvailable -ErrorAction SilentlyContinue
        
        if ($module) {
            Write-Warning "BcContainerHelper already installed: v$($module.Version)"
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
Prerequisites installation complete!

Next steps:
1. Review the configuration in: $DockerPath\daemon.json
2. Restart your computer for Windows features to take effect
3. After restart, Docker service should start automatically
4. Restart PowerShell to use git commands
5. Review the BC-Dev-Toolset README.md for additional configuration

For troubleshooting, see:
- Docker Engine: https://download.docker.com/win/static/stable/x86_64/
- BcContainerHelper: https://github.com/microsoft/navcontainerhelper
"@

Write-Success "`nPrerequisites installation script completed!"

Read-Host -Prompt 'Press Enter to close this window and finish the script' | Out-Null
