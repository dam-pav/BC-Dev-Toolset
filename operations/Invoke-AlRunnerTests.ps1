Clear-Host

$scriptPath = (Get-Item $PSScriptRoot).Parent
. $scriptPath/common/WorkspaceMgt.ps1

function Resolve-AlRunnerWorkspaceFolderPath {
    param(
        [Parameter(Mandatory=$true)] [string] $BasePath,
        [Parameter(Mandatory=$true)] [string] $ConfiguredPath
    )

    $candidatePath = if ([System.IO.Path]::IsPathRooted($ConfiguredPath)) {
        $ConfiguredPath
    } else {
        Join-Path $BasePath $ConfiguredPath
    }

    # Paths declared as workspace folders are explicitly authorized, including supported external folders.
    return [System.IO.Path]::GetFullPath($candidatePath)
}

function Get-AlRunnerApplicationControlEvent {
    param([Parameter(Mandatory=$true)] [datetime] $StartTime)

    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $event = Get-WinEvent -FilterHashtable @{
                LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
                # Code Integrity event timestamps have coarser precision than Get-Date.
                StartTime = $StartTime.AddSeconds(-5)
            } -ErrorAction Stop |
                Where-Object {
                    $_.Id -in @(3033, 3077) -and
                    $_.Message -match '(?i)al-runner(?:\.dll|\.exe)?'
                } |
                Select-Object -First 1
            if ($event) { return $event }
        } catch { }

        Start-Sleep -Milliseconds 200
    }

    return $null
}

$workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptPath -WorkspacePath $env:BCDEVTOOLSET_WORKSPACE_PATH
$workspaceFile = Resolve-BcDevToolsetWorkspaceFile `
    -WorkspaceRootPath $workspaceRootPath.FullName `
    -WorkspaceFile $env:BCDEVTOOLSET_WORKSPACE_FILE
$candidateAppPaths = @()

if ($null -ne $workspaceFile) {
    $workspaceDefinition = Get-Content -LiteralPath $workspaceFile.FullName -Raw | ConvertFrom-Json
    foreach ($workspaceFolder in @($workspaceDefinition.folders)) {
        $candidateAppPaths += Resolve-AlRunnerWorkspaceFolderPath `
            -BasePath $workspaceFile.DirectoryName `
            -ConfiguredPath ([string]$workspaceFolder.path)
    }
} elseif (Test-Path -LiteralPath (Join-Path $workspaceRootPath.FullName 'app.json') -PathType Leaf) {
    $candidateAppPaths += $workspaceRootPath.FullName
} else {
    $candidateAppPaths += @(Get-ChildItem -LiteralPath $workspaceRootPath.FullName -Directory -Recurse |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'app.json') -PathType Leaf } |
        ForEach-Object { $_.FullName })
}

$appPaths = @($candidateAppPaths |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'app.json') -PathType Leaf } |
    Select-Object -Unique)
if ($appPaths.Count -eq 0) {
    throw 'No AL apps with an app.json file were found in the workspace.'
}

$runnerCommand = Get-Command al-runner -ErrorAction SilentlyContinue
if (-not $runnerCommand) {
    throw "AL Runner is not installed or 'al-runner' is not available in PATH. Run the 'Install prerequisites' operation, restart PowerShell if needed, and try again."
}

Write-Host "Running AL Runner for $($appPaths.Count) app folder(s):" -ForegroundColor Blue
foreach ($appPath in $appPaths) {
    Write-Host "- $appPath" -ForegroundColor Gray
}

$runnerStartedAt = Get-Date
& $runnerCommand.Source @appPaths
$runnerExitCode = $LASTEXITCODE
if ($runnerExitCode -ne 0) {
    $applicationControlEvent = Get-AlRunnerApplicationControlEvent -StartTime $runnerStartedAt
    if ($applicationControlEvent) {
        throw "Windows Smart App Control or another Code Integrity policy blocked the upstream AL Runner payload (event $($applicationControlEvent.Id)). The published AL Runner binary must be signed or allowed by the device's application-control policy; BC Dev Toolset will not disable or bypass that protection. Upstream project: https://github.com/StefanMaron/BusinessCentral.AL.Runner"
    }

    $exitDescription = switch ($runnerExitCode) {
        1 { 'test assertion failures, runner errors, or invalid arguments' }
        2 { 'AL Runner limitations' }
        3 { 'AL compilation errors' }
        default { 'an unexpected runner failure' }
    }
    throw "AL Runner exited with code $runnerExitCode ($exitDescription)."
}

Write-Host 'AL Runner tests completed successfully.' -ForegroundColor Green
Write-Done
