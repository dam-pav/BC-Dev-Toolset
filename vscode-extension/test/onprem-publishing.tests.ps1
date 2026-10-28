$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Assert-Throws($action, $pattern) {
    $caught = $false
    try { & $action } catch { Assert ($_.Exception.Message -match $pattern) $_.Exception.Message; $caught=$true }
    Assert $caught "Expected failure matching $pattern"
}
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('bc-onprem-publish-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $fixtureRoot
$appFile = Join-Path $fixtureRoot 'Publisher_Workspace_1.0.0.0.app'
$moduleFile = Join-Path $fixtureRoot 'NavAdminTool.ps1'
try {
    Set-Content -LiteralPath $appFile -Value 'mock package'
    Set-Content -LiteralPath $moduleFile -Value '# mock administration shell'
    $configuration = [pscustomobject]@{
        name='remote';serverType='OnPrem';targetType='Dev';server='http://bc-host:8080/BC230';
        port='8049';serverInstance='BC230';authentication='Windows'
    }
    $settings = @{configurations=@($configuration)} # No loadOnPremMgtModule, as in the reported failure.
    function Get-SortedApps { @([pscustomobject]@{Name='Workspace';Dependencies=@()}) }
    function Get-PackageParams {
        param($scriptPath,$settingsJSON,$appJSON,$runtime,[ref]$packageName,[ref]$packagePath)
        $packageName.Value = Split-Path $appFile -Leaf
        $packagePath.Value = $fixtureRoot
    }
    function Initialize-OnPremPublishingManagement { throw 'Dev publishing must not load administration tools' }
    $script:requests = @()
    $script:failUpload = $false
    $script:successMessages = @()
    function Write-Host {
        param($Object)
        if ([string]$Object -like 'Successfully published*') { $script:successMessages += [string]$Object }
    }
    function Invoke-WebRequest {
        param($Uri,$Method,$Form,[switch]$UseDefaultCredentials,$Authentication,$Credential,$MaximumRedirection,[switch]$AllowUnencryptedAuthentication)
        if ($script:failUpload) { throw 'mock HTTP publish failure' }
        $script:requests += [pscustomobject]@{Uri=$Uri;Method=$Method;Form=$Form;Windows=$UseDefaultCredentials;Authentication=$Authentication;Credential=$Credential;Redirects=$MaximumRedirection;AllowHttp=$AllowUnencryptedAuthentication}
    }
    Publish-Apps -scriptPath $fixtureRoot -settingsJSON $settings -workspaceJSON @{} -publishAsDev $true
    Assert ($script:requests.Count -eq 1) 'Reported OnPrem Dev configuration did not upload its app'
    Assert ($script:successMessages.Count -eq 1 -and $script:successMessages[0] -eq "Successfully published 'Publisher_Workspace_1.0.0.0.app' to 'remote'.") 'Successful publishing must name the app and selected configuration'
    $request = $script:requests[0]
    Assert ($request.Uri.AbsoluteUri -eq 'http://bc-host:8049/BC230/dev/apps?SchemaUpdateMode=synchronize&DependencyPublishingOption=ignore') 'Developer port/path was not used'
    Assert ($request.Windows -and $request.Method -eq 'Post' -and $request.Redirects -eq 0) 'Windows authentication or HTTP method was lost'
    Assert $request.AllowHttp 'Windows HTTP publishing must satisfy the PowerShell authentication transport check'
    $uploadedFile = @($request.Form.Values)[0]
    Assert ($uploadedFile -is [IO.FileInfo] -and $uploadedFile.FullName -eq $appFile) 'Multipart upload did not contain the selected app'
    $script:failUpload=$true
    Assert-Throws { Publish-Apps -scriptPath $fixtureRoot -settingsJSON $settings -workspaceJSON @{} -publishAsDev $true } 'mock HTTP publish failure'
    Assert ($script:successMessages.Count -eq 1) 'Failed publishing must not report success'
    $script:failUpload=$false

    $script:credentialKind=''
    $script:missingCredential=$false
    function Get-ConfigurationCredential {
        param($configuration,$kind)
        if ($script:missingCredential) { throw 'Stored credential is missing' }
        $script:credentialKind=$kind
        [pscredential]::new("stored-$kind",(ConvertTo-SecureString 'fixture' -AsPlainText -Force))
    }
    $configuration | Add-Member remoteCredential $true
    Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=$appFile})
    Assert ($script:credentialKind -eq 'remote' -and $script:requests[-1].Credential.UserName -eq 'stored-remote' -and -not $script:requests[-1].Windows) 'Stored Windows credential was ignored'
    $configuration | Add-Member bcCredential $true
    Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=$appFile})
    Assert ($script:credentialKind -eq 'bc' -and $script:requests[-1].Credential.UserName -eq 'stored-bc') 'BC credential must take precedence over remote credential'
    $script:missingCredential=$true
    $requestCount=$script:requests.Count
    $originalSession = $env:BCDEVTOOLSET_MCP_SESSION_ID
    try {
        $env:BCDEVTOOLSET_MCP_SESSION_ID='test-agent'
        Assert-Throws { Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=$appFile}) } 'Stored credential is missing'
    } finally { $env:BCDEVTOOLSET_MCP_SESSION_ID=$originalSession }
    Assert ($script:requests.Count -eq $requestCount) 'Missing stored credentials must not fall back to another identity'
    $script:missingCredential=$false
    $configuration.server='https://bc-host'
    Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=$appFile})
    Assert (-not $script:requests[-1].AllowHttp) 'HTTPS must not enable unencrypted authentication'

    $configuration | Add-Member tenant 'tenant & other'
    Assert ((Get-OnPremDevelopmentPublishUri $configuration).Query -match 'tenant=tenant%20%26%20other') 'Tenant was not escaped'
    $configuration.port='0'
    Assert-Throws { Get-OnPremDevelopmentPublishUri $configuration } 'developer-services port'
    $configuration.port='8049'; $configuration.server='http://user:secret@bc-host'
    Assert-Throws { Get-OnPremDevelopmentPublishUri $configuration } 'without credentials'
    $configuration.server='http://bc-host'; $configuration.authentication='UserPassword'
    Assert-Throws { Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=$appFile}) } 'HTTPS'
    $configuration.server='https://bc-host'
    function Get-BcConfigurationCredential { [pscredential]::new('bcuser',(ConvertTo-SecureString 'fixture' -AsPlainText -Force)) }
    Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=$appFile})
    Assert ($script:requests[-1].Authentication -eq 'Basic' -and $script:requests[-1].Credential.UserName -eq 'bcuser') 'Configured BC credential was not used'
    Assert (-not $script:requests[-1].AllowHttp) 'UserPassword must not enable unencrypted authentication'
    Assert-Throws { Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=(Join-Path $fixtureRoot '../outside.app')}) } 'authorized package folder'
    Assert-Throws { Publish-OnPremDevelopmentApps $configuration @(@{Root=$fixtureRoot;Path=$moduleFile}) } 'authorized package folder'

    # Use real module initialization with mocked command discovery and module loading.
    . (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
    $script:available = $false
    $script:imports = 0
    function Get-Command { param($Name) if ($script:available) { [pscustomobject]@{Name=$Name} } }
    function Import-Module { param($Name,[switch]$Global) Assert ($Name -eq $moduleFile -and $Global) 'Module path/scope was not preserved'; $script:imports++; $script:available=$true }
    Assert-Throws { Initialize-OnPremPublishingManagement $settings $configuration } 'loadOnPremMgtModule'
    Assert-Throws { Initialize-OnPremPublishingManagement $settings $configuration -Unpublish } 'loadOnPremMgtModule'
    Assert ($script:imports -eq 0) 'Missing setting attempted a module import'
    $script:available=$true
    Initialize-OnPremPublishingManagement $settings $configuration
    Assert ($script:imports -eq 0) 'Already loaded management tools should not require a setting'
    $script:available=$false
    $settings.loadOnPremMgtModule='relative.ps1'
    Assert-Throws { Initialize-OnPremPublishingManagement $settings $configuration } 'absolute literal path'
    $settings.loadOnPremMgtModule=$moduleFile
    Initialize-OnPremPublishingManagement $settings $configuration
    Assert ($script:imports -eq 1 -and $script:available) 'Configured administration shell did not load'
} finally {
    # Remove only the fixed files in this newly allocated fixture, then the empty directory.
    Remove-Item -LiteralPath $appFile, $moduleFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $fixtureRoot -Force
}
