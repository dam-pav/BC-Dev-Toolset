. (Join-Path (Split-Path $PSScriptRoot -Parent) 'common/RemotingMgt.ps1')

if (Test-RemotingAgentWorkflow) {
    if ([string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_REMOTING_INPUTS)) {
        throw 'Supply computerName, addTrustedHost, execute=true and confirm=true to bc_dev_toolset_configure_win_rm. No settings were changed.'
    }
    $inputs = $env:BCDEVTOOLSET_REMOTING_INPUTS | ConvertFrom-Json
    if ($inputs.'remoting.computerName' -isnot [string] -or [string]::IsNullOrWhiteSpace($inputs.'remoting.computerName') -or $inputs.'remoting.addTrustedHost' -isnot [bool]) {
        throw 'computerName must be a non-empty string and addTrustedHost must be a boolean. No settings were changed.'
    }
    $computerName = $inputs.'remoting.computerName'
    $addTrustedHost = $inputs.'remoting.addTrustedHost'
} else {
    $computerName = Read-Host 'Remote hostname or IP address'
    $addTrustedHost = (Read-Host 'Also add this host to local TrustedHosts? Existing entries are preserved; server identity is not verified. [y/N]') -match '^(y|yes)$'
    if ((Read-Host 'Configure local WinRM (Automatic startup), with Windows administrator elevation? [y/N]') -notmatch '^(y|yes)$') {
        Write-Host 'WinRM configuration cancelled.'
        return
    }
}

Invoke-WinRmConfiguration -computerName $computerName -addTrustedHost $addTrustedHost
