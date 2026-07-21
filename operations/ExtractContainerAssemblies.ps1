Clear-Host

$scriptRoot = (Get-Item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1

$settingsJSON = @{}
$workspaceJSON = @{}
Initialize-Context `
    -scriptPath $scriptRoot `
    -settingsJSON ([ref]$settingsJSON) `
    -workspaceJSON ([ref]$workspaceJSON)

Test-DockerProcess

Invoke-ContainerAssemblyExtraction `
    -scriptPath $scriptRoot `
    -settingsJSON $settingsJSON `
    -workspaceJSON $workspaceJSON | Out-Null

Write-Done
