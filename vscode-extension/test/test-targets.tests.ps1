$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../../common/TestMgt.ps1"
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Assert-Throws([scriptblock] $action, [string] $pattern) {
    try { & $action; throw 'Expected failure did not occur' }
    catch { if ($_.Exception.Message -notmatch $pattern) { throw } }
}

$settings = [pscustomobject]@{ configurations = @(
    [pscustomobject]@{ name='Development'; serverType='Container'; targetType='Test'; includeTestToolkit='true'; container='dev' },
    [pscustomobject]@{ name='Dev Baseline'; serverType='Container'; targetType='Dev'; includeTestToolkit='true'; container='dev-baseline'; platform='23.0' },
    [pscustomobject]@{ name='Older'; serverType='Container'; targetType='Test'; includeTestToolkit='true'; container='old'; platform='22.0' },
    [pscustomobject]@{ name='Next'; serverType='Container'; targetType='Test'; includeTestToolkit='true'; container='next'; platform='24' },
    [pscustomobject]@{ name='Ahead'; serverType='Container'; targetType='Test'; includeTestToolkit='true'; container='ahead'; platform='27.1' },
    [pscustomobject]@{ name='No Toolkit'; serverType='Container'; targetType='Test'; includeTestToolkit='false'; container='no-toolkit'; platform='26.0' },
    [pscustomobject]@{ name='Not Test'; serverType='Container'; targetType='Test'; includeTestToolkit='false'; container='not-test'; platform='28.0' },
    [pscustomobject]@{ name='Dev Role'; serverType='Container'; targetType='Dev'; includeTestToolkit='true'; container='dev-role'; platform='28.0' },
    [pscustomobject]@{ name='Production Role'; serverType='Container'; targetType='Production'; includeTestToolkit='true'; container='production-role'; platform='31.0' },
    [pscustomobject]@{ name='Missing Role'; serverType='Container'; includeTestToolkit='true'; container='missing-role'; platform='29.0' },
    [pscustomobject]@{ name='Remote'; serverType='OnPrem'; targetType='Test'; includeTestToolkit='true'; container=''; platform='30.0' }
)}

$development = @(Resolve-BcTestTargetConfigurations -SettingsJSON $settings -BaselineApplicationVersion '23.0.0.0' -Suite Development)
Assert ($development.Count -eq 1) 'Development must include the single inherited baseline target'
Assert ($development[0].Configuration.name -eq 'Development' -and -not $development[0].Explicit) 'Inherited baseline classification'
$selectedDevelopment = Select-TestContainerConfiguration -SettingsJSON $settings -BaselineApplicationVersion '23.0.0.0'
Assert ($selectedDevelopment.Configuration.name -eq 'Development') 'Development execution must select the baseline platform even when newer containers exist'
$devOnly = [pscustomobject]@{ configurations = @([pscustomobject]@{ name='Dev'; serverType='Container'; targetType='Dev'; includeTestToolkit='true'; container='dev'; platform='23.0' }) }
Assert (@(Resolve-BcTestTargetConfigurations -SettingsJSON $devOnly -BaselineApplicationVersion '23.0.0.0' -Suite Development).Count -eq 0) 'A baseline Dev container must not be eligible for automated tests'

$compatibility = @(Resolve-BcTestTargetConfigurations -SettingsJSON $settings -BaselineApplicationVersion '23.0' -Suite Compatibility)
Assert (($compatibility | ForEach-Object { [string]$_.Platform }) -join ',' -eq '24.0.0.0,27.1.0.0') 'Compatibility targets must be explicit, newer, sorted versions'
Assert (@($compatibility | Where-Object { $_.Configuration.targetType -ne 'Test' }).Count -eq 0) 'Automated compatibility testing must never select Dev, Production, or unspecified target roles'

# The AL Runner loads WorkspaceMgt (which loads TestTargets), not TestMgt.
Remove-Item Function:Get-TestContainerConfigurations
. "$PSScriptRoot/../../common/TestTargets.ps1"
$standaloneCompatibility = @(Resolve-BcTestTargetConfigurations -SettingsJSON $settings -BaselineApplicationVersion '23.0' -Suite Compatibility -RequireTestToolkit:$false)
Assert ($standaloneCompatibility.Count -eq 4) 'AL Runner target resolution should include Test-role platforms without requiring a test toolkit'
Assert (@($standaloneCompatibility | Where-Object { $_.Configuration.targetType -ne 'Test' }).Count -eq 0) 'AL Runner must also exclude Dev, Production, and unspecified target roles'

$application = [pscustomobject]@{ application='23.0.0.0' }
Assert ((Get-ContainerArtifactApplicationVersion -Configuration $settings.configurations[0] -WorkspaceAppJSON $application) -eq '23.0.0.0') 'Omitted platform inherits app baseline'
Assert ((Get-ContainerArtifactApplicationVersion -Configuration $settings.configurations[4] -WorkspaceAppJSON $application) -eq '27.1.0.0') 'Explicit platform normalizes to four components'
Assert-Throws { Get-ContainerArtifactApplicationVersion -Configuration $settings.configurations[2] -WorkspaceAppJSON $application } 'older than.*minimum'

foreach ($invalid in @('27.1-preview', '27..1', '027.1', '1.2.3.4.5', '')) {
    Assert-Throws { ConvertTo-BcReleaseVersion -Value $invalid -SettingName 'test platform' } 'numeric Business Central release version'
}

$duplicate = [pscustomobject]@{ configurations = @(
    [pscustomobject]@{ name='One'; serverType='Container'; targetType='Test'; includeTestToolkit='true'; container='one'; platform='27.1' },
    [pscustomobject]@{ name='Two'; serverType='Container'; targetType='Test'; includeTestToolkit='true'; container='two'; platform='27.1.0.0' }
)}
Assert-Throws { Resolve-BcTestTargetConfigurations -SettingsJSON $duplicate -BaselineApplicationVersion '23.0' -Suite Compatibility } 'one configuration per platform version'

$workspaceRoot = Join-Path ([IO.Path]::GetTempPath()) ('bc-baseline-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path (Join-Path $workspaceRoot 'App')
try {
    [pscustomobject]@{ application='23.0.0.0' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workspaceRoot 'App/app.json')
    $workspace = [pscustomobject]@{ folders=@([pscustomobject]@{ path=(Join-Path $workspaceRoot 'App') }) }
    Assert ((Get-BcWorkspaceBaselineApplicationVersion -ScriptPath $PSScriptRoot -WorkspaceJSON $workspace) -eq '23.0.0.0') 'Workspace baseline is read from app.json'
} finally {
    Remove-Item -LiteralPath $workspaceRoot -Recurse -Force
}
Write-Output 'Platform target resolution tests passed.'

