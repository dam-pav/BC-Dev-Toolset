function Initialize-WindowsCredentialStore {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows Credential Manager requires Windows.' }
    if (-not ('BcDevToolset.CredentialStore' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'CredentialStore.cs') -ErrorAction Stop
    }
}

function Get-ProjectCredentialScope {
    param([switch] $Create)
    if ($script:credentialProjectScope) { return $script:credentialProjectScope }
    if ([string]::IsNullOrWhiteSpace($script:credentialProjectRoot)) { throw 'Initialize the project before accessing non-container credentials.' }
    $scopePath = [IO.Path]::GetFullPath((Join-Path $script:credentialProjectRoot '.bcdevtoolset/credential-scope.json'))
    $relative = [IO.Path]::GetRelativePath($script:credentialProjectRoot, $scopePath)
    if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw 'Credential scope path escapes the project root.' }
    if (-not (Test-Path -LiteralPath $scopePath -PathType Leaf)) {
        if (-not $Create) { throw 'Project credential scope is missing. Run Configure stored credentials in the human workflow. No plaintext fallback is allowed.' }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($scopePath)) | Out-Null
        # Persist an explicit UUID; paths and file metadata never form part of the identity.
        $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id=[guid]::NewGuid().ToString('D') } | ConvertTo-Json -Compress))
        try { $stream = [IO.File]::Open($scopePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
        catch [IO.IOException] {
            if (-not (Test-Path -LiteralPath $scopePath -PathType Leaf)) { throw }
            $stream = $null
        }
        if ($stream) { try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() } }
    }
    try {
        $scope = [IO.File]::ReadAllText($scopePath) | ConvertFrom-Json -ErrorAction Stop
        $id = [guid]::Empty
        if (-not [guid]::TryParse([string]$scope.id, [ref]$id) -or $id -eq [guid]::Empty) { throw 'Invalid scope' }
    } catch { throw 'Project credential-scope.json is invalid or unreadable. Restore its original ID before using stored credentials.' }
    $script:credentialProjectScope = $id.ToString('D')
    return $script:credentialProjectScope
}

function Get-ConfigurationCredentialTarget {
    param([Parameter(Mandatory=$true)][PSObject] $configuration,
          [Parameter(Mandatory=$true)][ValidateSet('bc','remote','database')][string] $kind)
    # Identity uses non-sensitive configuration values only, never paths or file metadata.
    if ($configuration.serverType -eq 'Container') {
        if ([string]::IsNullOrWhiteSpace($configuration.container)) { throw 'A container name is required for stored container credentials.' }
        $identity = @('Container', $configuration.container)
    } else {
        if ([string]::IsNullOrWhiteSpace($configuration.server) -and [string]::IsNullOrWhiteSpace($configuration.managementServer)) {
            throw 'A server or managementServer is required for stored remote credentials.'
        }
        $identity = @((Get-ProjectCredentialScope), $configuration.serverType, $configuration.server, $configuration.managementServer, $configuration.serverInstance)
    }
    $identity = $identity |
        ForEach-Object { ([string]$_).Trim().ToLowerInvariant() }
    $canonical = ConvertTo-Json -InputObject @($identity) -Compress
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return "BCDevToolset/v1/$hash/$kind"
}

function Get-ConfigurationCredential {
    param([Parameter(Mandatory=$true)][PSObject] $configuration,
          [Parameter(Mandatory=$true)][ValidateSet('bc','remote','database')][string] $kind)
    $flag = $configuration.PSObject.Properties["${kind}Credential"]
    if ($flag -and $flag.Value -isnot [bool]) { throw "${kind}Credential must be a boolean." }
    if ($flag -and $flag.Value) {
        $target = Get-ConfigurationCredentialTarget -configuration $configuration -kind $kind
        Initialize-WindowsCredentialStore
        $stored = [BcDevToolset.CredentialStore]::Read($target)
        if ($null -eq $stored) {
            throw "Stored $kind credential is missing for configuration '$($configuration.name)'. Run Configure stored credentials in the human workflow. Plaintext usernames and passwords are ignored while ${kind}Credential is true."
        }
        return [pscredential]::new($stored.UserName, $stored.Password)
    }
    $user = [string]$configuration."${kind}User"
    $password = [string]$configuration."${kind}Password"
    if ($kind -eq 'bc' -and -not ($configuration.PSObject.Properties['bcUser'] -and $configuration.PSObject.Properties['bcPassword'])) {
        $user = [string]$configuration.admin
        $password = [string]$configuration.password
    }
    if ($kind -ne 'bc' -and [string]::IsNullOrWhiteSpace($user)) { return $null }
    return [pscredential]::new($user, (ConvertTo-SecureString -String $password -AsPlainText -Force))
}

function Initialize-CredentialConfigurationContext {
    param([array] $settingsFiles, [string] $workspaceFile, [string] $projectRoot)
    $script:credentialProjectScope = $null
    $script:credentialProjectRoot = if ([string]::IsNullOrWhiteSpace($projectRoot)) { '' } else { [IO.Path]::GetFullPath($projectRoot) }
    $script:credentialConfigurationFiles = @()
    foreach ($file in @($settingsFiles) + @($workspaceFile)) {
        if ([string]::IsNullOrWhiteSpace($file)) { continue }
        # These are the exact files selected by Initialize-Context. Configurable locations
        # are authorized at this boundary; downstream code receives validated descriptors.
        $resolved = [IO.Path]::GetFullPath($file)
        if ([IO.Path]::GetExtension($resolved) -notin '.json', '.code-workspace') { throw 'Unsupported credential configuration file.' }
        if ($resolved -in $script:credentialConfigurationFiles.Path) { continue }
        $script:credentialConfigurationFiles += [pscustomobject]@{
            Path=$resolved; Root=[IO.Path]::GetDirectoryName($resolved); IsWorkspace=($file -eq $workspaceFile)
        }
    }
}

function Find-BcConfigurationDocument {
    param([Parameter(Mandatory=$true)][PSObject] $configuration)
    $configurationMatches = @()
    foreach ($descriptor in $script:credentialConfigurationFiles) {
        $validatedPath = [IO.Path]::GetFullPath($descriptor.Path)
        $relative = [IO.Path]::GetRelativePath($descriptor.Root, $validatedPath)
        if ([IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw 'Configuration path escapes its authorized root.' }
        if (-not (Test-Path -LiteralPath $validatedPath -PathType Leaf)) { continue }
        $text = [IO.File]::ReadAllText($validatedPath)
        try { $document = $text | ConvertFrom-Json -ErrorAction Stop }
        catch { throw 'Configuration JSON could not be parsed; no credentials or settings were changed.' }
        $configurations = if ($descriptor.IsWorkspace) { $document.settings.'dam-pav.bcdevtoolset'.configurations } else { $document.configurations }
        foreach ($candidate in $configurations) {
            if ([string]::IsNullOrWhiteSpace($candidate.name)) { continue }
            # Storage is shared by endpoint, but update only the selected configuration entry.
            if ($candidate.name -ne $configuration.name) { continue }
            if ($candidate.serverType -ne $configuration.serverType) { continue }
            $sameIdentity = $true
            foreach ($field in @('server', 'managementServer', 'serverInstance', 'container', 'databaseServerHost')) {
                if (([string]$candidate.$field).Trim() -ine ([string]$configuration.$field).Trim()) { $sameIdentity = $false; break }
            }
            if ($sameIdentity) {
                $configurationMatches += [pscustomobject]@{ Path=$validatedPath; Text=$text; Document=$document; Configuration=$candidate }
            }
        }
    }
    if ($configurationMatches.Count -ne 1) { throw 'Cannot uniquely locate the original configuration to update. No settings were changed.' }
    return $configurationMatches[0]
}

function Save-ConfigurationCredential {
    param([Parameter(Mandatory=$true)][PSObject] $configuration,
          [Parameter(Mandatory=$true)][ValidateSet('bc','remote','database')][string] $kind,
          [Parameter(Mandatory=$true)][pscredential] $credential)
    if ($configuration.serverType -ne 'Container') { Get-ProjectCredentialScope -Create | Out-Null }
    $target = Get-ConfigurationCredentialTarget -configuration $configuration -kind $kind
    $match = Find-BcConfigurationDocument -configuration $configuration
    Initialize-WindowsCredentialStore
    [BcDevToolset.CredentialStore]::Write($target, $credential.UserName, $credential.Password)
    # Verify storage before removing any plaintext password.
    $stored = [BcDevToolset.CredentialStore]::Read($target)
    if ($null -eq $stored -or $stored.UserName -ne $credential.UserName) { throw 'Stored credential verification failed; configuration was not updated.' }
    $match.Configuration | Add-Member NoteProperty "${kind}Credential" $true -Force
    $match.Configuration.PSObject.Properties.Remove("${kind}User")
    $match.Configuration.PSObject.Properties.Remove("${kind}Password")
    if ($kind -eq 'bc') { $match.Configuration.PSObject.Properties.Remove('password'); $match.Configuration.PSObject.Properties.Remove('admin') }
    if ([IO.File]::ReadAllText($match.Path) -cne $match.Text) { throw 'Configuration changed while saving. Credential is stored, but configuration was not updated; retry setup.' }
    [IO.File]::WriteAllText($match.Path, ($match.Document | ConvertTo-Json -Depth 100) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $configuration | Add-Member NoteProperty "${kind}Credential" $true -Force
    $configuration.PSObject.Properties.Remove("${kind}User")
    $configuration.PSObject.Properties.Remove("${kind}Password")
    if ($kind -eq 'bc') { $configuration.PSObject.Properties.Remove('password'); $configuration.PSObject.Properties.Remove('admin') }
    Write-Host "Stored $kind credentials and enabled ${kind}Credential for '$($configuration.name)'." -ForegroundColor Green
}

function Offer-ConfigurationCredentialStorage {
    param([PSObject] $configuration, [ValidateSet('bc','remote','database')][string] $kind, [pscredential] $credential)
    if (Test-RemotingAgentWorkflow) { return }
    try {
        if ((Read-Host "Save these $kind credentials in Windows Credential Manager and update '$($configuration.name)' configuration? [y/N]") -match '^(y|yes)$') {
            Save-ConfigurationCredential -configuration $configuration -kind $kind -credential $credential
        }
    } catch { Write-Host "Credential storage was not completed: $($_.Exception.Message)" -ForegroundColor Yellow }
}
