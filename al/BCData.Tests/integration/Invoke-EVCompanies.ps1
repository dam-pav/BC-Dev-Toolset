param(
    [ValidateSet('BC23 Baseline','BC27.1')][string] $Target = 'BC23 Baseline',
    [switch] $CleanupOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$container = @{'BC23 Baseline'='bcdata23test';'BC27.1'='bcdata271'}[$Target]
$statePath = Join-Path $root ".bcdevtoolset/evc-$container-state.json"
$evidencePath = Join-Path $root ".bcdevtoolset/evc-$container-evidence.json"
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
Import-Module BcContainerHelper -DisableNameChecking
function Assert-State($State) {
    if ($State.target -cne $Target -or $State.container -cne $container) { throw 'EVC target mismatch.' }
    foreach ($value in @($State.namespaceId,$State.runId,$State.exclusiveRunId,$State.requestId)) {
        $parsed = [guid]::Empty
        if (-not [guid]::TryParseExact($value,'D',[ref]$parsed) -or $parsed -eq [guid]::Empty) { throw 'Invalid EVC GUID.' }
    }
    $expected = 'BCD_CT_' + ([guid]$State.namespaceId).ToString('N').Substring(0,12)
    if ($State.secondaryName -cne $expected -or $State.primaryName -cne 'CRONUS International Ltd.') { throw 'EVC company scope mismatch.' }
}
function Save-State($State) { $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding utf8 }
function Invoke-Phase([string] $Phase, $State) {
    Assert-State $State
    $start = [Diagnostics.ProcessStartInfo]::new('node')
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'Verify-BCDataCompanies.cjs'))
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
        @{phase=$Phase;state=$State;admin=$admin} | ConvertTo-Json -Depth 8 -Compress |
            ForEach-Object { $process.StandardInput.WriteLine($_) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(180000)) { $process.Kill($true); throw 'EVC phase timed out; use -CleanupOnly.' }
        if ($process.ExitCode -ne 0) { throw ('EVC phase failed (exit code ' + $process.ExitCode + '): ' + $err.GetAwaiter().GetResult()) }
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
            throw 'EVC company ownership marker changed; refusing company access/removal.'
        }
        $company.Count -eq 1
    } -argumentList $State.secondaryName,"BCD CT $($State.namespaceId)"
    return [bool]$exists
}
function Remove-Fixture($State) {
    Assert-State $State
    if (Assert-CompanyOwner $State) {
        $binding = Invoke-Phase 'bind' $State
        if ($State.secondaryId -and $State.secondaryId -cne $binding.secondaryId) { throw 'EVC company identity changed.' }
        $State.secondaryId = $binding.secondaryId
        Save-State $State
    }
    $null = Invoke-Phase 'cleanup' $State
    if (Assert-CompanyOwner $State) {
        # A second native ownership check immediately precedes removal. Only the
        # generated empty company is removed, after its fixture rows are verified gone.
        Invoke-ScriptInBcContainer -containerName $container -scriptblock {
            param($Name,$Marker)
            $ErrorActionPreference = 'Stop'
            $company = @(Get-NAVCompany -ServerInstance $ServerInstance -Tenant default | Where-Object CompanyName -CEQ $Name)
            if ($company.Count -ne 1 -or $company[0].CompanyDisplayName -cne $Marker) { throw 'EVC company ownership changed.' }
            Remove-NAVCompany -ServerInstance $ServerInstance -Tenant default -CompanyName $Name -ForceImmediateDataDeletion -Force
            if (@(Get-NAVCompany -ServerInstance $ServerInstance -Tenant default -IncludePartiallyDeleted | Where-Object CompanyName -CEQ $Name).Count) {
                throw 'EVC temporary company remains.'
            }
        } -argumentList $State.secondaryName,"BCD CT $($State.namespaceId)" | Out-Null
    }
    $null = Invoke-Phase 'verifyAbsent' $State
    Remove-Item -LiteralPath $statePath
}
if ($CleanupOnly) {
    Remove-Fixture (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)
    Write-Host 'EVC fixture rows and tagged company removed and verified.'
    return
}
$namespaceId = [guid]::NewGuid().ToString('D')
$state = [pscustomobject]@{target=$Target;container=$container;namespaceId=$namespaceId;
    runId=[guid]::NewGuid().ToString('D');exclusiveRunId=[guid]::NewGuid().ToString('D');requestId=[guid]::NewGuid().ToString('D');
    primaryName='CRONUS International Ltd.';primaryId=$null;secondaryName=('BCD_CT_' + ([guid]$namespaceId).ToString('N').Substring(0,12));secondaryId=$null}
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
            throw 'EVC company name collision.'
        }
        New-NAVCompany -ServerInstance $ServerInstance -Tenant default -CompanyName $Name -CompanyDisplayName $Marker -Force
    } -argumentList $state.secondaryName,"BCD CT $namespaceId" | Out-Null
    if (-not (Assert-CompanyOwner $state)) { throw 'EVC company was not created.' }
    $state.secondaryId = (Invoke-Phase 'bind' $state).secondaryId
    Save-State $state
    $results = @((Invoke-Phase 'qualify' $state).results)
} finally {
    try { Remove-Fixture $state; $cleaned = $true }
    finally {
        $evidence = @{target=$Target;utc=[DateTime]::UtcNow.ToString('o');primaryId=$state.primaryId;secondaryId=$state.secondaryId;
            results=$results;cleaned=$cleaned;passed=($cleaned -and $results.Count -eq 12 -and @($results | Where-Object passed -NE $true).Count -eq 0)}
        $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidencePath -Encoding utf8
        $evidence | ConvertTo-Json -Depth 12
        $admin=$null; $credential=$null
    }
}
if (-not $evidence.passed) { throw 'EVC assertions failed; see credential-free evidence.' }
