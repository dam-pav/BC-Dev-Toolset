#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Interactively removes BC Dev Toolset prerequisites.
.DESCRIPTION
    Detects each prerequisite and asks for explicit confirmation before removing it.
    No component is removed by default.
#>

param(
    [string]$DockerPath = "c:\docker",
    [switch]$NoPause
)

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

function Confirm-Uninstall {
    param(
        [string]$Component,
        [string]$Impact
    )

    if (-not [string]::IsNullOrWhiteSpace($Impact)) {
        Write-Warning $Impact
    }

    do {
        $answer = Read-Host -Prompt "Uninstall ${Component}? [y/N]"
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $false
        }
    } while ($answer -notmatch '^(?i:y|yes|n|no)$')

    return $answer -match '^(?i:y|yes)$'
}

function Add-RemovalFailure {
    param(
        [System.Collections.Generic.List[string]]$Failures,
        [string]$Component,
        [System.Management.Automation.ErrorRecord]$Failure
    )

    $Failures.Add($Component)
    Write-Error "Failed to uninstall ${Component}: $($Failure.Exception.Message)"
}

function Get-UninstallRegistryEntry {
    param([string]$DisplayNamePattern)

    $registryPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )

    return Get-ItemProperty -Path $registryPaths -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.DisplayName -match $DisplayNamePattern } |
        Select-Object -First 1
}

function Invoke-RegisteredUninstaller {
    param(
        [Parameter(Mandatory=$true)]$RegistryEntry,
        [Parameter(Mandatory=$true)][string]$Component
    )

    $productCode = if ([string]$RegistryEntry.PSChildName -match '^\{[0-9A-F-]+\}$') {
        [string]$RegistryEntry.PSChildName
    } elseif ([string]$RegistryEntry.UninstallString -match '(\{[0-9A-F-]+\})') {
        $matches[1]
    } else {
        $null
    }

    if ($productCode) {
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @(
            "/x",
            $productCode,
            "/qn",
            "/norestart"
        ) -Wait -PassThru -ErrorAction Stop
    }
    else {
        $uninstallCommand = if (-not [string]::IsNullOrWhiteSpace([string]$RegistryEntry.QuietUninstallString)) {
            [string]$RegistryEntry.QuietUninstallString
        } else {
            [string]$RegistryEntry.UninstallString
        }

        if ($uninstallCommand -match '^"([^"]+)"\s*(.*)$') {
            $uninstallerPath = $matches[1]
            $uninstallerArguments = $matches[2]
        } elseif ($uninstallCommand -match '^(\S+)\s*(.*)$') {
            $uninstallerPath = $matches[1]
            $uninstallerArguments = $matches[2]
        } else {
            throw "No usable registered uninstaller was found for $Component."
        }

        $validatedUninstaller = if ([System.IO.Path]::IsPathRooted($uninstallerPath)) {
            [System.IO.Path]::GetFullPath($uninstallerPath)
        } else {
            $resolvedCommand = Get-Command $uninstallerPath -ErrorAction Stop
            [System.IO.Path]::GetFullPath($resolvedCommand.Source)
        }
        if (-not (Test-Path -LiteralPath $validatedUninstaller -PathType Leaf)) {
            throw "Registered uninstaller was not found at '$validatedUninstaller'."
        }

        if ([string]$RegistryEntry.DisplayName -match '^Git') {
            $uninstallerArguments = "/VERYSILENT /NORESTART /NOCANCEL /SP-"
        }

        $process = Start-Process -FilePath $validatedUninstaller -ArgumentList $uninstallerArguments -Wait -PassThru -ErrorAction Stop
    }

    if ($process.ExitCode -notin @(0, 1641, 3010)) {
        throw "$Component uninstaller exited with code $($process.ExitCode)."
    }
    if ($process.ExitCode -in @(1641, 3010)) {
        Write-Warning "$Component was removed and requires a system restart."
    }
}

function Get-ValidatedDockerPath {
    param([string]$ConfiguredPath)

    if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        throw "Docker path cannot be empty."
    }

    $validatedPath = [System.IO.Path]::GetFullPath($ConfiguredPath).TrimEnd('\')
    $pathRoot = [System.IO.Path]::GetPathRoot($validatedPath).TrimEnd('\')
    if ($validatedPath -eq $pathRoot) {
        throw "Refusing to remove a drive root as the Docker path."
    }

    $protectedPaths = @(
        $env:windir,
        [Environment]::GetFolderPath("ProgramFiles"),
        [Environment]::GetFolderPath("ProgramFilesX86"),
        [Environment]::GetFolderPath("UserProfile"),
        [Environment]::GetFolderPath("CommonApplicationData")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\') }
    if ($protectedPaths -contains $validatedPath) {
        throw "Refusing to remove protected path '$validatedPath'."
    }

    return $validatedPath
}

function Remove-DockerEngine {
    param([string]$ConfiguredDockerPath)

    $validatedDockerPath = Get-ValidatedDockerPath -ConfiguredPath $ConfiguredDockerPath
    if (Test-Path -LiteralPath $validatedDockerPath -PathType Container) {
        $dockerMarkerPresent = (Test-Path -LiteralPath (Join-Path $validatedDockerPath "dockerd.exe") -PathType Leaf) -or
            (Test-Path -LiteralPath (Join-Path $validatedDockerPath "docker.exe") -PathType Leaf) -or
            (Test-Path -LiteralPath (Join-Path $validatedDockerPath "daemon.json") -PathType Leaf)
        if (-not $dockerMarkerPresent) {
            throw "Refusing to remove '$validatedDockerPath' because it does not look like a Docker Engine installation."
        }
    }

    $dockerService = Get-Service -Name "Docker" -ErrorAction SilentlyContinue
    if ($dockerService) {
        if ($dockerService.Status -ne "Stopped") {
            Stop-Service -Name "Docker" -Force -ErrorAction Stop
            $dockerService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
        }
        & sc.exe delete Docker | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Service Control Manager could not delete the Docker service (exit code $LASTEXITCODE)."
        }
    }

    if (Test-Path -LiteralPath $validatedDockerPath -PathType Container) {
        # The configured path was normalized, checked against protected roots, and verified by Docker marker files.
        Remove-Item -LiteralPath $validatedDockerPath -Recurse -Force
    }

    $machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $remainingPathEntries = @($machinePath -split ';' | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and
        [System.IO.Path]::GetFullPath($_.Trim()) -ne $validatedDockerPath
    })
    [Environment]::SetEnvironmentVariable("PATH", ($remainingPathEntries -join ';'), "Machine")
}

function Test-IsWindowsServer {
    $operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $installationType = [string](Get-ItemPropertyValue `
        -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" `
        -Name "InstallationType" `
        -ErrorAction SilentlyContinue)
    return [int]$operatingSystem.ProductType -in @(2, 3) -or
        [string]$operatingSystem.Caption -match "Windows Server" -or
        $installationType -match "Server"
}

function Get-WindowsFeatureRemovalCandidates {
    if (Test-IsWindowsServer) {
        if (-not (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue) -or
            -not (Get-Command Uninstall-WindowsFeature -ErrorAction SilentlyContinue)) {
            throw "Windows Server feature management cmdlets are unavailable."
        }

        return @("Containers", "Hyper-V") | ForEach-Object {
            $feature = Get-WindowsFeature -Name $_ -ErrorAction SilentlyContinue
            if ($feature -and $feature.InstallState -eq "Installed") {
                [PSCustomObject]@{ Name = $_; Server = $true }
            }
        }
    }

    return @("Containers", "Microsoft-Hyper-V-All") | ForEach-Object {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $_ -ErrorAction SilentlyContinue
        if ($feature -and $feature.State -eq "Enabled") {
            [PSCustomObject]@{ Name = $_; Server = $false }
        }
    }
}

function Remove-WindowsFeature {
    param($Feature)

    if ($Feature.Server) {
        $arguments = @{ Name = $Feature.Name; ErrorAction = "Stop" }
        if ($Feature.Name -eq "Hyper-V") {
            $arguments.IncludeManagementTools = $true
        }
        $result = Uninstall-WindowsFeature @arguments
        if (-not $result.Success) {
            throw "Windows Server feature '$($Feature.Name)' was not removed successfully."
        }
        if ($result.RestartNeeded -eq "Yes") {
            Write-Warning "Feature '$($Feature.Name)' was removed and requires a system restart."
        }
    }
    else {
        $result = Disable-WindowsOptionalFeature -Online -FeatureName $Feature.Name -NoRestart -ErrorAction Stop
        if ($result.RestartNeeded) {
            Write-Warning "Feature '$($Feature.Name)' was removed and requires a system restart."
        }
    }
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

Write-Header "BC Dev Toolset Prerequisites Uninstallation"
Write-Warning "Each detected component is optional. Press Enter or answer No to keep it installed."
$removalFailures = [System.Collections.Generic.List[string]]::new()
$removedComponents = [System.Collections.Generic.List[string]]::new()

$dockerPathCandidate = Get-ValidatedDockerPath -ConfiguredPath $DockerPath
$dockerPresent = (Get-Service -Name "Docker" -ErrorAction SilentlyContinue) -or
    (Test-Path -LiteralPath (Join-Path $dockerPathCandidate "dockerd.exe") -PathType Leaf) -or
    (Test-Path -LiteralPath (Join-Path $dockerPathCandidate "docker.exe") -PathType Leaf)
if ($dockerPresent -and (Confirm-Uninstall -Component "Docker Engine" -Impact "This removes the Docker service, '$dockerPathCandidate', and its system PATH entry. Docker Desktop is not removed.")) {
    try {
        Remove-DockerEngine -ConfiguredDockerPath $dockerPathCandidate
        $removedComponents.Add("Docker Engine")
        Write-Success "Docker Engine removed"
    }
    catch { Add-RemovalFailure -Failures $removalFailures -Component "Docker Engine" -Failure $_ }
}

$bcReplayCommand = Get-Command replay -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
$bcReplayInstalled = $false
if ($npmCommand) {
    & $npmCommand.Source list -g @microsoft/bc-replay --depth=0 *> $null
    $bcReplayInstalled = $LASTEXITCODE -eq 0
}
if (($bcReplayCommand -or $bcReplayInstalled) -and $npmCommand -and
    (Confirm-Uninstall -Component "@microsoft/bc-replay" -Impact "Page script replay commands will no longer be available.")) {
    try {
        & $npmCommand.Source uninstall -g @microsoft/bc-replay
        if ($LASTEXITCODE -ne 0) { throw "npm exited with code $LASTEXITCODE." }
        $removedComponents.Add("@microsoft/bc-replay")
        Write-Success "@microsoft/bc-replay removed"
    }
    catch { Add-RemovalFailure -Failures $removalFailures -Component "@microsoft/bc-replay" -Failure $_ }
}

$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
$alRunnerInstalled = $false
if ($dotnetCommand) {
    $globalDotNetTools = @(& $dotnetCommand.Source tool list --global 2>$null)
    $alRunnerInstalled = $LASTEXITCODE -eq 0 -and ($globalDotNetTools -match '(?im)^msdyn365bc\.al\.runner\s+')
}
if ($alRunnerInstalled -and
    (Confirm-Uninstall -Component "MSDyn365BC.AL.Runner" -Impact "The standalone AL Runner Test operation will no longer work. The shared .NET SDK is kept installed.")) {
    try {
        & $dotnetCommand.Source tool uninstall --global MSDyn365BC.AL.Runner
        if ($LASTEXITCODE -ne 0) { throw "dotnet exited with code $LASTEXITCODE." }
        $removedComponents.Add("MSDyn365BC.AL.Runner")
        Write-Success "MSDyn365BC.AL.Runner removed"
    }
    catch { Add-RemovalFailure -Failures $removalFailures -Component "MSDyn365BC.AL.Runner" -Failure $_ }
}

$nodeEntry = Get-UninstallRegistryEntry -DisplayNamePattern '^Node\.js(?:\s|$)'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (($nodeEntry -or $nodeCommand) -and (Confirm-Uninstall -Component "Node.js" -Impact "Other applications may depend on Node.js and npm.")) {
    try {
        if (-not $nodeEntry) { throw "Node.js is available, but its registered uninstaller could not be found." }
        Invoke-RegisteredUninstaller -RegistryEntry $nodeEntry -Component "Node.js"
        $removedComponents.Add("Node.js")
        Write-Success "Node.js removed"
    }
    catch { Add-RemovalFailure -Failures $removalFailures -Component "Node.js" -Failure $_ }
}

$gitEntry = Get-UninstallRegistryEntry -DisplayNamePattern '^(?:Git version [0-9]|Git for Windows(?:\s|$)|Git$)'
if (((Get-Command git -ErrorAction SilentlyContinue) -or $gitEntry) -and
    (Confirm-Uninstall -Component "Git" -Impact "Source-control commands used by this and other projects will no longer be available.")) {
    try {
        if (-not $gitEntry) { throw "Git is available, but its registered uninstaller could not be found." }
        Invoke-RegisteredUninstaller -RegistryEntry $gitEntry -Component "Git"
        $removedComponents.Add("Git")
        Write-Success "Git removed"
    }
    catch { Add-RemovalFailure -Failures $removalFailures -Component "Git" -Failure $_ }
}

$bcContainerHelperModules = @(Get-Module -Name BcContainerHelper -ListAvailable -ErrorAction SilentlyContinue)
if ($bcContainerHelperModules.Count -gt 0 -and
    (Confirm-Uninstall -Component "BcContainerHelper" -Impact "Business Central container management operations will no longer work.")) {
    try {
        Remove-Module -Name BcContainerHelper -Force -ErrorAction SilentlyContinue
        Uninstall-Module -Name BcContainerHelper -AllVersions -Force -ErrorAction Stop
        $removedComponents.Add("BcContainerHelper")
        Write-Success "BcContainerHelper removed"
    }
    catch { Add-RemovalFailure -Failures $removalFailures -Component "BcContainerHelper" -Failure $_ }
}

try {
    $featureCandidates = @(Get-WindowsFeatureRemovalCandidates)
    foreach ($feature in $featureCandidates) {
        $impact = if ($feature.Name -match 'Hyper-V') {
            "Removing Hyper-V can affect virtual machines and software unrelated to BC Dev Toolset."
        } else {
            "Removing the Containers feature disables Windows container workloads system-wide."
        }
        if (Confirm-Uninstall -Component "Windows feature '$($feature.Name)'" -Impact $impact) {
            try {
                Remove-WindowsFeature -Feature $feature
                $removedComponents.Add("Windows feature '$($feature.Name)'")
                Write-Success "Feature '$($feature.Name)' removed"
            }
            catch { Add-RemovalFailure -Failures $removalFailures -Component "Windows feature '$($feature.Name)'" -Failure $_ }
        }
    }
}
catch { Add-RemovalFailure -Failures $removalFailures -Component "Windows feature discovery" -Failure $_ }

Write-Header "Uninstallation Summary"
if ($removedComponents.Count -eq 0) {
    Write-Warning "No prerequisites were removed."
}
else {
    Write-Success "Removed $($removedComponents.Count) component(s):"
    foreach ($component in $removedComponents) { Write-Host "- $component" }
}
if ($removalFailures.Count -gt 0) {
    Write-Error "$($removalFailures.Count) component(s) could not be removed:"
    foreach ($component in $removalFailures) { Write-Host "- $component" -ForegroundColor $colors.Error }
}

if (-not $NoPause) {
    Read-Host -Prompt 'Press Enter to close this window and finish the script' | Out-Null
}
if ($removalFailures.Count -gt 0) { exit 1 }
