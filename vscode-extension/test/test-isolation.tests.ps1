$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../../common/TestMgt.ps1"
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Assert-Throws([scriptblock] $action, [string] $pattern) {
    try { & $action; throw 'Expected failure did not occur' }
    catch { if ($_.Exception.Message -notmatch $pattern) { throw } }
}
$empty = [pscustomobject]@{}
$shared = '{"settings":{"bcDevToolset":{"testIsolationDisabledCodeunits":[60990,60992,60990]}}}' | ConvertFrom-Json
Assert (@(Get-TestIsolationDisabledCodeunits $empty $empty).Count -eq 0) 'Default policy'
Assert ((@(Get-TestIsolationDisabledCodeunits $empty $shared) -join ',') -eq '60990,60992') 'Shared policy and deduplication'
$legacy = '{"settings":{"dam-pav.bcdevtoolset":{"testIsolationDisabledCodeunits":[60992]}}}' | ConvertFrom-Json
Assert ((@(Get-TestIsolationDisabledCodeunits $empty $legacy) -join ',') -eq '60992') 'Legacy policy'
Assert (@(Get-TestIsolationDisabledCodeunits ('{"testIsolationDisabledCodeunits":[]}' | ConvertFrom-Json) $shared).Count -eq 0) 'Local clear'
Assert ((@(Get-TestIsolationDisabledCodeunits ('{"testIsolationDisabledCodeunits":[1]}' | ConvertFrom-Json) $shared) -join ',') -eq '1') 'Local replacement'
foreach ($value in @('null', '1', '"1"', 'true', '{}', '["1"]', '[true]', '[null]', '[1.5]', '[0]', '[-1]', '[2147483648]')) {
    $local = ('{"testIsolationDisabledCodeunits":' + $value + '}') | ConvertFrom-Json
    Assert-Throws { Get-TestIsolationDisabledCodeunits $local $shared } 'must be a JSON array'
}

# Run the real operation body with context/side-effect seams replaced. Invalid settings
# must stop before Docker startup, container selection, build or preparation.
$operation = Get-Content -LiteralPath "$PSScriptRoot/../../operations/Invoke-Tests.ps1" -Raw
$body = $operation.Substring($operation.IndexOf('$settingsJSON = @{}'))
function Initialize-Context {
    param($scriptPath, [ref]$settingsJSON, [ref]$workspaceJSON)
    $settingsJSON.Value = '{"testIsolationDisabledCodeunits":"60990"}' | ConvertFrom-Json
    $workspaceJSON.Value = [pscustomobject]@{}
}
function Test-DockerProcess { throw 'Docker startup must not be reached' }
function Request-TestExecutionContainerSelection { throw 'Container selection must not be reached' }
Assert-Throws { & ([scriptblock]::Create($body)) } 'must be a JSON array'

# Exercise real orchestration and result parsing without build, Docker or BC mutations.
$script:calls = @()
$script:discoveries = @()
$script:failureRunner = 0
$script:failureCount = 1
$script:mode = ''
$script:runner = 130450
function Get-SortedApps { param($workspaceJSON) @(
    [pscustomobject]@{ AppId='00000000-0000-0000-0000-000000000001'; Name='App A' },
    [pscustomobject]@{ AppId='00000000-0000-0000-0000-000000000002'; Name='App B' },
    [pscustomobject]@{ AppId='00000000-0000-0000-0000-000000000003'; Name='No Tests' }
) }
function Test-DockerContainerExists { param($containerName) $true }
function Get-BcConfigurationCredential { param($configuration) [pscredential]::new('test', [System.Security.SecureString]::new()) }
function Get-BcContainerAppInfo { param($containerName, [switch]$installedOnly) Get-SortedApps }
function Get-TestsFromBcContainer {
    [CmdletBinding()] param($containerName, [pscredential]$credential, [guid]$extensionId, $testCodeunitRange, [switch]$ignoreGroups)
    $script:discoveries += $extensionId
    Assert ($testCodeunitRange -eq '') 'Discovery must not replace extension selection with a global range'
    Assert $ignoreGroups 'Discovery shape must be codeunits'
    $ids = switch ($extensionId.ToString()) {
        '00000000-0000-0000-0000-000000000001' { @(60990,60991) }
        '00000000-0000-0000-0000-000000000002' { @(60992) }
        '00000000-0000-0000-0000-000000000003' { @() }
    }
    foreach ($id in $ids) {
        $count = if ($script:failureCount -gt 1) { $script:failureCount } else { 2 }
        [pscustomobject]@{ Id="$id"; Tests=@(1..$count | ForEach-Object { "Test$_" }) }
    }
}
function Run-TestsInBcContainer {
    [CmdletBinding()] param($containerName, [pscredential]$credential, [guid]$extensionId = [guid]::Empty, $appName, $JUnitResultFileName,
        [switch]$returnTrueIfAllPassed, [switch]$detailed, $testRunnerCodeunitId, $testCodeunitRange)
    $script:runner = $testRunnerCodeunitId
    $script:calls += [pscustomobject]@{ app=$extensionId; runner=$testRunnerCodeunitId; filter=$testCodeunitRange }
    if ($testCodeunitRange -eq '0') {
        Assert (-not $PSBoundParameters.ContainsKey('extensionId')) 'Reset must use the helper default extension ID'
        Assert ($extensionId -eq [guid]::Empty) 'Reset default extension ID'
        Assert ($testRunnerCodeunitId -eq 130450) 'Reset runner'
        '<testsuites />' | Set-Content -LiteralPath $JUnitResultFileName
        return $true
    }
    if ($script:mode -and $testRunnerCodeunitId -eq 130451) {
        switch ($script:mode) {
            throw { throw 'Unavailable runner/filter' }
            missing { return $true }
            malformed { '<garbage />' | Set-Content -LiteralPath $JUnitResultFileName; return $true }
            incomplete { '<testsuites />' | Set-Content -LiteralPath $JUnitResultFileName; return $true }
            inconsistent { '<testsuites><testsuite tests="1" failures="0" errors="0" skipped="0" time="0" /></testsuites>' | Set-Content -LiteralPath $JUnitResultFileName; return $true }
            nonboolean { return }
        }
    }
    $allowed = switch ($extensionId.ToString()) {
        '00000000-0000-0000-0000-000000000001' { @(60990,60991) }
        '00000000-0000-0000-0000-000000000002' { @(60992) }
        default { @() }
    }
    $failed = $testRunnerCodeunitId -eq $script:failureRunner
    $xml = '<testsuites>'
    foreach ($id in ($testCodeunitRange -split '\|')) {
        Assert ([int]$id -in $allowed) 'Range escaped extension scope'
        $count = if ($script:failureCount -gt 1) { $script:failureCount } else { 2 }
        $failures = if ($failed) { $script:failureCount } else { 0 }
        $skipped = if ($failures -eq 0) { 1 } else { 0 }
        $xml += "<testsuite name='$id Codeunit' tests='$count' failures='$failures' errors='0' skipped='$skipped' time='1.25'>"
        for ($i = 1; $i -le $count; $i++) {
            $xml += "<testcase classname='$id Codeunit' name='Test$i'>"
            if ($i -le $failures) { $xml += '<failure message="assertion">stack</failure>' }
            elseif ($skipped -gt 0 -and $i -eq $count) { $xml += '<skipped />' }
            $xml += '</testcase>'
        }
        $xml += '</testsuite>'
    }
    $xml += '</testsuites>'
    $xml | Set-Content -LiteralPath $JUnitResultFileName
    return (-not $failed)
}
$previousHelperFolder = $env:BCDEVTOOLSET_HOST_HELPER_FOLDER
$previousSelectedIds = $env:BCDEVTOOLSET_TEST_CODEUNIT_IDS
$previousSuite = $env:BCDEVTOOLSET_TEST_SUITE
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('bc-isolation-' + [guid]::NewGuid().ToString('N'))
$env:BCDEVTOOLSET_HOST_HELPER_FOLDER = $testRoot
$settings = [pscustomobject]@{ configurations=@([pscustomobject]@{ name='Test'; serverType='Container'; targetType='Test'; container='test' }) }
try {
    Assert-TestIsolationCapabilities
    $script:discoveries = @()
    Assert-Throws { Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $shared -CodeunitIds @(60990, 987654) } '987654.*Refresh the test selection.*No tests were executed'
    Assert ($script:discoveries.Count -eq 3) 'Missing selected IDs must be checked against all deployed workspace apps'
    Assert ($script:calls.Count -eq 0) 'A mixed known and unknown selection must execute zero tests'
    Assert (-not (Test-Path -LiteralPath $testRoot)) 'Missing selection must not create a JUnit capture directory'

    $report = Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $shared -CodeunitIds @(60992, 60991, 60991)
    $runs = @($script:calls | Where-Object filter -ne '0')
    Assert (($report.selectedCodeunitIds -join ',') -eq '60991,60992') 'Scope reports sorted unique IDs'
    Assert ($report.allPassed -and $report.total -eq 4) 'Only the selected codeunits count in the report'
    Assert ($report.applicationCount -eq 2 -and $report.groups.Count -eq 4 -and
        $report.groups.app -notcontains 'No Tests') 'The selected report contains only apps with selected codeunits'
    Assert ($report.unmatchedCodeunitIds.Count -eq 0) 'Excluding an existing codeunit must not make its isolation entry unmatched'
    Assert ($runs.Count -eq 2 -and $runs[0].filter -eq '60991' -and $runs[0].runner -eq 130450 -and
        $runs[0].app -eq [guid]'00000000-0000-0000-0000-000000000001' -and
        $runs[1].filter -eq '60992' -and $runs[1].runner -eq 130451 -and
        $runs[1].app -eq [guid]'00000000-0000-0000-0000-000000000002') 'Only selected IDs reach their app and isolation runner'
    Assert ($script:calls[-1].filter -eq '0' -and $script:runner -eq 130450) 'Filtered disabled isolation is still reset'

    foreach ($failedRunner in @(0,130450,130451)) {
        $script:calls = @(); $script:failureRunner = $failedRunner
        $report = Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $shared
        Assert ($report.applicationCount -eq 3 -and $report.total -eq 6) 'Combined application/test counts'
        Assert ($null -eq $report.selectedCodeunitIds) 'Comprehensive run scope'
        Assert ($report.groups.Count -eq 6) 'Empty groups must be represented'
        Assert ($report.allPassed -eq ($failedRunner -eq 0)) 'Mixed failure hidden'
        Assert ($report.durationSeconds -eq 3.75) 'Combined duration'
        $runs = @($script:calls | Where-Object filter -ne '0')
        Assert ($runs.Count -eq 3) 'Tests executed twice or group omitted'
        Assert (($runs | Where-Object runner -eq 130450).filter -eq '60991') 'Isolated partition'
        Assert ((@($runs | Where-Object runner -eq 130451 | ForEach-Object filter) -join ',') -eq '60990,60992') 'Disabled partition'
        Assert ($script:runner -eq 130450) 'Persistent runner not reset'
        $expectedFailed = switch ($failedRunner) { 0 { 0 }; 130450 { 1 }; 130451 { 2 } }
        Assert ($report.failed -eq $expectedFailed) 'Failure totals'
        Assert ($report.skipped -eq (3 - $expectedFailed)) 'Skipped totals'
    }
    $script:failureRunner = 0; $script:calls = @()
    $report = Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $empty
    Assert (@($script:calls | Where-Object runner -ne 130450).Count -eq 0) 'Default after disabled run is unsafe'
    Assert ($report.allPassed -and $report.total -eq 6) 'Default results'
    $script:failureRunner = 130451; $script:failureCount = 12
    $report = Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $shared
    Assert ($report.failed -eq 24 -and $report.failures.Count -eq 20 -and $report.omittedFailureCount -eq 4) 'Failure detail truncation'
    $script:failureCount = 1; $script:failureRunner = 0
    foreach ($mode in @('throw','missing','malformed','incomplete','inconsistent','nonboolean')) {
        $script:mode = $mode; $script:calls = @()
        Assert-Throws { Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $shared } 'Test infrastructure failure'
        Assert ($script:runner -eq 130450 -and $script:calls[-1].filter -eq '0') "Reset on $mode failure"
    }
    $script:mode = ''
    $unmatched = '{"settings":{"bcDevToolset":{"testIsolationDisabledCodeunits":[123]}}}' | ConvertFrom-Json
    $report = Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $unmatched
    Assert (-not $report.allPassed -and $report.unmatchedCodeunitIds[0] -eq 123) 'Missing selection not reported'

    # Exercise the production operation body, including the selection env handoff,
    # the final MCP report and expected failure propagation to the launcher.
    $scriptRoot = $testRoot
    $script:phaseEvents = [System.Collections.Generic.List[string]]::new()
    $script:operationReport = $null
    $null = New-Item -ItemType Directory -Path (Join-Path $testRoot 'operations')
    'param([switch] $SkipOperationUI, [switch] $WarningsAsErrors)' | Set-Content -LiteralPath (Join-Path $testRoot 'operations/BuildAllApps.ps1')
    function Initialize-Context {
        param($scriptPath, [ref]$settingsJSON, [ref]$workspaceJSON)
        $script:phaseEvents.Add('initialize')
        $settingsJSON.Value = $settings
        $workspaceJSON.Value = $shared
    }
    function Get-BcWorkspaceBaselineApplicationVersion { '27.0' }
    function Request-TestExecutionContainerSelection {
        [pscustomobject]@{ Targets = @([pscustomobject]@{ Configuration = $settings.configurations[0]; Platform = '27.0' }) }
    }
    function Initialize-TestExecutionContainer { $script:phaseEvents.Add('prepare'); $settings }
    function Write-McpStageMarker { param($Stage, $Status) $script:phaseEvents.Add("${Stage}:${Status}") }
    function Write-McpTestReport { param($Report) $script:operationReport = $Report }
    function Write-Done { $script:phaseEvents.Add('done') }
    $env:BCDEVTOOLSET_TEST_SUITE = 'Development'
    foreach ($invalid in @('60992', '["60992"]', '[1.5]', '[]', '[2147483648]', '[null]', 'null', '[1,')) {
        $env:BCDEVTOOLSET_TEST_CODEUNIT_IDS = $invalid
        Assert-Throws { & ([scriptblock]::Create($body)) } 'Choose valid test codeunits or request all tests.*No build'
    }
    Assert ($script:phaseEvents.Count -eq 0) 'Invalid env selections must stop before context initialization and all dependent work'

    $script:calls = @()
    $env:BCDEVTOOLSET_TEST_CODEUNIT_IDS = '[60992]'
    & ([scriptblock]::Create($body))
    $runs = @($script:calls | Where-Object filter -ne '0')
    Assert ($runs.Count -eq 1 -and $runs[0].filter -eq '60992') 'A valid operation environment selection reaches the deployed test runner'
    Assert ($script:operationReport.selectedCodeunitIds -is [array] -and
        $script:operationReport.selectedCodeunitIds.Count -eq 1 -and $script:operationReport.allPassed) 'MCP report preserves single-ID selection as an array'

    $script:phaseEvents.Clear()
    $script:calls = @()
    $env:BCDEVTOOLSET_TEST_CODEUNIT_IDS = '[60992,987654]'
    try {
        & ([scriptblock]::Create($body))
        throw 'Missing selection should fail the operation'
    } catch {
        Assert ($_.Exception.Data['BcDevToolsetExpectedFailure'] -eq $true -and
            $_.Exception.Data['Stage'] -eq 'deployed test selection validation') 'Operation must retain the reviewed discovery failure'
    }
    Assert ($script:phaseEvents.Contains('tests:failed') -and -not $script:phaseEvents.Contains('done')) 'Failure marker and no completion'
    Assert ($script:calls.Count -eq 0 -and -not $script:operationReport.allPassed -and
        $script:operationReport.targets[0].error -match '987654.*Refresh the test selection') 'MCP report explains the failed target without executing tests'

    $script:phaseEvents.Clear()
    $script:calls = @()
    $env:BCDEVTOOLSET_TEST_SUITE = 'Compatibility'
    & ([scriptblock]::Create($body))
    Assert ($script:operationReport.total -eq 6 -and $null -eq $script:operationReport.selectedCodeunitIds) 'Compatibility ignores development codeunit selection'

    function Run-TestsInBcContainer { param($extensionId) }
    Assert-Throws { Assert-TestIsolationCapabilities } 'Unsupported test isolation capability'
} finally {
    $env:BCDEVTOOLSET_HOST_HELPER_FOLDER = $previousHelperFolder
    $env:BCDEVTOOLSET_TEST_CODEUNIT_IDS = $previousSelectedIds
    $env:BCDEVTOOLSET_TEST_SUITE = $previousSuite
    # The test owns this UUID-named directory directly beneath the system temp root.
    $relative = [IO.Path]::GetRelativePath([IO.Path]::GetTempPath(), $testRoot)
    if ($relative -notmatch '^bc-isolation-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path' }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
