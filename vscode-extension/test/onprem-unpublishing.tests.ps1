$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$configuration = [pscustomobject]@{name='selected';serverType='OnPrem';targetType='Dev';server='http://bc-host:8080/BC230';serverInstance='BC230';tenant='tenant-one';remoteCredential=$true}
$workspaceApps = @(
    [pscustomobject]@{Name='Payroll';AppId='payroll-id';ProcessOrder=1},
    [pscustomobject]@{Name='Tests';AppId='tests-id';ProcessOrder=2},
    [pscustomobject]@{Name='Absent';AppId='absent-id';ProcessOrder=3}
)
function Get-AppJSON { param($scriptPath,$appPath,[ref]$appJSON) $appJSON.Value=@{application='23.0'} }
function Get-AppDependencies { $workspaceApps }
function Test-IsLocalSqlServer { $false }
function Initialize-OnPremPublishingManagement { throw 'Remote unpublishing must not require local administration tools' }
function New-RemoteBackupSession {
    param($computerName,$configuration,$OperationName)
    Assert ($computerName -eq $script:expectedHost -and $configuration.remoteCredential -and $OperationName -eq 'Unpublish') 'Selected host/credential context was not passed to remoting'
    if ($script:scenario -eq 'connect') { throw 'Connection failed' }
    'session'
}
function Invoke-Command { param($Session,$ScriptBlock,[object[]]$ArgumentList) Assert ($Session -eq 'session') 'Wrong session'; & $ScriptBlock @ArgumentList }
function Remove-PSSession { $script:closed=$true }
function Get-CimInstance {
    if ($script:scenario -eq 'service') { return }
    $executable = if ($script:scenario -eq 'path') { 'malformed.exe' } else { '"C:\BC23\Service\Microsoft.Dynamics.Nav.Server.exe" $BC230' }
    [pscustomobject]@{Name='MicrosoftDynamicsNavServer$BC230';PathName=$executable}
    [pscustomobject]@{Name='MicrosoftDynamicsNavServer$BC240';PathName='"C:\BC24\Service\Microsoft.Dynamics.Nav.Server.exe" $BC240'}
}
function Test-Path { $script:scenario -ne 'tools' }
function Import-Module { param($Name) Assert ($Name -eq 'C:\BC23\Service\NavAdminTool.ps1') 'Loaded tools from a different BC service'; if ($script:scenario -eq 'import') { throw 'Import failed' }; $script:imported=$true }
function Get-Command { param($Name) if ($script:scenario -ne 'command') { $true } }
function Get-NAVAppInfo {
    param($ServerInstance,$Tenant,[switch]$TenantSpecificProperties)
    Assert ($ServerInstance -eq 'BC230' -and $Tenant -eq 'tenant-one' -and $TenantSpecificProperties) 'Discovery escaped selected instance/tenant'
    [pscustomobject]@{AppId='payroll-id';Name='Payroll';Publisher='Publisher';Version='1.0.0.47';Scope='Tenant';IsInstalled=$true}
    [pscustomobject]@{AppId='tests-id';Name='Tests';Publisher='Publisher';Version='1.0.0.1';Scope='Global';IsInstalled=$false}
    [pscustomobject]@{AppId='unrelated-id';Name='Payroll';Publisher='Other';Version='9.0.0.0';Scope='Tenant';IsInstalled=$true}
}
function Uninstall-NAVApp {
    param($ServerInstance,$Name,$Publisher,$Version,$Tenant,[switch]$DoNotSaveData,[switch]$DoNotSaveSchema)
    Assert ($ServerInstance -eq 'BC230' -and $Tenant -eq 'tenant-one' -and $Publisher -eq 'Publisher' -and -not $DoNotSaveData -and -not $DoNotSaveSchema) 'Uninstall changed another target or removed extension data'
    if ($script:scenario -eq 'uninstall') { throw 'Uninstall failed' }
    $script:changes.Add("uninstall:$Name`:$Version")
}
function Unpublish-NAVApp {
    param($ServerInstance,$Name,$Publisher,$Version,$Tenant)
    Assert ($ServerInstance -eq 'BC230' -and $Publisher -eq 'Publisher') 'Unpublish escaped selected app identity'
    Assert (($Name -eq 'Payroll' -and $Tenant -eq 'tenant-one') -or ($Name -eq 'Tests' -and -not $Tenant)) 'Wrong package scope'
    if ($script:scenario -eq 'unpublish') { throw 'Unpublish failed' }
    $script:changes.Add("unpublish:$Name`:$Version")
}
function Write-Host { param($Object) $script:messages.Add([string]$Object) }
foreach ($scenario in @('success','service','path','tools','command','import','uninstall','unpublish','connect')) {
    $script:scenario=$scenario; $script:closed=$false; $script:imported=$false; $script:expectedHost='bc-host'
    $script:changes=[Collections.Generic.List[string]]::new(); $script:messages=[Collections.Generic.List[string]]::new()
    $caught=$false
    try { Unpublish-Apps -scriptPath $PSScriptRoot -settingsJSON @{configurations=@($configuration)} -workspaceJSON @{folders=@(@{path='.'})} }
    catch { $caught=$true }
    Assert ($caught -eq ($scenario -ne 'success')) "$scenario outcome was not propagated"
    Assert ($script:closed -eq ($scenario -ne 'connect')) "$scenario leaked a remote session"
    if ($scenario -eq 'success') {
        Assert (($script:changes -join ',') -eq 'unpublish:Tests:1.0.0.1,uninstall:Payroll:1.0.0.47,unpublish:Payroll:1.0.0.47') 'Wrong apps, versions, or dependency order were removed'
        Assert (@($script:messages | Where-Object { $_ -like 'Successfully unpublished*' }).Count -eq 2) 'Success messages missing'
        Assert (@($script:messages | Where-Object { $_ -like "'Absent' is not published*" }).Count -eq 1) 'Missing apps should report nothing to remove'
    } else {
        Assert (@($script:messages | Where-Object { $_ -like 'Successfully unpublished*' }).Count -eq 0) 'Failed operation reported success'
    }
}
$script:scenario='success'; $script:expectedHost='management-host'; $configuration | Add-Member managementServer 'management-host'
Unpublish-RemoteOnPremWorkspaceApps -Configuration $configuration -Apps $workspaceApps
Assert $script:closed 'Explicit management host session leaked'
