# Private extension-host subprocess protocol. Never run in the operation terminal
# or under a transcript: stdout is an anonymous pipe carrying credential replies.
$ErrorActionPreference = 'Stop'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'CredentialMgt.ps1')
while ($null -ne ($line = [Console]::ReadLine())) {
    $id = $null
    $credential = $null
    $reply = $null
    try {
        if ($line.Length -gt 1024) { throw 'Invalid request.' }
        $request = $line | ConvertFrom-Json -ErrorAction Stop
        $keys = @($request.PSObject.Properties.Name)
        if ($keys.Count -ne 2 -or 'id' -notin $keys -or 'container' -notin $keys -or
            $request.id -isnot [string] -or $request.id -notmatch '^[0-9a-f-]{36}$' -or
            $request.container -isnot [string] -or $request.container -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$') { throw 'Invalid request.' }
        $id = $request.id
        $configuration = [pscustomobject]@{ name = 'BC Data'; serverType = 'Container'; container = $request.container; bcCredential = $true }
        $credential = Get-ConfigurationCredential -configuration $configuration -kind bc
        $reply = @{ id = $id; username = $credential.UserName; password = $credential.GetNetworkCredential().Password }
    } catch {
        # Only fixed codes cross the pipe. No exception text, configuration paths,
        # credential targets, environment variables or stack traces are returned.
        $code = if ($_.Exception.Message -like 'Stored bc credential is missing*') { 'credential_missing' } else { 'credential_unavailable' }
        $reply = @{ id = $id; error = $code }
    }
    try { [Console]::WriteLine(($reply | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
    finally { $reply = $null; $credential = $null; $request = $null; $line = $null }
}
