$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/BackupMgt.ps1
. $scriptRoot/common/PublishApps.ps1
. $scriptRoot/common/TestMgt.ps1

function Write-McpStageMarker {
    Param (
        [Parameter(Mandatory=$true)] [ValidateSet('build', 'prepare', 'tests')] [string] $Stage,
        [Parameter(Mandatory=$true)] [ValidateSet('started', 'succeeded', 'failed', 'cancelled')] [string] $Status
    )
    if (-not [string]::IsNullOrWhiteSpace([string]$env:BCDEVTOOLSET_MCP_REPORT_PATH)) {
        Write-Host "__BCDEVTOOLSET_STAGE__${Stage}::${Status}"
    }
}

function Write-McpTestReport {
    Param ([Parameter(Mandatory=$true)] [PSObject] $Report)

    $configuredReportPath = [string]$env:BCDEVTOOLSET_MCP_REPORT_PATH
    if ([string]::IsNullOrWhiteSpace($configuredReportPath)) {
        return
    }

    $captureRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'bc-dev-toolset-mcp')).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar)
    $validatedReportPath = [System.IO.Path]::GetFullPath($configuredReportPath)
    $capturePrefix = $captureRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $validatedReportPath.StartsWith($capturePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetExtension($validatedReportPath) -ne '.json') {
        throw "The MCP test-report path is outside the authorized capture directory."
    }

    $Report | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $validatedReportPath -Encoding UTF8
}

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

# Reject invalid isolation settings before build or environment preparation.
$null = @(Get-TestIsolationDisabledCodeunits -SettingsJSON $settingsJSON -WorkspaceJSON $workspaceJSON)
Assert-TestIsolationCapabilities

$baselineVersion = Get-BcWorkspaceBaselineApplicationVersion -ScriptPath $scriptRoot -WorkspaceJSON $workspaceJSON
$suite = if ($env:BCDEVTOOLSET_TEST_SUITE -eq 'Compatibility') { 'Compatibility' } else { 'Development' }
$testContainerSelection = Request-TestExecutionContainerSelection `
    -settingsJSON $settingsJSON `
    -BaselineApplicationVersion $baselineVersion `
    -Suite $suite
if ($null -eq $testContainerSelection) {
    Write-Done
    return
}

Write-McpStageMarker -Stage build -Status started
try {
    $warningsAsErrors = Get-TestBuildWarningsAsErrors -SettingsJSON $settingsJSON -WorkspaceJSON $workspaceJSON
    & (Join-Path $scriptRoot 'operations/BuildAllApps.ps1') -SkipOperationUI -WarningsAsErrors:$warningsAsErrors
    Write-McpStageMarker -Stage build -Status succeeded
} catch {
    Write-McpStageMarker -Stage build -Status failed
    throw
}

$targetResults = @()
$targetReports = @()
foreach ($selection in @($testContainerSelection.Targets)) {
    $targetResult = [PSCustomObject]@{
        name = $selection.Configuration.name
        container = $selection.Configuration.container
        targetPlatform = [string]$selection.Platform
        actualApplicationVersion = ''
        status = 'failed'
        error = ''
    }
    Write-McpStageMarker -Stage prepare -Status started
    try {
        $testSettingsJSON = Initialize-TestExecutionContainer `
            -scriptPath $scriptRoot `
            -settingsJSON $settingsJSON `
            -workspaceJSON $workspaceJSON `
            -Selection $selection
        $targetResult.actualApplicationVersion = [string]$testSettingsJSON.bcDevToolsetActualPlatformVersion
        Write-McpStageMarker -Stage prepare -Status succeeded
    } catch {
        $targetResult.error = "Preparation: $($_.Exception.Message)"
        Write-McpStageMarker -Stage prepare -Status failed
        $targetResults += $targetResult
        continue
    }

    Write-McpStageMarker -Stage tests -Status started
    try {
        $targetReport = Invoke-Tests `
            -scriptPath $scriptRoot `
            -settingsJSON $testSettingsJSON `
            -workspaceJSON $workspaceJSON
        $targetReports += $targetReport
        $targetResult.status = if ($targetReport.allPassed) { 'passed' } else { 'failed' }
        if (-not $targetReport.allPassed) { $targetResult.error = "$($targetReport.failed) of $($targetReport.total) AL tests failed." }
        Write-McpStageMarker -Stage tests -Status $(if ($targetReport.allPassed) { 'succeeded' } else { 'failed' })
    } catch {
        $targetResult.error = "Tests: $($_.Exception.Message)"
        Write-McpStageMarker -Stage tests -Status failed
    }
    $targetResults += $targetResult
}

$testReport = [PSCustomObject]@{
    total = [int](($targetReports | Measure-Object -Property total -Sum).Sum)
    passed = [int](($targetReports | Measure-Object -Property passed -Sum).Sum)
    failed = [int](($targetReports | Measure-Object -Property failed -Sum).Sum)
    skipped = [int](($targetReports | Measure-Object -Property skipped -Sum).Sum)
    durationSeconds = [Math]::Round([double](($targetReports | Measure-Object -Property durationSeconds -Sum).Sum), 3)
    applicationCount = [int](($targetReports | Measure-Object -Property applicationCount -Sum).Sum)
    groups = @($targetReports | ForEach-Object { $_.groups })
    failures = @($targetReports | ForEach-Object { $_.failures })
    unmatchedCodeunitIds = @($targetReports | ForEach-Object { $_.unmatchedCodeunitIds } | Sort-Object -Unique)
    testIsolationDisabledCodeunits = @(Get-TestIsolationDisabledCodeunits -SettingsJSON $settingsJSON -WorkspaceJSON $workspaceJSON)
    targets = $targetResults
    allPassed = (@($targetResults | Where-Object status -ne 'passed').Count -eq 0)
}
Write-McpTestReport -Report $testReport
foreach ($target in $targetResults) {
    Write-Host "Compatibility target '$($target.name)' (configured $($target.targetPlatform), actual $($target.actualApplicationVersion)): $($target.status). $($target.error)" -ForegroundColor $(if ($target.status -eq 'passed') { 'Green' } else { 'Red' })
}
Write-Host "Test summary: $($testReport.total) total, $($testReport.passed) passed, $($testReport.failed) failed, $($testReport.skipped) skipped ($($testReport.durationSeconds) seconds)." -ForegroundColor $(if ($testReport.allPassed) { 'Green' } else { 'Red' })
if (-not $testReport.allPassed) {
    $targetErrors = @($targetResults | Where-Object { -not [string]::IsNullOrWhiteSpace($_.error) } | ForEach-Object { "$($_.name): $($_.error)" }) -join '; '
    throw "One or more $($suite.ToLowerInvariant()) test targets failed. Review per-target outcomes above. $targetErrors"
}

Write-Done
