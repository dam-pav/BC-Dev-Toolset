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
$script:failureRunner = 0
$script:failureCount = 1
$script:mode = ''
$script:runner = 130450
function Get-SortedApps { param($workspaceJSON) @(
    [pscustomobject]@{ AppId='a'; Name='App A' },
    [pscustomobject]@{ AppId='b'; Name='App B' },
    [pscustomobject]@{ AppId='c'; Name='No Tests' }
) }
function Test-DockerContainerExists { param($containerName) $true }
function Get-BcConfigurationCredential { param($configuration) [pscredential]::new('test', (ConvertTo-SecureString 'test' -AsPlainText -Force)) }
function Get-BcContainerAppInfo { param($containerName, [switch]$installedOnly) Get-SortedApps }
function Get-TestsFromBcContainer {
    [CmdletBinding()] param($containerName, $credential, $extensionId, $testCodeunitRange, [switch]$ignoreGroups)
    Assert ($testCodeunitRange -eq '') 'Discovery must not replace extension selection with a global range'
    Assert $ignoreGroups 'Discovery shape must be codeunits'
    $ids = switch ($extensionId) { a { @(60990,60991) }; b { @(60992) }; c { @() } }
    foreach ($id in $ids) {
        $count = if ($script:failureCount -gt 1) { $script:failureCount } else { 2 }
        [pscustomobject]@{ Id="$id"; Tests=@(1..$count | ForEach-Object { "Test$_" }) }
    }
}
function Run-TestsInBcContainer {
    [CmdletBinding()] param($containerName, $credential, $extensionId, $appName, $JUnitResultFileName,
        [switch]$returnTrueIfAllPassed, [switch]$detailed, $testRunnerCodeunitId, $testCodeunitRange)
    $script:runner = $testRunnerCodeunitId
    $script:calls += [pscustomobject]@{ app=$extensionId; runner=$testRunnerCodeunitId; filter=$testCodeunitRange }
    if ($testCodeunitRange -eq '0') {
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
    $allowed = switch ($extensionId) { a { @(60990,60991) }; b { @(60992) }; default { @() } }
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
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('bc-isolation-' + [guid]::NewGuid().ToString('N'))
$env:BCDEVTOOLSET_HOST_HELPER_FOLDER = $testRoot
$settings = [pscustomobject]@{ configurations=@([pscustomobject]@{ name='Test'; serverType='Container'; container='test' }) }
try {
    Assert-TestIsolationCapabilities
    foreach ($failedRunner in @(0,130450,130451)) {
        $script:calls = @(); $script:failureRunner = $failedRunner
        $report = Invoke-Tests -scriptPath $PWD -settingsJSON $settings -workspaceJSON $shared
        Assert ($report.applicationCount -eq 3 -and $report.total -eq 6) 'Combined application/test counts'
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
    function Run-TestsInBcContainer { param($extensionId) }
    Assert-Throws { Assert-TestIsolationCapabilities } 'Unsupported test isolation capability'
} finally {
    $env:BCDEVTOOLSET_HOST_HELPER_FOLDER = $previousHelperFolder
    # The test owns this UUID-named directory directly beneath the system temp root.
    $relative = [IO.Path]::GetRelativePath([IO.Path]::GetTempPath(), $testRoot)
    if ($relative -notmatch '^bc-isolation-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path' }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
