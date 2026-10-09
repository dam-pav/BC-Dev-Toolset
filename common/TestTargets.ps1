function Get-TestContainerConfigurations {
    param(
        [Parameter(Mandatory=$true)] [PSObject] $SettingsJSON,
        [bool] $RequireTestToolkit = $true
    )

    return @($SettingsJSON.configurations | Where-Object {
        $_.serverType -eq 'Container' -and
        -not [string]::IsNullOrWhiteSpace($_.container) -and
        (-not $RequireTestToolkit -or $_.includeTestToolkit -eq 'true')
    })
}

function ConvertTo-BcReleaseVersion {
    param(
        [Parameter(Mandatory=$true)] [AllowEmptyString()] [string] $Value,
        [Parameter(Mandatory=$true)] [string] $SettingName
    )

    $versionText = $Value.Trim()
    if ($versionText -notmatch '^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}$') {
        throw "$SettingName must be a numeric Business Central release version with one to four components, for example '27.1'."
    }

    $parts = @($versionText.Split('.'))
    while ($parts.Count -lt 4) { $parts += '0' }
    try { return [version]($parts -join '.') }
    catch { throw "$SettingName contains a version component outside the supported numeric range." }
}

function Resolve-BcTestTargetConfigurations {
    param(
        [Parameter(Mandatory=$true)] [PSObject] $SettingsJSON,
        [Parameter(Mandatory=$true)] [string] $BaselineApplicationVersion,
        [Parameter(Mandatory=$true)] [ValidateSet('Development', 'Compatibility')] [string] $Suite,
        [bool] $RequireTestToolkit = $true
    )

    $baseline = ConvertTo-BcReleaseVersion -Value $BaselineApplicationVersion -SettingName "Workspace app.json application"
    $targets = @()
    foreach ($configuration in @(Get-TestContainerConfigurations -settingsJSON $SettingsJSON -RequireTestToolkit:$RequireTestToolkit)) {
        $configuredPlatform = ''
        if ($configuration.PSObject.Properties['platform']) {
            $configuredPlatform = [string]$configuration.platform
        }
        $explicitPlatform = -not [string]::IsNullOrWhiteSpace($configuredPlatform)
        $platform = if ($explicitPlatform) {
            ConvertTo-BcReleaseVersion -Value $configuredPlatform -SettingName "Container configuration '$($configuration.name)' platform"
        } else { $baseline }

        if ($platform -lt $baseline) { continue }
        if ($Suite -eq 'Development' -and $platform -eq $baseline) {
            $targets += [PSCustomObject]@{ Configuration=$configuration; Platform=$platform; Explicit=$explicitPlatform }
        } elseif ($Suite -eq 'Compatibility' -and $explicitPlatform -and $platform -gt $baseline) {
            $targets += [PSCustomObject]@{ Configuration=$configuration; Platform=$platform; Explicit=$true }
        }
    }

    $duplicates = @($targets | Group-Object { [string]$_.Platform } | Where-Object Count -gt 1)
    if ($duplicates.Count -gt 0) {
        $duplicateVersions = @($duplicates | ForEach-Object Name) -join ', '
        throw "More than one eligible test Container configuration targets the same Business Central platform version: $duplicateVersions. Keep one configuration per platform version."
    }

    return @($targets | Sort-Object Platform)
}

function Get-BcWorkspaceBaselineApplicationVersion {
    param(
        [Parameter(Mandatory=$true)] [string] $ScriptPath,
        [Parameter(Mandatory=$true)] [PSObject] $WorkspaceJSON
    )

    $workspace = if ($WorkspaceJSON.PSObject.Properties['value']) { $WorkspaceJSON.value } else { $WorkspaceJSON }
    $versions = @()
    foreach ($folder in @($workspace.folders)) {
        $folderPath = [string]$folder.path
        if (Get-Command Resolve-WorkspaceFolderPath -ErrorAction SilentlyContinue) {
            $appPath = Resolve-WorkspaceFolderPath -scriptPath $ScriptPath -folderPath $folderPath
        } elseif ([System.IO.Path]::IsPathRooted($folderPath)) {
            $appPath = [System.IO.Path]::GetFullPath($folderPath)
        } else {
            $workspaceRoot = if ($script:bcDevToolsetWorkspaceRootPath) { $script:bcDevToolsetWorkspaceRootPath } else { $ScriptPath }
            $appPath = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot $folderPath))
        }
        $manifestPath = Join-Path $appPath 'app.json'
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$manifest.application)) {
            throw "Application version is missing in '$manifestPath'."
        }
        $versions += ConvertTo-BcReleaseVersion -Value ([string]$manifest.application) -SettingName "'$manifestPath' application"
    }

    $distinctVersions = @($versions | Sort-Object -Unique)
    if ($distinctVersions.Count -eq 0) { throw 'No workspace app.json application baseline was found.' }
    if ($distinctVersions.Count -ne 1) {
        throw "Workspace apps must use one application baseline for test target resolution. Found: $($distinctVersions -join ', ')."
    }
    return $distinctVersions[0].ToString()
}

function Get-ContainerArtifactApplicationVersion {
    param(
        [Parameter(Mandatory=$true)] [PSObject] $Configuration,
        [Parameter(Mandatory=$true)] [PSObject] $WorkspaceAppJSON
    )

    $minimum = ConvertTo-BcReleaseVersion -Value ([string]$WorkspaceAppJSON.application) -SettingName "Workspace app.json application"
    $configuredPlatform = ''
    if ($Configuration.PSObject.Properties['platform']) { $configuredPlatform = [string]$Configuration.platform }
    if ([string]::IsNullOrWhiteSpace($configuredPlatform)) { return $minimum.ToString() }

    $target = ConvertTo-BcReleaseVersion -Value $configuredPlatform -SettingName "Container configuration '$($Configuration.name)' platform"
    if ($target -lt $minimum) {
        throw "Container configuration '$($Configuration.name)' platform '$configuredPlatform' is older than the workspace app.json application minimum '$minimum'."
    }
    return $target.ToString()
}
