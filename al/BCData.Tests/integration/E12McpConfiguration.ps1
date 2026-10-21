# Pure configuration transforms. The harness owns the fixed local settings path.
function Get-E12McpAliases {
    param([string] $Container, [string] $RunId)
    if ($Container -cnotin @('bcdata23test','bcdata271')) { throw 'Invalid E12 MCP target.' }
    $guid = [guid]::Empty
    if (-not [guid]::TryParseExact($RunId,'D',[ref]$guid) -or $guid -eq [guid]::Empty) { throw 'Invalid E12 MCP run.' }
    $tag = $guid.ToString('N').Substring(0,12)
    foreach ($kind in @('none','header','related','filtered')) {
        [pscustomobject]@{kind=$kind;name="E12 MCP $Container $kind $tag";username="bcd_e12_${tag}_$kind"}
    }
}

function Add-E12McpAliases {
    param($Settings, [string] $Container, [string] $RunId, $Users)
    $aliases = @(Get-E12McpAliases $Container $RunId)
    if (@($Settings.configurations | Where-Object name -CIn @($aliases.name)).Count) { throw 'E12 MCP alias collision.' }
    $new = foreach ($alias in $aliases) {
        $user = @($Users | Where-Object { $_.kind -ceq $alias.kind -and $_.username -ceq $alias.username })
        if ($user.Count -ne 1 -or [string]::IsNullOrEmpty($user[0].password)) { throw 'Invalid E12 MCP identity.' }
        [pscustomobject]@{name=$alias.name;serverType='Container';targetType='Test';container=$Container;
            authentication='UserPassword';bcCredential=$false;bcUser=$alias.username;bcPassword=$user[0].password;
            bcData=[pscustomobject]@{provisioningEnabled=$false}}
    }
    $Settings.configurations = @($Settings.configurations) + @($new)
}

function Remove-E12McpAliases {
    param($Settings, [string] $Container, [string] $RunId)
    $aliases = @(Get-E12McpAliases $Container $RunId)
    foreach ($alias in $aliases) {
        $existing = @($Settings.configurations | Where-Object name -CEQ $alias.name)
        if ($existing.Count -gt 1 -or ($existing.Count -eq 1 -and
            ($existing[0].container -cne $Container -or $existing[0].bcUser -cne $alias.username))) {
            throw 'E12 MCP alias ownership changed; cleanup refused.'
        }
    }
    $Settings.configurations = @($Settings.configurations | Where-Object name -CNotIn @($aliases.name))
}
