$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('bc-publish-credentials-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $fixtureRoot
$appFile = Join-Path $fixtureRoot 'fixture.app'
$originalSession = $env:BCDEVTOOLSET_MCP_SESSION_ID
$originalNonInteractive = $env:BCDEVTOOLSET_NON_INTERACTIVE
try {
    Set-Content -LiteralPath $appFile -Value 'fixture'
    $env:BCDEVTOOLSET_MCP_SESSION_ID=''; $env:BCDEVTOOLSET_NON_INTERACTIVE=''
    $packages = @(@{Root=$fixtureRoot;Path=$appFile}, @{Root=$fixtureRoot;Path=$appFile})
    function Get-ConfigurationCredential {
        param($configuration,$kind)
        if ($script:missing) { throw 'Stored credential is missing' }
        [pscredential]::new('stored',[Security.SecureString]::new())
    }
    function Get-Credential {
        $script:prompts++
        if ($script:cancel) { return $null }
        [pscredential]::new('entered',[Security.SecureString]::new())
    }
    function Read-Host { $script:storagePrompts++; $script:storageDecision }
    function Invoke-WebRequest {
        param([pscredential]$Credential)
        $script:uploads++
        if ($script:failUpload) { throw 'Upload failed' }
        $expected = if ($script:missing) { 'entered' } else { 'stored' }
        Assert ($Credential.UserName -eq $expected) 'Publishing did not reuse the resolved credential'
    }
    function Save-ConfigurationCredential {
        param($configuration,$kind,[pscredential]$credential)
        Assert ($script:uploads -eq 2) 'Storage was offered before all apps were published'
        Assert ($kind -eq $script:expectedKind -and $credential.UserName -eq 'entered') 'Wrong credential was offered for storage'
        $script:saves++
    }
    function Reset-Scenario {
        $script:prompts=0; $script:storagePrompts=0; $script:uploads=0; $script:saves=0
        $script:missing=$true; $script:cancel=$false; $script:failUpload=$false; $script:storageDecision='y'
    }
    foreach ($kind in @('remote','bc')) {
        foreach ($authentication in @('Windows','UserPassword')) {
            if ($kind -eq 'remote' -and $authentication -eq 'UserPassword') { continue }
            Reset-Scenario
            $script:expectedKind=$kind
            $configuration = [pscustomobject]@{name='manual';server='https://bc-host';port=8049;serverInstance='BC230';authentication=$authentication}
            $configuration | Add-Member "${kind}Credential" $true
            Publish-OnPremDevelopmentApps $configuration $packages
            Assert ($script:prompts -eq 1 -and $script:uploads -eq 2 -and $script:saves -eq 1) 'Manual publishing must prompt once, reuse the credential, and offer storage after success'
        }
    }
    Reset-Scenario
    $script:storageDecision='n'
    Publish-OnPremDevelopmentApps $configuration $packages
    Assert ($script:uploads -eq 2 -and $script:storagePrompts -eq 1 -and $script:saves -eq 0) 'Declining storage should keep the entered credential session-only'

    foreach ($scenario in @('cancel','upload-failure','agent','noninteractive')) {
        Reset-Scenario
        $script:cancel=$scenario -eq 'cancel'; $script:failUpload=$scenario -eq 'upload-failure'
        $env:BCDEVTOOLSET_MCP_SESSION_ID=if ($scenario -eq 'agent') {'test-agent'} else {''}
        $env:BCDEVTOOLSET_NON_INTERACTIVE=if ($scenario -eq 'noninteractive') {'true'} else {''}
        $caught=$false
        try { Publish-OnPremDevelopmentApps $configuration $packages } catch { $caught=$true }
        Assert $caught "$scenario must stop publishing"
        Assert ($script:storagePrompts -eq 0 -and $script:saves -eq 0) "$scenario offered to save an unverified credential"
        if ($scenario -in @('agent','noninteractive')) {
            Assert ($script:prompts -eq 0 -and $script:uploads -eq 0) "$scenario must not prompt or upload"
        } elseif ($scenario -eq 'cancel') {
            Assert ($script:prompts -eq 1 -and $script:uploads -eq 0) 'Cancelling credential entry must prevent uploads'
        }
    }
    $env:BCDEVTOOLSET_MCP_SESSION_ID=''; $env:BCDEVTOOLSET_NON_INTERACTIVE=''
    Reset-Scenario
    $script:missing=$false
    Publish-OnPremDevelopmentApps $configuration $packages
    Assert ($script:prompts -eq 0 -and $script:uploads -eq 2 -and $script:storagePrompts -eq 0) 'Existing stored credentials should not prompt'

    # Container Dev publishing uses the same human recovery and save-after-success rule.
    function Get-SortedApps { @([pscustomobject]@{Name='one';Dependencies=@()},[pscustomobject]@{Name='two';Dependencies=@()}) }
    function Get-PackageParams {
        param($scriptPath,$settingsJSON,$appJSON,$runtime,[ref]$packageName,[ref]$packagePath)
        $packageName.Value='fixture.app'; $packagePath.Value=$fixtureRoot
    }
    function Test-DockerContainerExists { $true }
    function Test-BcContainerTenantAccessible { $true }
    function Publish-BcContainerApp {
        param([pscredential]$Credential,$appFile)
        if ($script:failUpload) { throw 'Container publish failed' }
        Assert ($Credential.UserName -eq 'entered') 'Container did not use the entered credential'
        $script:uploads += @($appFile).Count
    }
    $configuration = [pscustomobject]@{name='container';serverType='Container';container='fixture';targetType='Dev';authentication='UserPassword';bcCredential=$true}
    $settings = @{configurations=@($configuration)}
    foreach ($fail in @($false,$true)) {
        Reset-Scenario; $script:expectedKind='bc'; $script:failUpload=$fail
        $caught=$false
        try { Publish-Apps -scriptPath $fixtureRoot -settingsJSON $settings -workspaceJSON @{} -publishAsDev $true } catch { $caught=$true }
        Assert ($caught -eq $fail) 'Container publish failure was not propagated'
        Assert ($script:prompts -eq 1 -and $script:saves -eq [int](-not $fail)) 'Container credential recovery/storage did not follow publish success'
    }
} finally {
    $env:BCDEVTOOLSET_MCP_SESSION_ID=$originalSession
    $env:BCDEVTOOLSET_NON_INTERACTIVE=$originalNonInteractive
    Remove-Item -LiteralPath $appFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $fixtureRoot -Force
}
