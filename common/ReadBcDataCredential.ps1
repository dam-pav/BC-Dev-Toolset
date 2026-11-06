# Private extension-host subprocess protocol. Never run in the operation terminal
# or under a transcript: stdout is an anonymous pipe carrying credential replies.
$ErrorActionPreference = 'Stop'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'CredentialMgt.ps1')
. (Join-Path $PSScriptRoot 'BcDataWindowsHttp.ps1')
. (Join-Path $PSScriptRoot 'EndpointCredentials.ps1')
while ($null -ne ($line = [Console]::ReadLine())) {
    $id = $null
    $credential = $null
    $reply = $null
    $kind = 'bc'
    try {
        if ($line.Length -gt 6 * 1024 * 1024) { throw 'Invalid request.' }
        $request = $line | ConvertFrom-Json -ErrorAction Stop
        $keys = @($request.PSObject.Properties.Name)
        if ($request.id -isnot [string] -or $request.id -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid request.' }
        $id = $request.id
        if ($keys.Count -eq 2 -and 'http' -in $keys) {
            try { $reply = Invoke-BcDataWindowsHttp -Request $request.http; $reply.id = $id }
            catch { $reply = @{id=$id;error=$(if (Test-WindowsEndpointAuthenticationFailure $_.Exception) { 'authentication_failure' } else { 'transport_failure' })} }
            [Console]::WriteLine(($reply | ConvertTo-Json -Compress)); [Console]::Out.Flush()
            $reply = $null; $request = $null; $line = $null
            continue
        }
        if ($keys.Count -eq 2 -and 'container' -in $keys -and $request.container -is [string] -and $request.container -match '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$') {
            $configuration = [pscustomobject]@{ name = 'BC Data'; serverType = 'Container'; container = $request.container; bcCredential = $true }
        } elseif (($keys.Count -eq 3 -or ($keys.Count -eq 4 -and 'kind' -in $keys -and $request.kind -in @('bc','remote'))) -and 'configuration' -in $keys -and 'projectScope' -in $keys -and
            $request.projectScope -is [string] -and $request.projectScope -match '^[0-9a-f-]{36}$' -and $request.configuration.serverType -eq 'OnPrem') {
            $configuration = $request.configuration
            if ('kind' -in $keys) { $kind = [string]$request.kind }
            if (@($configuration.PSObject.Properties.Name | Where-Object { $_ -notin @('serverType','server','managementServer','serverInstance') }).Count) { throw 'Invalid configuration.' }
            $configuration | Add-Member NoteProperty "${kind}Credential" $true -Force
            $script:credentialProjectScope = ([guid]$request.projectScope).ToString('D')
        } else { throw 'Invalid request.' }
        $credential = Get-ConfigurationCredential -configuration $configuration -kind $kind
        $reply = @{ id = $id; username = $credential.UserName; password = $credential.GetNetworkCredential().Password }
    } catch {
        # Only fixed codes cross the pipe. No exception text, configuration paths,
        # credential targets, environment variables or stack traces are returned.
        $code = if ($_.Exception.Message -like "Stored $kind credential is missing*") { 'credential_missing' } else { 'credential_unavailable' }
        $reply = @{ id = $id; error = $code }
    }
    try { [Console]::WriteLine(($reply | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
    finally { $reply = $null; $credential = $null; $request = $null; $line = $null }
}
