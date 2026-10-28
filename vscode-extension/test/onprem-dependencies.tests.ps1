$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
function Assert($condition,$message) { if (-not $condition) { throw $message } }
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('bc-remote-dependencies-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory -Path $fixtureRoot
$files=@('child.app','already.app','upgrade.app','dependencies.zip')
try {
    @{AppId='child';Name='Child';Publisher='Fixture';Version='2.0.0.0';Dependencies=@(@{Id='base'})} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'child.app')
    @{AppId='already';Name='Already';Publisher='Fixture';Version='1.0.0.0';Dependencies=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'already.app')
    @{AppId='upgrade';Name='Upgrade';Publisher='Fixture';Version='2.0.0.0';Dependencies=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'upgrade.app')
    $zipPath=Join-Path $fixtureRoot 'dependencies.zip'
    $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($version in @('1.0.0.0','2.0.0.0')) {
            # Archive paths are intentionally hostile; extraction must generate its own filenames.
            $entry=$zip.CreateEntry("../../outside/$version/base.app")
            $writer=[IO.StreamWriter]::new($entry.Open())
            try { $writer.Write((@{AppId='base';Name='Base';Publisher='Fixture';Version=$version;Dependencies=@()} | ConvertTo-Json)) }
            finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    $configuration=[pscustomobject]@{name='selected';serverType='OnPrem';server='http://bc-host:8080/BC230';serverInstance='BC230';targetType='Dev';tenant='selected-tenant';remoteCredential=$true}
    $settings=@{configurations=@($configuration);dependenciesPaths=@($fixtureRoot,$zipPath)}
    function Test-IsLocalSqlServer { $false }
    function Initialize-OnPremPublishingManagement { throw 'Remote dependencies must not load local management tools' }
    function New-RemoteBackupSession {
        param($computerName,$configuration,$OperationName)
        Assert ($computerName -eq $script:expectedHost -and $configuration.remoteCredential -and $OperationName -eq 'Dependency publishing') 'Wrong remoting target or credential context'
        if ($script:scenario -eq 'connect') { throw 'Connection failed' }
        'session'
    }
    function Invoke-Command {
        param($Session,$ScriptBlock,[object[]]$ArgumentList)
        Assert ($Session -eq 'session') 'Wrong session'
        $result=& $ScriptBlock @ArgumentList
        if ($result -and $result.PSObject.Properties['Root']) {
            $script:stage=$result.Path
            if ($script:scenario -eq 'callback') { $result.Path=[IO.Path]::Combine($result.Root,'outside-stage') }
        }
        $result
    }
    function Remove-PSSession { $script:closed=$true }
    function Get-CimInstance {
        [pscustomobject]@{Name='MicrosoftDynamicsNavServer$BC230';PathName='"C:\BC23\Service\Microsoft.Dynamics.Nav.Server.exe" $BC230'}
        [pscustomobject]@{Name='MicrosoftDynamicsNavServer$BC240';PathName='"C:\BC24\Service\Microsoft.Dynamics.Nav.Server.exe" $BC240'}
    }
    function Test-Path {
        param($LiteralPath,$PathType)
        if ($LiteralPath -eq 'C:\BC23\Service\NavAdminTool.ps1') { return $true }
        if ($PathType) { Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType }
        else { Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath }
    }
    function Import-Module {
        param($Name,[switch]$Global)
        Assert ($Name -eq 'C:\BC23\Service\NavAdminTool.ps1' -and $Global) 'Wrong service administration tools or module scope'
        if ($script:scenario -eq 'import') { throw 'Import failed' }
    }
    function Get-Command { $true }
    function Copy-Item {
        param($LiteralPath,$Destination,$ToSession)
        Assert ($ToSession -eq 'session' -and [IO.Path]::GetDirectoryName($Destination) -eq $script:stage) 'Copy escaped staging or selected session'
        if ($script:scenario -eq 'copy') { throw 'Copy failed' }
        Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination
        $script:copies++
    }
    function Get-NAVAppInfo {
        param($Path,$ServerInstance,$Tenant,[switch]$TenantSpecificProperties)
        if ($Path) {
            $app=Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
            if ($script:scenario -eq 'cycle' -and $app.AppId -eq 'base') { $app.Dependencies=@(@{Id='child'}) }
            return $app
        }
        Assert ($ServerInstance -eq 'BC230' -and $Tenant -eq 'selected-tenant' -and $TenantSpecificProperties) 'Discovery escaped the selected target'
        [pscustomobject]@{AppId='already';Version='1.0.0.0';IsInstalled=$true}
        [pscustomobject]@{AppId='upgrade';Version='1.0.0.0';IsInstalled=$true}
    }
    function Publish-NAVApp {
        param($ServerInstance,$Path,$Scope,$Tenant)
        Assert ($ServerInstance -eq 'BC230' -and $Scope -eq 'Tenant' -and $Tenant -eq 'selected-tenant') 'Publish escaped the selected instance/tenant'
        if ($script:scenario -eq 'publish') { throw 'Publish failed' }
        $app=Get-NAVAppInfo -Path $Path
        $script:changes.Add("publish:$($app.Name):$($app.Version)")
    }
    function Sync-NAVApp {
        param($ServerInstance,$Tenant,$Name,$Mode)
        Assert ($ServerInstance -eq 'BC230' -and $Tenant -eq 'selected-tenant' -and $Mode -eq 'Add') 'Sync escaped selected target or used destructive mode'
        if ($script:scenario -eq 'sync') { throw 'Sync failed' }
    }
    function Install-NAVApp { param($Name) if ($script:scenario -eq 'install') { throw 'Install failed' }; $script:changes.Add("install:$Name") }
    function Start-NAVAppDataUpgrade { param($Name) if ($script:scenario -eq 'upgrade') { throw 'Upgrade failed' }; $script:changes.Add("upgrade:$Name") }
    function Uninstall-NAVApp { throw 'Dependency publishing must not uninstall existing apps' }
    function Unpublish-NAVApp { throw 'Dependency publishing must not unpublish existing apps' }
    function Write-Host { param($Object) $script:messages.Add([string]$Object) }
    foreach ($scenario in @('success','connect','import','callback','copy','cycle','publish','sync','install','upgrade')) {
        $script:scenario=$scenario; $script:expectedHost='bc-host'; $script:stage=''; $script:closed=$false; $script:copies=0
        $script:changes=[Collections.Generic.List[string]]::new(); $script:messages=[Collections.Generic.List[string]]::new()
        $caught=$false
        try { Publish-Dependencies -settingsJSON $settings } catch { $caught=$true }
        Assert ($caught -eq ($scenario -ne 'success')) "$scenario outcome was not propagated"
        Assert ($script:closed -eq ($scenario -ne 'connect')) "$scenario leaked its session"
        if ($script:stage) { Assert (-not (Test-Path -LiteralPath $script:stage)) "$scenario left staged files behind" }
        if ($scenario -eq 'success') {
            Assert ($script:copies -eq 4) 'Not all configured apps and archives were copied'
            Assert ($script:changes.IndexOf('publish:Base:2.0.0.0') -lt $script:changes.IndexOf('publish:Child:2.0.0.0')) 'Dependency prerequisite order was lost'
            Assert (-not ($script:changes -contains 'publish:Base:1.0.0.0')) 'Older duplicate dependency was published'
            Assert ($script:changes -contains 'upgrade:Upgrade') 'Installed dependency was not upgraded'
            Assert (-not ($script:changes -contains 'install:Already')) 'Already installed dependency was installed again'
            Assert (@($script:messages | Where-Object { $_ -like 'Successfully published dependency*' }).Count -eq 3) 'Dependency outcome messages missing'
        } else {
            Assert (@($script:messages | Where-Object { $_ -like 'Successfully published dependency*' }).Count -eq 0) 'Failed operation reported success'
            if ($scenario -eq 'cycle') { Assert ($script:changes.Count -eq 0) 'Dependency cycle was detected after changing apps' }
        }
    }
    $script:scenario='success'; $script:expectedHost='management-host'; $configuration | Add-Member managementServer 'management-host'
    Publish-Dependencies -settingsJSON $settings
} finally {
    foreach ($file in $files) { Remove-Item -LiteralPath (Join-Path $fixtureRoot $file) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $fixtureRoot -Force
}
