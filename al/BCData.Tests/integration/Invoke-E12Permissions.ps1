param(
    [ValidateSet('BC23 Baseline','BC27.1')][string] $Target = 'BC23 Baseline',
    [switch] $CleanupOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$containers = @{'BC23 Baseline'='bcdata23test';'BC27.1'='bcdata271'}
$container = $containers[$Target]
$statePath = Join-Path $root ".bcdevtoolset/e12-$container-state.json"
$evidencePath = Join-Path $root ".bcdevtoolset/e12-$container-evidence.json"
$nodeScript = Join-Path $PSScriptRoot 'Verify-BCDataPermissions.cjs'
. (Join-Path $root 'common/CredentialMgt.ps1')
$settings = Get-Content -LiteralPath (Join-Path $root '.bcdevtoolset/settings.json') -Raw | ConvertFrom-Json
$matches = @($settings.configurations | Where-Object name -CEQ $Target)
if ($matches.Count -ne 1 -or $matches[0].container -cne $container -or $matches[0].serverType -ne 'Container' -or
    $matches[0].targetType -ne 'Test' -or $matches[0].authentication -ne 'UserPassword') {
    throw 'Only the two dedicated UserPassword Test configurations are accepted.'
}
$credential = Get-ConfigurationCredential -configuration $matches[0] -kind bc
$admin = @{username=$credential.UserName;password=$credential.GetNetworkCredential().Password}
Import-Module BcContainerHelper -DisableNameChecking

function Invoke-NodePhase([string] $Phase, $State, $Users = @()) {
    $start = [Diagnostics.ProcessStartInfo]::new('node')
    $start.ArgumentList.Add($nodeScript)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $out = $process.StandardOutput.ReadToEndAsync()
        $err = $process.StandardError.ReadToEndAsync()
        @{phase=$Phase;container=$container;runId=$State.runId;companyId=$State.companyId;admin=$admin;users=@($Users)} |
            ConvertTo-Json -Depth 10 -Compress | ForEach-Object { $process.StandardInput.WriteLine($_) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(180000)) { $process.Kill($true); throw 'E12 HTTP phase deadline exceeded.' }
        if ($process.ExitCode -ne 0) { throw ('E12 HTTP phase failed: ' + $err.GetAwaiter().GetResult()) }
        return $out.GetAwaiter().GetResult() | ConvertFrom-Json
    } finally { $process.Dispose() }
}

function Get-FixtureIdentities([string] $RunId) {
    $guid = [guid]::Empty
    if (-not [guid]::TryParseExact($RunId,'D',[ref]$guid) -or $guid -eq [guid]::Empty) { throw 'Invalid E12 state.' }
    $tag = $guid.ToString('N').Substring(0,12)
    foreach ($kind in @('none','header','related','filtered')) {
        [pscustomobject]@{kind=$kind;username="bcd_e12_${tag}_$kind";role=("BE12$tag$($kind.Substring(0,1))").ToUpperInvariant()}
    }
}

function Remove-Fixture($State) {
    if ($State.container -cne $container -or $State.target -cne $Target) { throw 'E12 state target mismatch.' }
    $identities = @(Get-FixtureIdentities $State.runId)
    $marker = "BCD E12 $($State.runId)"
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities, $Marker)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            $user = @(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default |
                Where-Object UserName -IEQ $identity.username)
            if ($user.Count -gt 0) {
                if ($user.Count -ne 1 -or $user[0].FullName -cne $Marker) { throw 'E12 user ownership changed; cleanup refused.' }
                Remove-NAVServerUser -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -Force
            }
        }
        $remaining = @(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default |
            Where-Object UserName -IIn @($Identities.username))
        if ($remaining.Count -ne 0) { throw 'E12 users remain after cleanup.' }
    } -argumentList $identities, $marker | Out-Null
    $cleaned = Invoke-NodePhase 'cleanup' $State
    if ($cleaned.cleaned -ne $true) { throw 'E12 rows remain after cleanup.' }
    Remove-Item -LiteralPath $statePath
}

if ($CleanupOnly) {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'No E12 cleanup state exists.' }
    Remove-Fixture (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)
    Write-Host 'E12 users, roles and fixture rows removed and verified.'
    return
}
if (Test-Path -LiteralPath $statePath) { throw 'An E12 run needs cleanup first; use -CleanupOnly.' }
$state = [pscustomobject]@{target=$Target;container=$container;runId=[guid]::NewGuid().ToString('D');companyId=$null}
$identities = @(Get-FixtureIdentities $state.runId)
$password = 'E12!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$users = @($identities | ForEach-Object { @{kind=$_.kind;username=$_.username;password=$password} })
# Persist cleanup intent before the first mutation. This file contains no credentials.
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
try {
    $prepared = Invoke-NodePhase 'prepare' $state
    $state.companyId = $prepared.companyId
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
    Invoke-ScriptInBcContainer -containerName $container -scriptblock {
        param($Identities, $Password, $Marker)
        $ErrorActionPreference = 'Stop'
        foreach ($identity in $Identities) {
            if (@(Get-NAVServerUser -ServerInstance $ServerInstance -Tenant default | Where-Object UserName -IEQ $identity.username).Count) {
                throw 'E12 user collision; fixture refused.'
            }
        }
        foreach ($identity in $Identities) {
            New-NAVServerUser -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -FullName $Marker -Password $Password
            New-NAVServerUserPermissionSet -ServerInstance $ServerInstance -Tenant default -UserName $identity.username -PermissionSetId $identity.role -Scope Tenant
        }
    } -argumentList $identities,$securePassword,"BCD E12 $($state.runId)" | Out-Null
    $result = Invoke-NodePhase 'verify' $state $users
    $result | Add-Member NoteProperty target $Target
    $result | Add-Member NoteProperty utc ([DateTime]::UtcNow.ToString('o'))
    $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidencePath -Encoding utf8
    $result | ConvertTo-Json -Depth 12
    if (-not $result.passed) { throw 'E12 assertions failed; see credential-free evidence.' }
} finally {
    try {
        Remove-Fixture $state
        Write-Host 'E12 users, roles and fixture rows removed and verified.'
    } finally {
        $password = $null; $securePassword = $null; $users = $null; $admin = $null; $credential = $null
    }
}
