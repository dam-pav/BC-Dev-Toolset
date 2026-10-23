. (Join-Path $PSScriptRoot 'BcDataPackage.ps1')

function Select-BcDataInitializationConfiguration {
    param($SettingsJSON)

    $configurations = @($SettingsJSON.configurations | Where-Object {
        $_.serverType -eq 'Container' -and $_.targetType -eq 'Dev' -and
        -not [string]::IsNullOrWhiteSpace($_.name) -and
        -not [string]::IsNullOrWhiteSpace($_.container)
    })
    if ($configurations.Count -eq 0) {
        throw 'No Dev Container configurations with a name and container found. No target was changed.'
    }
    foreach ($configuration in $configurations) {
        if (@($SettingsJSON.configurations | Where-Object name -eq $configuration.name).Count -ne 1) {
            throw 'Choose an exact unique configuration name. No target was changed.'
        }
    }

    $connectionId = Request-BcDevToolsetMcpPrompt -PromptId 'bcData.connectionId' -Type 'choice' `
        -Question 'Select the Dev container configuration to initialize' -Choices @($configurations.name)
    if ($null -eq $connectionId) {
        $index = Select-IndexFromList -Title 'Select the Dev container to initialize BC Data on:' `
            -Options @($configurations | ForEach-Object { "$($_.name) ($($_.container))" })
        return $configurations[$index]
    }
    $selectedConfigurations = @($configurations | Where-Object { $_.name -ceq $connectionId })
    if ($selectedConfigurations.Count -ne 1) {
        throw 'Choose an exact unique Dev Container configuration name from the available options. No target was changed.'
    }
    return $selectedConfigurations[0]
}

function Assert-BcDataConfiguration {
    param($Configuration)
    if ($Configuration.serverType -ne 'Container' -or $Configuration.targetType -notin @('Dev','Test') -or
        [string]$Configuration.container -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$' -or
        $Configuration.authentication -ne 'UserPassword') {
        throw 'BC Data initialization requires one Dev/Test Container configuration with UserPassword authentication.'
    }
    $data = $Configuration.bcData
    if ($null -ne $data) {
        if ($data -isnot [pscustomobject] -and $data -isnot [System.Collections.IDictionary]) { throw 'bcData must be an object.' }
        $keys = if ($data -is [System.Collections.IDictionary]) { @($data.Keys) } else { @($data.PSObject.Properties.Name) }
        if (@($keys | Where-Object { $_ -notin @('baseUrl','tenant','provisioningEnabled','allowedAllMutationOperations','allowedMutationOperations') }).Count -gt 0) { throw 'Unsupported bcData configuration property.' }
        if ($keys -contains 'provisioningEnabled' -and $data.provisioningEnabled -isnot [bool]) { throw 'bcData.provisioningEnabled must be a boolean.' }
        if ($keys -contains 'allowedAllMutationOperations' -and $data.allowedAllMutationOperations -isnot [bool]) { throw 'bcData.allowedAllMutationOperations must be a boolean.' }
        if ($data.allowedAllMutationOperations -ne $true -and $keys -contains 'allowedMutationOperations') {
            $allowed = $data.allowedMutationOperations
            $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            if ($allowed -isnot [array]) { throw 'bcData.allowedMutationOperations must be a unique list of insert, modify, rename and delete.' }
            foreach ($operation in $allowed) {
                if ($operation -isnot [string] -or $operation -cnotin @('insert','modify','rename','delete') -or -not $seen.Add($operation)) {
                    throw 'bcData.allowedMutationOperations must be a unique list of insert, modify, rename and delete.'
                }
            }
        }
    }
}

function Get-BcDataEndpoint {
    param($Configuration)
    foreach ($key in @('baseUrl','tenant')) {
        if ($null -ne $Configuration.bcData.$key -and $Configuration.bcData.$key -isnot [string]) { throw "bcData.$key must be a string." }
    }
    $baseUrl = [string]$Configuration.bcData.baseUrl
    if ([string]::IsNullOrWhiteSpace($baseUrl)) { $baseUrl = "http://$($Configuration.container):7048/BC/ODataV4" }
    $uri = $null
    if (-not [Uri]::TryCreate($baseUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https') -or
        $uri.UserInfo -ne '' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or -not $uri.AbsolutePath.EndsWith('/ODataV4')) {
        throw 'bcData.baseUrl must be an HTTP(S) ODataV4 URL without credentials, query or fragment.'
    }
    $tenant = [string]$Configuration.bcData.tenant
    if ([string]::IsNullOrWhiteSpace($tenant)) { $tenant = 'default' }
    return [pscustomobject]@{ BaseUrl = $baseUrl; Tenant = $tenant }
}

function Get-BcDataInitializationReadiness {
    param($Configuration, [pscredential] $Credential, $Expected)
    $endpoint = Get-BcDataEndpoint -Configuration $Configuration
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $client.MaxResponseContentBufferSize = 65536
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,
        "$($endpoint.BaseUrl)/BCDData_Readiness?tenant=$([Uri]::EscapeDataString($endpoint.Tenant))")
    $request.Version = [Version]'1.0'
    $request.VersionPolicy = [Net.Http.HttpVersionPolicy]::RequestVersionExact
    $password = $Credential.GetNetworkCredential().Password
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Credential.UserName + ':' + $password))
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Basic', $basic)
    $request.Headers.ConnectionClose = $true
    $request.Headers.TryAddWithoutValidation('Accept-Encoding','identity') | Out-Null
    $request.Content = [Net.Http.StringContent]::new('{"inputJson":"{}"}', [Text.Encoding]::UTF8, 'application/json')
    $response = $null
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) { throw 'BC Data readiness was rejected. Check companion service registration, credentials and permissions.' }
        $envelope = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json -ErrorAction Stop
        $readiness = $envelope.value | ConvertFrom-Json -ErrorAction Stop
        if (($readiness.contractVersion -isnot [int] -and $readiness.contractVersion -isnot [long]) -or
            $readiness.contractVersion -ne $Expected.contractVersion -or $readiness.mutationsEnabled -isnot [bool] -or
            ($Expected.mutationsEnabled -eq $true -and ($readiness.mutationsEnabled -ne $true -or $readiness.mutationProtocolVersion -ne 1 -or
                ($readiness.mutationProtocolVersion -isnot [int] -and $readiness.mutationProtocolVersion -isnot [long]) -or 'mutation-scopes-v1' -notin $readiness.capabilities)) -or
            @('companies','table-search','schema','read-primary-key' | Where-Object { $_ -notin $readiness.capabilities }).Count -gt 0 -or
            [string]$readiness.appVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or [version]$readiness.appVersion -lt [version]$Expected.version) {
            throw 'BC Data companion contract/capabilities are incompatible.'
        }
        return $readiness
    } catch {
        # Never surface raw HTTP/BC exception text or credentials into a transcript.
        throw 'BC Data readiness verification failed. Check service BCDData, compatible contract 1, endpoint, credentials and execute/table permissions. No automatic retry was attempted.'
    } finally {
        $password = $null; $basic = $null
        if ($response) { $response.Dispose() }
        $request.Dispose(); $client.Dispose()
    }
}

function Initialize-BcDataCompanion {
    param([string] $ToolsetRoot, $Configuration)
    Assert-BcDataConfiguration -Configuration $Configuration
    $endpoint = Get-BcDataEndpoint -Configuration $Configuration
    $bundle = Get-ValidatedBcDataPackage -ToolsetRoot $ToolsetRoot
    $credential = Get-BcConfigurationCredential -configuration $Configuration
    $apps = @(Get-BcContainerAppInfo -containerName $Configuration.container -tenant $endpoint.Tenant -tenantSpecificProperties -ErrorAction Stop)
    $base = @($apps | Where-Object { $_.Name -eq 'Base Application' -and $_.Publisher -eq 'Microsoft' -and $_.IsInstalled })
    if ($base.Count -ne 1 -or [version]$base[0].Version -lt [version]$bundle.Manifest.application) { throw 'BC Data requires Business Central application 23 or newer.' }
    $installed = @($apps | Where-Object { [string]$_.AppId -eq $bundle.Manifest.appId -and $_.IsInstalled } | Sort-Object { [version]$_.Version } -Descending)
    $action = 'unchanged'
    if ($installed.Count -eq 0 -or [version]$installed[0].Version -lt [version]$bundle.Manifest.version) {
        $action = if ($installed.Count -eq 0) { 'installed' } else { 'upgraded' }
        # Reuse ordinary tenant app deployment; no Dev endpoint replacement,
        # force sync, uninstall, schema cleanup, container creation or downgrade.
        $parameters = @{ containerName = $Configuration.container; tenant = $endpoint.Tenant; appFile = $bundle.Path;
            scope = 'Tenant'; skipVerification = $true; sync = $true; install = $true; upgrade = ($installed.Count -gt 0); ErrorAction = 'Stop' }
        $null = Publish-BcContainerApp @parameters
    }
    $readiness = Get-BcDataInitializationReadiness -Configuration $Configuration -Credential $credential -Expected $bundle.Manifest
    Write-Host "BC Data $action on '$($Configuration.name)': contract $($readiness.contractVersion), app $($readiness.appVersion). MCP tool exposure is configured separately; no tool switches were changed."
    return [pscustomobject]@{ ConnectionId = [string]$Configuration.name; Action = $action; AppVersion = [string]$readiness.appVersion; ContractVersion = $readiness.contractVersion }
}

function Sync-ConfiguredBcData {
    param([string] $ToolsetRoot, $Configuration)
    # Disabled is a true no-op: no package, credentials, metadata or HTTP reads.
    if ($null -eq $Configuration.bcData) { return }
    $data = $Configuration.bcData
    if ($null -ne $data.provisioningEnabled -and $data.provisioningEnabled -isnot [bool]) { throw 'bcData.provisioningEnabled must be a boolean.' }
    if ($data.provisioningEnabled -ne $true) { return }
    Initialize-BcDataCompanion -ToolsetRoot $ToolsetRoot -Configuration $Configuration | Out-Null
}
