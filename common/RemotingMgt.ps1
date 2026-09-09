function Test-RemotingAgentWorkflow {
    return (-not [string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_MCP_SESSION_ID) -or $env:BCDEVTOOLSET_NON_INTERACTIVE -eq 'true')
}

function Test-RemotingAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-WinRmConfiguration {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $computerName,
        [bool] $addTrustedHost = $false
    )
    Invoke-BackupRemotingRepair -computerName $computerName -addTrustedHost $addTrustedHost
    Write-Host 'Local WinRM configuration completed. Retry the backup; the remote server must already allow PowerShell remoting.' -ForegroundColor Green
}

function Invoke-BackupRemotingRepair {
    Param (
        [Parameter(Mandatory=$true)]
        [string] $computerName,
        [bool] $addTrustedHost = $false
    )

    # Only a single literal DNS name or IP address may enter the elevated script.
    if ($addTrustedHost -and $computerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$') {
        throw 'TrustedHosts repair requires a single DNS hostname or IP address without wildcards.'
    }
    $repairScript = @'
$ErrorActionPreference = 'Stop'
try {
    Set-Service -Name WinRM -StartupType Automatic
    Start-Service -Name WinRM
'@
    if ($addTrustedHost) {
        $repairScript += [Environment]::NewLine + '$targetHost = ' + "'$computerName'" + [Environment]::NewLine
        $repairScript += @'
    $existing = @((Get-Item WSMan:\localhost\Client\TrustedHosts).Value -split ',' | ForEach-Object { $_.Trim() })
    if ($targetHost -notin $existing) {
        Set-Item WSMan:\localhost\Client\TrustedHosts -Value $targetHost -Concatenate -Force
    }
'@
    }
    $repairScript += [Environment]::NewLine + 'exit 0 } catch { exit 1 }'
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($repairScript))
    $processParameters = @{
        FilePath = 'powershell.exe'
        WindowStyle = 'Hidden'
        Wait = $true
        PassThru = $true
        ErrorAction = 'Stop'
        ArgumentList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand)
    }
    if (Test-RemotingAgentWorkflow) {
        if (-not (Test-RemotingAdministrator)) {
            throw 'WinRM configuration requires administrator rights. Run Configure WinRM and TrustedHosts from the human VS Code workflow to approve Windows elevation, then retry the backup. No settings were changed.'
        }
    } else {
        $processParameters.Verb = 'RunAs'
    }
    $process = Start-Process @processParameters
    if ($process.ExitCode -ne 0) {
        throw 'Windows could not apply local WinRM settings. Check administrator rights and machine policy.'
    }
}

