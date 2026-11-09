# Compatibility entry point; the configuration determines the backup sequence.
& (Join-Path $PSScriptRoot 'BackupBcDatabases.ps1')
