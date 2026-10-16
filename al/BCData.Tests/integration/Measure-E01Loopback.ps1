# Server-local comparison. Credential material is passed through stdin only,
# never command arguments or files. All container paths/names are fixed.
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$settings = Get-Content -LiteralPath (Join-Path $repositoryRoot '.bcdevtoolset/settings.json') -Raw | ConvertFrom-Json
$configuration = @($settings.configurations | Where-Object name -eq 'BC27.1')
if ($configuration.Count -ne 1 -or $configuration[0].container -ne 'bcdata271' -or $configuration[0].bcCredential) {
    throw 'Expected the dedicated BC27.1 local-credential configuration.'
}
$serverScript = @'
$ErrorActionPreference = 'Stop'
. 'C:/run/my/e01-diagnostics/E01Http.ps1'
$credentials = [Console]::In.ReadToEnd() | ConvertFrom-Json
$authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($credentials.user + ':' + $credentials.password))
$uri = 'http://localhost:7048/BC/ODataV4/BCDCompatibilityE01_Echo?tenant=default&company=CRONUS%20International%20Ltd.'
$results = @()
foreach ($size in @(64, 65536, 65536)) {
    $inner = '{"large":"' + ('x' * $size) + '"}'
    $body = @{ inputJson = $inner } | ConvertTo-Json -Compress
    $response = Send-E01HttpRequest -Uri $uri -Method POST -Body $body -Authorization $authorization -TimeoutSeconds 15
    $exact = $false
    if ($response.completed -and $response.status -eq 200) {
        $echo = ($response.body | ConvertFrom-Json).value | ConvertFrom-Json
        $exact = $echo.inputJson -ceq $inner
    }
    $results += [pscustomobject]@{ utc = [DateTime]::UtcNow.ToString('o'); location = 'container loopback'; characters = $size; exactInput = $exact; result = $response }
}
$authorization = $null
$credentials = $null
$results | ConvertTo-Json -Depth 12
'@
$encodedServerScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($serverScript))
$credentialInput = @{ user = [string]$configuration[0].bcUser; password = [string]$configuration[0].bcPassword } | ConvertTo-Json -Compress
$output = $credentialInput | docker exec -i bcdata271 pwsh -NoProfile -EncodedCommand $encodedServerScript
if ($LASTEXITCODE -ne 0) { throw 'Container loopback measurement failed.' }
$output | Set-Content -LiteralPath (Join-Path $repositoryRoot '.bcdevtoolset/e01-loopback.json') -Encoding utf8
$output | ConvertFrom-Json | ForEach-Object {
    [pscustomobject]@{ characters = $_.characters; exactInput = $_.exactInput; status = $_.result.status; completed = $_.result.completed; elapsedMs = $_.result.elapsedMs; responseBytes = $_.result.responseBytes }
} | ConvertTo-Json
