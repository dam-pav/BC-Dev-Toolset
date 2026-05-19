Clear-Host

$scriptRoot = (get-item $PSScriptRoot).Parent

. $scriptRoot/common/WorkspaceMgt.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

Write-Host ""

# Create the data file path
$workspaceRootPath = Get-WorkspaceRootPath -scriptPath $scriptRoot
$workspaceName = $workspaceRootPath.Name
if ($env:BCDEVTOOLSET_WORKSPACE_FILE) {
    $workspaceName = [System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileName($env:BCDEVTOOLSET_WORKSPACE_FILE))
}

$localConfigPath = Join-Path -Path $workspaceRootPath.FullName -ChildPath ".bcdevtoolset"
$dataFileName = "$workspaceName.visualization.json"
$dataFilePath = Join-Path -Path $localConfigPath -ChildPath $dataFileName
New-Item -ItemType Directory -Path $localConfigPath -Force | Out-Null

# Load existing data if present; otherwise inform user we'll create it
if (Test-Path -Path $dataFilePath) {
    Write-Host "Opening the existing $dataFileName..." -ForegroundColor Blue
    $existingData = Get-Content -Path $dataFilePath | ConvertFrom-Json
    $pool_range = $existingData.pool_range
} else {
    Write-Host "**************************************************************************" -ForegroundColor Green
    Write-Host "* If your workspace contains apps occupying the same range of id's, then *" -ForegroundColor Green
    Write-Host "* this information is not part of individual app.json files. You will be *" -ForegroundColor Green
    Write-Host "* asked to input the overall range manually.                             *" -ForegroundColor Green
    Write-Host "**************************************************************************" -ForegroundColor Green
    Write-Host ""
    Write-Host "$dataFileName not found. It will be created." -ForegroundColor Blue
    $existingData = $null
    $pool_range = @{ name = "Customization Range"; from = $null; to = $null }
}

# Always offer to update pool range, using existing values as defaults (or 50000/59999)
$defaultFrom = 50000
if ($null -ne $pool_range -and $null -ne $pool_range.from -and [string]::IsNullOrWhiteSpace("$($pool_range.from)") -eq $false) {
    try { $defaultFrom = [int]$pool_range.from } catch { $defaultFrom = 50000 }
}
$defaultTo = 59999
if ($null -ne $pool_range -and $null -ne $pool_range.to -and [string]::IsNullOrWhiteSpace("$($pool_range.to)") -eq $false) {
    try { $defaultTo = [int]$pool_range.to } catch { $defaultTo = 59999 }
}

$fromInput = Read-Host -Prompt "Set the pool range 'from' value [$defaultFrom]"
if ([string]::IsNullOrWhiteSpace($fromInput)) {
    $From = $defaultFrom
} else {
    try { $From = [int]$fromInput } catch { $From = 0 }
}
if ($From -lt 50000) { throw "The value 'from' ($From) must be equal to or larger than 50000." }

$toInput = Read-Host -Prompt "Set the pool range 'to' value [$defaultTo]"
if ([string]::IsNullOrWhiteSpace($toInput)) {
    $To = $defaultTo
} else {
    try { $To = [int]$toInput } catch { $To = 0 }
}
if ($From -gt $To) { throw "The value of 'to' ($To) can not be smaller than the value of 'from' ($From)." }

$pool_range = @{
    name = $(if ($null -ne $pool_range -and $null -ne $pool_range.name -and -not [string]::IsNullOrWhiteSpace($pool_range.name)) { $pool_range.name } else { "Customization Range" })
    from = $From
    to = $To
}

Write-Host "Retrieving ranges from projects within the workspace..." -ForegroundColor Blue
$ranges = @()
foreach ($appPath in $workspaceJSON.folders.path) {
    $appJSON = @{}
    Get-AppJSON `
        -scriptPath $scriptRoot  `
        -appPath $appPath  `
        -appJSON ([ref]$appJSON)
    
    if ($null -ne $appJSON.application) {
        foreach ($currentRange in $appJSON.idRanges) {
            $range = @{
                name = $($appJSON.name)
                from = $($currentRange.from)
                to = $($currentRange.to)
            }
            $ranges = @($ranges) + $range
        }
    } 
}

$existingData = @{
    pool_range = $pool_range
    ranges = $ranges
}

Write-Host "Writing $dataFileName..." -ForegroundColor Blue
$existingData | ConvertTo-Json -Depth 10 | Format-Json | Set-Content -Path $dataFilePath -Force

Write-Done

Write-Host "To visualise the collected data, run the 'BC Dev Toolset: Show object id range visualization data' command." -ForegroundColor Blue
Write-Host ""
