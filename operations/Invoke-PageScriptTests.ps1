Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1
. $scriptRoot/common/BackupMgt.ps1
. $scriptRoot/common/PublishApps.ps1
. $scriptRoot/common/TestMgt.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

$baselineVersion = Get-BcWorkspaceBaselineApplicationVersion -ScriptPath $scriptRoot -WorkspaceJSON $workspaceJSON
$suite = if ($env:BCDEVTOOLSET_TEST_SUITE -eq 'Compatibility') { 'Compatibility' } else { 'Development' }
$pageScriptResultsRoot = [string]$settingsJSON.pageScriptTestResultsPath
if ($suite -eq 'Compatibility' -and [string]::IsNullOrWhiteSpace($pageScriptResultsRoot)) {
    throw 'Page script compatibility tests require pageScriptTestResultsPath so each platform run can retain separate results.'
}
if ($suite -eq 'Compatibility' -and -not (Test-Path -LiteralPath $pageScriptResultsRoot -PathType Container)) {
    throw "Page script compatibility test results folder '$pageScriptResultsRoot' does not exist."
}
$testContainerSelection = Request-TestExecutionContainerSelection `
    -settingsJSON $settingsJSON `
    -BaselineApplicationVersion $baselineVersion `
    -Suite $suite

if ($null -eq $testContainerSelection) {
    Write-Done
    return
}

& (Join-Path $scriptRoot 'operations/BuildAllApps.ps1') -SkipOperationUI

$targetResults = @()
foreach ($selection in @($testContainerSelection.Targets)) {
    $status = 'failed'
    $errorText = ''
    $testSettingsJSON = $null
    try {
        $testSettingsJSON = Initialize-TestExecutionContainer `
            -scriptPath $scriptRoot `
            -settingsJSON $settingsJSON `
            -workspaceJSON $workspaceJSON `
            -Selection $selection
        if ($suite -eq 'Compatibility') {
            $targetResultPath = Join-Path $pageScriptResultsRoot ("BC-$($selection.Platform)")
            New-Item -ItemType Directory -Path $targetResultPath -Force | Out-Null
            $testSettingsJSON.pageScriptTestResultsPath = $targetResultPath
        }
        Invoke-PageScriptTests -settingsJSON $testSettingsJSON
        $status = 'passed'
    } catch {
        $errorText = $_.Exception.Message
        Write-Host "Page script target '$($selection.Configuration.name)' (BC $($selection.Platform)) failed: $errorText" -ForegroundColor Red
    }
    $targetResults += [PSCustomObject]@{
        name = $selection.Configuration.name
        container = $selection.Configuration.container
        targetPlatform = [string]$selection.Platform
        actualApplicationVersion = if ($testSettingsJSON) { [string]$testSettingsJSON.bcDevToolsetActualPlatformVersion } else { '' }
        status = $status
        error = $errorText
    }
}
foreach ($target in $targetResults) {
    Write-Host "Page script target '$($target.name)' (configured $($target.targetPlatform), actual $($target.actualApplicationVersion)): $($target.status). $($target.error)" -ForegroundColor $(if ($target.status -eq 'passed') { 'Green' } else { 'Red' })
}
if (@($targetResults | Where-Object status -ne 'passed').Count -gt 0) {
    $targetErrors = @($targetResults | Where-Object { -not [string]::IsNullOrWhiteSpace($_.error) } | ForEach-Object { "$($_.name): $($_.error)" }) -join '; '
    throw "One or more $($suite.ToLowerInvariant()) page script targets failed. Review per-target outcomes above. $targetErrors"
}

Write-Done
