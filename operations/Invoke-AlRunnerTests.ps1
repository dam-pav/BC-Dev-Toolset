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
$settingsJSON = @{}
$targetWorkspaceJSON = @{}
$initializeParameters = @{
    scriptPath = $scriptPath
    settingsJSON = [ref]$settingsJSON
    workspaceJSON = [ref]$targetWorkspaceJSON
    WorkspacePath = $workspaceRootPath.FullName
}
if ($null -ne $workspaceFile) { $initializeParameters.WorkspaceFile = $workspaceFile.FullName }
Initialize-Context @initializeParameters
$baselineApplicationVersion = Get-BcWorkspaceBaselineApplicationVersion `
    -ScriptPath $scriptPath `
    -WorkspaceJSON $targetWorkspaceJSON
$suite = if ($env:BCDEVTOOLSET_TEST_SUITE -eq 'Compatibility') { 'Compatibility' } else { 'Development' }
$platformTargets = @(Resolve-BcTestTargetConfigurations `
    -SettingsJSON $settingsJSON `
    -BaselineApplicationVersion $baselineApplicationVersion `
    -Suite $suite `
    -RequireTestToolkit:$false)
if (($suite -eq 'Development' -and $platformTargets.Count -ne 1) -or ($suite -eq 'Compatibility' -and $platformTargets.Count -eq 0)) {
    throw "AL Runner $suite target resolution found $($platformTargets.Count) configured platform targets for workspace baseline '$baselineApplicationVersion'. Add one baseline target or at least one explicitly newer platform."
}

$runnerCommand = Get-Command al-runner -ErrorAction SilentlyContinue
if (-not $runnerCommand) {
    Write-AlRunnerToolFailure `
        -Code 'not_installed' `
        -Message "AL Runner is not installed or 'al-runner' is not available in PATH. Run the 'Install prerequisites' operation, restart PowerShell if needed, and try again."
    return
}

Write-Host "Running AL Runner for $($appPaths.Count) app folder(s):" -ForegroundColor Blue
foreach ($appPath in $appPaths) {
    Write-Host "- $appPath" -ForegroundColor Gray
}
$targetResults = @()
foreach ($platformTarget in $platformTargets) {
    $bcVersionPrefix = $platformTarget.Platform.ToString(2)
    Write-Host "Running AL Runner for configured BC release '$bcVersionPrefix' ($($platformTarget.Configuration.name)); the same exact release is passed through --bc-version." -ForegroundColor Blue
    $runnerArguments = @('--bc-version', $bcVersionPrefix) + $appPaths
    $runnerStartedAt = Get-Date
    & $runnerCommand.Source @runnerArguments
    $runnerExitCode = $LASTEXITCODE
    if ($runnerExitCode -eq 0) {
        $targetResults += [PSCustomObject]@{ configuration=$platformTarget.Configuration.name; platform=$bcVersionPrefix; status='passed'; exitCode=0 }
        continue
    }

    if ($runnerExitCode -in @(1, 3, 4)) {
        $exitDescription = switch ($runnerExitCode) {
            1 { 'one or more tests failed or errored' }
            3 { 'AL compilation errors' }
            4 { 'a test or app-group count did not match its declared baseline' }
        }
        $targetResults += [PSCustomObject]@{ configuration=$platformTarget.Configuration.name; platform=$bcVersionPrefix; status='failed'; exitCode=$runnerExitCode; error=$exitDescription }
        continue
    }

    if ($runnerExitCode -ne 2) {
        $applicationControlEvent = Get-AlRunnerApplicationControlEvent -StartTime $runnerStartedAt
        if ($applicationControlEvent) {
            Write-AlRunnerToolFailure `
                -Code 'application_control' `
                -Message "Windows Smart App Control or another Code Integrity policy blocked the upstream AL Runner payload (event $($applicationControlEvent.Id)). The published AL Runner binary must be signed or allowed by the device's application-control policy; BC Dev Toolset will not disable or bypass that protection. Upstream project: https://github.com/StefanMaron/BusinessCentral.AL.Runner"
            return
        }
    }

    $toolFailure = if ($runnerExitCode -eq 2) {
        'AL Runner could not execute a bundle or rejected the invocation. Review the visible runner diagnostics.'
    } else {
        "AL Runner stopped with unexpected process exit code $runnerExitCode. Review the visible runner diagnostics."
    }
    Write-AlRunnerToolFailure -Code $(if ($runnerExitCode -eq 2) { 'execution' } else { 'unexpected' }) -Message $toolFailure
    return
}

foreach ($targetResult in $targetResults) {
    Write-Host "AL Runner target '$($targetResult.configuration)' (configured and requested BC $($targetResult.platform)): $($targetResult.status); exit code $($targetResult.exitCode) $($targetResult.error)" -ForegroundColor $(if ($targetResult.status -eq 'passed') { 'Green' } else { 'Red' })
}
if (@($targetResults | Where-Object status -ne 'passed').Count -gt 0) {
    throw "One or more $($suite.ToLowerInvariant()) AL Runner targets failed. Review per-target outcomes above."
}
Write-Host "AL Runner $($suite.ToLowerInvariant()) tests completed successfully." -ForegroundColor Green
Write-Done
