function Get-AlObjectIdUsage {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string] $Source)

    # Tokenize before examining declarations: comments and literals can contain AL-looking text.
    $tokens = [regex]::Matches($Source, '(?s)//[^\r\n]*|/\*.*?\*/|''(?:''''|[^''])*''|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]')
    $types = 'table|tableextension|page|pageextension|pagecustomization|report|reportextension|codeunit|query|xmlport|enum|enumextension|permissionset|permissionsetextension|entitlement'
    $depth = 0
    $pendingType = $null
    foreach ($token in $tokens) {
        $value = $token.Value
        if ($value.StartsWith('//') -or $value.StartsWith('/*')) { continue }
        if ($value -eq '{') { $depth++; $pendingType = $null; continue }
        if ($value -eq '}') { $depth--; $pendingType = $null; continue }
        if ($depth -ne 0) { continue }
        if ($pendingType -and $value -match '^[0-9]+$') {
            [PSCustomObject]@{ type = $pendingType; id = [int]$value }
        }
        $pendingType = $null
        if ($value -match "^($types)$") { $pendingType = $value.ToLowerInvariant() }
    }
}

function Get-AppObjectIdUsage {
    param([Parameter(Mandatory=$true)][string] $AuthorizedAppRoot)

    # Workspace folder resolution authorizes this app root, including external workspace folders.
    $validatedRoot = [System.IO.Path]::GetFullPath($AuthorizedAppRoot)
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($validatedRoot)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            # Never follow links into another app or outside the authorized folder.
            if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
            $validatedPath = [System.IO.Path]::GetFullPath($entry.FullName)
            $relative = [System.IO.Path]::GetRelativePath($validatedRoot, $validatedPath)
            if ([System.IO.Path]::IsPathRooted($relative) -or $relative -eq '..' -or $relative.StartsWith('../') -or $relative.StartsWith('..\')) {
                throw 'Source path escapes the authorized app root.'
            }
            if ($entry.PSIsContainer) {
                if ($entry.Name -in @('.git', '.alpackages', '.snapshots', '.bcdevtoolset', 'node_modules') -or
                    (Test-Path -LiteralPath (Join-Path $validatedPath 'app.json'))) { continue }
                $pending.Push($validatedPath)
            } elseif ($entry.Extension -ieq '.al') {
                Get-AlObjectIdUsage -Source (Get-Content -LiteralPath $validatedPath -Raw -ErrorAction Stop)
            }
        }
    }
}
