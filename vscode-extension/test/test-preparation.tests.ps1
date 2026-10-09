$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/TestMgt.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('bc-test-preparation-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'operations')
try {
    Set-Content -LiteralPath (Join-Path $fixtureRoot 'operations/BuildAllApps.ps1') -Value @'
param([switch] $SkipOperationUI, [switch] $WarningsAsErrors)
$global:preparationCalls.Add('build')
if ($global:failPreparationBuild) { throw 'build failed' }
'@
    $scriptRoot = $fixtureRoot
    function Initialize-Context {
        param($scriptPath, [ref]$settingsJSON, [ref]$workspaceJSON)
        # The reported discrepancy: a single eligible target, no legacy default setting.
        $settingsJSON.Value = [pscustomobject]@{ configurations = @([pscustomobject]@{
            name='Test'; serverType='Container'; targetType='Test'; container='bc-test'; includeTestToolkit='true'; autoRestoreBackup=$true
        }) }
        $workspaceJSON.Value = [pscustomobject]@{}
    }
    function Confirm-Option { $true }
    function Assert-TestIsolationCapabilities { }
    function Get-BcWorkspaceBaselineApplicationVersion { '23.0.0.0' }
    function Test-DockerProcess { $global:preparationCalls.Add('docker') }
    function New-TestExecutionContainerIfMissing { $global:preparationCalls.Add('create-if-missing'); $false }
    function Ensure-ConfiguredContainers { $global:preparationCalls.Add('ensure') }
    function Test-DockerContainerRunning { $true }
    function Get-BcContainerAppInfo {
        $version = if ($global:preparationActualVersion) { $global:preparationActualVersion } elseif ($global:failPreparationPlatform) { '27.1.0.0' } else { '23.18.32409.0' }
        @([pscustomobject]@{ Name='Application'; Publisher='Microsoft'; Version=$version })
    }
    function Test-AutoRestoreBackup { param($configuration) $configuration.autoRestoreBackup }
    function Restore-TestContainerBackupIfExists { $global:preparationCalls.Add('restore') }
    function Publish-Dependencies { $global:preparationCalls.Add('dependencies') }
    function Publish-Apps {
        param($scriptPath, $settingsJSON, $workspaceJSON, $publishAsDev)
        Assert ($settingsJSON.configurations.Count -eq 1 -and $settingsJSON.configurations[0].container -eq 'bc-test') 'Wrong deployment target'
        $global:preparationCalls.Add('deploy')
    }
    function Invoke-Tests {
        $global:preparationCalls.Add('tests')
        [pscustomobject]@{ total=1; passed=1; failed=0; skipped=0; durationSeconds=0; allPassed=$true }
    }
    function Invoke-PageScriptTests { $global:preparationCalls.Add('tests') }
    function Write-Done { }
    function Write-McpStageMarker { }
    function Write-McpTestReport { }
    foreach ($operationName in @('Invoke-Tests.ps1', 'Invoke-PageScriptTests.ps1')) {
        $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "../../operations/$operationName") -Raw
        # Execute production orchestration, excluding imports/UI setup; side effects are mocked above.
        $body = [scriptblock]::Create($source.Substring($source.IndexOf('$settingsJSON = @{}')))
        $global:preparationCalls = [Collections.Generic.List[string]]::new()
        $global:failPreparationBuild = $false
        $global:failPreparationPlatform = $false
        & $body
        Assert (($global:preparationCalls -join ',') -eq 'build,docker,create-if-missing,ensure,restore,dependencies,deploy,tests') "$operationName must build before container access and always deploy"
        $global:preparationCalls.Clear()
        $global:failPreparationBuild = $true
        $global:failPreparationPlatform = $false
        $caught = $false
        try { & $body } catch { if ($_.Exception.Message -ne 'build failed') { throw }; $caught=$true }
        Assert $caught 'Build failure must propagate'
        Assert (($global:preparationCalls -join ',') -eq 'build') "$operationName touched the container after build failure"

        $global:preparationCalls.Clear()
        $global:failPreparationBuild = $false
        $global:failPreparationPlatform = $true
        $caught = $false
        try { & $body } catch { if ($_.Exception.Message -notmatch "targets '23.0.0.0'") { throw }; $caught=$true }
        Assert $caught 'Container platform mismatch must fail before restore or deployment'
        Assert (($global:preparationCalls -join ',') -eq 'build,docker,create-if-missing,ensure') "$operationName mutated a mismatched container"
    }

    $exactMinorTarget = [pscustomobject]@{ name='BC27.1'; container='bcdata271' }
    $global:preparationActualVersion = '27.0.32409.0'
    $caught = $false
    try { Assert-BcTestContainerPlatform -Configuration $exactMinorTarget -ExpectedApplicationVersion '27.1.0.0' | Out-Null }
    catch { if ($_.Exception.Message -notmatch "targets '27.1.0.0'") { throw }; $caught=$true }
    Assert $caught 'A non-zero configured minor must match the installed Application minor exactly'
    $global:preparationActualVersion = '27.1.32409.0'
    Assert ((Assert-BcTestContainerPlatform -Configuration $exactMinorTarget -ExpectedApplicationVersion '27.1.0.0') -eq '27.1.32409.0') 'A matching non-zero configured minor must pass'
} finally {
    # Only the newly allocated fixture root is removed.
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    Remove-Variable preparationCalls, failPreparationBuild, failPreparationPlatform, preparationActualVersion -Scope Global -ErrorAction SilentlyContinue
}
