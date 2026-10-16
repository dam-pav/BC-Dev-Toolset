function Send-E01HttpRequest {
    param(
        [string] $Uri, [string] $Method, [string] $Body, [string] $Authorization,
        [ValidateRange(1, 120)][int] $TimeoutSeconds = 30,
        [ValidateSet('default', 'buffered', 'gzip', 'close', 'http10')][string] $ResponseMode = 'default',
        [Net.Http.HttpClient] $Client
    )
    $ownsClient = $null -eq $Client
    if ($ownsClient) {
        $handler = [Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $handler.UseProxy = $false
        if ($ResponseMode -eq 'gzip') { $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip }
        $Client = [Net.Http.HttpClient]::new($handler)
        $Client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    }
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), $Uri)
    $cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $response = $null
    $stream = $null
    $content = [IO.MemoryStream]::new()
    $result = [ordered]@{
        status = 0; phase = 'send/headers'; elapsedMs = 0; headersMs = $null
        responseBytes = 0; contentLength = $null; transferEncoding = $null
        contentType = $null; body = ''; completed = $false
        timeoutSeconds = $TimeoutSeconds; cancellationRequested = $false; exceptions = @()
    }
    try {
        if ($Authorization) { $request.Headers.Add('Authorization', $Authorization) }
        switch ($ResponseMode) {
            'buffered' { $request.Headers.Add('Accept', 'application/json;odata.streaming=false') }
            'close' { $request.Headers.ConnectionClose = $true }
            'http10' { $request.Version = [Version]::new(1, 0); $request.VersionPolicy = [Net.Http.HttpVersionPolicy]::RequestVersionExact }
        }
        if ($Method -eq 'POST') {
            $request.Content = [Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json')
        }
        $response = $Client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
        $result.status = [int]$response.StatusCode
        $result.headersMs = $watch.ElapsedMilliseconds
        $result.contentLength = $response.Content.Headers.ContentLength
        $result.transferEncoding = [string]$response.Headers.TransferEncoding
        $result.contentType = [string]$response.Content.Headers.ContentType
        $result.phase = 'response body'
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $buffer = [byte[]]::new(8192)
        while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
            $content.Write($buffer, 0, $count)
            $result.responseBytes += $count
        }
        $result.completed = $true
        $result.phase = 'complete'
    } catch {
        $exception = $_.Exception
        while ($null -ne $exception) {
            # Numeric/type diagnostics only: no arbitrary exception messages or headers.
            $detail = [ordered]@{ type = $exception.GetType().FullName; hresult = $exception.HResult }
            if ($exception -is [Net.Sockets.SocketException]) {
                $detail.socketError = [string]$exception.SocketErrorCode
                $detail.nativeError = $exception.NativeErrorCode
            }
            if ($exception.PSObject.Properties['HttpRequestError']) { $detail.httpRequestError = [string]$exception.HttpRequestError }
            $result.exceptions += [pscustomobject]$detail
            $exception = $exception.InnerException
        }
    } finally {
        $result.elapsedMs = $watch.ElapsedMilliseconds
        $result.cancellationRequested = $cancellation.IsCancellationRequested
        $result.body = [Text.Encoding]::UTF8.GetString($content.ToArray())
        if ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $content.Dispose()
        $cancellation.Dispose()
        if ($ownsClient) { $Client.Dispose() }
    }
    return [pscustomobject]$result
}
