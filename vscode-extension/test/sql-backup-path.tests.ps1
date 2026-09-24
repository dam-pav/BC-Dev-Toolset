$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/BackupMgt.ps1')

function Get-WorkspaceRootPath { [pscustomobject]@{ FullName = 'C:\workspace' } }
function Test-Path { throw 'Unexpected filesystem probe' }

$unsafePaths = @(
    '\\host\share', '//host/share', '\\\host\share', '\\?\C:\backup', '\\.\NUL',
    '\??\C:\backup', '\backup', 'C:backup', 'FileSystem::C:\backup',
    'C:\backup:stream', 'C:\NUL', 'C:\aux.txt', 'backup\COM1',
    'C:\backup\*', '..\outside', 'C:\backup.\folder'
)
foreach ($candidate in $unsafePaths) {
    $rejected = $false
    try { Get-SqlBackupRootPath -sqlBackupPath $candidate | Out-Null }
    catch {
        if ($_.Exception.Message -eq 'Unexpected filesystem probe') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Unsafe path accepted: $candidate" }
}

foreach ($case in @(
    @('C:\missing\backup', 'C:\missing\backup'),
    @('backup/child/..', 'C:\workspace\backup'),
    @('.', 'C:\workspace'),
    @('', '')
)) {
    $actual = Get-SqlBackupRootPath -sqlBackupPath $case[0]
    if ($actual -ne $case[1]) { throw "Unexpected resolution: '$actual' for '$($case[0])'" }
}

# Even menu entries that are not selected must never cause a filesystem probe.
function Get-ContainerSqlBackupConfigurations {
    @(
        [pscustomobject]@{ name = 'safe'; container = 'safe'; sqlBackupPath = 'C:\backup' },
        [pscustomobject]@{ name = 'unsafe'; container = 'unsafe'; sqlBackupPath = '\\host\share' }
    )
}
$rejected = $false
try { Select-ContainerSqlBackupConfigurations -settingsJSON ([pscustomobject]@{}) -operationName 'backup' | Out-Null }
catch {
    if ($_.Exception.Message -eq 'Unexpected filesystem probe') { throw }
    $rejected = $true
}
if (-not $rejected) { throw 'Unsafe menu configuration was accepted' }
Write-Output 'SQL backup path validation tests passed.'
