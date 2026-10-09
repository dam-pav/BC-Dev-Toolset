$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../../common/TestMgt.ps1"
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Assert-Throws([scriptblock] $action, [string] $pattern) {
    try { & $action; throw 'Expected failure did not occur' }
    catch { if ($_.Exception.Message -notmatch $pattern) { throw } }
}

$settings = [pscustomobject]@{ configurations = @(
    [pscustomobject]@{ name='Development'; serverType='Container'; includeTestToolkit='true'; container='dev' },
    [pscustomobject]@{ name='Older'; serverType='Container'; includeTestToolkit='true'; container='old'; platform='22.0' },
    [pscustomobject]@{ name='Next'; serverType='Container'; includeTestToolkit='true'; container='next'; platform='24' },
    [pscustomobject]@{ name='Ahead'; serverType='Container'; includeTestToolkit='true'; container='ahead'; platform='27.1' },
    [pscustomobject]@{ name='Not Test'; serverType='Container'; includeTestToolkit='false'; container='not-test'; platform='28.0' },
    [pscustomobject]@{ name='Remote'; serverType='OnPrem'; includeTestToolkit='true'; container=''; platform='29.0' }
)}

$development = @(Resolve-BcTestTargetConfigurations -SettingsJSON $settings -BaselineApplicationVersion '23.0.0.0' -Suite Development)
Assert ($development.Count -eq 1) 'Development must include the single inherited baseline target'
Assert ($development[0].Configuration.name -eq 'Development' -and -not $development[0].Explicit) 'Inherited baseline classification'
$selectedDevelopment = Select-TestContainerConfiguration -SettingsJSON $settings -BaselineApplicationVersion '23.0.0.0'
Assert ($selectedDevelopment.Configuration.name -eq 'Development') 'Development execution must select the baseline platform even when newer containers exist'

$compatibility = @(Resolve-BcTestTargetConfigurations -SettingsJSON $settings -BaselineApplicationVersion '23.0' -Suite Compatibility)
Assert (($compatibility | ForEach-Object { [string]$_.Platform }) -join ',' -eq '24.0.0.0,27.1.0.0') 'Compatibility targets must be explicit, newer, sorted versions'

$application = [pscustomobject]@{ application='23.0.0.0' }
Assert ((Get-ContainerArtifactApplicationVersion -Configuration $settings.configurations[0] -WorkspaceAppJSON $application) -eq '23.0.0.0') 'Omitted platform inherits app baseline'
Assert ((Get-ContainerArtifactApplicationVersion -Configuration $settings.configurations[3] -WorkspaceAppJSON $application) -eq '27.1.0.0') 'Explicit platform normalizes to four components'
Assert-Throws { Get-ContainerArtifactApplicationVersion -Configuration $settings.configurations[1] -WorkspaceAppJSON $application } 'older than.*minimum'

foreach ($invalid in @('27.1-preview', '27..1', '027.1', '1.2.3.4.5', '')) {
    Assert-Throws { ConvertTo-BcReleaseVersion -Value $invalid -SettingName 'test platform' } 'numeric Business Central release version'
}

$duplicate = [pscustomobject]@{ configurations = @(
    [pscustomobject]@{ name='One'; serverType='Container'; includeTestToolkit='true'; container='one'; platform='27.1' },
    [pscustomobject]@{ name='Two'; serverType='Container'; includeTestToolkit='true'; container='two'; platform='27.1.0.0' }
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

