[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string] $Operation,

    [Parameter(Mandatory=$false)]
    [string] $WorkspacePath = (Get-Location).Path,

    [Parameter(Mandatory=$false)]
    [string] $WorkspaceFile = '',

    [Parameter(Mandatory=$false)]
    [string] $ProjectSettingsPath = '',

    [Parameter(Mandatory=$false)]
    [string] $LocalSettingsPath = '',

    [Parameter(Mandatory=$false)]
    [string] $SettingsPath = '',

    [Parameter(Mandatory=$false)]
    [switch] $ListOperations,

    [Parameter(Mandatory=$false)]
    [switch] $NonInteractive
)

$scriptPath = $PSScriptRoot
. (Join-Path (Join-Path $scriptPath 'common') 'WorkspaceMgt.ps1')

$operations = @(Get-OperationDefinitions -ScriptPath $scriptPath)

if ($ListOperations) {
    $operations |
        Select-Object id, title, category, script, requiresConfirmation |
        Format-Table -AutoSize
    return
}

if ([string]::IsNullOrWhiteSpace($Operation)) {
    throw "Please specify -Operation, or use -ListOperations to show available operation IDs."
}

if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Container)) {
    throw "Workspace path not found: $WorkspacePath"
}

$matchingOperations = @(
    $operations | Where-Object {
        $script = if ([string]::IsNullOrWhiteSpace($_.script)) { '' } else { $_.script }
        $_.id -eq $Operation -or
        $_.title -eq $Operation -or
        $script -eq $Operation -or
        (-not [string]::IsNullOrWhiteSpace($script) -and (Split-Path $script -Leaf) -eq $Operation)
    }
)

if ($matchingOperations.Count -eq 0) {
    throw "Operation '$Operation' was not found. Use -ListOperations to show available operation IDs."
}

if ($matchingOperations.Count -gt 1) {
    $matches = ($matchingOperations | ForEach-Object { $_.id }) -join ', '
    throw "Operation '$Operation' matched multiple operations: $matches"
}

$selectedOperation = $matchingOperations[0]
if ([string]::IsNullOrWhiteSpace($selectedOperation.script)) {
    throw "Operation '$Operation' is handled by the VS Code extension and cannot be run through Invoke-BcDevToolsetOperation.ps1."
}

if (-not (Test-Path -LiteralPath $selectedOperation.ScriptPath -PathType Leaf)) {
    throw "Operation script not found: $($selectedOperation.ScriptPath)"
}

$previousWorkspacePath = $env:BCDEVTOOLSET_WORKSPACE_PATH
$previousWorkspaceFile = $env:BCDEVTOOLSET_WORKSPACE_FILE
$previousProjectSettingsPath = $env:BCDEVTOOLSET_PROJECT_SETTINGS_PATH
$previousLocalSettingsPath = $env:BCDEVTOOLSET_LOCAL_SETTINGS_PATH
$previousSettingsPath = $env:BCDEVTOOLSET_SETTINGS_PATH
$previousNonInteractive = $env:BCDEVTOOLSET_NON_INTERACTIVE

try {
    $env:BCDEVTOOLSET_WORKSPACE_PATH = (Get-Item -LiteralPath $WorkspacePath).FullName
    $env:BCDEVTOOLSET_WORKSPACE_FILE = $WorkspaceFile
    $env:BCDEVTOOLSET_PROJECT_SETTINGS_PATH = $ProjectSettingsPath
    $env:BCDEVTOOLSET_LOCAL_SETTINGS_PATH = $LocalSettingsPath
    $env:BCDEVTOOLSET_SETTINGS_PATH = $SettingsPath
    $env:BCDEVTOOLSET_NON_INTERACTIVE = if ($NonInteractive) { 'true' } else { '' }

    Write-Host "Running BC Dev Toolset operation: $($selectedOperation.title)" -ForegroundColor Green
    Write-Host "Operation ID: $($selectedOperation.id)" -ForegroundColor Gray
    Write-Host "Workspace: $($env:BCDEVTOOLSET_WORKSPACE_PATH)" -ForegroundColor Gray

    & $selectedOperation.ScriptPath
} finally {
    $env:BCDEVTOOLSET_WORKSPACE_PATH = $previousWorkspacePath
    $env:BCDEVTOOLSET_WORKSPACE_FILE = $previousWorkspaceFile
    $env:BCDEVTOOLSET_PROJECT_SETTINGS_PATH = $previousProjectSettingsPath
    $env:BCDEVTOOLSET_LOCAL_SETTINGS_PATH = $previousLocalSettingsPath
    $env:BCDEVTOOLSET_SETTINGS_PATH = $previousSettingsPath
    $env:BCDEVTOOLSET_NON_INTERACTIVE = $previousNonInteractive
}
