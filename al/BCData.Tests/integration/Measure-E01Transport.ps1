param(
    [ValidateSet('BC23 Baseline', 'BC27.1')][string[]] $Target = @('BC27.1'),
    [ValidateRange(1, 5)][int] $Repeats = 2,
    [ValidateRange(1, 120)][int] $TimeoutSeconds = 30,
    [ValidateSet('initial', 'framing', 'sizes')][string] $Experiment = 'initial'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'E01Http.ps1')
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$settings = Get-Content -LiteralPath (Join-Path $repositoryRoot '.bcdevtoolset/settings.json') -Raw | ConvertFrom-Json
$evidencePath = Join-Path $repositoryRoot '.bcdevtoolset/e01-transport-measurements.jsonl'
foreach ($name in $Target) {
    $configuration = @($settings.configurations | Where-Object name -eq $name)
    $hostName = if ($name -eq 'BC23 Baseline') { 'bcdata23test' } else { 'bcdata271' }
    if ($configuration.Count -ne 1 -or $configuration[0].container -ne $hostName -or $configuration[0].authentication -ne 'UserPassword' -or $configuration[0].bcCredential) {
        throw 'Measurement requires the dedicated configured UserPassword target.'
    }
    $authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
        ([string]$configuration[0].bcUser + ':' + [string]$configuration[0].bcPassword)))
    $base = "http://${hostName}:7048/BC/ODataV4"
    $companies = Send-E01HttpRequest -Uri "$base/Company?tenant=default" -Method GET -Authorization $authorization -TimeoutSeconds $TimeoutSeconds
    [pscustomobject]@{
        utc = [DateTime]::UtcNow.ToString('o'); target = $name; attempt = 0
        experiment = $Experiment; mode = 'default'; action = 'Company'; characters = 0
        requestBytes = 0; uri = "$base/Company?tenant=default"; result = $companies
    } | ConvertTo-Json -Depth 12 -Compress | Add-Content -LiteralPath $evidencePath -Encoding utf8
    if (-not $companies.completed -or $companies.status -ne 200) { throw 'Company discovery failed.' }
    $company = [string](($companies.body | ConvertFrom-Json).value | Select-Object -First 1).Name
    if (-not $company) { throw 'Company context is missing.' }
    $query = '?tenant=default&company=' + [Uri]::EscapeDataString($company)
    for ($attempt = 1; $attempt -le $Repeats; $attempt++) {
        $scenarios = @(
            @{ action = 'Echo'; size = 64 },
            @{ action = 'Fail'; size = 65536 },
            @{ action = 'Echo'; size = 65536 },
            @{ action = 'Metadata'; size = 0 }
        )
        if ($Experiment -eq 'framing') {
            $scenarios = @('default', 'buffered', 'gzip', 'close', 'http10') | ForEach-Object { @{ action = 'Echo'; size = 65536; mode = $_ } }
        }
        if ($Experiment -eq 'sizes') {
            $scenarios = @(1024, 8192, 16384, 32768, 65536) | ForEach-Object { @{ action = 'Echo'; size = $_ } }
        }
        foreach ($scenario in $scenarios) {
            $mode = if ($scenario.mode) { $scenario.mode } else { 'default' }
            $body = $null
            $method = 'GET'
            $uri = "$base/`$metadata?tenant=default"
            if ($scenario.action -ne 'Metadata') {
                $inner = '{"large":"' + ('x' * $scenario.size) + '"}'
                $body = @{ inputJson = $inner } | ConvertTo-Json -Compress
                $method = 'POST'
                $uri = "$base/BCDCompatibilityE01_$($scenario.action)$query"
            }
            Write-Host "E01 $name attempt=$attempt action=$($scenario.action) characters=$($scenario.size) mode=$mode"
            $result = Send-E01HttpRequest -Uri $uri -Method $method -Body $body -Authorization $authorization -TimeoutSeconds $TimeoutSeconds -ResponseMode $mode
            $record = [pscustomobject]@{
                utc = [DateTime]::UtcNow.ToString('o'); target = $name; attempt = $attempt
                experiment = $Experiment; mode = $mode; action = $scenario.action; characters = $scenario.size
                requestBytes = [Text.Encoding]::UTF8.GetByteCount([string]$body)
                company = $company; uri = $uri; result = $result
            }
            $record | ConvertTo-Json -Depth 12 -Compress | Add-Content -LiteralPath $evidencePath -Encoding utf8
            # Keep metadata/large bodies in local evidence; summarize only progress.
            Write-Host "  status=$($result.status) phase=$($result.phase) elapsedMs=$($result.elapsedMs) bytes=$($result.responseBytes) cancelled=$($result.cancellationRequested)"
        }
    }
    $authorization = $null
}
