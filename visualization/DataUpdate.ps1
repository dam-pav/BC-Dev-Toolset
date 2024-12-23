Clear-Host

$scriptPath = (get-item $PSScriptRoot).Parent.FullName

. $scriptPath/common/WorkspaceMgt.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptPath  `
    -settingsJSON ([ref]$settingsJSON)  `
    -workspaceJSON ([ref]$workspaceJSON)

Write-Host ""

# Create the data file path
$dataFilePath = Join-Path -Path $scriptPath -ChildPath "visualization/data.json"

# Check if the data file exists, and if not, create it
if (-not (Test-Path -Path $dataFilePath)) {
    Write-Host "**************************************************************************" -ForegroundColor Green
    Write-Host "* If your workspace contains apps occupying the same range of id's, then *" -ForegroundColor Green
    Write-Host "* this information is not part of individual app.json files. You will be *" -ForegroundColor Green
    Write-Host "* asked to input the overall range manually.                             *" -ForegroundColor Green
    Write-Host "**************************************************************************" -ForegroundColor Green
    Write-Host ""
    Write-Host "Creating a new data.json..." -ForegroundColor Blue
    $From = 0
    $To = 0
    $From = Read-Host -Prompt "Please set the pool range 'from' value [50000]"
    if ([string]::IsNullOrWhiteSpace($From)) {
        $From = 50000
    } else {
        try {
            $From = [int]$From
        }
        catch {
            $From = 0
        }
    }
    if ($From -lt 50000) {
        throw "The value 'from' ($From) must be equal to or larger than 50000."
    }
    $To = Read-Host -Prompt "Please set the pool range 'to' value [59999]"
    if ([string]::IsNullOrWhiteSpace($To)) {
        $To = 59999
    } else {
        try {
            $To = [int]$To
        }
        catch {
            $To = 0
        }
    }
    if ($From -gt $To) {
        throw "The value of 'to' ($To) can not be smaller than the value of 'from' ($From)."
    }
    $pool_range = @{
        name = "Customization Range"
        from = $From
        to = $To
    }
    $existingData | ConvertTo-Json -Depth 10 | Format-Json | Set-Content -Path $dataFilePath
  } else {
    # Read the existing data
    Write-Host "Opening the existing data.json, keeping the pool range setup..." -ForegroundColor Blue
    $existingData = Get-Content -Path $dataFilePath | ConvertFrom-Json
    $pool_range = $existingData.pool_range
} 

Write-Host "Retrieving ranges from projects within the workspace..." -ForegroundColor Blue
$ranges = @()
foreach ($appPath in $workspaceJSON.folders.path) {
    $appJSON = @{}
    Get-AppJSON `
        -scriptPath $scriptPath  `
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

Write-Host "Writing data.json..." -ForegroundColor Blue
$existingData | ConvertTo-Json -Depth 10 | Format-Json | Set-Content -Path $dataFilePath -Force

Write-Done

Write-Host "Attention: To visualise the collected data, open the 'WorkspaceAnalysis.html' with the Live Server VSCode extension. Regular HTML preview will not show the data." -ForegroundColor Blue
Write-Host ""
