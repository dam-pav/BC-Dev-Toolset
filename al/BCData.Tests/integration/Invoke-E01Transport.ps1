param(
    [ValidateSet('BC23 Baseline', 'BC24 Matrix', 'BC25 Matrix', 'BC26 Matrix', 'BC27.1')]
    [string[]] $Target = @('BC23 Baseline', 'BC27.1'),
    [ValidateSet('default', 'gzip', 'http10')]
    [string] $ResponseMode = 'default'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'E01Http.ps1')
# Fixed repository-owned settings path; no caller-supplied filesystem paths.
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$settingsPath = Join-Path $repositoryRoot '.bcdevtoolset/settings.json'
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json

function Send-ProbeRequest {
    param([string] $Uri, [string] $Method, [string] $Body, [string] $Authorization)
    Write-Host "E01 $Method $Uri"
    Send-E01HttpRequest -Uri $Uri -Method $Method -Body $Body -Authorization $Authorization -ResponseMode $ResponseMode
}

$results = @()
foreach ($name in $Target) {
    $configuration = @($settings.configurations | Where-Object name -eq $name)
    if ($configuration.Count -ne 1) { throw 'E01 requires exactly one dedicated target configuration.' }
    $configuration = $configuration[0]
    $hostName = @{'BC23 Baseline'='bcdata23test';'BC24 Matrix'='bcdata24test';'BC25 Matrix'='bcdata25test';'BC26 Matrix'='bcdata26test';'BC27.1'='bcdata271'}[$name]
    if ($configuration.container -cne $hostName -or $configuration.authentication -ne 'UserPassword' -or
        $configuration.serverType -ne 'Container' -or $configuration.targetType -ne 'Test') {
        throw 'E01 target must match the dedicated container and UserPassword authentication.'
    }
    if ($configuration.bcCredential) { throw 'E01 harness needs a credential-store adapter for stored credentials.' }
    if (-not $configuration.bcUser -or -not $configuration.bcPassword) { throw 'E01 configured credentials are missing.' }
    $authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
        ([string]$configuration.bcUser + ':' + [string]$configuration.bcPassword)))
    # The default OData port is a probe candidate; a response establishes availability.
    $base = "http://${hostName}:7048/BC/ODataV4"
    $anonymous = Send-ProbeRequest "$base/`$metadata?tenant=default" 'GET' $null $null
    if (-not $anonymous.completed -or $anonymous.status -ne 401) { throw 'E01 expected unauthenticated metadata access to return 401.' }
    $companies = Send-ProbeRequest "$base/Company?tenant=default" 'GET' $null $authorization
    if (-not $companies.completed -or $companies.status -ne 200) { throw 'E01 could not discover company context over HTTP.' }
    $company = [string](($companies.body | ConvertFrom-Json).value | Select-Object -First 1).Name
    if (-not $company) { throw 'E01 needs a company returned by the dedicated target.' }
    $query = '?tenant=default&company=' + [Uri]::EscapeDataString($company)
    $cases = @(
        '{"unicode":"Živjo 世界 😀","escaped":"quote: \" slash: \\ newline: \n","empty":"","number":123.456,"boolean":true,"null":null,"array":[0,false,""]}',
        ('{"large":"' + ('x' * 65536) + '"}')
    )
    $exchanges = @()
    $failures = @()
    foreach ($inputJson in $cases) {
        $body = @{ inputJson = $inputJson } | ConvertTo-Json -Compress
        $uri = "$base/BCDCompatibilityE01_Echo$query"
        $response = Send-ProbeRequest $uri 'POST' $body $authorization
        $exchanges += [pscustomobject]@{ method = 'POST'; uri = $uri; request = $body; requestBytes = [Text.Encoding]::UTF8.GetByteCount($body); response = $response }
        if (-not $response.completed -or $response.status -ne 200) {
            $failures += "Echo did not complete with 200 for $([Text.Encoding]::UTF8.GetByteCount($body)) request bytes."
            continue
        }
        $envelope = $response.body | ConvertFrom-Json
        $echo = $envelope.value | ConvertFrom-Json
        if ($echo.inputJson -cne $inputJson -or $echo.company -cne $company -or $echo.experiment -ne 'E01') {
            $failures += 'Exact input/company/experiment assertion failed.'
        }
        $expectedPayload = $inputJson | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress
        $actualPayload = $echo.payload | ConvertTo-Json -Depth 20 -Compress
        if ($expectedPayload -cne $actualPayload) { $failures += 'Parsed payload assertion failed.' }
    }
    foreach ($failure in @(
        @{ action = 'Fail'; input = '{"private":"must not appear in error"}'; marker = 'BCD_E01_DELIBERATE_ERROR' },
        @{ action = 'Echo'; input = '{'; marker = 'BCD_E01_INVALID_JSON' }
    )) {
        $body = @{ inputJson = $failure.input } | ConvertTo-Json -Compress
        $uri = "$base/BCDCompatibilityE01_$($failure.action)$query"
        $response = Send-ProbeRequest $uri 'POST' $body $authorization
        $exchanges += [pscustomobject]@{ method = 'POST'; uri = $uri; request = $body; requestBytes = [Text.Encoding]::UTF8.GetByteCount($body); response = $response }
        if (-not $response.completed -or $response.status -lt 400 -or $response.body -notmatch $failure.marker -or $response.body -match 'must not appear in error') {
            $failures += "Expected a structured error containing $($failure.marker)."
            continue
        }
        $errorBody = $response.body | ConvertFrom-Json
        if (-not $errorBody.error.code -or -not $errorBody.error.message) { $failures += 'Expected an OData error object.' }
    }
    $targetResult = [pscustomobject]@{
        target = $name; container = $hostName; company = $company; fixtureVersion = '1'; responseMode = $ResponseMode
        authentication = 'HTTP Basic with configured UserPassword credentials'
        anonymousMetadataStatus = $anonymous.status; authenticatedCompanyStatus = $companies.status
        completedUtc = [DateTime]::UtcNow.ToString('o')
        exchanges = $exchanges; passed = ($failures.Count -eq 0); failures = $failures
    }
    # Preserve each completed target if a later target fails. Fixed filenames only.
    $evidenceFiles = @{
        'BC23 Baseline/default' = 'e01-http-bc23.json'; 'BC27.1/default' = 'e01-http-bc271.json'
        'BC23 Baseline/gzip' = 'e01-http-bc23-gzip.json'; 'BC27.1/gzip' = 'e01-http-bc271-gzip.json'
        'BC23 Baseline/http10' = 'e01-http-bc23-http10.json'; 'BC27.1/http10' = 'e01-http-bc271-http10.json'
        'BC24 Matrix/default' = 'e01-http-bc24.json'; 'BC25 Matrix/default' = 'e01-http-bc25.json'; 'BC26 Matrix/default' = 'e01-http-bc26.json'
        'BC24 Matrix/gzip' = 'e01-http-bc24-gzip.json'; 'BC25 Matrix/gzip' = 'e01-http-bc25-gzip.json'; 'BC26 Matrix/gzip' = 'e01-http-bc26-gzip.json'
        'BC24 Matrix/http10' = 'e01-http-bc24-http10.json'; 'BC25 Matrix/http10' = 'e01-http-bc25-http10.json'; 'BC26 Matrix/http10' = 'e01-http-bc26-http10.json'
    }
    $evidenceFile = $evidenceFiles["$name/$ResponseMode"]
    $targetResult | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $repositoryRoot ".bcdevtoolset/$evidenceFile") -Encoding utf8
    $results += $targetResult
    $authorization = $null
}
$results | ConvertTo-Json -Depth 20
if (@($results | Where-Object { -not $_.passed }).Count -gt 0) {
    throw 'E01 assertions failed; inspect the per-target evidence under .bcdevtoolset.'
}
