param(
    [ValidateSet('BC23 Baseline','BC27.1')][string] $Target = 'BC23 Baseline',
    [ValidateSet('modify','rename')][string] $Operation = 'modify',
    [switch] $CleanupOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$container = @{'BC23 Baseline'='bcdata23test';'BC27.1'='bcdata271'}[$Target]
$prefix = if ($Operation -eq 'rename') { 'evpr' } else { 'evp' }
$statePath = Join-Path $root ".bcdevtoolset/$prefix-$container-state.json"
$evidencePath = Join-Path $root ".bcdevtoolset/$prefix-$container-evidence.json"
. (Join-Path $root 'common/CredentialMgt.ps1')
$settings = Get-Content -LiteralPath (Join-Path $root '.bcdevtoolset/settings.json') -Raw | ConvertFrom-Json
$matches = @($settings.configurations | Where-Object name -CEQ $Target)
if ($matches.Count -ne 1 -or $matches[0].container -cne $container -or $matches[0].serverType -ne 'Container' -or
    $matches[0].targetType -ne 'Test' -or $matches[0].authentication -ne 'UserPassword') {
    throw 'Only the two dedicated UserPassword Test configurations are accepted.'
}
$credential = Get-ConfigurationCredential -configuration $matches[0] -kind bc
$admin = @{username=$credential.UserName;password=$credential.GetNetworkCredential().Password}
# Native user/role assignment has no exposed Toolset MCP operation. Use only
# these tagged disposable identities; AL build/deploy/test remains MCP-driven.
Import-Module BcContainerHelper -DisableNameChecking

function Get-Identities($State) {
    if (($State.operation -and $State.operation -cne $Operation) -or $State.target -cne $Target -or $State.container -cne $container) { throw 'EVP state target mismatch.' }
    $id = [guid]::Empty
    if (-not [guid]::TryParseExact($State.namespaceId, 'D', [ref]$id) -or $id -eq [guid]::Empty) { throw 'Invalid EVP namespace.' }
    if ((@($State.runs.kind | Sort-Object) -join ',') -cne 'f,x') { throw 'Invalid EVP runs.' }
    foreach ($run in $State.runs) {
        $runGuid = [guid]::Empty
        if (-not [guid]::TryParseExact($run.runId,'D',[ref]$runGuid) -or $runGuid -eq [guid]::Empty) { throw 'Invalid EVP run.' }
        $tag = $id.ToString('N').Substring(0,12)
        [pscustomobject]@{kind=$run.kind;username="bcd_evp_${tag}_$($run.kind)";role=("BEVP$tag$($run.kind)").ToUpperInvariant()}
    }
}
function Invoke-NodePhase([string] $Phase, $State, $Users = @(), $Expected = $null) {
    $start = [Diagnostics.ProcessStartInfo]::new('node')
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'Verify-BCDataReplayPermissions.cjs'))
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
        @{phase=$Phase;state=$State;admin=$admin;users=@($Users);expectedHistory=$Expected} | ConvertTo-Json -Depth 10 -Compress |
            ForEach-Object { $process.StandardInput.WriteLine($_) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(180000)) { $process.Kill($true); throw 'EVP phase timed out; run -CleanupOnly.' }
        if ($process.ExitCode -ne 0) { throw ('EVP phase failed (exit code ' + $process.ExitCode + '): ' + $err.GetAwaiter().GetResult()) }
        return $out.GetAwaiter().GetResult() | ConvertFrom-Json
    } finally { $process.Dispose() }
}
function Remove-Fixture($State) {
    $identities = @(Get-Identities $State)
    $null = Invoke-NodePhase 'cleanupData' $State
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities, $Marker)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            $users = @(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $identity.username)
            if ($users.Count) {
                if ($users.Count -ne 1 -or $users[0].FullName -cne $Marker) { throw 'EVP identity ownership changed.' }
                Remove-NAVServerUser -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -Force
            }
        }
        if (@(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IIn @($Identities.username)).Count) {
            throw 'EVP users remain.'
        }
    } -argumentList $identities,"BCD EVP $($State.namespaceId)" | Out-Null
    $null = Invoke-NodePhase 'cleanupRoles' $State
    Remove-Item -LiteralPath $statePath
}
function Set-OwnerProfile($State, [string] $From, [string] $To) {
    if ($From -cnotin @('f','r','n','v') -or $To -cnotin @('f','r','n','v')) { throw 'Invalid EVP profile.' }
    $owner = @(Get-Identities $State | Where-Object kind -CEQ 'f')[0]
    $tag = ([guid]$State.namespaceId).ToString('N').Substring(0,12)
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Username, $Marker, $FromRole, $ToRole)
        $ErrorActionPreference = 'Stop'
        $user = @(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $Username)
        if ($user.Count -ne 1 -or $user[0].FullName -cne $Marker) { throw 'EVP identity ownership changed.' }
        Remove-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $Username -PermissionSetId $FromRole -Scope Tenant -Force
        New-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $Username -PermissionSetId $ToRole -Scope Tenant
    } -argumentList $owner.username,"BCD EVP $($State.namespaceId)",("BEVP$tag$From").ToUpperInvariant(),("BEVP$tag$To").ToUpperInvariant() | Out-Null
}
if ($CleanupOnly) {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'No EVP cleanup state.' }
    Remove-Fixture (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)
    Write-Host 'EVP rows, users and roles removed and verified.'
    return
}
$state = [pscustomobject]@{target=$Target;container=$container;namespaceId=[guid]::NewGuid().ToString('D');
    requestId=[guid]::NewGuid().ToString('D');companyId=$null;operation=$Operation;
    runs=@('f','x' | ForEach-Object { @{kind=$_;runId=[guid]::NewGuid().ToString('D')} })}
$identities = @(Get-Identities $state)
$password = 'EVP!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$users = @($identities | ForEach-Object { @{kind=$_.kind;username=$_.username;password=$password} })
# Exclusive metadata-only recovery intent before creating any identities or roles.
$stream = [IO.File]::Open($statePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$stream.Dispose()
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding utf8
$results = @(); $cleaned = $false
try {
    $state.companyId = (Invoke-NodePhase 'discover' $state).companyId
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding utf8
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities, $Password, $Marker)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            if (@(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $identity.username).Count) {
                throw 'EVP user collision.'
            }
        }
        foreach ($identity in $Identities) {
            New-NAVServerUser -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -FullName $Marker -Password $Password
        }
    } -argumentList $identities,$securePassword,"BCD EVP $($state.namespaceId)" | Out-Null
    $null = Invoke-NodePhase 'prepareRoles' $state
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            New-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -PermissionSetId $identity.role -Scope Tenant
        }
    } -argumentList (,$identities) | Out-Null
    $initial = Invoke-NodePhase 'initial' $state $users
    $results += @($initial.results)
    if (-not $initial.ownerHistory) { throw 'EVP owner could not establish its receipt.' }
    $from = 'f'
    foreach ($profile in @('r','n','v','f')) {
        Set-OwnerProfile $state $from $profile
        $phase = Invoke-NodePhase $profile $state $users $initial.ownerHistory
        $results += @($phase.results)
        $from = $profile
    }
} finally {
    try {
        Remove-Fixture $state
        $cleaned = $true
    } finally {
        $evidence = @{target=$Target;operation=$Operation;utc=[DateTime]::UtcNow.ToString('o');results=$results;cleaned=$cleaned;
            passed=($cleaned -and $results.Count -eq 16 -and @($results | Where-Object passed -NE $true).Count -eq 0)}
        $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidencePath -Encoding utf8
        $evidence | ConvertTo-Json -Depth 12
        $password=$null; $securePassword=$null; $users=$null; $admin=$null; $credential=$null
    }
}
if (-not $evidence.passed) { throw 'EVP assertions failed; see credential-free evidence.' }
