param([Parameter(Mandatory)][ValidateSet('Setup','Cleanup')][string] $Action)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
. (Join-Path $root 'common/CredentialMgt.ps1')
Initialize-WindowsCredentialStore
$settingsPath = Join-Path $root '.bcdevtoolset/settings.json'
$statePath = Join-Path $root '.bcdevtoolset/bc-data-stored-qualification-state.json'
$targets = @{'BC23 Baseline'='bcdata23test';'BC27.1'='bcdata271'}

function Restore-QualificationFixture {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Stored credential qualification state is missing.' }
    $state = @(Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    foreach ($entry in $state) {
        if (-not $targets.ContainsKey([string]$entry.target) -or $entry.container -cne $targets[$entry.target] -or $entry.created -isnot [bool]) { throw 'Invalid qualification state; cleanup refused.' }
        $storedName = "Stored BC Data Qualification ($($entry.target))"
        $missingName = "Missing BC Data Qualification ($($entry.target))"
        $settings.configurations = @($settings.configurations | Where-Object { $_.name -notin @($storedName,$missingName) })
        if ($entry.created) {
            $original = @($settings.configurations | Where-Object name -eq $entry.target)
            $configuration = [pscustomobject]@{serverType='Container';container=$entry.container}
            $target = Get-ConfigurationCredentialTarget -configuration $configuration -kind bc
            $current = [BcDevToolset.CredentialStore]::Read($target)
            if ($null -ne $current) {
                # Preserve credentials if the user changed them or opted into
                # native storage while the fixture was active.
                if ($original.Count -eq 1 -and $original[0].bcCredential -ne $true -and
                    $original[0].PSObject.Properties['bcUser'] -and $original[0].PSObject.Properties['bcPassword'] -and
                    $current.UserName -ceq $original[0].bcUser -and
                    ([pscredential]::new($current.UserName,$current.Password)).GetNetworkCredential().Password -ceq $original[0].bcPassword) {
                    [BcDevToolset.CredentialStore]::Delete($target)
                } else { Write-Host 'A credential changed during qualification; it was preserved.' }
            }
        }
    }
    $settings | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $settingsPath -Encoding utf8
    Remove-Item -LiteralPath $statePath
    Write-Host 'Stored credential qualification fixture removed; original configurations preserved.'
}

if ($Action -eq 'Cleanup') { Restore-QualificationFixture; return }
if (Test-Path -LiteralPath $statePath) { throw 'A qualification fixture already exists. Clean it up first.' }
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$state = @()
$fixtures = @()
try {
    foreach ($name in @('BC23 Baseline','BC27.1')) {
        $matches = @($settings.configurations | Where-Object name -eq $name)
        if ($matches.Count -ne 1 -or $matches[0].container -cne $targets[$name] -or
            $matches[0].serverType -ne 'Container' -or $matches[0].targetType -ne 'Test' -or $matches[0].authentication -ne 'UserPassword') {
            throw 'Only the two dedicated UserPassword Test targets are accepted.'
        }
        $original = $matches[0]
        $storedName = "Stored BC Data Qualification ($name)"
        $missingName = "Missing BC Data Qualification ($name)"
        if (@($settings.configurations | Where-Object { $_.name -in @($storedName,$missingName) }).Count -gt 0) { throw 'A qualification configuration already exists.' }
        $target = Get-ConfigurationCredentialTarget -configuration $original -kind bc
        $existing = [BcDevToolset.CredentialStore]::Read($target)
        $created = $null -eq $existing
        if ($created -and $original.bcCredential -eq $true) { throw 'The dedicated target already expects a missing stored credential. No plaintext fallback is allowed.' }
        $state += [pscustomobject]@{target=$name;container=$original.container;created=$created}
        # Record cleanup intent before any credential write. No secret is stored
        # in this state file; original configurations remain untouched.
        ConvertTo-Json -InputObject @($state) -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
        if ($created) {
            $credential = Get-ConfigurationCredential -configuration $original -kind bc
            if ($null -ne [BcDevToolset.CredentialStore]::Read($target)) {
                $state[-1].created = $false
                ConvertTo-Json -InputObject @($state) -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
                throw 'Credential changed during setup; fixture aborted.'
            }
            [BcDevToolset.CredentialStore]::Write($target,$credential.UserName,$credential.Password)
            $credential = $null
        }
        $endpoint = [pscustomobject]@{provisioningEnabled=$false}
        if ($null -ne $original.bcData.baseUrl) { $endpoint|Add-Member NoteProperty baseUrl $original.bcData.baseUrl }
        if ($null -ne $original.bcData.tenant) { $endpoint|Add-Member NoteProperty tenant $original.bcData.tenant }
        $fixtures += [pscustomobject]@{name=$storedName;serverType='Container';targetType='Test';container=$original.container;
            authentication='UserPassword';bcCredential=$true;bcUser='ignored-plaintext-trap';bcPassword='ignored-plaintext-trap';bcData=$endpoint}
        $missingContainer = 'bcdata-missing-' + [guid]::NewGuid().ToString('N')
        $missingConfig = [pscustomobject]@{name=$missingName;serverType='Container';targetType='Test';container=$missingContainer;
            authentication='UserPassword';bcCredential=$true;bcUser='ignored-plaintext-trap';bcPassword='ignored-plaintext-trap'}
        $missingTarget = Get-ConfigurationCredentialTarget -configuration $missingConfig -kind bc
        if ($null -ne [BcDevToolset.CredentialStore]::Read($missingTarget)) { throw 'Unexpected synthetic credential collision.' }
        $fixtures += $missingConfig
    }
    # Preserve unrelated edits made while native credential setup was running.
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if (@($settings.configurations | Where-Object { $_.name -in @($fixtures.name) }).Count -gt 0) { throw 'A qualification configuration appeared during setup.' }
    $settings.configurations = @($settings.configurations) + $fixtures
    $settings | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $settingsPath -Encoding utf8
    Write-Host 'Stored credential qualification fixture prepared for the two dedicated test targets. No existing stored credential was overwritten.'
} catch {
    if (Test-Path -LiteralPath $statePath) { Restore-QualificationFixture }
    throw 'Stored credential qualification setup failed and cleanup was attempted. No credentials are included in diagnostics.'
}
