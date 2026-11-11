# Opt-in diagnostics. Never serialize invocation arguments, exception messages,
# connection strings, environment variables or container configuration contents.
function Get-BcRestoreDiagnosticCode {
    return {
        function Write-BcRestoreSnapshot {
            param([string]$Stage, $Failure)
            $ErrorActionPreference = 'Stop'
            $assemblies = @([AppDomain]::CurrentDomain.GetAssemblies() | Where-Object {
                $_.GetName().Name -match '^(Microsoft\.Extensions\.|Microsoft\.Dynamics\.|Microsoft\.SqlServer\.|System\.Data|Microsoft\.Data)'
            } | Select-Object -First 400 | ForEach-Object {
                $location = ''; $mvid = ''; $context = ''
                if (-not $_.IsDynamic) { $location = $_.Location; $mvid = [string]$_.ManifestModule.ModuleVersionId }
                if ($PSVersionTable.PSEdition -eq 'Core') { $context = [string][System.Runtime.Loader.AssemblyLoadContext]::GetLoadContext($_) }
                [pscustomobject]@{ identity=$_.FullName; location=$location; mvid=$mvid; context=$context }
            })
            $command = Get-Command New-NAVDatabase -ListImported -ErrorAction Ignore
            $implementation = $null
            if ($command -and $command.ImplementingType) {
                $a = $command.ImplementingType.Assembly
                $implementation = @{ type=$command.ImplementingType.FullName; assembly=$a.FullName; location=$a.Location; references=@($a.GetReferencedAssemblies() | ForEach-Object FullName) }
            }
            $exceptions = @()
            if ($Failure) {
                $e = $Failure.Exception
                for ($n=0; $e -and $n -lt 8; $n++) {
                    # StackTrace contains method/file locations, never exception messages.
                    $exceptions += @{type=$e.GetType().FullName; hresult=$e.HResult; stack=([string]$e.StackTrace).Substring(0,[Math]::Min(16000,([string]$e.StackTrace).Length))}
                    if ($e -is [Reflection.ReflectionTypeLoadException]) {
                        $exceptions += @($e.LoaderExceptions | Select-Object -First 20 | ForEach-Object { @{type=$_.GetType().FullName;hresult=$_.HResult} })
                    }
                    $e=$e.InnerException
                }
            }
            $events = @()
            if ('BcRestoreAssemblyEvents' -as [type]) { $events = @([BcRestoreAssemblyEvents]::Drain()) }
            $data = [ordered]@{
                stage=$Stage; utc=[DateTime]::UtcNow.ToString('o'); pid=$PID
                executable=(Get-Process -Id $PID).Path; psVersion=[string]$PSVersionTable.PSVersion; edition=$PSVersionTable.PSEdition
                clr=[string][Environment]::Version; bitness=([IntPtr]::Size*8); runspace=[string][runspace]::DefaultRunspace.InstanceId
                modules=@(Get-Module | Where-Object Name -match 'BcContainerHelper|Nav|BusinessCentral|SqlServer' | Select-Object Name,@{n='Version';e={[string]$_.Version}},Path,ModuleBase)
                availableModules=@(Get-Module -ListAvailable | Where-Object Name -match 'BcContainerHelper|Nav|BusinessCentral' | Select-Object -First 50 Name,@{n='Version';e={[string]$_.Version}},Path)
                commandImplementation=$implementation; assemblies=$assemblies; assemblyEvents=$events; exceptions=$exceptions
                scriptStack=if($Failure){([string]$Failure.ScriptStackTrace).Substring(0,[Math]::Min(16000,([string]$Failure.ScriptStackTrace).Length))}else{''}
            }
            if ($PSVersionTable.PSEdition -eq 'Core') { $data.framework=[System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription }
            $helperConfigVariable=Get-Variable bcContainerHelperConfig -ErrorAction Ignore
            if ($helperConfigVariable -and $helperConfigVariable.Value.usePwshForBc24 -is [bool]) {
                $data.helperUsePwshForBc24=$helperConfigVariable.Value.usePwshForBc24
            }
            $json=$data | ConvertTo-Json -Depth 9 -Compress
            if ($json.Length -gt 220000) { throw 'Diagnostic capture exceeded its bounded record size.' }
            Write-Host ('BC_RESTORE_DIAGNOSTIC '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
        }
        function Start-BcRestoreAssemblyEvents {
            if (-not ('BcRestoreAssemblyEvents' -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Reflection;
public static class BcRestoreAssemblyEvents {
    static readonly ConcurrentQueue<string> Items = new ConcurrentQueue<string>();
    static readonly AssemblyLoadEventHandler Handler = (sender, args) => {
        if (Items.Count >= 400) return;
        Assembly a=args.LoadedAssembly;
        string name=a.GetName().Name;
        if (!(name.StartsWith("Microsoft.Extensions.") || name.StartsWith("Microsoft.Dynamics.") || name.StartsWith("Microsoft.SqlServer."))) return;
        string location=a.IsDynamic ? "" : a.Location;
        Items.Enqueue(a.FullName+" | "+location);
    };
    public static void Start() { AppDomain.CurrentDomain.AssemblyLoad += Handler; }
    public static void Stop() { AppDomain.CurrentDomain.AssemblyLoad -= Handler; }
    public static string[] Drain() { string item; var result=new System.Collections.Generic.List<string>(); while(Items.TryDequeue(out item)) result.Add(item); return result.ToArray(); }
}
'@
            }
            [BcRestoreAssemblyEvents]::Start()
        }
    }.ToString()
}

function Invoke-BcInstrumentedSqlRestore {
    param([hashtable]$RestoreParameters)
    # Build reviewed failures in the caller's scope: the helper module cannot
    # rely on resolving Toolset functions from an operation's script scope.
    $rejections = @{}
    foreach ($entry in @(
        @{Key='module'; Detail='Instrumented restore requires the loaded BcContainerHelper module.'},
        @{Key='active'; Detail='A diagnostic wrapper is already active.'},
        @{Key='target'; Detail='Diagnostic target mismatch; the helper requested a different container.'},
        @{Key='boundaries'; Detail='Unsupported helper restore command boundaries; diagnostics require exactly one Remove-NAVDatabase and one New-NAVDatabase command.'}
    )) {
        $rejections[$entry.Key] = New-BcExpectedFailure -Stage 'restore diagnostic compatibility' -Message "$($entry.Detail) SQL restore was not started; the BC service may already be stopped by restore preparation. Check the loaded helper version, diagnostic wrapper state and selected container service state before an explicitly approved retry. Use a supported helper layout or explicitly disable restoreDiagnostics after reconciling the target. No automatic retry or alternate restore was attempted."
    }
    $command = Get-Command Restore-DatabasesInBcContainer -ErrorAction Stop
    $module = $command.Module
    if (-not $module -or $module.Name -ne 'BcContainerHelper') {
        throw $rejections.module
    }
    $code = Get-BcRestoreDiagnosticCode
    . ([scriptblock]::Create($code))
    Write-BcRestoreSnapshot -Stage 'host-before-restore'
    # Temporarily wrap the helper's invocation in its own module scope. The
    # installed helper files are never edited. Always restore the original.
    & $module {
        param($code, $target, $rejections)
        if (Get-Variable BcRestoreOriginalInvoke -Scope Script -ErrorAction Ignore) { throw $rejections.active }
        $script:BcRestoreOriginalInvoke = (Get-Command Invoke-ScriptInBcContainer -CommandType Function).ScriptBlock
        $script:BcRestoreDiagnosticCode = $code
        $script:BcRestoreDiagnosticTarget = $target
        $script:BcRestoreDiagnosticRejections = $rejections
        function script:Invoke-ScriptInBcContainer {
            param([string]$containerName, [scriptblock]$scriptblock, [object[]]$argumentList,
                [bool]$useSession=$bcContainerHelperConfig.usePsSession,
                [bool]$usePwsh=$bcContainerHelperConfig.usePwshForBc24)
            if ($containerName -cne $script:BcRestoreDiagnosticTarget) { throw $script:BcRestoreDiagnosticRejections.target }
            $original = $scriptblock.ToString()
            # Insert capture statements at the actual helper command boundaries.
            # Reject unexpected helper code instead of running without capture.
            $commands=@($scriptblock.Ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -in @('Remove-NAVDatabase','New-NAVDatabase')},$true))
            if (@($commands | Where-Object { $_.GetCommandName() -eq 'New-NAVDatabase' }).Count -ne 1 -or
                @($commands | Where-Object { $_.GetCommandName() -eq 'Remove-NAVDatabase' }).Count -ne 1) {
                throw $script:BcRestoreDiagnosticRejections.boundaries
            }
            foreach($node in @($commands | Sort-Object { $_.Extent.StartOffset } -Descending)) {
                $offset=$node.Extent.StartOffset-$scriptblock.Ast.Extent.StartOffset
                # ScriptBlock.ToString omits its surrounding braces, unlike Extent.
                if ($scriptblock.Ast.Extent.Text.StartsWith('{')) { $offset-- }
                $original=$original.Insert($offset,"Write-BcRestoreSnapshot -Stage 'before-$($node.GetCommandName())';`n")
            }
            $wrapped = {
                param($diagnosticCode, $originalCode, $originalArguments)
                $ErrorActionPreference='Stop'
                . ([scriptblock]::Create($diagnosticCode))
                Write-BcRestoreSnapshot -Stage 'container-after-bootstrap'
                Start-BcRestoreAssemblyEvents
                try {
                    if ($originalArguments[1]) {
                        # Native SQL verification keeps its dependency loading
                        # outside the administration-module process being tested.
                        $null=Get-Command sqlcmd -CommandType Application -ErrorAction Stop
                        $configPath=Join-Path (Get-Item 'C:\Program Files\Microsoft Dynamics NAV\*\Service').FullName 'CustomSettings.config'
                        [xml]$cfg=[IO.File]::ReadAllText($configPath)
                        $server=$cfg.SelectSingleNode("//appSettings/add[@key='DatabaseServer']").Value
                        $instance=$cfg.SelectSingleNode("//appSettings/add[@key='DatabaseInstance']").Value
                        $endpoint=if($instance){"$server\$instance"}else{$server}
                        $backupPath=([string]$originalArguments[1]).Replace("'","''")
                        & sqlcmd -S $endpoint -E -b -Q "RESTORE VERIFYONLY FROM DISK=N'$backupPath'"
                        if($LASTEXITCODE -ne 0){throw 'Fresh backup SQL verification failed; no database removal was attempted.'}
                        Write-Host 'BC_RESTORE_BACKUP_VERIFY: passed before database removal.'
                    }
                    & ([scriptblock]::Create($originalCode)) @originalArguments
                    Write-BcRestoreSnapshot -Stage 'container-restore-returned'
                } catch {
                    $failure=$_
                    try { Write-BcRestoreSnapshot -Stage 'container-restore-failed' -Failure $failure }
                    catch { Write-Host 'BC_RESTORE_DIAGNOSTIC_CAPTURE_FAILED: original restore failure preserved.' }
                    throw $failure
                } finally {
                    [BcRestoreAssemblyEvents]::Stop()
                }
            }
            & $script:BcRestoreOriginalInvoke -containerName $containerName -scriptblock $wrapped -argumentList @($script:BcRestoreDiagnosticCode,$original,$argumentList) -useSession:$useSession -usePwsh:$usePwsh
        }
    } $code $RestoreParameters.containerName $rejections
    try { & $command @RestoreParameters -ErrorAction Stop }
    finally {
        & $module {
            Set-Item function:script:Invoke-ScriptInBcContainer -Value $script:BcRestoreOriginalInvoke
            Remove-Variable BcRestoreOriginalInvoke,BcRestoreDiagnosticCode,BcRestoreDiagnosticTarget,BcRestoreDiagnosticRejections -Scope Script
        }
    }
}

function Get-BcRestoreEnvironment {
    param($SettingsJSON)
    $ErrorActionPreference = 'Stop'
    $targets=@($SettingsJSON.configurations | Where-Object serverType -eq 'Container')
    if ($targets.Count -ne 1 -or $targets[0].container -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') {
        throw (New-BcExpectedFailure -Stage 'restore diagnostic target validation' -Message 'Select exactly one Container configuration with a valid container name. No container or SQL changes were started.')
    }
    $name=[string]$targets[0].container
    $inspectionMode=[string]$targets[0].restoreInspectionMode
    if(-not $inspectionMode){$inspectionMode='Database'}
    if($inspectionMode -notin @('Full','Database','State')) {
        throw (New-BcExpectedFailure -Stage 'restore diagnostic mode validation' -Message 'restoreInspectionMode must be Full, Database or State. No container or SQL changes were started.')
    }
    $stage = 'container identity inspection'
    $failureDetail = ''
    try {
        $inspect=Invoke-ConfiguredContainerDocker -DockerArguments @('container','inspect','--format','{"Name":{{json .Name}},"Id":{{json .Id}},"Image":{{json .Config.Image}},"Status":{{json .State.Status}},"Running":{{json .State.Running}},"Health":{{json .State.Health.Status}}}','--',$name)
        $identity=$inspect | ConvertFrom-Json -ErrorAction Stop
        if ($identity.Name -cne "/$name") {
            $failureDetail = 'The inspected identity did not match the selected container name.'
            throw 'Container identity mismatch.'
        }
        Write-Host ('BC_RESTORE_CONTAINER '+($identity | ConvertTo-Json -Compress))
        if($inspectionMode -eq 'State'){return}
        $stage = 'host diagnostic inventory'
        . ([scriptblock]::Create((Get-BcRestoreDiagnosticCode)))
        Write-BcRestoreSnapshot -Stage 'host-inventory'
        if (-not $identity.Running) { Write-Host 'Container stopped. Live container/module/database inventory unavailable; no startup attempted.'; return }
        if($inspectionMode -eq 'Full') {
        $stage = 'fresh host process inventory'
        $freshCode=(Get-BcRestoreDiagnosticCode)+[Environment]::NewLine+"Write-BcRestoreSnapshot -Stage 'host-fresh-process'"
        $helper=Get-Module BcContainerHelper
        if($helper) {
            $manifest=Join-Path $helper.ModuleBase 'BcContainerHelper.psd1'
            $freshCode+=[Environment]::NewLine+"Import-Module '"+$manifest.Replace("'","''")+"' -ErrorAction Stop"+[Environment]::NewLine+"Write-BcRestoreSnapshot -Stage 'host-fresh-helper-imported'"
        }
        $freshEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($freshCode))
        $freshOutput=& (Get-Process -Id $PID).Path -NoProfile -NonInteractive -EncodedCommand $freshEncoded 2>&1
        $freshExit=$LASTEXITCODE
        $freshOutput | ForEach-Object { Write-Host ([string]$_) }
        if($freshExit -ne 0){
            $failureDetail = "The fresh host inventory process failed. Native exit code: $freshExit."
            throw 'Fresh host process inventory failed.'
        }
        }
        $stage = 'container inventory preparation'
        $body = (Get-BcRestoreDiagnosticCode) + @'

Write-BcRestoreSnapshot -Stage 'container-before-bootstrap'
Start-BcRestoreAssemblyEvents
try {
    . C:\Run\prompt.ps1 -silent | Out-Null
    . C:\Run\ServiceSettings.ps1 | Out-Null
    . C:\Run\HelperFunctions.ps1 | Out-Null
    Write-BcRestoreSnapshot -Stage 'container-inventory-after-bootstrap'
    if('__BC_RESTORE_INSPECTION_MODE__' -eq 'Full') {
    $sqlModule=Get-Module -ListAvailable SqlServer | Sort-Object Version -Descending | Select-Object -First 1
    if($sqlModule) {
        $sourcePath=Join-Path $sqlModule.ModuleBase 'SqlServer.psm1'
        $sourceLines=@()
        if(Test-Path -LiteralPath $sourcePath -PathType Leaf) {
            $sourceLines=@(Get-Content -LiteralPath $sourcePath | Select-String -Pattern 'AssemblyLoadContext|Resolving|AssemblyResolve|coreclr|Import-Module|LoadFrom' | Select-Object -First 40 | ForEach-Object { @{line=$_.LineNumber;code=$_.Line.Substring(0,[Math]::Min(300,$_.Line.Length))} })
        }
        Write-Host ('BC_RESTORE_SQL_MODULE '+(@{name=$sqlModule.Name;version=[string]$sqlModule.Version;path=$sqlModule.Path;resolverSource=$sourceLines} | ConvertTo-Json -Depth 5 -Compress))
        $cmd=Get-Command New-NAVDatabase -ListImported -ErrorAction Stop
        $adminRoot=Split-Path -Parent $cmd.ImplementingType.Assembly.Location
        $files=@((Join-Path $adminRoot 'Microsoft.Extensions.DependencyInjection.Abstractions.dll'),(Join-Path $sqlModule.ModuleBase 'coreclr\Microsoft.Extensions.DependencyInjection.Abstractions.dll'))
        $metadata=@(foreach($file in $files) {
            if(Test-Path -LiteralPath $file -PathType Leaf) {
                @{path=$file;identity=[Reflection.AssemblyName]::GetAssemblyName($file).FullName}
            }
        })
        Write-Host ('BC_RESTORE_DEPENDENCY_FILES '+(ConvertTo-Json -InputObject @($metadata) -Depth 4 -Compress))
        if($PSVersionTable.PSEdition -eq 'Core') {
            # Two disposable processes isolate the resolver experiment. Neither
            # invokes database administration cmdlets or performs SQL writes.
            $probe={
                param([bool]$Preload)
                $ErrorActionPreference='Stop'
                . C:\Run\prompt.ps1 -silent | Out-Null
                . C:\Run\ServiceSettings.ps1 | Out-Null
                . C:\Run\HelperFunctions.ps1 | Out-Null
                $cmd=Get-Command New-NAVDatabase -ListImported -ErrorAction Stop
                $file=Join-Path (Split-Path -Parent $cmd.ImplementingType.Assembly.Location) 'Microsoft.Extensions.DependencyInjection.Abstractions.dll'
                $expected=[Reflection.AssemblyName]::GetAssemblyName($file)
                $resolved=$null; $failure=$null; $present=$false
                try {
                    if($Preload){$null=[System.Runtime.Loader.AssemblyLoadContext]::Default.LoadFromAssemblyPath($file)}
                    Import-Module SqlServer -ErrorAction Stop
                    $resolved=[Reflection.Assembly]::Load($expected)
                    $type=$resolved.GetType('Microsoft.Extensions.DependencyInjection.ServiceCollection',$true)
                    $null=[Activator]::CreateInstance($type)
                    $present=$true
                } catch { $failure=@{type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult} }
                $record=@{preload=$Preload;pid=$PID;psVersion=[string]$PSVersionTable.PSVersion;expected=$expected.FullName;serviceCollectionAvailable=$present;failure=$failure}
                if($resolved){$record.actual=$resolved.FullName;$record.location=$resolved.Location;$record.context=[string][System.Runtime.Loader.AssemblyLoadContext]::GetLoadContext($resolved)}
                [Console]::WriteLine('BC_RESTORE_RESOLUTION_PROBE '+($record | ConvertTo-Json -Depth 5 -Compress))
            }.ToString()
            foreach($preload in @('$false','$true')) {
                $probeScript='& {'+$probe+'} '+$preload
                $probeEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeScript))
                $probeOutput=& pwsh -NoProfile -NonInteractive -EncodedCommand $probeEncoded 2>&1
                if($LASTEXITCODE -ne 0){throw 'Read-only resolver probe process failed.'}
                $probeOutput | ForEach-Object { Write-Host ([string]$_) }
            }
        }
    }
    }
    $services=@(Get-Service | Where-Object { $_.Name -match '^(MicrosoftDynamicsNavServer\$|MSSQL\$)' } | Select-Object Name,@{n='Status';e={[string]$_.Status}})
    Write-Host ('BC_RESTORE_SERVICES '+($services | ConvertTo-Json -Compress))
    $configPath=Join-Path (Get-Item 'C:\Program Files\Microsoft Dynamics NAV\*\Service').FullName 'CustomSettings.config'
    [xml]$cfg=[IO.File]::ReadAllText($configPath)
    $server=$cfg.SelectSingleNode("//appSettings/add[@key='DatabaseServer']").Value
    $instance=$cfg.SelectSingleNode("//appSettings/add[@key='DatabaseInstance']").Value
    $db=$cfg.SelectSingleNode("//appSettings/add[@key='DatabaseName']").Value
    $null=Get-Command sqlcmd -CommandType Application -ErrorAction Stop
    $endpoint=if($instance){"$server\$instance"}else{$server}
    $escapedDb=([string]$db).Replace("'","''")
    $result=& sqlcmd -S $endpoint -E -b -h -1 -W -Q "SET NOCOUNT ON; SELECT name,state_desc FROM sys.databases WHERE name=N'$escapedDb'"
    if($LASTEXITCODE -ne 0){throw 'Read-only database state query failed.'}
    Write-Host ('BC_RESTORE_DATABASES '+($result -join ' ').Trim())
    $applications=@(Get-NAVApplication -ServerInstance BC -ErrorAction Stop)
    $versionFields=@(foreach($application in $applications) {
        foreach($property in @($application.PSObject.Properties | Where-Object Name -Match 'Version')) {
            $value=[string]$property.Value
            @{name=$property.Name;isEmpty=[string]::IsNullOrWhiteSpace($value);numericVersion=if($value -match '^\d+(\.\d+){1,4}$'){$value}else{$null}}
        }
    })
    $serviceFile=Get-Item (Join-Path (Split-Path -Parent $configPath) 'Microsoft.Dynamics.Nav.Server.exe')
    Write-Host ('BC_RESTORE_APPLICATION_METADATA '+(@{count=$applications.Count;versionFields=$versionFields;serviceFileVersion=$serviceFile.VersionInfo.FileVersion;serviceProductVersion=$serviceFile.VersionInfo.ProductVersion} | ConvertTo-Json -Depth 5 -Compress))
} catch {
    Write-BcRestoreSnapshot -Stage 'container-inventory-failed' -Failure $_
    exit 1
} finally { [BcRestoreAssemblyEvents]::Stop() }
'@
        $body=$body.Replace('__BC_RESTORE_INSPECTION_MODE__',$inspectionMode)
        $shells=if($inspectionMode -eq 'Database'){@('powershell')}else{@('powershell','pwsh')}
        foreach($shell in $shells) {
            $stage = "container $shell inventory"
            $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
            $output=& docker exec $name $shell -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1
            $exit=$LASTEXITCODE
            # Encoded-command host output is CLIXML. Preserve it for local decoding;
            # never include Docker inspect env, connection strings or credentials.
            Write-Host "BC_RESTORE_SHELL $shell exit=$exit"
            $output | ForEach-Object { Write-Host ([string]$_) }
            if ($exit -ne 0) {
                $failureDetail = "The container $shell inventory process failed. Native exit code: $exit."
                throw 'Container runtime inventory failed.'
            }
        }
    } catch {
        # Preserve only reviewed Toolset details, never arbitrary backend text.
        if (-not $failureDetail) { $failureDetail = "The underlying cause is unknown. Error code: $($_.Exception.HResult)." }
        throw (New-BcExpectedFailure -Stage $stage -Message "Read-only restore environment inspection failed during $stage. $failureDetail No lifecycle or SQL writes were requested; no restore was started. Check Docker availability, the selected container identity and the diagnostic stage output before retrying this read-only inspection. No automatic retry was attempted.")
    }
}
