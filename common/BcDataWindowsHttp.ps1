# Private extension-host transport; never use the operation terminal/transcript.
function Invoke-BcDataWindowsHttp {
    param($Request)
    $uri = $null
    if (-not [Uri]::TryCreate([string]$Request.url, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Fragment -or
        $uri.AbsolutePath -notmatch '/ODataV4/BCDData(?:Write)?_[A-Za-z]+$') { throw 'Invalid endpoint.' }
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    if ($Request.username -and $Request.password) {
        $handler.Credentials = [Net.NetworkCredential]::new($Request.username, $Request.password)
    } else { $handler.UseDefaultCredentials = $true }
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $uri)
    # Windows negotiation requires HTTP/1.1. Read bounded decoded bytes while
    # keeping redirects disabled and never retrying a submitted business request.
    $response = $null
    try {
        $json = $Request.body | ConvertTo-Json -Depth 20 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 4 * 1024 * 1024) { throw 'Request too large.' }
        $message.Content = [Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
        $response = $client.SendAsync($message, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $buffer = [byte[]]::new(8192)
        $output = [IO.MemoryStream]::new()
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while ($true) {
                $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
                $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
                if ($remaining -le 0 -or -not $read.Wait($remaining)) { throw 'Response timeout.' }
                $count = $read.GetAwaiter().GetResult()
                if ($count -eq 0) { break }
                if ($output.Length + $count -gt 4 * 1024 * 1024) { throw 'Response too large.' }
                $output.Write($buffer, 0, $count)
            }
            return @{status=[int]$response.StatusCode;body=[Convert]::ToBase64String($output.ToArray())}
        } finally { $stream.Dispose(); $output.Dispose() }
    } finally {
        if ($response) { $response.Dispose() }
        $message.Dispose(); $client.Dispose()
    }
}
