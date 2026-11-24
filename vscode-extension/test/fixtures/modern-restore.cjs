'use strict';

const ids={
  system:'00000000-0000-0000-0000-000000000001',
  foundation:'00000000-0000-0000-0000-000000000002',
  base:'00000000-0000-0000-0000-000000000003',
  application:'00000000-0000-0000-0000-000000000004',
  extra:'00000000-0000-0000-0000-000000000005',
  partner:'00000000-0000-0000-0000-000000000006'
};
const names={system:'System Application',foundation:'Business Foundation',base:'Base Application',application:'Application',extra:'Microsoft Extra Component'};
const implicitApplicationId='10000000-0000-0000-0000-000000000044';
const zeroId='00000000-0000-0000-0000-000000000000';
const nativeDependencyDtoScript=`
  if(-not ('BcNativeDependencyFixture' -as [type])){
    Add-Type -TypeDefinition @'
using System;
public sealed class BcNativeDependencyFixture {
  public Guid AppId {get;set;}
  public string Name {get;set;}
  public string Publisher {get;set;}
  public Version MinVersion {get;set;}
}
public sealed class BcNativeDependencyAliasFixture {
  public Guid AppId {get;set;}
  public string Name {get;set;}
  public string Publisher {get;set;}
  public Version MinVersion {get;set;}
  public Version Version {get;set;}
}
'@
  }
  function Convert-FixtureNativeDependencies {
    param($Dependencies,[switch]$VersionAlias)
    foreach($dependency in @($Dependencies)){
      $native=if($VersionAlias){[BcNativeDependencyAliasFixture]::new()}else{[BcNativeDependencyFixture]::new()}
      $native.AppId=[Guid]$dependency.AppId;$native.Name=[string]$dependency.Name;$native.Publisher=[string]$dependency.Publisher
      $native.MinVersion=[Version]$dependency.MinVersion
      if($VersionAlias){$native.Version=if($null -ne $dependency.PSObject.Properties['Version']){[Version]$dependency.Version}else{[Version]$dependency.MinVersion}}
      $native
    }
  }
`;
const commandParameters={
  'Get-NAVAppInfo':['ServerInstance','Tenant','TenantSpecificProperties','Path','Id','Name','Publisher','Version'],
  'Publish-NAVApp':['ServerInstance','Path','SkipVerification','Force'],
  'Sync-NAVApp':['ServerInstance','Tenant','AppId','Name','Publisher','Version','Mode','Force'],
  'Install-NAVApp':['ServerInstance','Tenant','AppId','Name','Publisher','Version','Force'],
  'Start-NAVAppDataUpgrade':['ServerInstance','Tenant','AppId','Name','Publisher','Version','SyncMode','Force'],
  'Sync-NAVTenant':['ServerInstance','Tenant','Mode','Force','Confirm'],
  'Start-NAVDataUpgrade':['ServerInstance','Tenant','SkipAppVersionCheck','FunctionExecutionMode','Force'],
  'Get-NAVDataUpgrade':['ServerInstance','Tenant'],
  'Repair-NAVApp':['ServerInstance','Tenant','AppId','Name','Publisher','Version'],
  'Restart-NAVServerInstance':['ServerInstance'],
  'Get-NAVServerSession':['ServerInstance','Tenant'],
  'Remove-NAVServerSession':['ServerInstance','Tenant','SessionId','Force','Confirm']
};
function state(major=27,aligned=false) {
  const old=major+'.0.38460.40242';const target=major+'.13.57301.0';
  const dependencies={system:[],foundation:['system'],base:['system','foundation'],application:['base'],extra:['base']};
  const packageApps=Object.keys(names).map(key=>({
    Id:ids[key],Name:names[key],Publisher:'Microsoft',Version:target,
    Path:'C:\\Applications\\'+names[key]+'\\Microsoft_'+names[key]+'.app',
    Dependencies:dependencies[key].map(dependency=>({AppId:ids[dependency],Name:names[dependency],Publisher:'Microsoft',MinVersion:target}))
  }));
  const installed=packageApps.map(app=>({...app,Version:aligned?target:old,IsInstalled:true,
    Dependencies:app.Dependencies.map(dependency=>({...dependency,MinVersion:aligned?target:old}))}));
  return {PlatformVersion:major+'.0.57239.0',TenantId:'default',Multitenant:false,TenantState:'Operational',AllowAppDatabaseWrite:true,InstalledApps:installed,
    PackageApps:packageApps,Capabilities:structuredClone(commandParameters)};
}
function implicitApplicationState({major=27,payroll=false,transitive=false}={}) {
  const data=state(major);
  for(const app of [...data.PackageApps,...data.InstalledApps]) {
    if(app.Id===ids.application) app.Id=implicitApplicationId;
    for(const dependency of app.Dependencies) if(dependency.AppId===ids.application) dependency.AppId=implicitApplicationId;
  }
  data.PackageApps.find(app=>app.Id===ids.extra).Dependencies=[{AppId:zeroId,Name:'Application',Publisher:'Microsoft',MinVersion:major+'.13.0.0'}];
  data.InstalledApps.find(app=>app.Id===ids.extra).Dependencies=[{AppId:zeroId,Name:'Application',Publisher:'Microsoft',MinVersion:major+'.0.0.0'}];
  if(payroll) data.InstalledApps.push({Id:ids.partner,Name:'Payroll',Publisher:'Payroll Vendor',Version:'1.3.0.0',IsInstalled:true,IsRuntimePackage:false,Dependencies:[{AppId:zeroId,Name:'Application',Publisher:'Microsoft',MinVersion:major+'.0.0.0'}]});
  if(transitive) data.InstalledApps.push({Id:'00000000-0000-0000-0000-000000000007',Name:'Payroll Reporting',Publisher:'Payroll Vendor',Version:'1.0.0.0',IsInstalled:true,IsRuntimePackage:false,Dependencies:[{AppId:ids.partner,Name:'Payroll',Publisher:'Payroll Vendor',MinVersion:'1.3.0.0'}]});
  return data;
}
function workflowFixture(options={}) {
  const {mode='upgrade',major=27,multitenant=false,entryPoint='restore',tenantSelection='omitted',captureMessages=true}=options;
  const selectionArguments={omitted:'',null:' -TenantIds $null',empty:' -TenantIds @()',blank:" -TenantIds @('')",whitespace:" -TenantIds @(' ')",unknown:" -TenantIds @('unknown')",'mixed-null':" -TenantIds @('default',$null)",'mixed-blank':" -TenantIds @('default','')"};
  if(!Object.hasOwn(selectionArguments,tenantSelection)) throw new Error('Unsupported fixture selection');
  const invocation=entryPoint==='creation'
    ? 'Invoke-BcContainerSystemApplicationUpgradeAfterRestore -containerName target'+selectionArguments[tenantSelection]
    : 'Restore-BcContainerSqlBackupEntries -containerName target -bakFolder unused -backupEntries @($entries) -configuration ([pscustomobject]@{})';
  const runtimeParameters=mode==='runtime-parameters-missing'?'':mode==='runtime-parameters-string'?',[string]$usePwsh,[bool]$useSession':',[bool]$usePwsh=$script:runtime.usePwshForBc24,[bool]$useSession=$true';
  const syncBinding=mode==='sync-cap-confirm-missing'?'[CmdletBinding()]':'[CmdletBinding(SupportsShouldProcess)]';
  const syncForceParameter=mode==='sync-cap-force-missing'?'':',[switch]$Force';
  const data=mode.startsWith('implicit-')?implicitApplicationState({major,payroll:mode.includes('payroll'),transitive:mode.includes('transitive')}):state(major,mode==='aligned');
  if(mode==='implicit-minimum-conflict') {
    const dependency=data.PackageApps.find(app=>app.Id===ids.extra).Dependencies[0];dependency.MinVersion=major+'.14.0.0';dependency.Version=major+'.0.0.0';
  }
  if(mode==='implicit-payroll-minimum-conflict') {
    const dependency=data.InstalledApps.find(app=>app.Id===ids.partner).Dependencies[0];dependency.MinVersion=major+'.14.0.0';dependency.Version=major+'.0.0.0';
  }
  if(mode==='implicit-snapshot-minimum-alias') data.PackageApps.find(app=>app.Id===ids.extra).Dependencies[0].Version=major+'.0.0.0';
  data.Multitenant=multitenant;
  if(mode==='install'||mode.startsWith('install-')) data.InstalledApps=data.InstalledApps.filter(app=>app.Id!==ids.foundation);
  if(mode==='unequal-components') {
    data.PackageApps.forEach((app,index)=>{app.Version=major+'.'+(8+index)+'.57301.0'});
    for(const app of data.PackageApps) for(const dependency of app.Dependencies) dependency.MinVersion=data.PackageApps.find(item=>item.Id===dependency.AppId).Version;
  }
  if(mode==='repair'||mode.startsWith('repair-')||mode.startsWith('restart-')||mode==='selected-scope-repair') data.InstalledApps.push({Id:ids.partner,Name:'Partner Component',Publisher:'Partner',Version:'1.0.0.0',IsInstalled:true,IsRuntimePackage:false,Dependencies:[{AppId:ids.base,Name:names.base,Publisher:'Microsoft',MinVersion:major+'.0.0.0'}]});
  if(mode==='duplicate-identity-tuple') {
    const packageCopy=structuredClone(data.PackageApps.find(app=>app.Id===ids.extra));packageCopy.Id='00000000-0000-0000-0000-000000000007';packageCopy.Path='C:\\Applications\\Duplicate\\Duplicate.app';data.PackageApps.push(packageCopy);
    const installedCopy=structuredClone(data.InstalledApps.find(app=>app.Id===ids.extra));installedCopy.Id=packageCopy.Id;data.InstalledApps.push(installedCopy);
  }
  const json=JSON.stringify(data).replaceAll("'","''");
  return `
    $script:fixture=ConvertFrom-Json '${json}'
    ${mode.startsWith('implicit-')?nativeDependencyDtoScript:''}
    ${['sync-unknown-null-hresult','sync-wrapped-unknown-null-hresult'].includes(mode)?`
      Add-Type -TypeDefinition @'
using System;
public sealed class UnknownSyncFailureFixture : Exception {
  public UnknownSyncFailureFixture() : base("PRIVATE unknown backend password=secret") { HResult=-2147467261; }
}
'@
    `:''}
    # All external BC commands below are synthetic. Never auto-load a real
    # machine module while discovering their command parameter metadata.
    $PSModuleAutoLoadingPreference='None'
    $script:mode='${mode}';$script:events=[Collections.Generic.List[object]]::new()
    $script:runtime=@{usePwshForBc24=$true};$script:runtimeCalls=[Collections.Generic.List[object]]::new();$script:syncCalls=[Collections.Generic.List[object]]::new();$script:boundary='';$script:sql=0;$script:admin=0;$script:polls=0;$script:packageReads=0;$script:nativeDependencyReads=0;$script:nativePackageReads=0;$script:nativeInstalledReads=0;$script:adminTenants=@()
    $script:tenantIds=${mode.startsWith('selected-scope')?"@('default','north')":multitenant?"@('north','south')":"@('default')"}
    $script:installed=@{}
    $script:mountStates=@{}
    foreach($tenant in $script:tenantIds){$script:installed[$tenant]=@($script:fixture.InstalledApps|ForEach-Object {$_|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json})}
    foreach($tenant in $script:tenantIds){$script:mountStates[$tenant]=if($script:mode -eq 'sync-pending'){'OperationalWithSyncPending'}else{'Operational'}}
    if($script:mode -eq 'selected-scope-unselected-pending'){$script:mountStates.north='OperationalWithSyncPending'}
    $script:published=@($script:fixture.InstalledApps|ForEach-Object {$_|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json})
    if($script:mode -eq 'progress-catalog-reuse'){$script:published+=@($script:fixture.PackageApps)}
    if($script:mode -eq 'second-tenant-blocked'){$script:installed.south[0].Version='${major}.99.99999.0'}
    if($script:mode -eq 'selected-scope-conflict'){$script:installed.north[0].Version='${major}.99.99999.0'}
    function Add-FixtureEvent {param($Stage,$Tenant='',$App=$null) $script:events.Add([pscustomobject]@{Stage=$Stage;Tenant=[string]$Tenant;Id=[string]$App.Id;Name=[string]$App.Name;Version=[string]$App.Version})}
    function Invoke-FixtureFailure {
      param($Stage)
      if($script:mode -in @(($Stage+'-throw'),('serialized-'+$Stage+'-throw'))){throw [InvalidOperationException]::new('PRIVATE backend password=secret')}
      if($script:mode -in @(($Stage+'-error'),('serialized-'+$Stage+'-error'))){Write-Error 'PRIVATE backend password=secret'}
    }
    function Find-FixtureApp {param($Id,$Name,$Version)
      @($script:fixture.PackageApps|Where-Object {if($Id){[string]$_.Id -eq [string]$Id}else{$_.Name -eq $Name}}|Where-Object {-not $Version -or [string]$_.Version -eq [string]$Version})|Select-Object -First 1
    }
    function Convert-FixtureWireApp {param($App,$Kind)
      $wire=$App|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json
      if($script:mode -like 'implicit-*'){
        $wire.Dependencies=@(Convert-FixtureNativeDependencies $wire.Dependencies -VersionAlias:($script:mode -like '*conflict*' -or $script:mode -like '*alias*'))
        $script:nativeDependencyReads++
        if($Kind -eq 'package'){$script:nativePackageReads++}
        if($Kind -eq 'installed'){$script:nativeInstalledReads++}
        foreach($dependency in $wire.Dependencies){
          if($dependency.AppId -isnot [Guid] -or $dependency.MinVersion -isnot [Version] -or $null -ne $dependency.PSObject.Properties['Id']){throw 'UNEXPECTED NONNATIVE DEPENDENCY SHAPE'}
        }
      }
      return $wire
    }
    function Set-FixtureInstalled {param($Tenant,$App)
      if($script:mode -eq 'verify-mismatch'){return}
      $existing=@($script:installed[$Tenant]|Where-Object Id -eq $App.Id)
      if($existing.Count){foreach($item in $existing){$item.Version=[string]$App.Version;$item.IsInstalled=$true}}
      else {$copy=$App|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json;$copy|Add-Member IsInstalled $true -Force;$script:installed[$Tenant]=@($script:installed[$Tenant])+@($copy)}
    }
    function Get-BcRestoreRuntimeConfiguration {$script:runtime}
    function Get-BcContainerSqlBackupRestoreParameters {@{containerName='target';bakFolder='unused'}}
    function Restore-DatabasesInBcContainer {
      if(-not $script:fixture.Multitenant -and $script:runtime.usePwshForBc24){throw 'UNEXPECTED SQL RUNTIME'}
      $script:sql++;Add-FixtureEvent 'sql'
    }
    function Get-Variable {
      [CmdletBinding()]param($Name,$Scope,[switch]$ValueOnly)
      if($Name -eq 'PSSenderInfo' -and (($script:mode -eq 'unexpected-discovery-runtime' -and $script:boundary -eq 'discovery') -or ($script:mode -eq 'unexpected-executor-runtime' -and $script:boundary -eq 'executor'))){
        return [psvariable]::new('PSSenderInfo',[pscustomobject]@{ConnectionString='PRIVATE forbidden remoting password=secret'})
      }
      Microsoft.PowerShell.Utility\\Get-Variable @PSBoundParameters
    }
    function Invoke-ScriptInBcContainer {param($containerName,$ScriptBlock,[object[]]$ArgumentList${runtimeParameters})
      if($containerName -ne 'target'){throw 'UNEXPECTED TARGET'}
      $body=$ScriptBlock.ToString()
      $script:boundary=if($body -match 'BcModernUpgradeResult'){'executor'}elseif($body -match 'Convert-ModernRestoreAppMetadata'){'discovery'}else{'context'}
      if($script:boundary -ne 'context'){
        $script:runtimeCalls.Add([pscustomobject]@{Boundary=$script:boundary;UsePwsh=$usePwsh;UseSession=$useSession;ExplicitPwsh=$PSBoundParameters.ContainsKey('usePwsh');ExplicitSession=$PSBoundParameters.ContainsKey('useSession');GlobalUsePwsh=$script:runtime.usePwshForBc24})
        if(-not $usePwsh -or $useSession -or -not $PSBoundParameters.ContainsKey('usePwsh') -or -not $PSBoundParameters.ContainsKey('useSession')){throw 'UNEXPECTED MODERN RUNTIME ARGUMENTS'}
      }
      if($script:mode -eq 'unsafe-planned-path' -and $ScriptBlock.ToString() -match 'BcModernUpgradeResult'){
        $ArgumentList[0][0].Actions[0].Path='C:\\outside\\PRIVATE password=secret.app'
      }
      if($script:mode -like 'transport-*' -and $ScriptBlock.ToString() -match 'BcModernUpgradeResult'){
        Add-FixtureEvent 'transport-result'
        # Make a false accepted success observable: post-state would otherwise
        # look aligned, so only strict transport-result validation prevents admin.
        foreach($tenant in $script:tenantIds){foreach($app in $script:fixture.PackageApps){Set-FixtureInstalled $tenant $app}}
        $record=[pscustomobject]@{BcModernUpgradeResult=1;Passed=$true;Step='complete';ErrorCode=$null;WritesStarted=$true}
        if($script:mode -eq 'transport-string-marker'){$record.BcModernUpgradeResult='1'}
        if($script:mode -eq 'transport-error-code'){$record.ErrorCode=-2146233079}
        if($script:mode -eq 'transport-invalid-write-state'){$record.WritesStarted='true'}
        if($script:mode -in @('transport-unknown-failure-kind','transport-nonstring-failure-kind','transport-code-only-nullref','transport-invalid-marker-nullref')){
          $record.Passed=$false;$record.Step='tenant synchronization';$record.ErrorCode=-2147467261
          $kind=switch($script:mode){
            'transport-unknown-failure-kind' {'PRIVATE backend type password=secret'}
            'transport-nonstring-failure-kind' {,@('NullReference')}
            'transport-code-only-nullref' {'Unknown'}
            default {'NullReference'}
          }
          $record|Add-Member FailureKind $kind
          if($script:mode -eq 'transport-invalid-marker-nullref'){$record.WritesStarted=$false;$record.BcModernUpgradeResult='1'}
        }
        if($script:mode -eq 'transport-success-failure-kind'){$record.WritesStarted=$false;$record|Add-Member FailureKind 'NullReference'}
        if($script:mode -in @('transport-unknown-reason','transport-nonstring-reason')){
          $record.Passed=$false;$record.Step='publication preflight';$record.WritesStarted=$false;$record.ErrorCode=-2146233087
          $record|Add-Member ReasonCode $(if($script:mode -eq 'transport-unknown-reason'){'PRIVATE unknown reason password=secret'}else{,@('UnsafeMediaPath')})
          $record|Add-Member AppId 'PRIVATE invalid identity password=secret'
          $record|Add-Member Version 'PRIVATE invalid version password=secret'
        }
        if($script:mode -eq 'transport-missing-result'){return}
        if($script:mode -eq 'transport-extra-record'){$record;$record;return}
        return $record
      }
      if($script:mode -like 'serialized-*'){
        $transportArguments=[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($ArgumentList))
        $transportResult=@(& $ScriptBlock @transportArguments)
        foreach($item in $transportResult){[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($item))}
      }else{& $ScriptBlock @ArgumentList}
    }
    function Get-NAVServerConfiguration { [CmdletBinding()]param($ServerInstance,$KeyName)
      [pscustomobject]@{Value=([string]$script:fixture.Multitenant).ToLowerInvariant();KeyValue=([string]$script:fixture.Multitenant).ToLowerInvariant()}
    }
    function Get-NAVTenant { [CmdletBinding()]param($ServerInstance,$Tenant)
      foreach($id in $script:tenantIds){if(-not $Tenant -or $Tenant -eq $id){[pscustomobject]@{Id=$id;State=$(if($script:mode -eq 'tenant-not-ready'){'OperationalWithSyncFailure'}else{$script:mountStates[$id]});AllowAppDatabaseWrite=($script:mode -ne 'no-appdb-write')}}}
    }
    function Get-Item { [CmdletBinding()]param($Path,$LiteralPath)
      $requested=if($LiteralPath){$LiteralPath}else{$Path}
      if($requested -like '*Microsoft.Dynamics.Nav.Server.exe'){[pscustomobject]@{FullName=$requested;VersionInfo=@{FileVersion=$script:fixture.PlatformVersion}};return}
      if($requested -like '*Microsoft Dynamics NAV*Service'){[pscustomobject]@{FullName='C:\\fixture\\Service'};return}
      if($requested -eq 'C:\\Applications'){[pscustomobject]@{FullName=$requested;Attributes=[IO.FileAttributes]::Directory;PSIsContainer=$true};return}
      if($requested -like 'C:\\Applications\\*'){[pscustomobject]@{FullName=$requested;Attributes=$(if($script:mode -eq 'linked-media' -and $requested -like '*.app'){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal});PSIsContainer=$false;Length=100};return}
      throw 'UNEXPECTED FILE ACCESS'
    }
    function Test-Path { [CmdletBinding()]param($Path,$LiteralPath,$PathType) $true }
    function Get-ChildItem { [CmdletBinding()]param($Path,$LiteralPath,$Filter,[switch]$File,[switch]$Recurse)
      $root=if($LiteralPath){$LiteralPath}else{$Path}
      if($root -ne 'C:\\Applications'){throw 'UNEXPECTED PACKAGE ROOT'}
      foreach($app in $script:fixture.PackageApps){[pscustomobject]@{FullName=$app.Path;Name=([IO.Path]::GetFileName($app.Path));Attributes=[IO.FileAttributes]::Normal;PSIsContainer=$false;Length=100}}
    }
    function Get-NAVAppInfo { [CmdletBinding()]param($ServerInstance,$Tenant,$Path,$Id,$AppId,$Name,$Publisher,$Version,[switch]$TenantSpecificProperties)
      if($Path){
        $script:packageReads++
        $app=@($script:fixture.PackageApps|Where-Object Path -eq $Path);if($app.Count -ne 1){throw 'UNEXPECTED PACKAGE QUERY'}
        if($script:mode -like 'package-*-changed' -and $script:packageReads -gt ($script:tenantIds.Count*$script:fixture.PackageApps.Count)){
          $copy=$app[0]|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json
          if($script:mode -eq 'package-version-changed'){$copy.Version='${major}.14.99999.0'}
          else {$copy.Dependencies=@([pscustomobject]@{AppId='${ids.partner}';Name='Unexpected prerequisite';Publisher='Partner';MinVersion='1.0.0.0'})}
          return $copy
        }
        if($script:mode -like 'implicit-snapshot-*' -and $script:packageReads -gt ($script:tenantIds.Count*$script:fixture.PackageApps.Count) -and $app[0].Id -eq '${ids.extra}'){
          $copy=$app[0]|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json
          if($script:mode -like '*minimum*'){$copy.Dependencies[0].MinVersion='${major}.14.0.0'}
          if($script:mode -eq 'implicit-snapshot-unknown-zero'){$copy.Dependencies[0].Name='Not Application'}
          if($script:mode -eq 'implicit-snapshot-other-id'){$copy.Dependencies[0].AppId='${ids.base}'}
          return Convert-FixtureWireApp $copy 'package'
        }
        return Convert-FixtureWireApp $app[0] 'package'
      }
      if(-not $Tenant -and -not $TenantSpecificProperties){
        if(-not $Id -or -not $Version){throw 'UNEXPECTED AMBIGUOUS PUBLISHED QUERY'}
        if($script:mode -in @('ambiguous-publication','conflicting-publication')){
          $copy=Find-FixtureApp $Id $Name $Version
          if($script:mode -eq 'ambiguous-publication'){return @($copy,$copy)}
          $conflict=$copy|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json;$conflict.Id='00000000-0000-0000-0000-000000000099';return $conflict
        }
        return @($script:published|Where-Object {([string]$_.Id -eq [string]$Id) -and [string]$_.Version -eq [string]$Version})
      }
      if(-not $TenantSpecificProperties){throw 'UNEXPECTED PUBLISHED ONLY QUERY'}
      if($Tenant -notin $script:tenantIds){throw 'UNEXPECTED TENANT QUERY'}
      Add-FixtureEvent 'query' $Tenant
      Invoke-FixtureFailure 'query'
      $wanted=if($Id){$Id}else{$AppId}
      $apps=@($script:installed[$Tenant])
      if($wanted -or $Name){return @($apps|Where-Object {(-not $wanted -or [string]$_.Id -eq [string]$wanted) -and (-not $Name -or $_.Name -eq $Name) -and (-not $Version -or [string]$_.Version -eq [string]$Version)}|ForEach-Object {Convert-FixtureWireApp $_ 'installed'})}
      foreach($app in $apps){
        $summary=$app|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json
        $summary.PSObject.Properties.Remove('Dependencies')
        if($script:mode -eq 'missing-installed-marker'){$summary.PSObject.Properties.Remove('IsInstalled')}
        $summary
      }
      # Merely published media version must never be mistaken for installed state.
      foreach($package in $script:fixture.PackageApps){$copy=$package|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json;$copy|Add-Member IsInstalled $false -Force;$copy.Version='${major}.99.99999.0';$copy}
    }
    function Get-NAVApplication {throw 'UNEXPECTED MODERN DATABASE VERSION QUERY'}
    function Set-NAVApplication {throw 'UNEXPECTED LEGACY APPLICATIONVERSION WRITE'}
    function Get-NAVServerSession { [CmdletBinding()]param($ServerInstance,$Tenant) }
    function Remove-NAVServerSession { [CmdletBinding(SupportsShouldProcess)]param($ServerInstance,$Tenant,$SessionId,[switch]$Force) }
    function Publish-NAVApp { [CmdletBinding()]param($ServerInstance,$Path,[switch]$SkipVerification,[switch]$Force)
      $app=@($script:fixture.PackageApps|Where-Object Path -eq $Path)[0];Add-FixtureEvent 'publish' '' $app;Invoke-FixtureFailure 'publish';$script:published+=@($app)
      if($script:mode -eq 'selected-scope-unselected-mutated'){$script:installed.north[0].Version='${major}.14.99999.0'}
    }
    function Sync-NAVApp { [CmdletBinding()]param($ServerInstance,$Tenant,$AppId,$Id,$Name,$Publisher,$Version,$Mode,[switch]$Force)
      if(-not $AppId){throw 'UNEXPECTED UNQUALIFIED SYNC TARGET'}
      if($Mode -ne 'Add'){throw 'UNEXPECTED NONADDITIVE APP SYNC'}
      $app=Find-FixtureApp $(if($AppId){$AppId}else{$Id}) $Name $Version;Add-FixtureEvent 'sync-app' $Tenant $app;Invoke-FixtureFailure 'sync-app'
    }
    function Install-NAVApp { [CmdletBinding()]param($ServerInstance,$Tenant,$AppId,$Id,$Name,$Publisher,$Version,[switch]$Force)
      if(-not $AppId){throw 'UNEXPECTED UNQUALIFIED INSTALL TARGET'}
      $app=Find-FixtureApp $(if($AppId){$AppId}else{$Id}) $Name $Version;Add-FixtureEvent 'install' $Tenant $app;Invoke-FixtureFailure 'install';Set-FixtureInstalled $Tenant $app
    }
    function Start-NAVAppDataUpgrade { [CmdletBinding()]param($ServerInstance,$Tenant,$AppId,$Id,$Name,$Publisher,$Version,$SyncMode,[switch]$Force)
      if(-not $AppId){throw 'UNEXPECTED UNQUALIFIED UPGRADE TARGET'}
      $app=Find-FixtureApp $(if($AppId){$AppId}else{$Id}) $Name $Version;Add-FixtureEvent 'app-upgrade' $Tenant $app;Invoke-FixtureFailure 'app-upgrade';Set-FixtureInstalled $Tenant $app
    }
    function Sync-NAVTenant { ${syncBinding}param($ServerInstance,$Tenant,$Mode${syncForceParameter})
      if($Mode -ne 'Sync'){throw 'UNEXPECTED TENANT SYNC MODE'}
      $script:syncCalls.Add([pscustomobject]@{Tenant=$Tenant;Mode=$Mode;Force=[bool]$Force;ExplicitForce=$PSBoundParameters.ContainsKey('Force');Confirm=[bool]$PSBoundParameters['Confirm'];ExplicitConfirm=$PSBoundParameters.ContainsKey('Confirm')})
      if(-not $Force -or -not $PSBoundParameters.ContainsKey('Force') -or -not $PSBoundParameters.ContainsKey('Confirm') -or [bool]$PSBoundParameters['Confirm']){throw 'UNEXPECTED ATTENDED TENANT SYNCHRONIZATION'}
      Add-FixtureEvent 'sync-tenant' $Tenant
      if($script:mode -in @('progress-block-sync','serialized-progress-block-sync')){
        [Console]::WriteLine('BC_FIXTURE_SYNC_ENTERED')
        if([Console]::ReadLine() -ne 'continue'){throw 'UNEXPECTED SYNC RELEASE SIGNAL'}
        [Console]::WriteLine('BC_FIXTURE_SYNC_RETURNED')
      }
      if($script:mode -in @('sync-null-reference','serialized-sync-null-reference')){throw [NullReferenceException]::new('PRIVATE backend license/schema/confirmation password=secret')}
      if($script:mode -eq 'sync-unknown-null-hresult'){throw [UnknownSyncFailureFixture]::new()}
      if($script:mode -eq 'sync-unknown-failure'){throw [InvalidOperationException]::new('PRIVATE backend license/schema/confirmation password=secret')}
      if($script:mode -eq 'sync-wrapped-null-reference'){throw [InvalidOperationException]::new('PRIVATE outer password=secret',[NullReferenceException]::new('PRIVATE inner password=secret'))}
      if($script:mode -eq 'sync-wrapped-unknown-null-hresult'){throw [InvalidOperationException]::new('PRIVATE outer password=secret',[UnknownSyncFailureFixture]::new())}
      Invoke-FixtureFailure 'sync-tenant';$script:mountStates[$Tenant]='Operational'
    }
    function Start-NAVDataUpgrade { [CmdletBinding()]param($ServerInstance,$Tenant,$FunctionExecutionMode,[switch]$SkipAppVersionCheck,[switch]$Force)
      if(-not $SkipAppVersionCheck){throw 'UNEXPECTED MISSING SKIP APP VERSION CHECK'}
      Add-FixtureEvent 'tenant-upgrade' $Tenant;Invoke-FixtureFailure 'tenant-upgrade'
      # Tenant data upgrade cannot choose newer versions while old publications
      # remain. Only explicit per-app upgrade/install changes this fixture state.
    }
    function Get-NAVDataUpgrade { [CmdletBinding()]param($ServerInstance,$Tenant)
      $script:polls++;if($script:polls -gt 250){throw 'UNEXPECTED UNBOUNDED POLL'}
      Add-FixtureEvent 'upgrade-status' $Tenant
      [pscustomobject]@{State=$(if($script:mode -eq 'job-error'){'Failed'}elseif($script:mode -eq 'job-timeout' -or ($script:mode -eq 'job-pending' -and $script:polls -eq 1)){'InProgress'}else{'Completed'});Errors=@();ExecutionErrors=@()}
    }
    function Repair-NAVApp { [CmdletBinding()]param($ServerInstance,$Tenant,$AppId,$Id,$Name,$Publisher,$Version)
      if(-not $AppId -or [string]$AppId -notin @('${ids.partner}','00000000-0000-0000-0000-000000000007')){throw 'UNEXPECTED UNQUALIFIED REPAIR TARGET'}
      Add-FixtureEvent 'repair' $Tenant ([pscustomobject]@{Id=[string]$AppId;Name=$Name;Version=$Version});Invoke-FixtureFailure 'repair'
    }
    function Restart-NAVServerInstance { [CmdletBinding()]param($ServerInstance)
      Add-FixtureEvent 'restart';Invoke-FixtureFailure 'restart'
    }
    function Start-Sleep {param($Seconds,$Milliseconds)}
    function Repair-BcContainerAdministratorAfterRestore {param($configuration,$tenants) $script:admin++;$script:adminTenants=@($tenants);Add-FixtureEvent 'admin' ($tenants -join ',')}
    $entries=${mode.startsWith('selected-scope')?"@([pscustomobject]@{DatabaseRole='tenant';DatabaseName='default'})":multitenant?"@('north','south')|ForEach-Object {[pscustomobject]@{DatabaseRole='tenant';DatabaseName=$_}}":"@([pscustomobject]@{DatabaseRole='database';DatabaseName='CRONUS'})"}
    $script:messages=@();$failure=$null
    try {${invocation}${captureMessages?' 6>&1|ForEach-Object {$script:messages += [string]$_}':''}}
    catch {$failure=$_.Exception}
    @{events=@($script:events);sql=$script:sql;admin=$script:admin;adminTenants=$script:adminTenants;installed=$script:installed;runtimeCalls=@($script:runtimeCalls);syncCalls=@($script:syncCalls);nativeDependencyReads=$script:nativeDependencyReads;nativePackageReads=$script:nativePackageReads;nativeInstalledReads=$script:nativeInstalledReads;polls=$script:polls;runtime=$script:runtime.usePwshForBc24;message=$failure.Message;stage=$(if($failure){$failure.Data['Stage']});expected=$(if($failure){$failure.Data['BcDevToolsetExpectedFailure']});messages=$script:messages}|ConvertTo-Json -Depth 20 -Compress
    if($failure){exit 1}
  `;
}
module.exports={ids,names,commandParameters,state,implicitApplicationState,implicitApplicationId,zeroId,nativeDependencyDtoScript,workflowFixture};
