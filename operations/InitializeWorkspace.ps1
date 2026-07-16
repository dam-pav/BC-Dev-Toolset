Clear-Host

$scriptRoot = (Get-Item $PSScriptRoot).Parent
. $scriptRoot/common/WorkspaceMgt.ps1

function Test-WorkspaceName {
    param([string] $Name)

    $workspaceName = $Name.Trim()
    if ([string]::IsNullOrWhiteSpace($workspaceName)) {
        return 'Enter a workspace name.'
    }
    if ($workspaceName -in @('.', '..')) {
        return 'The workspace name cannot be "." or "..".'
    }
    if ($workspaceName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $workspaceName -match '[/\\]') {
        return 'The workspace name contains characters that are not valid in a file name.'
    }
    if ($workspaceName -match '[. ]$') {
        return 'The workspace name cannot end with a period or space.'
    }
    if ($workspaceName -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') {
        return 'The workspace name is reserved by the operating system.'
    }

    return $null
}

function Get-AppWorkspaceFolders {
    param([string] $RootPath)

    if (Test-Path -LiteralPath (Join-Path $RootPath 'app.json') -PathType Leaf) {
        return @('.')
    }

    return @(Get-ChildItem -LiteralPath $RootPath -Directory -Recurse | Where-Object {
        $_.FullName -notmatch '[\\/](?:node_modules|\.git)(?:[\\/]|$)' -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'app.json') -PathType Leaf)
    } | ForEach-Object {
        [System.IO.Path]::GetRelativePath($RootPath, $_.FullName).Replace('\', '/')
    } | Sort-Object)
}

function Add-BcDevToolsetGitIgnore {
    param([string] $RootPath)

    $gitIgnorePath = Join-Path $RootPath '.gitignore'
    $content = if (Test-Path -LiteralPath $gitIgnorePath) { Get-Content -LiteralPath $gitIgnorePath -Raw } else { '' }
    $entries = @($content -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    if ('.bcdevtoolset/' -in $entries -or '.bcdevtoolset' -in $entries) {
        return
    }

    $separator = if ($content -and -not ($content.EndsWith("`n"))) { "`n" } else { '' }
    Set-Content -LiteralPath $gitIgnorePath -Value "$content$separator.bcdevtoolset/" -NoNewline
    Add-Content -LiteralPath $gitIgnorePath -Value ''
}

$workspaceRoot = (Get-Item -LiteralPath $env:BCDEVTOOLSET_WORKSPACE_PATH).FullName
$workspaceFile = if ([string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_WORKSPACE_FILE)) { $null } else { Get-Item -LiteralPath $env:BCDEVTOOLSET_WORKSPACE_FILE -ErrorAction Stop }

if ($null -eq $workspaceFile) {
    $workspaceFiles = @(Get-ChildItem -LiteralPath $workspaceRoot -Filter '*.code-workspace' -File)
    if ($workspaceFiles.Count -gt 1) {
        throw "Multiple .code-workspace files were found in '$workspaceRoot'. Open the intended workspace before initializing."
    }
    if ($workspaceFiles.Count -eq 1) {
        $workspaceFile = $workspaceFiles[0]
    }
}

if ($null -eq $workspaceFile) {
    $defaultWorkspaceName = Split-Path $workspaceRoot -Leaf
    while ($true) {
        $workspaceName = Request-BcDevToolsetMcpPrompt `
            -PromptId 'initializeWorkspace.workspaceName' `
            -Type 'text' `
            -Question 'Enter a name for the new workspace' `
            -DefaultValue $defaultWorkspaceName `
            -Risk 'The answer determines the name of the new .code-workspace file and default container.'

        if ($null -eq $workspaceName) {
            $workspaceName = Read-Host -Prompt "Workspace name [$defaultWorkspaceName]"
        }
        if ([string]::IsNullOrWhiteSpace($workspaceName)) {
            $workspaceName = $defaultWorkspaceName
        }

        $validationError = Test-WorkspaceName -Name $workspaceName
        if ($null -eq $validationError) {
            break
        }

        Write-Host $validationError -ForegroundColor Red
        if (-not [string]::IsNullOrWhiteSpace($env:BCDEVTOOLSET_MCP_SESSION_ID)) {
            throw $validationError
        }
    }

    $workspaceName = $workspaceName.Trim()
    $workspaceFilePath = Join-Path $workspaceRoot "$workspaceName.code-workspace"
    $workspace = [ordered]@{
        folders = @(Get-AppWorkspaceFolders -RootPath $workspaceRoot | ForEach-Object { [ordered]@{ path = $_ } })
    }
    $workspace | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $workspaceFilePath
    $workspaceFile = Get-Item -LiteralPath $workspaceFilePath
} else {
    $workspaceName = [System.IO.Path]::GetFileNameWithoutExtension($workspaceFile.Name)
}

$workspaceJson = Get-Content -LiteralPath $workspaceFile.FullName -Raw | ConvertFrom-Json
if (-not $workspaceJson.PSObject.Properties['settings']) {
    $workspaceJson | Add-Member -MemberType NoteProperty -Name settings -Value ([PSCustomObject]@{})
}
if (-not $workspaceJson.settings.PSObject.Properties['dam-pav.bcdevtoolset']) {
    $workspaceJson.settings | Add-Member -MemberType NoteProperty -Name 'dam-pav.bcdevtoolset' -Value ([ordered]@{
        country = 'w1'
        selectArtifact = 'Closest'
        configurations = @([ordered]@{
            name = 'sample'; serverType = ''; targetType = ''; server = ''; serverInstance = ''; container = ''
            port = ''; environmentType = ''; environmentName = ''; includeTestToolkit = ''; tenant = ''
            authentication = ''; bcUser = ''; bcPassword = ''; databaseUser = ''; databasePassword = ''
            remoteUser = ''; remotePassword = ''
        })
    })
    $workspaceJson | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $workspaceFile.FullName
}

$settingsPath = Join-Path $workspaceRoot '.bcdevtoolset' 'settings.json'
Build-Settings -settingsPath $settingsPath -workspaceName $workspaceName
Add-BcDevToolsetGitIgnore -RootPath $workspaceRoot

Write-Host "BC Dev Toolset workspace configuration is ready: $($workspaceFile.FullName)" -ForegroundColor Green
Write-Done
