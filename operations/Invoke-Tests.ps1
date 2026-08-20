Clear-Host

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

# Make sure Docker is running
Test-DockerProcess

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

$testContainerSelection = Request-TestExecutionContainerSelection -settingsJSON $settingsJSON
if ($null -eq $testContainerSelection) {
    Write-Done
    return
}

Write-McpStageMarker -Stage build -Status started
try {
    & (Join-Path $scriptRoot 'operations/BuildAllApps.ps1') -SkipOperationUI
    Write-McpStageMarker -Stage build -Status succeeded
} catch {
    Write-McpStageMarker -Stage build -Status failed
    throw
}

Write-McpStageMarker -Stage prepare -Status started
try {
    $testSettingsJSON = Initialize-TestExecutionContainer `
        -scriptPath $scriptRoot `
        -settingsJSON $settingsJSON `
        -workspaceJSON $workspaceJSON `
        -Selection $testContainerSelection
    Write-McpStageMarker -Stage prepare -Status succeeded
} catch {
    Write-McpStageMarker -Stage prepare -Status failed
    throw
}

Write-McpStageMarker -Stage tests -Status started
try {
    $testReport = Invoke-Tests `
        -scriptPath $scriptRoot `
        -settingsJSON $testSettingsJSON `
        -workspaceJSON $workspaceJSON
    Write-McpTestReport -Report $testReport
    Write-Host "Test summary: $($testReport.total) total, $($testReport.passed) passed, $($testReport.failed) failed, $($testReport.skipped) skipped ($($testReport.durationSeconds) seconds)." -ForegroundColor $(if ($testReport.allPassed) { 'Green' } else { 'Red' })
    if (-not $testReport.allPassed) {
        throw "$($testReport.failed) of $($testReport.total) AL tests failed."
    }
    Write-McpStageMarker -Stage tests -Status succeeded
} catch {
    Write-McpStageMarker -Stage tests -Status failed
    throw
}

Write-Done
