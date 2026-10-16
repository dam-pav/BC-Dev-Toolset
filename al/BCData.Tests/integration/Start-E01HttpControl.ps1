# Temporary synthetic server for isolating HTTP.sys from BC/OData. No auth or
# business data; fixed test ports, fixed 131320-byte body, lifetime 120 seconds.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public static class E01HttpControl {
    static readonly byte[] Body = Encoding.ASCII.GetBytes(new string('x', 131320));
    public static void Run() {
        var http = new HttpListener();
        http.Prefixes.Add("http://+:18081/");
        http.Start();
        var tcp = new TcpListener(IPAddress.Any, 18082);
        tcp.Start();
        Task.Run(async () => {
            while (true) {
                var context = await http.GetContextAsync();
                _ = Task.Run(async () => {
                    try {
                        var response = context.Response;
                        response.ContentType = "application/octet-stream";
                        response.KeepAlive = false;
                        if (context.Request.RawUrl.StartsWith("/chunked")) response.SendChunked = true;
                        else response.ContentLength64 = Body.Length;
                        await response.OutputStream.WriteAsync(Body, 0, Body.Length);
                        response.Close();
                    } catch (Exception e) { Console.WriteLine("HTTP.sys response: " + e.GetType().Name); }
                });
            }
        });
        Task.Run(async () => {
            while (true) {
                var client = await tcp.AcceptTcpClientAsync();
                _ = Task.Run(async () => {
                    using (client) {
                        try {
                            var stream = client.GetStream();
                            var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                            string line;
                            do { line = await reader.ReadLineAsync(); } while (!string.IsNullOrEmpty(line));
                            var header = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n" + Body.Length.ToString("X") + "\r\n");
                            await stream.WriteAsync(header, 0, header.Length);
                            await stream.WriteAsync(Body, 0, Body.Length);
                            var end = Encoding.ASCII.GetBytes("\r\n0\r\n\r\n");
                            await stream.WriteAsync(end, 0, end.Length);
                        } catch (Exception e) { Console.WriteLine("TCP response: " + e.GetType().Name); }
                    }
                });
            }
        });
        Console.WriteLine("E01 synthetic controls ready on 18081 (HTTP.sys) and 18082 (raw TCP).");
        Thread.Sleep(TimeSpan.FromSeconds(120));
        Environment.Exit(0);
    }
}
'@
[E01HttpControl]::Run()
