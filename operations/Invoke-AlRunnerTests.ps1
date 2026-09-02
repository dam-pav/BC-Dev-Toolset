Clear-Host

$scriptPath = (Get-Item $PSScriptRoot).Parent
. $scriptPath/common/WorkspaceMgt.ps1

function Resolve-AlRunnerWorkspaceFolderPath {
    param(
        [Parameter(Mandatory=$true)] [string] $BasePath,
        [Parameter(Mandatory=$true)] [string] $ConfiguredPath
    )

    $candidatePath = if ([System.IO.Path]::IsPathRooted($ConfiguredPath)) {
        $ConfiguredPath
    } else {
        Join-Path $BasePath $ConfiguredPath
    }

    # Paths declared as workspace folders are explicitly authorized, including supported external folders.
    return [System.IO.Path]::GetFullPath($candidatePath)
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

function Get-AlRunnerShippedEngineVersions {
    param([Parameter(Mandatory=$true)] [string] $RunnerExecutablePath)

    $runnerToolRoot = [System.IO.Path]::GetFullPath((Split-Path $RunnerExecutablePath -Parent))
    $variantRoots = @()
    $directVariantRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerToolRoot 'variants'))
    if ([System.IO.Path]::GetRelativePath($runnerToolRoot, $directVariantRoot) -notmatch '^\.\.(?:[\\/]|$)' -and
        (Test-Path -LiteralPath $directVariantRoot -PathType Container)) {
        $variantRoots += $directVariantRoot
    }

    $toolStoreRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerToolRoot '.store\msdyn365bc.al.runner'))
    if ([System.IO.Path]::GetRelativePath($runnerToolRoot, $toolStoreRoot) -notmatch '^\.\.(?:[\\/]|$)' -and
        (Test-Path -LiteralPath $toolStoreRoot -PathType Container)) {
        $variantRoots += @(Get-ChildItem -LiteralPath $toolStoreRoot -Directory -Recurse -Filter 'variants' |
            ForEach-Object { $_.FullName })
    }

    return @($variantRoots | Select-Object -Unique | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Directory | ForEach-Object {
            try { [version]$_.Name } catch { }
        }
    } | Sort-Object -Unique)
}

function Write-AlRunnerToolFailure {
    param(
        [Parameter(Mandatory=$true)] [ValidateSet('not_installed', 'unsupported_engine', 'application_control', 'execution', 'unexpected')] [string] $Code,
        [Parameter(Mandatory=$true)] [string] $Message
    )

    Write-Host "__BCDEVTOOLSET_AL_RUNNER_TOOL_FAILURE__::$Code"
    Write-Host "AL Runner tool failure: $Message" -ForegroundColor Yellow
    Write-Host 'AL Runner tests were not executed.' -ForegroundColor Yellow
    Write-Host "Suggested fallback: run 'Run AL test tool tests' (MCP: bc_dev_toolset_invoke_tests)." -ForegroundColor Cyan
}

$workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath -WorkspacePath $env:BCDEVTOOLSET_WORKSPACE_PATH
$workspaceFile = Resolve-BcDevToolsetWorkspaceFile `
    -WorkspaceRootPath $workspaceRootPath.FullName `
    -WorkspaceFile $env:BCDEVTOOLSET_WORKSPACE_FILE
$candidateAppPaths = @()

if ($null -ne $workspaceFile) {
    $workspaceDefinition = Get-Content -LiteralPath $workspaceFile.FullName -Raw | ConvertFrom-Json
    foreach ($workspaceFolder in @($workspaceDefinition.folders)) {
        $candidateAppPaths += Resolve-AlRunnerWorkspaceFolderPath `
            -BasePath $workspaceFile.DirectoryName `
            -ConfiguredPath ([string]$workspaceFolder.path)
    }
} elseif (Test-Path -LiteralPath (Join-Path $workspaceRootPath.FullName 'app.json') -PathType Leaf) {
    $candidateAppPaths += $workspaceRootPath.FullName
} else {
    $candidateAppPaths += @(Get-ChildItem -LiteralPath $workspaceRootPath.FullName -Directory -Recurse |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'app.json') -PathType Leaf } |
        ForEach-Object { $_.FullName })
}

$appPaths = @($candidateAppPaths |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'app.json') -PathType Leaf } |
    Select-Object -Unique)
if ($appPaths.Count -eq 0) {
    throw 'No AL apps with an app.json file were found in the workspace.'
}

$workspaceApps = @($appPaths | ForEach-Object {
    $appJsonPath = Join-Path $_ 'app.json'
    try {
        $manifest = Get-Content -LiteralPath $appJsonPath -Raw | ConvertFrom-Json
    } catch {
        throw "Could not read AL app manifest '$appJsonPath': $($_.Exception.Message)"
    }

    $applicationText = [string]$manifest.application
    if ([string]::IsNullOrWhiteSpace($applicationText)) {
        throw "Application version is missing in '$appJsonPath'."
    }
    try {
        $applicationVersion = [version]$applicationText
    } catch {
        throw "Application version '$applicationText' in '$appJsonPath' is invalid."
    }

    [PSCustomObject]@{
        Path = $_
        ManifestPath = $appJsonPath
        ApplicationVersion = $applicationVersion
    }
})

$applicationMajors = @($workspaceApps |
    ForEach-Object { $_.ApplicationVersion.Major } |
    Sort-Object -Unique)
if ($applicationMajors.Count -ne 1) {
    $versionDetails = $workspaceApps |
        ForEach-Object { "'$($_.ManifestPath)': '$($_.ApplicationVersion)'" }
    throw "All AL Runner workspace apps must target the same Business Central application major. Found: $($versionDetails -join '; ')"
}
$bcVersionPrefix = [string]$applicationMajors[0]

$runnerCommand = Get-Command al-runner -ErrorAction SilentlyContinue
if (-not $runnerCommand) {
    Write-AlRunnerToolFailure `
        -Code 'not_installed' `
        -Message "AL Runner is not installed or 'al-runner' is not available in PATH. Run the 'Install prerequisites' operation, restart PowerShell if needed, and try again."
    return
}

$shippedEngineVersions = @(Get-AlRunnerShippedEngineVersions -RunnerExecutablePath $runnerCommand.Source)
if ($shippedEngineVersions.Count -gt 0 -and
    $bcVersionPrefix -notin @($shippedEngineVersions | ForEach-Object { [string]$_.Major } | Select-Object -Unique)) {
    $availableVersions = ($shippedEngineVersions | ForEach-Object { "$($_.Major).$($_.Minor)" }) -join ', '
    Write-AlRunnerToolFailure `
        -Code 'unsupported_engine' `
        -Message "The installed AL Runner does not ship a Business Central $bcVersionPrefix engine variant. Available variants: $availableVersions. This workspace cannot run with the published AL Runner package until an upstream build includes its BC major; no artifacts were downloaded."
    return
}

Write-Host "Running AL Runner for $($appPaths.Count) app folder(s):" -ForegroundColor Blue
foreach ($appPath in $appPaths) {
    Write-Host "- $appPath" -ForegroundColor Gray
}
Write-Host "Business Central artifact version prefix: $bcVersionPrefix (from app.json application versions)" -ForegroundColor Gray

$runnerArguments = @('--bc-version', $bcVersionPrefix) + $appPaths
$runnerStartedAt = Get-Date
& $runnerCommand.Source @runnerArguments
$runnerExitCode = $LASTEXITCODE
if ($runnerExitCode -ne 0) {
    if ($runnerExitCode -notin @(1, 2, 3, 4)) {
        $applicationControlEvent = Get-AlRunnerApplicationControlEvent -StartTime $runnerStartedAt
        if ($applicationControlEvent) {
            Write-AlRunnerToolFailure `
                -Code 'application_control' `
                -Message "Windows Smart App Control or another Code Integrity policy blocked the upstream AL Runner payload (event $($applicationControlEvent.Id)). The published AL Runner binary must be signed or allowed by the device's application-control policy; BC Dev Toolset will not disable or bypass that protection. Upstream project: https://github.com/StefanMaron/BusinessCentral.AL.Runner"
            return
        }
    }

    if ($runnerExitCode -eq 2) {
        Write-AlRunnerToolFailure `
            -Code 'execution' `
            -Message 'AL Runner could not execute a bundle or rejected the invocation. Review the visible runner diagnostics.'
        return
    }

    if ($runnerExitCode -notin @(1, 3, 4)) {
        Write-AlRunnerToolFailure `
            -Code 'unexpected' `
            -Message "AL Runner stopped with unexpected process exit code $runnerExitCode. Review the visible runner diagnostics."
        return
    }

    $exitDescription = switch ($runnerExitCode) {
        1 { 'one or more tests failed or errored' }
        3 { 'AL compilation errors' }
        4 { 'a test or app-group count did not match its declared baseline' }
        default { 'an unexpected runner failure' }
    }
    throw "AL Runner exited with code $runnerExitCode ($exitDescription)."
}

Write-Host 'AL Runner tests completed successfully.' -ForegroundColor Green
Write-Done
