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
        [Parameter(Mandatory=$true)] [ValidateSet('Development', 'Compatibility')] [string] $Suite
    )

    $baseline = ConvertTo-BcReleaseVersion -Value $BaselineApplicationVersion -SettingName "Workspace app.json application"
    $targets = @()
    foreach ($configuration in @(Get-TestContainerConfigurations -settingsJSON $SettingsJSON)) {
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
