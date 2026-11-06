. (Join-Path $PSScriptRoot 'PublishingDiagnostics.ps1')

function Test-WindowsEndpointAuthenticationFailure {
    param([Exception] $Exception)
    $cause = $Exception
    for ($depth = 0; $null -ne $cause -and $depth -lt 8; $depth++) {
        if ($cause.Data['AuthenticationRejected'] -eq $true) { return $true }
        foreach ($status in @($cause.Response.StatusCode, $cause.StatusCode, $cause.Data['HttpStatus'])) {
            if ([string]$status -in @('401','403','Unauthorized','Forbidden')) { return $true }
        }
        if ($cause -is [Net.Http.HttpRequestException] -and [string]$cause.HttpRequestError -eq 'UserAuthenticationError') { return $true }
        $cause = $cause.InnerException
    }
    return $false
}

function Get-EndpointCredentialSource {
    param($Configuration, [ValidateSet('management','data')][string] $Purpose)
    $key = if ($Purpose -eq 'management') { 'useManagementCredentials' } else { 'useDataCredentials' }
    $source = $Configuration.$key
    $hasSource = if ($Configuration -is [System.Collections.IDictionary]) { $Configuration.Contains($key) } else { $null -ne $Configuration.PSObject.Properties[$key] }
    if (-not $hasSource) { return $(if ($Purpose -eq 'management') { 'remote' } else { 'bc' }) }
    if ($source -isnot [string] -or $source -cnotin @('bc','remote','currentWindows')) {
        throw (New-BcExpectedFailure -Stage Authentication -Message "$key must be bc, remote or currentWindows. Correct the configuration before retrying. No endpoint request was started.")
    }
    return $source
}

function Get-SelectedEndpointCredential {
    param($Configuration, [ValidateSet('management','data')][string] $Purpose, [bool] $AllowCurrentWindows = $true)
    $kind = Get-EndpointCredentialSource -Configuration $Configuration -Purpose $Purpose
    if ($kind -eq 'currentWindows') {
        if (-not $AllowCurrentWindows) { throw (New-BcExpectedFailure -Stage Authentication -Message "The $Purpose credential source currentWindows requires Windows endpoint authentication. Select bc or remote for UserPassword authentication. No endpoint request was started.") }
        return [pscustomobject]@{ Kind='currentWindows'; Credential=$null }
    }
    $flag = $Configuration."${kind}Credential"
    $hasFlag = if ($Configuration -is [System.Collections.IDictionary]) { $Configuration.Contains("${kind}Credential") } else { $null -ne $Configuration.PSObject.Properties["${kind}Credential"] }
    if ($hasFlag -and $flag -isnot [bool]) { throw (New-BcExpectedFailure -Stage Authentication -Message "${kind}Credential must be a boolean. No endpoint request was started.") }
    $user = $Configuration."${kind}User"
    $password = $Configuration."${kind}Password"
    $legacyBc = $kind -eq 'bc' -and ($Configuration.admin -or $Configuration.password)
    $configured = $flag -eq $true -or -not [string]::IsNullOrEmpty($user) -or -not [string]::IsNullOrEmpty($password) -or $legacyBc
    if (-not $configured) {
        $key = if ($Purpose -eq 'management') { 'useManagementCredentials' } else { 'useDataCredentials' }
        throw (New-BcExpectedFailure -Stage Authentication -Message "Selected $Purpose credentials ($kind) are not configured. Configure ${kind}User/${kind}Password or enable ${kind}Credential with a stored entry, or explicitly select another source with $key. Select currentWindows explicitly for integrated Windows authentication. No alternate identity or endpoint request was attempted.")
    }
    try {
        $credentialConfiguration = if ($Configuration -is [System.Collections.IDictionary]) { [pscustomobject]$Configuration } else { $Configuration }
        $credential = Get-ConfigurationCredential -configuration $credentialConfiguration -kind $kind
        if (-not $credential -or [string]::IsNullOrWhiteSpace($credential.UserName) -or $credential.Password.Length -eq 0) { throw 'Credential is incomplete.' }
    } catch {
        if ($_.Exception.Data['BcDevToolsetExpectedFailure'] -eq $true) { throw }
        throw (New-BcExpectedFailure -Stage Authentication -Message "Selected $Purpose credentials ($kind) are missing, incomplete or unreadable. Check ${kind}Credential and configure its stored entry or ${kind}User/${kind}Password. No alternate identity or endpoint request was attempted.")
    }
    return [pscustomobject]@{ Kind=$kind; Credential=$credential }
}

function Test-ManagementIdentityRequiresRemoting {
    param($Configuration)
    $kind = Get-EndpointCredentialSource -Configuration $Configuration -Purpose management
    return $kind -ne 'currentWindows'
}

function New-SelectedManagementSession {
    param([string] $ComputerName, $Configuration, [string] $OperationName = 'Management')
    $selected = Get-SelectedEndpointCredential -Configuration $Configuration -Purpose management
    $parameters = @{ ComputerName=$ComputerName; ErrorAction='Stop' }
    if ($selected.Credential) { $parameters.Credential = $selected.Credential }
    try { return New-PSSession @parameters }
    catch {
        $cause = $_.Exception
        $transportCode = $null
        for ($depth = 0; $null -ne $cause -and $depth -lt 8; $depth++) {
            # Only the numeric code of the runtime's remoting exception is safe;
            # messages, ErrorDetails and arbitrary Data entries can contain secrets.
            if ($cause -is [System.Management.Automation.Remoting.PSRemotingTransportException]) {
                $transportCode = '0x{0:X8}' -f ([long]$cause.ErrorCode -band 0xFFFFFFFFL)
                break
            }
            $cause = $cause.InnerException
        }
        $guidance = switch ($transportCode) {
            '0x00000005' { 'WinRM access was denied. Check the selected identity and its endpoint/remoting permissions.' }
            '0x80070005' { 'WinRM access was denied. Check the selected identity and its endpoint/remoting permissions.' }
            '0x80338012' { 'The WinRM destination could not be reached. Check the hostname, WinRM service/listener, port and firewall access.' }
            '0x8009030E' { 'WinRM could not establish the authentication logon session. Check the selected credentials, domain/SPN configuration and approved HTTPS or host-trust configuration.' }
            '0x80338171' { 'The WinRM endpoint returned HTTP 400 without fault details. Check the management hostname, listener and any proxy routing.' }
            default { 'The WinRM failure cause is unknown. Check the selected identity, host permissions, WinRM trust, DNS and firewall configuration.' }
        }
        $status = if ($transportCode) { " WinRM error $transportCode." } else { '' }
        $failure = New-BcExpectedFailure -Stage Authentication -Message "$OperationName failed: the management WinRM connection could not be established using $($selected.Kind).$status $guidance No management session was established; dependent management work was not started. No alternate identity was attempted."
        if ($transportCode) { $failure.Data['RemotingErrorCode'] = $transportCode }
        throw $failure
    } finally { $selected = $null }
}
