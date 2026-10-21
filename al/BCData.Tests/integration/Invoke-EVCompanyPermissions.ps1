param(
    [ValidateSet('BC23 Baseline','BC27.1')][string] $Target = 'BC23 Baseline',
    [switch] $CleanupOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$container = @{'BC23 Baseline'='bcdata23test';'BC27.1'='bcdata271'}[$Target]
$statePath = Join-Path $root ".bcdevtoolset/evca-$container-state.json"
$evidencePath = Join-Path $root ".bcdevtoolset/evca-$container-evidence.json"
. (Join-Path $root 'common/CredentialMgt.ps1')
$settings = Get-Content -LiteralPath (Join-Path $root '.bcdevtoolset/settings.json') -Raw | ConvertFrom-Json
$matches = @($settings.configurations | Where-Object name -CEQ $Target)
if ($matches.Count -ne 1 -or $matches[0].container -cne $container -or $matches[0].serverType -ne 'Container' -or
    $matches[0].targetType -ne 'Test' -or $matches[0].authentication -ne 'UserPassword') {
    throw 'Only the two dedicated UserPassword Test configurations are accepted.'
}
$credential = Get-ConfigurationCredential -configuration $matches[0] -kind bc
$admin = @{username=$credential.UserName;password=$credential.GetNetworkCredential().Password}
# No matching company creation/removal MCP operation is exposed. Native administration
# below accepts only this run's namespace-derived empty company and full display marker.
# Temporary user and company-scoped role assignment likewise have no matching MCP operation.
Import-Module BcContainerHelper -DisableNameChecking
function Assert-State($State) {
    if ($State.target -cne $Target -or $State.container -cne $container) { throw 'EVCA target mismatch.' }
    foreach ($value in @($State.namespaceId,$State.runId,$State.exclusiveRunId,$State.requestId)) {
        $parsed = [guid]::Empty
        if (-not [guid]::TryParseExact($value,'D',[ref]$parsed) -or $parsed -eq [guid]::Empty) { throw 'Invalid EVCA GUID.' }
    }
    $expected = 'BCD_CT_' + ([guid]$State.namespaceId).ToString('N').Substring(0,12)
    if ($State.secondaryName -cne $expected -or $State.primaryName -cne 'CRONUS International Ltd.') { throw 'EVCA company scope mismatch.' }
}
function Save-State($State) { $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding utf8 }
function Invoke-Phase([string] $Phase, $State, $Users = @(), $Expected = $null) {
    Assert-State $State
    $start = [Diagnostics.ProcessStartInfo]::new('node')
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'Verify-BCDataCompanyPermissions.cjs'))
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
        @{phase=$Phase;state=$State;admin=$admin;users=@($Users);expectedHistory=$Expected} | ConvertTo-Json -Depth 8 -Compress |
            ForEach-Object { $process.StandardInput.WriteLine($_) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(180000)) { $process.Kill($true); throw 'EVCA phase timed out; use -CleanupOnly.' }
        if ($process.ExitCode -ne 0) { throw ('EVCA phase failed (exit code ' + $process.ExitCode + '): ' + $err.GetAwaiter().GetResult()) }
        return $out.GetAwaiter().GetResult() | ConvertFrom-Json
    } finally { $process.Dispose() }
}
function Assert-CompanyOwner($State) {
    Assert-State $State
    $exists = Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Name,$Marker)
        $ErrorActionPreference = 'Stop'
        $company = @(Get-NAVCompany -ServerInstance $ServerInstance -Tenant default | Where-Object CompanyName -CEQ $Name)
        if ($company.Count -gt 1 -or ($company.Count -eq 1 -and $company[0].CompanyDisplayName -cne $Marker)) {
            throw 'EVCA company ownership marker changed; refusing company access/removal.'
        }
        $company.Count -eq 1
    } -argumentList $State.secondaryName,"BCD CT $($State.namespaceId)"
    return [bool]$exists
}
function Get-Identities($State) {
    Assert-State $State
    $tag = ([guid]$State.namespaceId).ToString('N').Substring(0,12)
    foreach ($kind in @('f','x')) {
        [pscustomobject]@{kind=$kind;username="bcd_evp_${tag}_$kind";role=("BEVP$tag$kind").ToUpperInvariant()}
    }
}
function Remove-Identities($State) {
    $identities = @(Get-Identities $State)
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities,$Marker)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            $users = @(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $identity.username)
            if ($users.Count) {
                if ($users.Count -ne 1 -or $users[0].FullName -cne $Marker) { throw 'EVCA identity ownership changed.' }
                Remove-NAVServerUser -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -Force
            }
        }
        if (@(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IIn @($Identities.username)).Count) {
            throw 'EVCA users remain.'
        }
    } -argumentList $identities,"BCD EVP $($State.namespaceId)" | Out-Null
}
function Set-OwnerCompanyGrant($State,[string] $Company,[bool] $Grant) {
    Assert-State $State
    if ($Company -cnotin @($State.primaryName,$State.secondaryName)) { throw 'EVCA grant company outside test scope.' }
    if (-not $Grant -and $Company -cne $State.primaryName) { throw 'EVCA revocation scenario is restricted to the primary company.' }
    $owner = @(Get-Identities $State | Where-Object kind -CEQ 'f')[0]
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Username,$Marker,$Role,$Company,$Grant)
        $ErrorActionPreference = 'Stop'
        $user = @(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $Username)
        if ($user.Count -ne 1 -or $user[0].FullName -cne $Marker) { throw 'EVCA identity ownership changed.' }
        if ($Grant) {
            New-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $Username -PermissionSetId $Role -Scope Tenant -CompanyName $Company -Force
            New-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $Username -PermissionSetId 'BCD DATA EXECUTE' -Scope System -AppName 'BC Dev Toolset Data' -AppPublisher 'dam-pav' -CompanyName $Company -Force
        } else {
            Remove-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $Username -PermissionSetId $Role -Scope Tenant -CompanyName $Company -Force
        }
    } -argumentList $owner.username,"BCD EVP $($State.namespaceId)",$owner.role,$Company,$Grant | Out-Null
    if (-not $Grant) { $null = Invoke-Phase 'removeExecutionA' $State }
}
function Remove-Fixture($State) {
    Assert-State $State
    if (Assert-CompanyOwner $State) {
        $binding = Invoke-Phase 'bind' $State
        if ($State.secondaryId -and $State.secondaryId -cne $binding.secondaryId) { throw 'EVCA company identity changed.' }
        $State.secondaryId = $binding.secondaryId
        Save-State $State
    }
    $null = Invoke-Phase 'cleanup' $State
    Remove-Identities $State
    $null = Invoke-Phase 'cleanupRoles' $State
    if (Assert-CompanyOwner $State) {
        # A second native ownership check immediately precedes removal. Only the
        # generated empty company is removed, after its fixture rows are verified gone.
        Invoke-ScriptInBcContainer -containerName $container -scriptblock {
            param($Name,$Marker)
            $ErrorActionPreference = 'Stop'
            $company = @(Get-NAVCompany -ServerInstance $ServerInstance -Tenant default | Where-Object CompanyName -CEQ $Name)
            if ($company.Count -ne 1 -or $company[0].CompanyDisplayName -cne $Marker) { throw 'EVCA company ownership changed.' }
            Remove-NAVCompany -ServerInstance $ServerInstance -Tenant default -CompanyName $Name -ForceImmediateDataDeletion -Force
            if (@(Get-NAVCompany -ServerInstance $ServerInstance -Tenant default -IncludePartiallyDeleted | Where-Object CompanyName -CEQ $Name).Count) {
                throw 'EVCA temporary company remains.'
            }
        } -argumentList $State.secondaryName,"BCD CT $($State.namespaceId)" | Out-Null
    }
    $null = Invoke-Phase 'verifyAbsent' $State
    Remove-Item -LiteralPath $statePath
}
if ($CleanupOnly) {
    Remove-Fixture (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)
    Write-Host 'EVCA fixture rows and tagged company removed and verified.'
    return
}
$namespaceId = [guid]::NewGuid().ToString('D')
$state = [pscustomobject]@{target=$Target;container=$container;namespaceId=$namespaceId;
    runId=[guid]::NewGuid().ToString('D');exclusiveRunId=[guid]::NewGuid().ToString('D');requestId=[guid]::NewGuid().ToString('D');
    primaryName='CRONUS International Ltd.';primaryId=$null;secondaryName=('BCD_CT_' + ([guid]$namespaceId).ToString('N').Substring(0,12));secondaryId=$null;runs=@()}
$state.runs = @(@{kind='f';runId=$state.runId},@{kind='x';runId=$state.exclusiveRunId})
$identities = @(Get-Identities $state)
$password = 'EVCA!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$users = @($identities | ForEach-Object { @{kind=$_.kind;username=$_.username;password=$password} })
Assert-State $state
# Exclusive metadata-only recovery intent before creating any company or fixture data.
$stream = [IO.File]::Open($statePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$stream.Dispose()
Save-State $state
$results = @(); $cleaned = $false
try {
    $state.primaryId = (Invoke-Phase 'discover' $state).primaryId
    Save-State $state
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Name,$Marker)
        $ErrorActionPreference = 'Stop'
        if (@(Get-NAVCompany -ServerInstance $ServerInstance -Tenant default -IncludePartiallyDeleted | Where-Object CompanyName -CEQ $Name).Count) {
            throw 'EVCA company name collision.'
        }
        New-NAVCompany -ServerInstance $ServerInstance -Tenant default -CompanyName $Name -CompanyDisplayName $Marker -Force
    } -argumentList $state.secondaryName,"BCD CT $namespaceId" | Out-Null
    if (-not (Assert-CompanyOwner $state)) { throw 'EVCA company was not created.' }
    $state.secondaryId = (Invoke-Phase 'bind' $state).secondaryId
    Save-State $state
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities,$Password,$Marker)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            if (@(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $identity.username).Count) {
                throw 'EVCA identity collision.'
            }
        }
        foreach ($identity in $Identities) {
            New-NAVServerUser -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -FullName $Marker -Password $Password
        }
    } -argumentList $identities,$securePassword,"BCD EVP $namespaceId" | Out-Null
    $null = Invoke-Phase 'prepareRoles' $state
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities,$Marker,$Primary,$Secondary)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            $user = @(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $identity.username)
            if ($user.Count -ne 1 -or $user[0].FullName -cne $Marker) { throw 'EVCA identity ownership changed.' }
            $company = if ($identity.kind -ceq 'f') { $Primary } else { $Secondary }
            New-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -PermissionSetId $identity.role -Scope Tenant -CompanyName $company -Force
            New-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -PermissionSetId 'BCD DATA EXECUTE' -Scope System -AppName 'BC Dev Toolset Data' -AppPublisher 'dam-pav' -CompanyName $company -Force
        }
    } -argumentList $identities,"BCD EVP $namespaceId",$state.primaryName,$state.secondaryName | Out-Null
    $initial = Invoke-Phase 'initial' $state $users
    $results += @($initial.results)
    if (-not $initial.ownerHistory) { throw 'EVCA owner setup failed.' }
    Set-OwnerCompanyGrant $state $state.secondaryName $true
    $granted = Invoke-Phase 'grantB' $state $users $initial.ownerHistory
    $results += @($granted.results)
    if (-not $granted.ownerHistory.secondary) { throw 'EVCA secondary owner setup failed.' }
    Set-OwnerCompanyGrant $state $state.primaryName $false
    $revoked = Invoke-Phase 'revokeA' $state $users $granted.ownerHistory
    $results += @($revoked.results)
    Set-OwnerCompanyGrant $state $state.primaryName $true
    $restored = Invoke-Phase 'restoreA' $state $users $granted.ownerHistory
    $results += @($restored.results)
} finally {
    try { Remove-Fixture $state; $cleaned = $true }
    finally {
        $evidence = @{target=$Target;utc=[DateTime]::UtcNow.ToString('o');primaryId=$state.primaryId;secondaryId=$state.secondaryId;
            results=$results;cleaned=$cleaned;passed=($cleaned -and $results.Count -eq 21 -and @($results | Where-Object passed -NE $true).Count -eq 0)}
        $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidencePath -Encoding utf8
        $evidence | ConvertTo-Json -Depth 12
        $admin=$null; $credential=$null; $password=$null; $securePassword=$null; $users=$null
    }
}
if (-not $evidence.passed) { throw 'EVCA assertions failed; see credential-free evidence.' }
