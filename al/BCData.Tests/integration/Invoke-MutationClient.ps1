param(
    [ValidateSet('BC23 Baseline','BC24 Matrix','BC25 Matrix','BC26 Matrix','BC27.1')][string] $Target = 'BC23 Baseline',
    [switch] $CleanupOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$containers = @{'BC23 Baseline'='bcdata23test';'BC24 Matrix'='bcdata24test';'BC25 Matrix'='bcdata25test';'BC26 Matrix'='bcdata26test';'BC27.1'='bcdata271'}
$container = $containers[$Target]
. (Join-Path $root 'common/CredentialMgt.ps1')
$settings = Get-Content -LiteralPath (Join-Path $root '.bcdevtoolset/settings.json') -Raw | ConvertFrom-Json
$matches = @($settings.configurations | Where-Object name -CEQ $Target)
if ($matches.Count -ne 1 -or $matches[0].container -cne $container -or $matches[0].serverType -ne 'Container' -or
    $matches[0].targetType -ne 'Test' -or $matches[0].authentication -ne 'UserPassword') {
    throw 'Only the five dedicated UserPassword Test configurations are accepted.'
}
$credential = Get-ConfigurationCredential -configuration $matches[0] -kind bc
$start = [Diagnostics.ProcessStartInfo]::new('node')
$start.ArgumentList.Add((Join-Path $PSScriptRoot 'Verify-BCDataMutationClient.cjs'))
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::Start($start)
try {
    $out = $process.StandardOutput.ReadToEndAsync()
    $err = $process.StandardError.ReadToEndAsync()
    @{target=$Target;container=$container;cleanupOnly=$CleanupOnly.IsPresent;
      admin=@{username=$credential.UserName;password=$credential.GetNetworkCredential().Password}} |
        ConvertTo-Json -Depth 5 -Compress | ForEach-Object { $process.StandardInput.WriteLine($_) }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(240000)) { $process.Kill($true); throw 'Mutation client HTTP deadline exceeded; run -CleanupOnly.' }
    $output = $out.GetAwaiter().GetResult()
    if ($output) { Write-Output $output }
    if ($process.ExitCode -ne 0) { throw ('Mutation client qualification failed (exit code ' + $process.ExitCode + '): ' + $err.GetAwaiter().GetResult()) }
} finally {
    $process.Dispose()
    $credential = $null
}
