using System.Text;
using System.Text.Json;

// Synthetic diagnostic only: no credentials, business data, or BC dependencies.
if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("This control requires Windows HTTP.sys.");
var buffered = args.Contains("--buffered");
var port = buffered ? 18084 : 18083;
var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.UseHttpSys(options =>
{
    options.UrlPrefixes.Add($"http://+:{port}/");
    options.AllowSynchronousIO = true;
    options.EnableKernelResponseBuffering = buffered;
});
var app = builder.Build();
var body = Encoding.ASCII.GetBytes(new string('x', 131320));
app.Run(async context =>
{
    context.Response.ContentType = "application/octet-stream";
    switch (context.Request.Path.Value)
    {
        case "/fixed":
            context.Response.ContentLength = body.Length;
            await context.Response.Body.WriteAsync(body);
            break;
        case "/single":
            await context.Response.Body.WriteAsync(body);
            break;
        case "/sync":
            for (var offset = 0; offset < body.Length; offset += 8192)
                context.Response.Body.Write(body, offset, Math.Min(8192, body.Length - offset));
            break;
        case "/json":
            context.Response.ContentType = "application/json";
            await JsonSerializer.SerializeAsync(context.Response.Body, new string('x', body.Length));
            break;
        default:
            for (var offset = 0; offset < body.Length; offset += 8192)
            {
                await context.Response.Body.WriteAsync(body.AsMemory(offset, Math.Min(8192, body.Length - offset)));
                await context.Response.Body.FlushAsync();
            }
            break;
    }
});
Console.WriteLine($"E01 ASP.NET Core HTTP.sys control starting on {port}; kernel buffering={buffered}; lifetime 120 seconds.");
using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(120));
await app.RunAsync(lifetime.Token);
