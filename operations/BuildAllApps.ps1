Param (
    [switch] $SkipOperationUI
)

if (-not $SkipOperationUI) {
    Clear-Host
}

$scriptPath = (Get-Item $PSScriptRoot).Parent
. $scriptPath/common/WorkspaceMgt.ps1

function Resolve-AlToolPath {
    $candidates = @()

    if (-not [string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_ALTOOL_PATH)) {
        $candidates += $env:BCDEVTOOLSET_ALTOOL_PATH
    }

    foreach ($commandName in @('altool.exe', 'al.exe', 'altool', 'al')) {
        $toolCommand = Get-Command $commandName -CommandType Application -ErrorAction SilentlyContinue
        if ($null -ne $toolCommand) { $candidates += $toolCommand.Source }
    }

    $extensionRoots = @()
    if (-not [string]::IsNullOrWhiteSpace($env:VSCODE_EXTENSIONS)) {
        $extensionRoots += $env:VSCODE_EXTENSIONS
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $extensionRoots += (Join-Path $env:USERPROFILE '.vscode\extensions')
        $extensionRoots += (Join-Path $env:USERPROFILE '.vscode-insiders\extensions')
    }

    foreach ($extensionRoot in ($extensionRoots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $extensionRoot -PathType Container)) { continue }
        foreach ($alExtension in @(Get-ChildItem -LiteralPath $extensionRoot -Directory -Filter 'ms-dynamics-smb.al-*' |
            Sort-Object Name -Descending)) {
            $candidates += (Join-Path $alExtension.FullName 'bin\win32\altool.exe')
        }
    }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate)) { continue }

        # This path is intentionally configurable for CI installations. Validate it once here.
        $validatedAlToolPath = [System.IO.Path]::GetFullPath([string]$candidate)
        if (-not (Test-Path -LiteralPath $validatedAlToolPath -PathType Leaf)) { continue }

        $LASTEXITCODE = 0
        $helpOutput = @(& $validatedAlToolPath compile --help 2>&1)
        if ($LASTEXITCODE -eq 0 -and (($helpOutput -join "`n") -match 'invoking alc.exe')) {
            return $validatedAlToolPath
        }
    }

    throw "ALTool was not found. Install a current Microsoft AL Language extension, install the Business Central Development Tools .NET tool, or set BCDEVTOOLSET_ALTOOL_PATH."
}

function Resolve-AlSettingPath {
    param(
        [Parameter(Mandatory=$true)] [string] $BasePath,
        [Parameter(Mandatory=$true)] [string] $ConfiguredPath
    )

    $candidatePath = if ([System.IO.Path]::IsPathRooted($ConfiguredPath)) {
        $ConfiguredPath
    } else {
        Join-Path $BasePath $ConfiguredPath
    }
    return [System.IO.Path]::GetFullPath($candidatePath)
}

function Read-AlSettingsFile {
    param([Parameter(Mandatory=$true)] [string] $SettingsPath)

    if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
    } catch {
        Write-Host "Could not read AL settings from '$SettingsPath': $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

function Get-SettingValue {
    param(
        [PSObject] $FolderSettings,
        [PSObject] $WorkspaceSettings,
        [Parameter(Mandatory=$true)] [string] $Name
    )

    if ($null -ne $FolderSettings -and $null -ne $FolderSettings.PSObject.Properties[$Name]) {
        return $FolderSettings.PSObject.Properties[$Name].Value
    }
    if ($null -ne $WorkspaceSettings -and $null -ne $WorkspaceSettings.PSObject.Properties[$Name]) {
        return $WorkspaceSettings.PSObject.Properties[$Name].Value
    }
    return $null
}

function Get-WorkspaceAppsInBuildOrder {
    param([Parameter(Mandatory=$true)] [PSObject[]] $Apps)

    $appsById = @{}
    foreach ($app in $Apps) {
        $appId = [string]$app.id
        if ([string]::IsNullOrWhiteSpace($appId)) {
            throw "App id is missing in '$(Join-Path $app.path 'app.json')'."
        }
        if ($appsById.ContainsKey($appId)) { throw "Duplicate workspace app id '$appId'." }
        $appsById[$appId] = $app
    }

    $orderedApps = @()
    $orderedAppIds = @{}
    $pendingApps = @($Apps)
    while ($pendingApps.Count -gt 0) {
        $readyApps = @($pendingApps | Where-Object {
            $isReady = $true
            foreach ($dependency in @($_.dependencies)) {
                $dependencyId = [string]$dependency.id
                if ($appsById.ContainsKey($dependencyId) -and -not $orderedAppIds.ContainsKey($dependencyId)) {
                    $isReady = $false
                    break
                }
            }
            $isReady
        })

        if ($readyApps.Count -eq 0) {
            throw "A circular dependency was found between workspace apps: $(($pendingApps | ForEach-Object { $_.name }) -join ', ')"
        }

        foreach ($readyApp in $readyApps) {
            $orderedApps += $readyApp
            $orderedAppIds[[string]$readyApp.id] = $true
        }
        $pendingApps = @($pendingApps | Where-Object { -not $orderedAppIds.ContainsKey([string]$_.id) })
    }

    return $orderedApps
}

$workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath -WorkspacePath $env:BCDEVTOOLSET_WORKSPACE_PATH
$workspaceFile = Resolve-BcDevToolsetWorkspaceFile `
    -WorkspaceRootPath $workspaceRootPath.FullName `
    -WorkspaceFile $env:BCDEVTOOLSET_WORKSPACE_FILE
$workspaceSettings = $null
$appPaths = @()

if ($null -ne $workspaceFile) {
    $workspaceDefinition = Get-Content -LiteralPath $workspaceFile.FullName -Raw | ConvertFrom-Json
    $workspaceSettings = $workspaceDefinition.settings
    foreach ($workspaceFolder in @($workspaceDefinition.folders)) {
        $appPaths += Resolve-AlSettingPath `
            -BasePath $workspaceFile.DirectoryName `
            -ConfiguredPath ([string]$workspaceFolder.path)
    }
} else {
    if (Test-Path -LiteralPath (Join-Path $workspaceRootPath.FullName 'app.json') -PathType Leaf) {
        $appPaths += $workspaceRootPath.FullName
    } else {
        $appPaths += @(Get-ChildItem -LiteralPath $workspaceRootPath.FullName -Directory -Recurse |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'app.json') -PathType Leaf } |
            ForEach-Object { $_.FullName })
    }
    $workspaceSettings = Read-AlSettingsFile -SettingsPath (Join-Path $workspaceRootPath.FullName '.vscode\settings.json')
}

$workspaceApps = @()
foreach ($appPath in @($appPaths | Select-Object -Unique)) {
    $appJsonPath = Join-Path $appPath 'app.json'
    if (-not (Test-Path -LiteralPath $appJsonPath -PathType Leaf)) { continue }

    $app = Get-Content -LiteralPath $appJsonPath -Raw | ConvertFrom-Json
    $app | Add-Member -MemberType NoteProperty -Name path -Value $appPath -Force
    $app | Add-Member -MemberType NoteProperty -Name folderSettings -Value (
        Read-AlSettingsFile -SettingsPath (Join-Path $appPath '.vscode\settings.json')
    ) -Force
    $workspaceApps += $app
}

if ($workspaceApps.Count -eq 0) { throw "No AL apps with an app.json file were found in the workspace." }

$orderedApps = @(Get-WorkspaceAppsInBuildOrder -Apps $workspaceApps)
$alToolPath = Resolve-AlToolPath
$builtPackages = @{}
$operatingSystemTemporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$temporaryBuildRoot = Join-Path $operatingSystemTemporaryRoot "bc-dev-toolset-build-$([guid]::NewGuid().ToString('N'))"
$temporaryBuildRoot = [System.IO.Path]::GetFullPath($temporaryBuildRoot)
if ([System.IO.Path]::GetDirectoryName($temporaryBuildRoot) -ne $operatingSystemTemporaryRoot) {
    throw "Temporary build path escaped the operating system temporary directory."
}
New-Item -ItemType Directory -Path $temporaryBuildRoot -Force | Out-Null

Write-Host "Using ALTool: $alToolPath" -ForegroundColor Gray
Write-Host "Building $($orderedApps.Count) app(s) in dependency order..." -ForegroundColor Blue

try {
    foreach ($app in $orderedApps) {
        $appPath = [string]$app.path
        $isolatedPackageCache = Join-Path $temporaryBuildRoot ([string]$app.id)
        New-Item -ItemType Directory -Path $isolatedPackageCache -Force | Out-Null

        $configuredPackageCachePaths = @(Get-SettingValue `
            -FolderSettings $app.folderSettings `
            -WorkspaceSettings $workspaceSettings `
            -Name 'al.packageCachePath')
        if ($configuredPackageCachePaths.Count -eq 0 -or
            [string]::IsNullOrWhiteSpace([string]$configuredPackageCachePaths[0])) {
            $configuredPackageCachePaths = @('.alpackages')
        }

        foreach ($configuredPackageCachePath in $configuredPackageCachePaths) {
            $sourcePackageCache = Resolve-AlSettingPath -BasePath $appPath -ConfiguredPath ([string]$configuredPackageCachePath)
            if (-not (Test-Path -LiteralPath $sourcePackageCache -PathType Container)) { continue }
            foreach ($package in @(Get-ChildItem -LiteralPath $sourcePackageCache -File -Filter '*.app')) {
                Copy-Item -LiteralPath $package.FullName -Destination $isolatedPackageCache -Force
            }
        }

        foreach ($dependency in @($app.dependencies)) {
            $dependencyId = [string]$dependency.id
            if ($builtPackages.ContainsKey($dependencyId)) {
                Copy-Item -LiteralPath $builtPackages[$dependencyId] -Destination $isolatedPackageCache -Force
            }
        }

        $packageFileName = "$($app.publisher)_$($app.name)_$($app.version).app"
        $packageFile = Join-Path $appPath $packageFileName
        $compilerArguments = @(
            "-project:$appPath",
            "-packagecachepath:$isolatedPackageCache",
            "-out:$packageFile"
        )

        $assemblyProbingPaths = @()
        foreach ($configuredPath in @(Get-SettingValue `
            -FolderSettings $app.folderSettings `
            -WorkspaceSettings $workspaceSettings `
            -Name 'al.assemblyProbingPaths')) {
            if ([string]::IsNullOrWhiteSpace([string]$configuredPath)) { continue }
            $resolvedPath = Resolve-AlSettingPath -BasePath $appPath -ConfiguredPath ([string]$configuredPath)
            if (Test-Path -LiteralPath $resolvedPath -PathType Container) { $assemblyProbingPaths += $resolvedPath }
        }
        if ($assemblyProbingPaths.Count -gt 0) {
            $compilerArguments += "-assemblyprobingpaths:$($assemblyProbingPaths -join ',')"
        }

        $configuredRuleSetPath = [string](Get-SettingValue `
            -FolderSettings $app.folderSettings `
            -WorkspaceSettings $workspaceSettings `
            -Name 'al.ruleSetPath')
        if (-not [string]::IsNullOrWhiteSpace($configuredRuleSetPath)) {
            $resolvedRuleSetPath = Resolve-AlSettingPath -BasePath $appPath -ConfiguredPath $configuredRuleSetPath
            if (Test-Path -LiteralPath $resolvedRuleSetPath -PathType Leaf) {
                $compilerArguments += "-ruleset:$resolvedRuleSetPath"
            }
        }

        Write-Host "Building '$($app.name)' using its isolated project package cache..." -ForegroundColor Blue
        $LASTEXITCODE = 0
        & $alToolPath compile @compilerArguments
        $alToolSucceeded = $?
        if (-not $alToolSucceeded -or $LASTEXITCODE -ne 0) {
            throw "AL compilation failed for '$($app.name)' (process exit code: $LASTEXITCODE)."
        }
        if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
            throw "AL compilation did not create the expected package: $packageFile"
        }

        $builtPackages[[string]$app.id] = $packageFile
        Write-Host "Built '$packageFile'." -ForegroundColor Green
    }
} finally {
    $validatedTemporaryBuildRoot = [System.IO.Path]::GetFullPath($temporaryBuildRoot)
    if ([System.IO.Path]::GetDirectoryName($validatedTemporaryBuildRoot) -eq $operatingSystemTemporaryRoot -and
        [System.IO.Path]::GetFileName($validatedTemporaryBuildRoot).StartsWith('bc-dev-toolset-build-')) {
        Remove-Item -LiteralPath $validatedTemporaryBuildRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not $SkipOperationUI) {
    Write-Done
}
