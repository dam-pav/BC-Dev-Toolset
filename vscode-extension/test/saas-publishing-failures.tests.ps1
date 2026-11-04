$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Write-Host { param($Object,$ForegroundColor,[switch]$NoNewline) $script:output += [string]$Object }
function Get-SortedApps { [pscustomobject]@{Name='Fixture';Dependencies=@()} }
function Get-PackageParams { param($scriptPath,$settingsJSON,$appJSON,$runtime,[ref]$packageName,[ref]$packagePath)
    $packageName.Value='fixture.app'; $packagePath.Value=$PSScriptRoot
}
function Test-Path { $true }
function Get-ChildItem { [pscustomobject]@{Extension='.app';FullName=(Join-Path $PSScriptRoot 'fixture.app')} }
function New-BcAuthContext { param([switch]$includeDeviceLogin,$tenantID,$refreshToken) @{AccessToken='secret-token'} }
function Publish-BcContainerApp { param($appFile,[switch]$useDevEndpoint,[switch]$replacePackageId,$bcAuthContext,$environment)
    $script:attempts++; Write-Error 'secret SaaS developer endpoint failure'
}
function Publish-PerTenantExtensionApps { param($appFiles,$bcAuthContext,$environment)
    $script:attempts++; Write-Error 'secret SaaS deployment failure'
}
foreach ($operation in @('Apps','Dependencies')) {
    foreach ($dev in @($false,$true)) {
        $script:output=@(); $script:attempts=0; $caught=$null; $auth=@{}
        $role=if($dev){'Dev'}else{'Test'}
        $settings=@{configurations=@(@{name='SaaS';serverType='Cloud';targetType=$role;tenant='tenant.example';environmentName='Sandbox'});dependenciesPath=$PSScriptRoot}
        try {
            if($operation -eq 'Apps') {
                Publish-Apps -scriptPath $PSScriptRoot -settingsJSON $settings -workspaceJSON @{} -publishAsDev $dev -authContext ([ref]$auth)
            } else {
                Publish-Dependencies -settingsJSON ([pscustomobject]$settings) -authContext ([ref]$auth)
            }
        } catch { $caught=$_ }
        Assert ($null -ne $caught) "$operation swallowed a SaaS error"
        Assert ($script:attempts -eq 1) "$operation repeated a failed deployment"
        Assert ($caught.Exception.Data['DeploymentState'] -eq 'Unknown') "$operation claimed a failed deployment was unapplied"
        Assert ($caught.Exception.Message -match 'Extension Deployment Status Details') "$operation omitted SaaS recovery guidance"
        Assert ($caught.Exception.Message -notmatch 'secret') "$operation exposed backend secrets"
        Assert (($script:output -join ' ') -notmatch 'deployment is done') "$operation printed completion after failure"
    }
}
