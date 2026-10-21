param([ValidateRange(1, 3)][int] $Repeats = 2)
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$settings = Get-Content -LiteralPath (Join-Path $repositoryRoot '.bcdevtoolset/settings.json') -Raw | ConvertFrom-Json
$configuration = @($settings.configurations | Where-Object name -eq 'BC27.1')
if ($configuration.Count -ne 1 -or $configuration[0].container -ne 'bcdata271' -or $configuration[0].bcCredential) {
    throw 'Expected the dedicated BC27.1 local-credential configuration.'
}
$inner = '{"large":"' + ('x' * 65536) + '"}'
$body = @{ inputJson = $inner } | ConvertTo-Json -Compress
$requestPath = Join-Path $repositoryRoot '.bcdevtoolset/e01-curl-request.json'
[IO.File]::WriteAllText($requestPath, $body, [Text.UTF8Encoding]::new($false))
$credential = ([string]$configuration[0].bcUser + ':' + [string]$configuration[0].bcPassword).Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n')
# curl reads credentials only from stdin, never arguments, files or output.
$curlConfiguration = 'user = "' + $credential + '"'
$format = '{"status":%{http_code},"responseBytes":%{size_download},"elapsedSeconds":%{time_total},"headersSeconds":%{time_starttransfer},"httpVersion":"%{http_version}"}'
for ($attempt = 1; $attempt -le $Repeats; $attempt++) {
    foreach ($protocol in @('--http1.1', '--http1.0')) {
        $responseName = if ($protocol -eq '--http1.1') { 'e01-curl-http11-body.json' } else { 'e01-curl-http10-body.json' }
        $responsePath = Join-Path $repositoryRoot ".bcdevtoolset/$responseName"
        Write-Host "E01 curl attempt=$attempt protocol=$protocol"
        $statistics = $curlConfiguration | & curl.exe --config - --noproxy '*' --basic --silent --show-error --max-time 15 $protocol `
            --header 'Content-Type: application/json; charset=utf-8' --data-binary "@$requestPath" `
            --output $responsePath --write-out $format `
            'http://bcdata271:7048/BC/ODataV4/BCDCompatibilityE01_Echo?tenant=default&company=CRONUS%20International%20Ltd.'
        $exitCode = $LASTEXITCODE
        $statistics = ($statistics -join '') | ConvertFrom-Json
        $exact = $false
        if ($exitCode -eq 0 -and $statistics.status -eq 200) {
            $echo = ((Get-Content -LiteralPath $responsePath -Raw -Encoding utf8 | ConvertFrom-Json).value | ConvertFrom-Json)
            $exact = $echo.inputJson -ceq $inner
        }
        [pscustomobject]@{
            utc = [DateTime]::UtcNow.ToString('o'); attempt = $attempt; client = 'curl'; protocol = $protocol
            requestBytes = [Text.Encoding]::UTF8.GetByteCount($body); exitCode = $exitCode
            exactInput = $exact; statistics = $statistics
        } | ConvertTo-Json -Depth 6 -Compress | Add-Content -LiteralPath (Join-Path $repositoryRoot '.bcdevtoolset/e01-curl-measurements.jsonl') -Encoding utf8
        Write-Host "  status=$($statistics.status) bytes=$($statistics.responseBytes) seconds=$($statistics.elapsedSeconds) exit=$exitCode exact=$exact"
    }
}
$credential = $null
$curlConfiguration = $null
