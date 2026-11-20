$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/TestMgt.ps1')
$createMissingContainer = ${function:New-TestExecutionContainerIfMissing}
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
        $configuration = [ordered]@{ name='Test'; serverType='Container'; targetType='Test'; container='bc-test'; includeTestToolkit='true' }
        foreach ($flag in $global:preparationFlags.Keys) { $configuration[$flag] = $global:preparationFlags[$flag] }
        $settingsJSON.Value = [pscustomobject]@{ configurations = @([pscustomobject]$configuration) }
        $workspaceJSON.Value = [pscustomobject]@{}
    }
    function Confirm-Option { $true }
    function Assert-TestIsolationCapabilities { }
    function Get-BcWorkspaceBaselineApplicationVersion { '23.0.0.0' }
    function Test-DockerProcess { $global:preparationCalls.Add('docker') }
    function New-TestExecutionContainerIfMissing { $global:preparationCalls.Add('create-if-missing'); $global:preparationContainerCreated }
    function Ensure-ConfiguredContainers { $global:preparationCalls.Add('ensure') }
    function Test-DockerContainerRunning { $true }
    function Get-BcContainerAppInfo {
        $version = if ($global:preparationActualVersion) { $global:preparationActualVersion } elseif ($global:failPreparationPlatform) { '27.1.0.0' } else { '23.18.32409.0' }
        @([pscustomobject]@{ Name='Application'; Publisher='Microsoft'; Version=$version })
    }
    function Restore-TestContainerBackupIfExists {
        $global:preparationCalls.Add('restore')
        if ($global:failPreparationRestore) { throw 'restore failed; inspect the target database before retrying' }
    }
    function Publish-Dependencies { $global:preparationCalls.Add('dependencies') }
    function Publish-Apps {
        param($scriptPath, $settingsJSON, $workspaceJSON, $publishAsDev, [switch]$IncludeTestApps)
        Assert ($settingsJSON.configurations.Count -eq 1 -and $settingsJSON.configurations[0].container -eq 'bc-test') 'Wrong deployment target'
        Assert $IncludeTestApps 'Test preparation must publish test apps'
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
        $global:failPreparationRestore = $false
        $global:preparationContainerCreated = $false
        $global:preparationFlags = @{}
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

        $global:failPreparationPlatform = $false
        foreach ($beforeTest in @('omitted', $true, $false)) {
            foreach ($onCreate in @('omitted', $true, $false)) {
                $global:preparationFlags = @{}
                if ($beforeTest -is [bool]) { $global:preparationFlags.autoRestoreBeforeTest = $beforeTest }
                if ($onCreate -is [bool]) { $global:preparationFlags.autoRestoreBackup = $onCreate }
                $global:preparationCalls.Clear()
                $diagnostics = (& $body 6>&1 | Out-String)
                $expectedRestore = if ($beforeTest -eq $false) { '' } else { ',restore' }
                Assert (($global:preparationCalls -join ',') -eq "build,docker,create-if-missing,ensure$expectedRestore,dependencies,deploy,tests") "$operationName restore must depend only on autoRestoreBeforeTest ($beforeTest), not autoRestoreBackup ($onCreate)"
                if ($beforeTest -eq $false) {
                    Assert ($diagnostics -match 'Skipping automatic SQL backup restore because autoRestoreBeforeTest is false') 'Skip guidance must identify the setting the user can change'
                    Assert ($diagnostics -notmatch 'because autoRestoreBackup is false') 'Skip guidance must not identify the old setting'
                }
            }
        }

        $global:preparationFlags = @{ autoRestoreBeforeTest=$true; autoRestoreBackup=$false }
        $global:preparationContainerCreated = $true
        $global:preparationCalls.Clear()
        $diagnostics = (& $body 6>&1 | Out-String)
        Assert (($global:preparationCalls -join ',') -eq 'build,docker,create-if-missing,ensure,dependencies,deploy,tests') "$operationName must not restore again after creating the container"
        Assert ($diagnostics -match 'Skipping SQL backup restore because the container was just created') 'New-container restore skip must remain explained'

        $global:preparationContainerCreated = $false
        $global:failPreparationRestore = $true
        $global:preparationCalls.Clear()
        $caught = $false
        try { & $body } catch {
            if ($_.Exception.Message -notmatch 'restore failed; inspect the target database before retrying') { throw }
            $caught = $true
        }
        Assert $caught 'Restore failure and recovery guidance must propagate'
        Assert (($global:preparationCalls -join ',') -eq 'build,docker,create-if-missing,ensure,restore') "$operationName continued to deployment or tests after restore failure"
        $global:failPreparationRestore = $false
    }

    # Exercise the real missing-container creator without Docker or database side effects.
    function docker { $global:LASTEXITCODE = if ($global:preparationContainerExists) { 0 } else { 1 } }
    function Remove-RedundantAppRegionSettings { }
    function Clear-Artifacts { }
    function Get-TestWorkspaceAppJson { [pscustomobject]@{ application='23.0.0.0' } }
    function New-DockerContainer {
        param($testMode, $scriptPath, $appJSON, $settingsJSON, $workspaceJSON, $selectArtifact, $pullFullArtifact,
            [bool]$honorAutoRestoreBackup=$true, [bool]$deferInitialBackupExport=$false)
        Assert (-not $honorAutoRestoreBackup) 'Test-triggered creation must ignore autoRestoreBackup and create a fresh database'
        Assert $deferInitialBackupExport 'Initial backup must wait until server configuration is applied'
        $global:preparationCalls.Add('create-fresh')
        return $true
    }
    function Update-ContainerServerConfiguration { $global:preparationCalls.Add('server-config') }
    function Export-InitialTestContainerSqlBackupSet { $global:preparationCalls.Add('initial-backup') }
    foreach ($beforeTest in @($true, $false)) {
        foreach ($onCreate in @($true, $false)) {
            $configuration = [pscustomobject]@{ name='Test'; serverType='Container'; targetType='Test'; container='bc-test'; includeTestToolkit='true'; sqlBackupPath='backups'; autoRestoreBeforeTest=$beforeTest; autoRestoreBackup=$onCreate }
            $settings = [pscustomobject]@{ configurations=@($configuration) }
            foreach ($exists in @($false, $true)) {
                $global:preparationContainerExists = $exists
                $global:preparationCalls.Clear()
                $created = & $createMissingContainer -scriptPath $fixtureRoot -settingsJSON $settings -workspaceJSON ([pscustomobject]@{}) -testSettings $settings -configuration $configuration
                Assert ($created -eq (-not $exists)) 'Missing-container creator must report whether it created the container'
                $expectedCalls = if ($exists) { '' } else { 'create-fresh,server-config,initial-backup' }
                Assert (($global:preparationCalls -join ',') -eq $expectedCalls) 'Fresh creation must configure the server before exporting exactly one initial backup; existing containers must be left untouched'
            }
        }
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
    $resolvedFixtureRoot = (Resolve-Path -LiteralPath $fixtureRoot -ErrorAction Stop).Path
    $relativeFixtureRoot = [IO.Path]::GetRelativePath([IO.Path]::GetTempPath(), $resolvedFixtureRoot)
    if ($relativeFixtureRoot -eq '.' -or [IO.Path]::IsPathRooted($relativeFixtureRoot) -or
        $relativeFixtureRoot -eq '..' -or $relativeFixtureRoot.StartsWith('..' + [IO.Path]::DirectorySeparatorChar) -or
        $resolvedFixtureRoot -ne [IO.Path]::GetFullPath($fixtureRoot)) {
        throw 'Refusing to remove a fixture outside the allocated temporary directory.'
    }
    Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
    Remove-Variable preparationCalls, failPreparationBuild, failPreparationPlatform, preparationActualVersion, failPreparationRestore, preparationFlags, preparationContainerCreated, preparationContainerExists -Scope Global -ErrorAction SilentlyContinue
}
