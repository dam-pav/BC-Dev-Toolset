# BC27+ restore assessment deliberately uses installed app identities and package
# dependencies, never the legacy database ApplicationVersion property.
function Test-BcModernRestorePackagePath {
    param([string] $Path)
    if ($Path -notmatch '^[Cc]:[\\/]Applications[\\/]' -or
        $Path -match '[\x00-\x1f<>"|?*\[\]]' -or
        $Path.Substring(3) -match ':' -or
        $Path.Replace('/', '\') -match '(^|\\)\.\.($|\\)' -or
        [IO.Path]::GetExtension($Path) -ine '.app') { return $false }
    try {
        $normalized = [IO.Path]::GetFullPath($Path)
        return $normalized.StartsWith('C:\Applications\', [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Resolve-BcModernRestoreDependencyId {
    param([Parameter(Mandatory)] $Dependency, [Guid] $ApplicationId)
    $identity=if($Dependency.Id){$Dependency.Id}else{$Dependency.AppId}
    $id=[Guid]::Empty
    if(-not [Guid]::TryParse([string]$identity,[ref]$id)){return $null}
    if($id -ne [Guid]::Empty){return $id}
    # Native NAV metadata represents app.json's logical application dependency
    # with Guid.Empty. Resolve only that exact Microsoft Application sentinel,
    # using the unique actual media identity rather than a fixed product GUID.
    if($Dependency.Name -ceq 'Application' -and $Dependency.Publisher -ceq 'Microsoft' -and $ApplicationId -ne [Guid]::Empty){return $ApplicationId}
    return $null
}

function Get-BcModernRestoreDependencyMinimumVersion {
    param([Parameter(Mandatory)][AllowNull()] $Dependency)
    # Native MinVersion is authoritative even when invalid or empty. Version is
    # accepted only for canonical DTOs that do not expose the native property.
    if($null -ne $Dependency.PSObject.Properties['MinVersion']){return [string]$Dependency.MinVersion}
    return [string]$Dependency.Version
}

function Get-BcModernSystemApplicationUpgradeAssessment {
    param([Parameter(Mandatory)] $State)
    $reasons = [Collections.Generic.List[string]]::new()
    $apps = [Collections.Generic.List[object]]::new()
    $actions = [Collections.Generic.List[object]]::new()
    $platform = $null
    if (-not [Version]::TryParse([string]$State.PlatformVersion, [ref]$platform) -or $platform.Major -lt 27) {
        $reasons.Add('A valid BC27 or later platform version is required.')
    }
    if ($State.Multitenant -isnot [bool] -or [string]::IsNullOrWhiteSpace([string]$State.TenantId)) {
        $reasons.Add('Actual tenancy and a selected mounted tenant identity are required.')
    }
    $installed = @{}
    $packages = @{}
    foreach ($record in @($State.InstalledApps)) {
        if ($record.IsInstalled -isnot [bool]) { $reasons.Add('Tenant-specific IsInstalled metadata is missing or invalid.'); continue }
        if (-not $record.IsInstalled) { continue }
        $id = [Guid]::Empty; $version = $null
        $identity = if ($record.Id) { [string]$record.Id } else { [string]$record.AppId }
        if (-not [Guid]::TryParse($identity,[ref]$id) -or $id -eq [Guid]::Empty -or
            -not [Version]::TryParse([string]$record.Version,[ref]$version) -or
            [string]::IsNullOrWhiteSpace([string]$record.Name) -or [string]::IsNullOrWhiteSpace([string]$record.Publisher) -or
            [string]$record.Name -match '[\x00-\x1f]' -or ([string]$record.Name).Length -gt 200) {
            $reasons.Add('An installed app has incomplete or invalid identity/version metadata.'); continue
        }
        $key = $id.ToString()
        if ($installed.ContainsKey($key)) { $reasons.Add('More than one installed version has the same app identity.'); continue }
        $installed[$key] = $record
    }
    foreach ($record in @($State.PackageApps)) {
        $id = [Guid]::Empty
        $identity = if ($record.Id) { [string]$record.Id } else { [string]$record.AppId }
        if (-not [Guid]::TryParse($identity,[ref]$id) -or $id -eq [Guid]::Empty) {
            $reasons.Add('A container package has missing or invalid app identity metadata.'); continue
        }
        $key = $id.ToString()
        if (-not $packages.ContainsKey($key)) { $packages[$key] = @() }
        $packages[$key] += $record
    }
    $requiredNames = @('System Application','Business Foundation','Base Application','Application')
    $selected = @{}
    $pending = [Collections.Generic.List[string]]::new()
    $applicationDependencyId=[Guid]::Empty
    foreach ($name in $requiredNames) {
        $matching = @($State.PackageApps | Where-Object { $_.Name -ceq $name -and $_.Publisher -ceq 'Microsoft' })
        if ($matching.Count -ne 1) { $reasons.Add("Exactly one Microsoft $name media package is required."); continue }
        $id = [Guid]::Empty
        $identity = if ($matching[0].Id) { $matching[0].Id } else { $matching[0].AppId }
        if ([Guid]::TryParse([string]$identity,[ref]$id) -and $id -ne [Guid]::Empty) {
            $pending.Add($id.ToString())
            if($name -ceq 'Application'){$applicationDependencyId=$id}
        }
    }
    foreach ($key in $installed.Keys) {
        if ($installed[$key].Publisher -ceq 'Microsoft' -and -not $pending.Contains($key)) { $pending.Add($key) }
    }
    # Expand target dependencies. A non-media dependency may be retained only when
    # an actual installed identity/version satisfies it; it is never fabricated.
    for ($index=0; $index -lt $pending.Count; $index++) {
        $key = $pending[$index]
        if ($selected.ContainsKey($key)) { continue }
        $candidate = @()
        if($packages.ContainsKey($key)){$candidate=@($packages[$key] | Where-Object {$null -ne $_})}
        $current = $installed[$key]
        if ($candidate.Count -ne 1) {
            $reasons.Add("Required app/dependency '$key' has $($candidate.Count) media packages; exactly one is required."); continue
        }
        $target = $candidate[0]; $version=$null; $oldVersion=$null
        if (-not [Version]::TryParse([string]$target.Version,[ref]$version) -or
            [string]::IsNullOrWhiteSpace([string]$target.Name) -or [string]::IsNullOrWhiteSpace([string]$target.Publisher) -or
            [string]$target.Name -match '[\x00-\x1f]' -or ([string]$target.Name).Length -gt 200 -or
            -not (Test-BcModernRestorePackagePath -Path ([string]$target.Path)) -or
            $null -eq $target.PSObject.Properties['Dependencies']) {
            $reasons.Add('A required package has incomplete identity/version/dependency metadata or an unsafe media path.'); continue
        }
        if ($current) {
            $null = [Version]::TryParse([string]$current.Version,[ref]$oldVersion)
            if ($current.Name -cne $target.Name -or $current.Publisher -cne $target.Publisher) { $reasons.Add('Installed and media app identities disagree on name or publisher.') }
            if ($target.Name -in $requiredNames -and $target.Publisher -ceq 'Microsoft' -and $oldVersion.Major -ne $version.Major) { $reasons.Add("App '$($target.Name)' requires a cross-major upgrade, which this restore does not perform.") }
            elseif ($oldVersion -gt $version) { $reasons.Add("App '$($target.Name)' would be downgraded from '$oldVersion' to '$version'.") }
        } elseif ($target.Name -in @('System Application','Base Application','Application')) {
            $reasons.Add("Required Microsoft $($target.Name) is not installed on the selected tenant.")
        }
        if ($target.Name -in $requiredNames -and $target.Publisher -ceq 'Microsoft' -and
            ($null -eq $platform -or $version.Major -ne $platform.Major)) { $reasons.Add('A core Microsoft package does not match the platform major.') }
        $entry = [pscustomobject]@{
            Id=$key; Name=[string]$target.Name; Publisher=[string]$target.Publisher
            InstalledVersion=if($oldVersion){[string]$oldVersion}else{''}; PackageVersion=[string]$version
            PackagePath=[string]$target.Path; Version=[string]$version; Path=[string]$target.Path
            Action=if(-not $current){'Install'}elseif($oldVersion -lt $version){'Upgrade'}else{'Keep'}
            Dependencies=@(); PackageDependencies=@()
        }
        $selected[$key]=$entry
        foreach ($dependency in @($target.Dependencies)) {
            $dependencyId=[Guid]::Empty; $minimum=$null
            $identity=if($dependency.Id){$dependency.Id}else{$dependency.AppId}
            $versionValue=Get-BcModernRestoreDependencyMinimumVersion -Dependency $dependency
            if (-not [Guid]::TryParse([string]$identity,[ref]$dependencyId) -or
                -not [Version]::TryParse([string]$versionValue,[ref]$minimum) -or
                [string]::IsNullOrWhiteSpace([string]$dependency.Name) -or [string]::IsNullOrWhiteSpace([string]$dependency.Publisher)) {
                $reasons.Add('A package dependency has incomplete identity or minimum-version metadata.'); continue
            }
            # Preserve the raw native dependency identity for media-drift checks;
            # only the execution graph resolves the logical Application edge.
            $entry.PackageDependencies += [pscustomobject]@{Id=$dependencyId.ToString();Name=[string]$dependency.Name;Publisher=[string]$dependency.Publisher;Version=[string]$minimum}
            $resolvedId=Resolve-BcModernRestoreDependencyId -Dependency $dependency -ApplicationId $applicationDependencyId
            if($null -eq $resolvedId){$reasons.Add('A package dependency has an invalid app identity or an unresolved implicit Microsoft Application reference.');continue}
            $dependencyKey=$resolvedId.ToString()
            $dependencyCandidates=@()
            if($packages.ContainsKey($dependencyKey)){$dependencyCandidates=@($packages[$dependencyKey] | Where-Object {$null -ne $_})}
            $dependencyInstalled=$installed[$dependencyKey]
            $dependencyTarget=if($dependencyCandidates.Count -eq 1){$dependencyCandidates[0]}else{$dependencyInstalled}
            $resolvedVersion=$null
            if (-not $dependencyTarget -or $dependencyTarget.Name -cne $dependency.Name -or $dependencyTarget.Publisher -cne $dependency.Publisher -or
                -not [Version]::TryParse([string]$dependencyTarget.Version,[ref]$resolvedVersion) -or $resolvedVersion -lt $minimum) {
                $reasons.Add("App '$($target.Name)' requires dependency '$dependencyKey' at minimum '$minimum'; matching installed/media identity and version were not established."); continue
            }
            if ($dependencyCandidates.Count -gt 1) { $reasons.Add('Dependency media packages are ambiguous.'); continue }
            $entry.Dependencies += $dependencyKey
            if ($dependencyCandidates.Count -eq 1) {
                if (-not $pending.Contains($dependencyKey)) { $pending.Add($dependencyKey) }
            }
        }
    }
    # Validate retained installed dependencies too: minimum versions establish
    # compatibility, not just the presence of an edge with a matching GUID.
    $effectiveGraph=@{}
    foreach($key in $selected.Keys){$effectiveGraph[$key]=@($selected[$key].Dependencies)}
    foreach($key in $installed.Keys) {
        $record=$installed[$key];$edges=@()
        if($null -eq $record.PSObject.Properties['Dependencies']){$reasons.Add('An installed app lacks complete dependency metadata.');continue}
        foreach($dependency in @($record.Dependencies)) {
            $dependencyId=[Guid]::Empty;$minimum=$null
            $identity=if($dependency.Id){$dependency.Id}else{$dependency.AppId}
            $minimumValue=Get-BcModernRestoreDependencyMinimumVersion -Dependency $dependency
            if(-not [Guid]::TryParse([string]$identity,[ref]$dependencyId) -or
                -not [Version]::TryParse([string]$minimumValue,[ref]$minimum) -or
                [string]::IsNullOrWhiteSpace([string]$dependency.Name) -or [string]::IsNullOrWhiteSpace([string]$dependency.Publisher)) {
                $reasons.Add('An installed dependency has invalid app identity, publisher or minimum-version metadata.');continue
            }
            $resolvedId=Resolve-BcModernRestoreDependencyId -Dependency $dependency -ApplicationId $applicationDependencyId
            if($null -eq $resolvedId){$reasons.Add('An installed dependency has an invalid app identity or an unresolved implicit Microsoft Application reference.');continue}
            $dependencyKey=$resolvedId.ToString();$edges+=$dependencyKey
            $resolved=if($selected.ContainsKey($dependencyKey)){$selected[$dependencyKey]}else{$installed[$dependencyKey]}
            $resolvedVersion=$null
            $hasResolvedVersion=[Version]::TryParse([string]$resolved.Version,[ref]$resolvedVersion)
            if(-not $resolved -or $resolved.Name -cne $dependency.Name -or $resolved.Publisher -cne $dependency.Publisher -or
                -not $hasResolvedVersion -or $resolvedVersion -lt $minimum) {
                $availableDetail=if($hasResolvedVersion){"Available version: '$resolvedVersion'."}else{'No valid available version was established.'}
                $reasons.Add("Installed app '$($record.Name)' ('$key') requires dependency '$dependencyKey' at minimum '$minimum'. $availableDetail The dependency is missing, has conflicting identity or does not meet the required minimum.")
            }
        }
        if(-not $effectiveGraph.ContainsKey($key)){$effectiveGraph[$key]=$edges}
    }
    $graphPending=@($effectiveGraph.Keys)
    while($graphPending.Count) {
        $ready=@($graphPending | Where-Object {@($effectiveGraph[$_] | Where-Object {$_ -in $graphPending}).Count -eq 0})
        if(-not $ready.Count){$reasons.Add('The installed and target dependency closure contains a cycle.');break}
        $graphPending=@($graphPending | Where-Object {$_ -notin $ready})
    }
    # Stable topological order is used for publication, synchronization and app
    # upgrade. Reject cycles before any tenant or application write is submitted.
    $remaining=@($selected.Keys | Sort-Object)
    while ($remaining.Count -gt 0) {
        $ready=@($remaining | Where-Object { @($selected[$_].Dependencies | Where-Object { $_ -in $remaining }).Count -eq 0 } | Sort-Object { [Array]::IndexOf($requiredNames,$selected[$_].Name) },{ $selected[$_].Name })
        if ($ready.Count -eq 0) { $reasons.Add('The target app dependency graph contains a cycle.'); break }
        foreach ($key in $ready) {
            $apps.Add($selected[$key])
            if ($selected[$key].Action -ne 'Keep') { $actions.Add($selected[$key]) }
        }
        $remaining=@($remaining | Where-Object { $_ -notin $ready })
    }
    if ($State.TenantState -notin @('Operational','OperationalWithSyncPending') -or ($actions.Count -eq 0 -and $State.TenantState -ne 'Operational')) { $reasons.Add('The selected tenant is not in a supported operational state; reconcile platform conversion and tenant synchronization first.') }
    if ($actions.Count -gt 0) {
        if ($State.Multitenant -eq $true -and ($State.AllowAppDatabaseWrite -isnot [bool] -or -not $State.AllowAppDatabaseWrite)) { $reasons.Add('A multitenant upgrade requires an existing mount with AllowAppDatabaseWrite enabled; reconcile the mount explicitly before retrying.') }
        $impacted=@($actions | Select-Object -ExpandProperty Id)
        $repairPending=@($installed.Keys | Where-Object { $installed[$_].Publisher -cne 'Microsoft' })
        do {
            $addedRepair=$false
            foreach ($key in @($repairPending)) {
                $record=$installed[$key]
                if ($null -eq $record.PSObject.Properties['Dependencies']) { $reasons.Add('A non-Microsoft installed extension lacks dependency metadata; complete a supported extension compatibility review before upgrading.'); $repairPending=@($repairPending | Where-Object {$_ -ne $key}); continue }
                $dependencyIds=@($record.Dependencies | ForEach-Object {
                    $resolvedId=Resolve-BcModernRestoreDependencyId -Dependency $_ -ApplicationId $applicationDependencyId
                    if($null -ne $resolvedId){$resolvedId.ToString()}
                })
                if (@($dependencyIds | Where-Object { $_ -in $impacted }).Count -eq 0) { continue }
                if ($record.IsRuntimePackage -eq $true -or $record.ExtensionType -ceq 'Runtime' -or
                    ($record.SourceAvailable -is [bool] -and -not $record.SourceAvailable)) {
                    $reasons.Add('An affected non-Microsoft extension is a runtime package or has no repairable source. Supply a compatible extension/runtime package through a supported upgrade procedure before retrying.')
                } else {
                    $repair=[pscustomobject]@{ Id=$key; Name=[string]$record.Name; Publisher=[string]$record.Publisher; InstalledVersion=[string]$record.Version; PackageVersion=$null; PackagePath=''; Version=[string]$record.Version; Path=''; Action='Repair'; Dependencies=$dependencyIds }
                    $apps.Add($repair); $actions.Add($repair)
                }
                $impacted += $key; $addedRepair=$true
                $repairPending=@($repairPending | Where-Object {$_ -ne $key})
            }
        } while($addedRepair)
        $repairOrder=@($actions | Where-Object Action -eq 'Repair')
        $orderedRepairs=@()
        while($repairOrder.Count) {
            $repairIds=@($repairOrder.Id)
            $ready=@($repairOrder | Where-Object {@($_.Dependencies | Where-Object {$_ -in $repairIds}).Count -eq 0} | Sort-Object Name)
            if(-not $ready.Count){$reasons.Add('Affected extension repairs have a cyclic dependency.');break}
            $orderedRepairs+=$ready
            $readyIds=@($ready.Id);$repairOrder=@($repairOrder | Where-Object {$_.Id -notin $readyIds})
        }
        $nonRepairActions=@($actions | Where-Object Action -ne 'Repair')
        $actions.Clear();foreach($action in @($nonRepairActions)+@($orderedRepairs)){$actions.Add($action)}
    }
    $requiredCapabilities=@{'Get-NAVAppInfo'=@('ServerInstance','Tenant','TenantSpecificProperties','Path','Id','Name','Publisher','Version')}
    if ($actions.Count -gt 0) {
        $requiredCapabilities['Publish-NAVApp']=@('ServerInstance','Path')
        $requiredCapabilities['Sync-NAVTenant']=@('ServerInstance','Tenant','Mode','Force','Confirm')
        $requiredCapabilities['Sync-NAVApp']=@('ServerInstance','Tenant','Name','Publisher','Version','AppId','Mode')
        if (@($actions | Where-Object Action -eq 'Repair').Count) {
            $requiredCapabilities['Repair-NAVApp']=@('ServerInstance','Name','Publisher','Version','AppId')
            $requiredCapabilities['Restart-NAVServerInstance']=@('ServerInstance')
        }
        if (@($actions | Where-Object Action -eq 'Upgrade').Count) { $requiredCapabilities['Start-NAVAppDataUpgrade']=@('ServerInstance','Tenant','Name','Publisher','Version','AppId') }
        if (@($actions | Where-Object Action -eq 'Install').Count) { $requiredCapabilities['Install-NAVApp']=@('ServerInstance','Tenant','Name','Publisher','Version','AppId') }
    }
    foreach ($command in $requiredCapabilities.Keys) {
        $available=@($State.Capabilities.$command)
        if (@($requiredCapabilities[$command] | Where-Object { $_ -notin $available }).Count) { $reasons.Add("Required administration command/parameters are unavailable: $command. Use compatible BC administration tools before upgrading.") }
    }
    $executableActions=@()
    if(-not $reasons.Count){$executableActions=@($actions.ToArray())}
    [pscustomobject]@{ Outcome=if($reasons.Count){'Blocked'}elseif($actions.Count){'Viable'}else{'Aligned'}; TenantId=[string]$State.TenantId; Multitenant=$State.Multitenant; Apps=@($apps.ToArray()); Actions=@($executableActions); Reasons=@($reasons.ToArray() | Select-Object -Unique) }
}

function Assert-BcModernRestoreRuntimeInvocation {
    $ErrorActionPreference='Stop';$detail=''
    try {
        $command=Get-Command Invoke-ScriptInBcContainer -ErrorAction Stop
        foreach($parameter in @('usePwsh','useSession')) {
            if(-not $command.Parameters.ContainsKey($parameter) -or $command.Parameters[$parameter].ParameterType -ne [bool]) {
                $detail='The active container invocation helper does not support the required boolean usePwsh/useSession parameters.'
                throw 'Unsupported modern administration runtime selection.'
            }
        }
    } catch {
        if(-not $detail){$detail="The administration invocation helper could not be resolved; its underlying failure is unknown. Error code: $($_.Exception.HResult)."}
        throw (New-BcRestoreFailure -Stage 'modern administration runtime selection' -State 'SQL restore may already have returned; no application writes were started by this runtime-selection step.' -Detail "$detail Install or repair a compatible BcContainerHelper with explicit PowerShell 7 fresh-process support and verify the container PowerShell 7 installation before retrying. No alternate administration runtime was attempted.")
    }
}

function Invoke-BcModernRestoreRead {
    param([string] $ContainerName, [string] $Stage, [scriptblock] $ScriptBlock, [object[]] $ArgumentList, [switch] $ModernRuntime)
    try {
        if($ModernRuntime) {
            Assert-BcModernRestoreRuntimeInvocation
            $result=Invoke-ScriptInBcContainer -containerName $ContainerName -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList -usePwsh:$true -useSession:$false -ErrorAction Stop
        } else {
            $result=Invoke-ScriptInBcContainer -containerName $ContainerName -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList -ErrorAction Stop
        }
        if (@($result).Count -ne 1 -or $result.BcModernRestoreFailure -eq $true) {
            $code=0
            $codeDetail=if([int]::TryParse([string]$result.ErrorCode,[ref]$code)){" Error code: $code."}else{''}
            $step=if($result.Step -in @('runtime','platform','tenancy','tenants','capabilities','installed-apps','installed-details','packages')){[string]$result.Step}else{'read result validation'}
            $runtimeGuidance=if($step -eq 'runtime'){' The selected modern administration process must run PowerShell Core 7 or later without a remoting session. Check container PowerShell 7 availability and the helper fresh-process invocation support; no alternate runtime was attempted.'}else{''}
            $causeDetail=if($runtimeGuidance){$runtimeGuidance}else{' The underlying cause has not been established from safe structured diagnostics.'}
            $failureStage=if($step -eq 'runtime'){'modern administration runtime selection'}else{$Stage}
            $failure=New-BcRestoreFailure -Stage $failureStage -State 'SQL restore returned; no application upgrade or administrator repair was started by this discovery step.' -Detail "Restored application discovery failed during $step.$codeDetail$causeDetail Inspect the BC service, actual tenant mounts, administration tools and event diagnostics for this query; preserve the restored database and backup set before explicitly retrying verification."
            if($codeDetail){$failure.Data['BackendErrorCode']=$code}
            throw $failure
        }
        return $result
    } catch {
        if ($_.Exception.Data['BcDevToolsetExpectedFailure']) { throw }
        throw (New-BcRestoreFailure -Stage $Stage -State 'SQL restore returned; no application upgrade or administrator repair was started by this discovery step.' -Cause $_.Exception -Detail 'The discovery transport failed; the underlying cause is unknown. Inspect the BC service, actual tenant mounts, administration tools and event diagnostics before explicitly retrying verification.')
    }
}

function Get-BcRestoredApplicationContext {
    param([Parameter(Mandatory)][string] $ContainerName)
    Invoke-BcModernRestoreRead -ContainerName $ContainerName -Stage 'restored application context discovery' -ScriptBlock {
        $ErrorActionPreference='Stop'; $step='platform'
        try {
            $serviceFolder=(Get-Item 'C:\Program Files\Microsoft Dynamics NAV\*\Service' -ErrorAction Stop | Select-Object -First 1).FullName
            $platformVersion=[string](Get-Item (Join-Path $serviceFolder 'Microsoft.Dynamics.Nav.Server.exe') -ErrorAction Stop).VersionInfo.FileVersion
            $platform=$null
            if(-not [Version]::TryParse($platformVersion,[ref]$platform)){throw 'Invalid platform version.'}
            # The legacy path retains its existing metadata/tenancy behavior.
            if($platform.Major -lt 27){return [pscustomobject]@{PlatformVersion=$platformVersion}}
            $step='tenancy'
            $value=Get-NAVServerConfiguration -ServerInstance BC -KeyName Multitenant -ErrorAction Stop
            $text=if($null -ne $value.PSObject.Properties['Value']){[string]$value.Value}elseif($null -ne $value.PSObject.Properties['KeyValue']){[string]$value.KeyValue}else{[string]$value}
            $multitenant=$false
            if(-not [bool]::TryParse($text,[ref]$multitenant)){throw 'Invalid tenancy metadata.'}
            $step='tenants'
            $tenants=@(Get-NAVTenant -ServerInstance BC -ErrorAction Stop | ForEach-Object {
                [pscustomobject]@{Id=[string]$_.Id;State=[string]$_.State;AllowAppDatabaseWrite=$_.AllowAppDatabaseWrite}
            })
            if($tenants.Count -eq 0){throw 'No mounted tenant.'}
            [pscustomobject]@{PlatformVersion=$platformVersion;Multitenant=$multitenant;TenantIds=@($tenants.Id);TenantStates=$tenants}
        } catch { [pscustomobject]@{BcModernRestoreFailure=$true;Step=$step;ErrorCode=$_.Exception.HResult} }
    }
}

function Get-BcModernRestoredApplicationState {
    param([Parameter(Mandatory)][string] $ContainerName, [Parameter(Mandatory)][string] $TenantId, [Parameter(Mandatory)] $Context)
    Invoke-BcModernRestoreRead -ContainerName $ContainerName -Stage 'application version discovery' -ModernRuntime -ArgumentList @($TenantId,$Context) -ScriptBlock {
        param($tenantId,$context)
        $ErrorActionPreference='Stop'; $step='runtime'
        try {
            $sender=Get-Variable PSSenderInfo -ErrorAction Ignore
            if($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or ($sender -and $null -ne $sender.Value)){throw 'Unsupported administration process.'}
            $step='capabilities'
            $caps=@{}
            foreach($name in @('Get-NAVAppInfo','Publish-NAVApp','Sync-NAVApp','Install-NAVApp','Start-NAVAppDataUpgrade','Sync-NAVTenant','Start-NAVDataUpgrade','Get-NAVDataUpgrade','Repair-NAVApp','Restart-NAVServerInstance')) {
                # Missing optional upgrade commands are assessed as blockers; a
                # discovery command failure itself remains a failed read.
                $command=Get-Command $name -ErrorAction Ignore
                $caps[$name]=if($command){@($command.Parameters.Keys)}else{@()}
            }
            if(@('ServerInstance','Tenant','TenantSpecificProperties','Id','Name','Publisher','Version','Path') | Where-Object {$_ -notin $caps['Get-NAVAppInfo']}){throw 'Installed app discovery capability is unavailable.'}
            function Convert-ModernRestoreAppMetadata {
                param($app,$installed,$path)
                $identity=if($app.Id){[string]$app.Id}else{[string]$app.AppId}
                [pscustomobject]@{
                    Id=$identity;Name=[string]$app.Name;Publisher=[string]$app.Publisher;Version=[string]$app.Version
                    IsInstalled=$installed;Path=$path;IsRuntimePackage=$app.IsRuntimePackage;ExtensionType=[string]$app.ExtensionType;SourceAvailable=$app.SourceAvailable
                    Dependencies=@($app.Dependencies | ForEach-Object {
                        [pscustomobject]@{Id=if($_.Id){[string]$_.Id}else{[string]$_.AppId};Name=[string]$_.Name;Publisher=[string]$_.Publisher;Version=if($null -ne $_.PSObject.Properties['MinVersion']){[string]$_.MinVersion}else{[string]$_.Version}}
                    })
                }
            }
            $step='installed-apps'
            $tenantApps=@(Get-NAVAppInfo -ServerInstance BC -Tenant $tenantId -TenantSpecificProperties -ErrorAction Stop -WarningAction Ignore)
            $installed=@()
            foreach($app in $tenantApps) {
                if($app.IsInstalled -isnot [bool]){throw 'Missing installed-state metadata.'}
                if(-not $app.IsInstalled){continue}
                $step='installed-details'
                $id=if($app.Id){$app.Id}else{$app.AppId}
                $details=@(Get-NAVAppInfo -ServerInstance BC -Tenant $tenantId -TenantSpecificProperties -Id $id -Name $app.Name -Publisher $app.Publisher -Version $app.Version -ErrorAction Stop -WarningAction Ignore)
                if($details.Count -ne 1 -or $details[0].IsInstalled -ne $true -or $null -eq $details[0].PSObject.Properties['Dependencies']){throw 'Ambiguous installed app details.'}
                $installed+=Convert-ModernRestoreAppMetadata $details[0] $true ''
            }
            $step='packages'; $packages=@()
            foreach($file in @(Get-ChildItem -LiteralPath 'C:\Applications' -Filter '*.app' -File -Recurse -ErrorAction Stop)) {
                $validatedPackagePath=[IO.Path]::GetFullPath([string]$file.FullName)
                if(-not $validatedPackagePath.StartsWith('C:\Applications\',[StringComparison]::OrdinalIgnoreCase) -or
                    $validatedPackagePath.Substring(3) -match '[:\x00-\x1f<>"|?*\[\]]' -or
                    [IO.Path]::GetExtension($validatedPackagePath) -ine '.app' -or
                    ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe media package path.'}
                # Reject linked ancestors as well as a linked package file.
                $parent=[IO.Path]::GetDirectoryName($validatedPackagePath)
                while($parent -and $parent.StartsWith('C:\Applications',[StringComparison]::OrdinalIgnoreCase)) {
                    if((Get-Item -LiteralPath $parent -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked media directory.'}
                    if($parent -ieq 'C:\Applications'){break}; $parent=[IO.Path]::GetDirectoryName($parent)
                }
                $metadata=@(Get-NAVAppInfo -Path $validatedPackagePath -ErrorAction Stop -WarningAction Ignore)
                if($metadata.Count -ne 1 -or $null -eq $metadata[0].PSObject.Properties['Dependencies']){throw 'Invalid package metadata.'}
                $packages+=Convert-ModernRestoreAppMetadata $metadata[0] $false $validatedPackagePath
            }
            $tenant=@($context.TenantStates | Where-Object Id -eq $tenantId)
            if($tenant.Count -ne 1){throw 'Tenant identity is missing or ambiguous.'}
            [pscustomobject]@{PlatformVersion=[string]$context.PlatformVersion;Multitenant=$context.Multitenant;TenantId=[string]$tenantId;TenantState=[string]$tenant[0].State;AllowAppDatabaseWrite=$tenant[0].AllowAppDatabaseWrite;InstalledApps=$installed;PackageApps=$packages;Capabilities=$caps}
        } catch { [pscustomobject]@{BcModernRestoreFailure=$true;Step=$step;ErrorCode=$_.Exception.HResult} }
    }
}

function Write-BcModernRestoreStatus {
    param([ValidateSet('START','COMPLETED','FAILED')][string] $Status,
        [string] $Stage, [string] $Item, [int] $Index, [int] $Total, [datetime] $Started)
    # Display only bounded metadata in authored templates, never backend text.
    $displayItem=[regex]::Replace([string]$Item,'[\x00-\x1f\x7f]','?')
    if($displayItem.Length -gt 320){$displayItem=$displayItem.Substring(0,320)}
    $elapsed=([DateTime]::UtcNow-$Started).TotalSeconds.ToString('F1',[Globalization.CultureInfo]::InvariantCulture)
    $color=if($Status -eq 'FAILED'){'Red'}else{'Gray'}
    Write-Host "BC RESTORE $Status [$Stage] [$Index/$Total] $displayItem; elapsed $($elapsed)s." -ForegroundColor $color
}

function Invoke-BcModernSystemApplicationUpgradeAfterRestore {
    param([Parameter(Mandatory)][string] $ContainerName, [string[]] $TenantIds, [Parameter(Mandatory)] $Context)
    $ErrorActionPreference='Stop'
    $actualTenants=@($Context.TenantIds)
    if($Context.Multitenant -isnot [bool] -or $actualTenants.Count -eq 0 -or
        @($actualTenants | Select-Object -Unique).Count -ne $actualTenants.Count -or
        @($actualTenants | Where-Object {[string]::IsNullOrWhiteSpace([string]$_)}).Count -gt 0 -or
        ($null -ne $TenantIds -and @($TenantIds | Where-Object {$_ -notin $actualTenants}).Count -gt 0) -or
        (-not $Context.Multitenant -and ($actualTenants.Count -ne 1 -or $actualTenants[0] -cne 'default'))) {
        throw (New-BcRestoreFailure -Stage 'modern restored tenant preflight' -State 'SQL restore returned; no application upgrade or administrator repair was started.' -Detail 'The actual tenant mounts are missing, ambiguous or disagree with the restored tenant selection. Inspect the service tenancy and mounted tenant identities; do not assume that a default tenant exists.')
    }
    $plans=@()
    $selectedTenants=if($TenantIds -and $TenantIds.Count){@($TenantIds)}else{$actualTenants}
    $assessmentIndex=0
    foreach($tenantId in $actualTenants) {
        $assessmentIndex++;$assessmentStarted=[DateTime]::UtcNow
        Write-BcModernRestoreStatus -Status START -Stage 'tenant assessment' -Item "tenant '$tenantId'" -Index $assessmentIndex -Total $actualTenants.Count -Started $assessmentStarted
        try {
        $state=Get-BcModernRestoredApplicationState -ContainerName $ContainerName -TenantId $tenantId -Context $Context
        $assessment=Get-BcModernSystemApplicationUpgradeAssessment -State $state
        $assessment | Add-Member -MemberType NoteProperty -Name Selected -Value ($tenantId -in $selectedTenants)
        $assessment | Add-Member -MemberType NoteProperty -Name BeforeInstalledApps -Value @($state.InstalledApps | Where-Object {$_.IsInstalled -is [bool] -and $_.IsInstalled} | ForEach-Object {[pscustomobject]@{Id=[string]$_.Id;Name=[string]$_.Name;Publisher=[string]$_.Publisher;Version=[string]$_.Version}})
        if(-not $assessment.Selected -and $state.TenantState -ne 'Operational') {
            $assessment.Outcome='Blocked'
            $assessment.Actions=@()
            $assessment.Reasons+= 'An unselected mounted tenant is not operational. Reconcile its platform/tenant synchronization state before upgrading selected tenants; this restore will not synchronize an unselected tenant.'
        }
        $displayTenant=[regex]::Replace([string]$tenantId,'[\x00-\x1f\x7f]','?');if($displayTenant.Length -gt 200){$displayTenant=$displayTenant.Substring(0,200)}
        $selection=if($assessment.Selected){'selected'}else{'unselected; assessment only; no per-tenant actions selected'}
        Write-Host "Tenant '$displayTenant' ($selection); platform: $($state.PlatformVersion); modern assessment: $($assessment.Outcome)." -ForegroundColor Gray
        foreach($app in $assessment.Apps) {
            if($app.Action -eq 'Repair') {
                Write-Host "$($app.Name): retained database extension, installed '$($app.InstalledVersion)'; repair installed version '$($app.Version)' (no media target selected)." -ForegroundColor Gray
            } else {
                Write-Host "$($app.Name): installed '$($app.InstalledVersion)', container media package from C:\Applications '$($app.PackageVersion)' ($($app.Action))." -ForegroundColor Gray
            }
        }
        $plans += $assessment
        $assessmentStatus=if($assessment.Outcome -eq 'Aligned'){'aligned; no application actions required'}else{$assessment.Outcome}
        Write-BcModernRestoreStatus -Status COMPLETED -Stage 'tenant assessment' -Item "tenant '$tenantId'; $selection; $assessmentStatus" -Index $assessmentIndex -Total $actualTenants.Count -Started $assessmentStarted
        } catch {
            Write-BcModernRestoreStatus -Status FAILED -Stage 'tenant assessment' -Item "tenant '$tenantId'" -Index $assessmentIndex -Total $actualTenants.Count -Started $assessmentStarted
            throw
        }
    }
    # Discover and assess every mounted tenant before publishing or synchronizing
    # anything. A later blocked tenant must not leave earlier tenants upgraded.
    $blocked=@($plans | Where-Object Outcome -eq 'Blocked')
    if($blocked.Count) {
        Write-BcModernRestoreStatus -Status FAILED -Stage 'upgrade preflight' -Item 'shared catalog and mounted tenant assessments contain blockers' -Index $blocked.Count -Total $plans.Count -Started $assessmentStarted
        $details=@($blocked | ForEach-Object { "Tenant '$($_.TenantId)': $($_.Reasons -join ' ')" }) -join ' '
        throw (New-BcRestoreFailure -Stage 'modern application upgrade preflight' -State 'SQL restore returned; all tenant assessments completed before app writes. No application upgrade or administrator repair was started.' -Detail "$details Inspect the observed installed and media versions and dependency metadata. Use compatible media or complete a supported application upgrade before explicitly retrying verification.")
    }
    # A shared application database must not receive conflicting package targets.
    $targets=@{}
    foreach($plan in $plans) {
        foreach($app in @($plan.Apps | Where-Object Action -ne 'Repair')) {
            if($targets.ContainsKey($app.Id) -and ($targets[$app.Id].Version -cne $app.Version -or $targets[$app.Id].Path -cne $app.Path)) {
                Write-BcModernRestoreStatus -Status FAILED -Stage 'upgrade preflight' -Item "shared catalog target conflict for app '$($app.Name)'" -Index 1 -Total 1 -Started ([DateTime]::UtcNow)
                throw (New-BcRestoreFailure -Stage 'modern application upgrade preflight' -State 'SQL restore returned; no application upgrade or administrator repair was started.' -Detail 'Mounted tenants reported conflicting target package identities, paths or versions. Reconcile the shared application database and media before explicitly retrying verification.')
            }
            $targets[$app.Id]=$app
        }
    }
    foreach($repair in @($plans | Where-Object Selected | ForEach-Object {$_.Actions} | Where-Object Action -eq 'Repair')) {
        if(@($plans | Where-Object {-not $_.Selected} | ForEach-Object {$_.BeforeInstalledApps} | Where-Object {$_.Id -ieq $repair.Id -and $_.Version -ceq $repair.Version}).Count) {
            Write-BcModernRestoreStatus -Status FAILED -Stage 'upgrade preflight' -Item "shared repair of retained extension '$($repair.Name)' would affect an unselected tenant" -Index 1 -Total 1 -Started ([DateTime]::UtcNow)
            throw (New-BcRestoreFailure -Stage 'modern application upgrade preflight' -State 'SQL restore returned; no application upgrade or administrator repair was started.' -Detail 'A required shared-catalog extension repair would affect an unselected mounted tenant. Review that tenant and explicitly select the affected tenants for a supported upgrade; this restore does not expand the tenant selection automatically.')
        }
    }
    if(@($plans | Where-Object {$_.Selected -and $_.Outcome -eq 'Viable'}).Count -eq 0) { return }
    try {
        Assert-BcModernRestoreRuntimeInvocation
        $result=Invoke-ScriptInBcContainer -containerName $ContainerName -usePwsh:$true -useSession:$false -ArgumentList @(,$plans) -ScriptBlock {
            param($plans)
            $ErrorActionPreference='Stop'; $step='runtime'; $writesStarted=$false
            $failureState=[pscustomobject]@{ReasonCode=$null;AppId=$null;Version=$null}
            $progress=[pscustomobject]@{Stage='administration runtime verification';Item='shared administration process';Index=1;Total=1;Started=[DateTime]::UtcNow}
            function Write-ModernRestoreStatus {
                param([ValidateSet('START','COMPLETED','FAILED')][string]$Status,[string]$Outcome='')
                $item=[string]$progress.Item
                if($Outcome){$item+='; '+$Outcome}
                $item=[regex]::Replace($item,'[\x00-\x1f\x7f]','?')
                if($item.Length -gt 320){$item=$item.Substring(0,320)}
                $elapsed=([DateTime]::UtcNow-$progress.Started).TotalSeconds.ToString('F1',[Globalization.CultureInfo]::InvariantCulture)
                $color=if($Status -eq 'FAILED'){'Red'}else{'Gray'}
                Write-Host "BC RESTORE $Status [$($progress.Stage)] [$($progress.Index)/$($progress.Total)] $item; elapsed $($elapsed)s." -ForegroundColor $color
            }
            function Start-ModernRestoreStep {
                param([string]$Stage,[string]$Item,[int]$Index,[int]$Total)
                $progress.Stage=$Stage;$progress.Item=$Item;$progress.Index=$Index;$progress.Total=$Total;$progress.Started=[DateTime]::UtcNow
                Write-ModernRestoreStatus START
            }
            try {
                Write-ModernRestoreStatus START
                $sender=Get-Variable PSSenderInfo -ErrorAction Ignore
                if($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or ($sender -and $null -ne $sender.Value)){$failureState.ReasonCode='UnsupportedAdminRuntime';throw 'Unsupported administration process.'}
                Write-ModernRestoreStatus COMPLETED
                $step='publication preflight'
                $publish=@(); $seen=@{}; $repairs=@(); $repairSeen=@{}
                function Get-ModernDependencySnapshot {
                    param($dependencies)
                    @($dependencies | ForEach-Object {
                        $id=[Guid]::Empty;$minimum=$null
                        $identity=if($_.Id){$_.Id}else{$_.AppId}
                        $version=if($null -ne $_.PSObject.Properties['MinVersion']){$_.MinVersion}else{$_.Version}
                        if(-not [Guid]::TryParse([string]$identity,[ref]$id) -or -not [Version]::TryParse([string]$version,[ref]$minimum)){$failureState.ReasonCode='MediaDependenciesChanged';throw 'Invalid package dependency snapshot.'}
                        [pscustomobject][ordered]@{Id=$id.ToString();Name=[string]$_.Name;Publisher=[string]$_.Publisher;Version=[string]$minimum}
                    } | Sort-Object Id,Name,Publisher,Version) | ConvertTo-Json -Depth 4 -Compress
                }
                function Assert-ModernTargetPackage {
                    param($app)
                $failureState.AppId=$app.Id;$failureState.Version=$app.Version
                $path=[string]$app.Path
                if($path -notmatch '^[Cc]:[\\/]Applications[\\/]' -or $path -match '[\x00-\x1f<>"|?*\[\]]' -or
                    $path.Substring(3) -match ':' -or $path.Replace('/','\') -match '(^|\\)\.\.($|\\)' -or
                    [IO.Path]::GetExtension($path) -ine '.app'){$failureState.ReasonCode='UnsafeMediaPath';throw 'Unsafe target media path.'}
                $validatedPackagePath=[IO.Path]::GetFullPath($path)
                $item=Get-Item -LiteralPath $validatedPackagePath -ErrorAction Stop
                if($item.PSIsContainer){$failureState.ReasonCode='UnsafeMediaPath';throw 'Unsafe target media item.'}
                if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){$failureState.ReasonCode='LinkedMedia';throw 'Linked target media file.'}
                $parent=[IO.Path]::GetDirectoryName($validatedPackagePath)
                while($parent -and $parent.StartsWith('C:\Applications',[StringComparison]::OrdinalIgnoreCase)) {
                    if((Get-Item -LiteralPath $parent -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){$failureState.ReasonCode='LinkedMedia';throw 'Linked target media directory.'}
                    if($parent -ieq 'C:\Applications'){break};$parent=[IO.Path]::GetDirectoryName($parent)
                }
                $package=@(Get-NAVAppInfo -Path $validatedPackagePath -ErrorAction Stop -WarningAction Ignore)
                $id=if($package.Count -eq 1 -and $package[0].Id){[string]$package[0].Id}elseif($package.Count -eq 1){[string]$package[0].AppId}else{''}
                if($package.Count -ne 1 -or $id -ine $app.Id -or [string]$package[0].Version -cne $app.Version -or
                    $package[0].Name -cne $app.Name -or $package[0].Publisher -cne $app.Publisher){$failureState.ReasonCode='MediaIdentityChanged';throw 'Target package changed after assessment.'}
                if($null -eq $package[0].PSObject.Properties['Dependencies'] -or
                    (Get-ModernDependencySnapshot $package[0].Dependencies) -cne (Get-ModernDependencySnapshot $app.PackageDependencies)){$failureState.ReasonCode='MediaDependenciesChanged';throw 'Target package dependencies changed after assessment.'}

                }
                # Validate all paths and publication identities before app writes.
                $mediaTotal=@($plans | Where-Object Selected | ForEach-Object {$_.Actions} | Where-Object Action -ne 'Repair' | Group-Object Id).Count
                $mediaIndex=0
                foreach($plan in @($plans | Where-Object Selected)) {
                    foreach($app in $plan.Actions) {
                        if($app.Action -eq 'Repair') {
                            $repairKey=$app.Id+':'+$app.Version
                            if(-not $repairSeen.ContainsKey($repairKey)){$repairs+=$app;$repairSeen[$repairKey]=$true};continue
                        }
                        if($seen.ContainsKey($app.Id)){continue};$seen[$app.Id]=$true
                        $mediaIndex++
                        Start-ModernRestoreStep -Stage 'media package validation' -Item "shared catalog app '$($app.Name)' ($($app.Id)) version '$($app.Version)'; container media under C:\Applications" -Index $mediaIndex -Total $mediaTotal
                        Assert-ModernTargetPackage $app
                        Write-ModernRestoreStatus COMPLETED
                        Start-ModernRestoreStep -Stage 'publication catalog lookup' -Item "shared catalog app '$($app.Name)' ($($app.Id)) version '$($app.Version)'" -Index $mediaIndex -Total $mediaTotal
                        $published=@(Get-NAVAppInfo -ServerInstance BC -Id $app.Id -Name $app.Name -Publisher $app.Publisher -Version $app.Version -ErrorAction Stop -WarningAction Ignore)
                        if($published.Count -gt 1){$failureState.ReasonCode='AmbiguousPublication';throw 'Ambiguous target publication.'}
                        if($published.Count -eq 1) {
                            $publishedId=if($published[0].Id){[string]$published[0].Id}else{[string]$published[0].AppId}
                            if($publishedId -ine $app.Id -or $published[0].Name -cne $app.Name -or $published[0].Publisher -cne $app.Publisher -or [string]$published[0].Version -cne $app.Version){$failureState.ReasonCode='PublicationIdentityConflict';throw 'Conflicting target publication identity.'}
                        }
                        if($published.Count -eq 0){$publish+=$app}
                        $catalogOutcome=if($published.Count -eq 0){'not published; publication planned'}else{'already published; reusing catalog package'}
                        Write-ModernRestoreStatus COMPLETED -Outcome $catalogOutcome
                    }
                }
                $syncTotal=@($plans | Where-Object {$_.Selected -and $_.Outcome -eq 'Viable'}).Count;$syncIndex=0
                foreach($plan in @($plans | Where-Object Selected)) {
                    if($plan.Outcome -ne 'Viable'){continue}
                    $step='tenant synchronization';$writesStarted=$true
                    $syncIndex++
                    Start-ModernRestoreStep -Stage $step -Item "tenant '$($plan.TenantId)'; Mode Sync" -Index $syncIndex -Total $syncTotal
                    Sync-NAVTenant -ServerInstance BC -Tenant $plan.TenantId -Mode Sync -Force -Confirm:$false -ErrorAction Stop -WarningAction Ignore | Out-Null
                    Write-ModernRestoreStatus COMPLETED
                }
                $publishIndex=0
                foreach($app in $publish) {
                    $step='package publication'
                    $publishIndex++
                    Start-ModernRestoreStep -Stage 'media package validation' -Item "shared catalog app '$($app.Name)' ($($app.Id)) version '$($app.Version)'; publication recheck" -Index $publishIndex -Total $publish.Count
                    Assert-ModernTargetPackage $app
                    Write-ModernRestoreStatus COMPLETED
                    $writesStarted=$true
                    Start-ModernRestoreStep -Stage $step -Item "shared catalog app '$($app.Name)' ($($app.Id)) version '$($app.Version)'; container media under C:\Applications" -Index $publishIndex -Total $publish.Count
                    Publish-NAVApp -ServerInstance BC -Path $app.Path -ErrorAction Stop -WarningAction Ignore | Out-Null
                    Write-ModernRestoreStatus COMPLETED
                }
                $repairIndex=0
                foreach($app in $repairs) {
                    $step='extension repair';$writesStarted=$true
                    $repairIndex++
                    Start-ModernRestoreStep -Stage $step -Item "shared catalog retained extension '$($app.Name)' ($($app.Id)); repair installed version '$($app.Version)' without changing its version" -Index $repairIndex -Total $repairs.Count
                    Repair-NAVApp -ServerInstance BC -AppId $app.Id -Name $app.Name -Publisher $app.Publisher -Version $app.Version -ErrorAction Stop -WarningAction Ignore | Out-Null
                    Write-ModernRestoreStatus COMPLETED
                }
                if($repairs.Count) {
                    $step='service restart after extension repair'
                    Start-ModernRestoreStep -Stage $step -Item "shared service BC after $($repairs.Count) retained extension repairs" -Index 1 -Total 1
                    Restart-NAVServerInstance -ServerInstance BC -ErrorAction Stop -WarningAction Ignore | Out-Null
                    Write-ModernRestoreStatus COMPLETED
                }
                foreach($plan in @($plans | Where-Object Selected)) {
                    if($plan.Outcome -ne 'Viable'){continue}
                    $appTotal=@($plan.Actions | Where-Object Action -ne 'Repair').Count;$appIndex=0
                    foreach($app in @($plan.Actions | Where-Object Action -ne 'Repair')) {
                        $step='app synchronization';$writesStarted=$true
                        $appIndex++
                        Start-ModernRestoreStep -Stage $step -Item "tenant '$($plan.TenantId)'; app '$($app.Name)' ($($app.Id)) target '$($app.Version)'; Mode Add" -Index $appIndex -Total $appTotal
                        Sync-NAVApp -ServerInstance BC -Tenant $plan.TenantId -AppId $app.Id -Name $app.Name -Publisher $app.Publisher -Version $app.Version -Mode Add -ErrorAction Stop -WarningAction Ignore | Out-Null
                        Write-ModernRestoreStatus COMPLETED
                    }
                    $appIndex=0
                    foreach($app in @($plan.Actions | Where-Object Action -ne 'Repair')) {
                        $appIndex++
                        # Old versions remain published for other mounted tenants.
                        # Bulk Start-NAVDataUpgrade is ineligible in that state;
                        # use explicit tenant/version-scoped app upgrades instead.
                        if($app.Action -eq 'Install') {
                            $step='app installation'
                            Start-ModernRestoreStep -Stage $step -Item "tenant '$($plan.TenantId)'; app '$($app.Name)' ($($app.Id)) target '$($app.Version)'" -Index $appIndex -Total $appTotal
                            Install-NAVApp -ServerInstance BC -Tenant $plan.TenantId -AppId $app.Id -Name $app.Name -Publisher $app.Publisher -Version $app.Version -ErrorAction Stop -WarningAction Ignore | Out-Null
                        } else {
                            $step='app data upgrade'
                            Start-ModernRestoreStep -Stage $step -Item "tenant '$($plan.TenantId)'; app '$($app.Name)' ($($app.Id)) from '$($app.InstalledVersion)' to '$($app.Version)'" -Index $appIndex -Total $appTotal
                            Start-NAVAppDataUpgrade -ServerInstance BC -Tenant $plan.TenantId -AppId $app.Id -Name $app.Name -Publisher $app.Publisher -Version $app.Version -ErrorAction Stop -WarningAction Ignore | Out-Null
                        }
                        Write-ModernRestoreStatus COMPLETED
                    }
                }
                [pscustomobject]@{BcModernUpgradeResult=1;Passed=$true;Step='complete';ErrorCode=$null;WritesStarted=$writesStarted;ReasonCode=$null;FailureKind=$null}
            } catch {
                Write-ModernRestoreStatus FAILED
                # Classify only the actual structured exception type. A numeric
                # HResult alone does not establish a null-reference exception.
                $failureKind='Unknown';$cause=$_.Exception
                for($depth=0;$null -ne $cause -and $depth -lt 8;$depth++) {
                    if($cause -is [NullReferenceException]){$failureKind='NullReference';break}
                    $cause=$cause.InnerException
                }
                [pscustomobject]@{BcModernUpgradeResult=1;Passed=$false;Step=$step;ErrorCode=$_.Exception.HResult;WritesStarted=$writesStarted;ReasonCode=$failureState.ReasonCode;AppId=$failureState.AppId;Version=$failureState.Version;FailureKind=$failureKind}
            }
        } -ErrorAction Stop
        if(@($result).Count -ne 1 -or $result.BcModernUpgradeResult -isnot [int] -or $result.BcModernUpgradeResult -ne 1 -or
            $result.Passed -isnot [bool] -or -not $result.Passed -or $result.Step -isnot [string] -or $result.Step -cne 'complete' -or
            $result.WritesStarted -isnot [bool] -or $null -ne $result.ErrorCode -or $null -ne $result.ReasonCode -or $null -ne $result.FailureKind) {
            $step=if($result.Step -in @('runtime','publication preflight','package publication','extension repair','service restart after extension repair','tenant synchronization','app synchronization','app installation','app data upgrade')){[string]$result.Step}else{'result verification'}
            $code=0;$codeDetail=if([int]::TryParse([string]$result.ErrorCode,[ref]$code)){" Error code: $code."}else{''}
            $validFailureReceipt=$result.BcModernUpgradeResult -is [int] -and $result.BcModernUpgradeResult -eq 1 -and $result.Passed -is [bool] -and -not $result.Passed
            $reviewedReason=if($validFailureReceipt -and $result.ReasonCode -is [string]){$result.ReasonCode}else{''}
            $reasonDetail=switch -CaseSensitive ($reviewedReason) {
                'UnsafeMediaPath' {'The target media path is unsafe or does not name a package file. Reconcile container media under the fixed C:\Applications root before reassessing the upgrade.'}
                'LinkedMedia' {'The target media file or an ancestor directory is linked. Reconcile container media and links under C:\Applications before reassessing the upgrade.'}
                'MediaIdentityChanged' {'The target package identity or version changed after assessment. Stabilize the container media and reassess its app identities and versions before retrying.'}
                'MediaDependenciesChanged' {'The target package dependencies changed or became invalid after assessment. Stabilize the container media and reassess its complete dependency closure before retrying.'}
                'AmbiguousPublication' {'The app catalog returned multiple target publications for one app identity/version. Inspect and reconcile that exact catalog identity before reassessing the upgrade.'}
                'PublicationIdentityConflict' {'The app catalog returned a publication with conflicting GUID, name, publisher or version. Inspect and reconcile that exact catalog identity before reassessing the upgrade.'}
                'UnsupportedAdminRuntime' {'The selected modern administration process requires PowerShell Core 7 or later without a remoting session. Check container PowerShell 7 and helper fresh-process invocation support before retrying; no alternate runtime was attempted.'}
                default {'The underlying cause has not been established from safe structured diagnostics.'}
            }
            $appId=[Guid]::Empty;$appVersion=$null
            $identityDetail=if($reviewedReason -in @('UnsafeMediaPath','LinkedMedia','MediaIdentityChanged','MediaDependenciesChanged','AmbiguousPublication','PublicationIdentityConflict') -and [Guid]::TryParse([string]$result.AppId,[ref]$appId) -and [Version]::TryParse([string]$result.Version,[ref]$appVersion)){" App identity: '$appId'; target version: '$appVersion'."}else{''}
            $kindDetail=if($validFailureReceipt -and $result.FailureKind -is [string] -and $result.FailureKind -ceq 'NullReference'){' The administration command raised a null-reference exception; its underlying cause has not been established.'}else{''}
            $state=if($validFailureReceipt -and $step -eq 'tenant synchronization'){
                'SQL restore returned; tenant synchronization may have partially completed. Package publication, extension repair, app synchronization, installation and app data upgrades were not started.'
            }elseif($validFailureReceipt -and $result.WritesStarted -is [bool] -and -not $result.WritesStarted){'SQL restore returned; application writes were not started by the upgrade executor.'}else{'SQL restore returned; publication, extension repair, synchronization or app data upgrades may have partially completed.'}
            throw (New-BcRestoreFailure -Stage "modern $step" -State "$state Administrator access has not been repaired." -Detail "The modern application upgrade failed during $step.$codeDetail$identityDetail$kindDetail $reasonDetail Inspect published and installed app versions, tenant state, extension compilation/upgrade diagnostics and service readiness. Reconcile partial work before explicitly retrying verification; no global unpublish or alternate upgrade was attempted.")
        }
    } catch {
        if($_.Exception.Data['BcDevToolsetExpectedFailure']){throw}
        throw (New-BcRestoreFailure -Stage 'modern application upgrade transport' -State 'SQL restore returned; application writes may have partially completed. Administrator access has not been repaired.' -Cause $_.Exception -Detail 'The upgrade transport failed; its write outcome is unknown. Inspect published/installed versions and tenant/service state before explicitly retrying verification.')
    }
    $verificationStage='tenant mount verification';$verificationItem='mounted tenant identities and tenancy mode';$verificationIndex=1;$verificationTotal=1;$verificationStarted=[DateTime]::UtcNow
    try {
        Write-BcModernRestoreStatus -Status START -Stage $verificationStage -Item $verificationItem -Index $verificationIndex -Total $verificationTotal -Started $verificationStarted
        $afterContext=Get-BcRestoredApplicationContext -ContainerName $ContainerName
        if($afterContext.Multitenant -isnot [bool] -or $afterContext.Multitenant -ne $Context.Multitenant -or
            @($afterContext.TenantIds).Count -ne $actualTenants.Count -or
            @($afterContext.TenantIds | Where-Object {$_ -notin $actualTenants}).Count -gt 0 -or
            @($afterContext.TenantIds | Select-Object -Unique).Count -ne $actualTenants.Count) {throw 'Tenant mounts changed during the upgrade.'}
        Write-BcModernRestoreStatus -Status COMPLETED -Stage $verificationStage -Item $verificationItem -Index $verificationIndex -Total $verificationTotal -Started $verificationStarted
        $verificationIndex=0;$verificationTotal=$plans.Count
        foreach($plan in $plans) {
            $verificationIndex++;$verificationStage='tenant verification';$verificationStarted=[DateTime]::UtcNow
            $verificationRole=if($plan.Selected){'selected installed targets'}else{'unchanged unselected installed versions'}
            $verificationItem="tenant '$($plan.TenantId)'; $verificationRole"
            Write-BcModernRestoreStatus -Status START -Stage $verificationStage -Item $verificationItem -Index $verificationIndex -Total $verificationTotal -Started $verificationStarted
            $after=Get-BcModernRestoredApplicationState -ContainerName $ContainerName -TenantId $plan.TenantId -Context $afterContext
            $verified=Get-BcModernSystemApplicationUpgradeAssessment -State $after
            $expectedApps=if($plan.Selected){@($plan.Apps)}else{@($plan.BeforeInstalledApps)}
            $mismatch=@($expectedApps | Where-Object {
                $expected=$_
                $actual=@($after.InstalledApps | Where-Object { $_.IsInstalled -is [bool] -and $_.IsInstalled -and $_.Id -ieq $expected.Id -and $_.Name -ceq $expected.Name -and $_.Publisher -ceq $expected.Publisher -and [string]$_.Version -ceq $expected.Version })
                $actual.Count -ne 1
            })
            $unselectedChanged=-not $plan.Selected -and @($after.InstalledApps | Where-Object {$_.IsInstalled -is [bool] -and $_.IsInstalled}).Count -ne @($plan.BeforeInstalledApps).Count
            if(($plan.Selected -and $verified.Outcome -cne 'Aligned') -or $mismatch.Count -gt 0 -or
                $unselectedChanged -or $after.TenantState -ne 'Operational') {throw 'Installed app targets or tenant readiness were not verified.'}
            Write-BcModernRestoreStatus -Status COMPLETED -Stage $verificationStage -Item $verificationItem -Index $verificationIndex -Total $verificationTotal -Started $verificationStarted
        }
    } catch {
        Write-BcModernRestoreStatus -Status FAILED -Stage $verificationStage -Item $verificationItem -Index $verificationIndex -Total $verificationTotal -Started $verificationStarted
        $code=0
        $codeDetail=if([int]::TryParse([string]$_.Exception.Data['BackendErrorCode'],[ref]$code)){" Discovery error code: $code."}else{" Error code: $($_.Exception.HResult)."}
        throw (New-BcRestoreFailure -Stage 'modern application upgrade verification' -State 'SQL restore returned; application writes returned but installed versions, unchanged unselected tenants or tenant readiness are not verified. Administrator access has not been repaired.' -Detail "Post-upgrade verification failed.$codeDetail Inspect all mounted tenant identities, tenancy mode and app upgrade status. Selected app identities/versions must match the plan and unselected installed versions must remain unchanged; tenant mounts must not change. Reconcile the target before explicitly retrying verification; do not infer success from publication alone.")
    }
    Write-Host 'Modern application upgrade returned and all planned installed app versions and tenant states were verified.' -ForegroundColor Green
}
