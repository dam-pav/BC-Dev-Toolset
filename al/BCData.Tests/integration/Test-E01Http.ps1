# Regression: retain HTTP status, partial byte count, and socket diagnostics when
# response-body reading fails. The earlier harness discarded all three.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'E01Http.ps1')
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
public sealed class E01PartialBodyHandler : HttpMessageHandler {
    private readonly bool waitForCancellation;
    public E01PartialBodyHandler(bool waitForCancellation = false) { this.waitForCancellation = waitForCancellation; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new PartialStream(waitForCancellation)) });
    }
    private sealed class PartialStream : Stream {
        private bool sent;
        private readonly bool waitForCancellation;
        public PartialStream(bool waitForCancellation) { this.waitForCancellation = waitForCancellation; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) {
            if (sent) throw new IOException("synthetic partial-response failure", new SocketException(10054));
            sent = true;
            for (int i = 0; i < 5; i++) buffer[offset + i] = (byte)'x';
            return 5;
        }
        public override async Task<int> ReadAsync(byte[] b, int o, int c, CancellationToken t) {
            if (sent && waitForCancellation) await Task.Delay(Timeout.Infinite, t);
            return Read(b, o, c);
        }
        public override void Flush() { }
        public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException();
        public override void SetLength(long v) => throw new NotSupportedException();
        public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();
    }
}
'@
$client = [Net.Http.HttpClient]::new([E01PartialBodyHandler]::new())
try {
    $result = Send-E01HttpRequest -Uri 'http://fixture.invalid/' -Method GET -Client $client
    if ($result.status -ne 200 -or $result.completed -or $result.phase -ne 'response body' -or $result.responseBytes -ne 5 -or $result.body -cne 'xxxxx') {
        throw 'Regression: status and partial-response evidence must survive body-read failure.'
    }
    if (-not @($result.exceptions | Where-Object { $_.socketError -eq 'ConnectionReset' -and $_.nativeError -eq 10054 }).Count) {
        throw 'Regression: socket error code must be retained.'
    }
    if ($result.cancellationRequested) { throw 'Regression: a socket reset must not be reported as a timeout.' }
    Write-Host 'E01 partial-response evidence regression passed (no network requests).'
} finally { $client.Dispose() }
$timeoutClient = [Net.Http.HttpClient]::new([E01PartialBodyHandler]::new($true))
try {
    $result = Send-E01HttpRequest -Uri 'http://fixture.invalid/' -Method GET -Client $timeoutClient -TimeoutSeconds 1
    if ($result.status -ne 200 -or $result.completed -or $result.responseBytes -ne 5 -or -not $result.cancellationRequested) {
        throw 'Regression: a body timeout must retain status/partial bytes and identify client cancellation.'
    }
    if (-not @($result.exceptions | Where-Object type -eq 'System.Threading.Tasks.TaskCanceledException').Count) {
        throw 'Regression: preserve the cancellation exception instead of only its deepest inner exception.'
    }
    Write-Host 'E01 partial-response timeout regression passed (no network requests).'
} finally { $timeoutClient.Dispose() }
