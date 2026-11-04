. (Join-Path $PSScriptRoot 'BcDataPackage.ps1')
. (Join-Path $PSScriptRoot 'PublishingDiagnostics.ps1')

function Select-BcDataInitializationConfiguration {
    param($SettingsJSON)

    $configurations = @($SettingsJSON.configurations | Where-Object {
        $_.serverType -in @('Container','Cloud','OnPrem') -and $_.targetType -in @('Dev','Test','Production') -and
        -not [string]::IsNullOrWhiteSpace($_.name) -and
        (($_.serverType -eq 'Container' -and -not [string]::IsNullOrWhiteSpace($_.container)) -or
         ($_.serverType -eq 'Cloud' -and -not [string]::IsNullOrWhiteSpace($_.environmentName)) -or
         ($_.serverType -eq 'OnPrem' -and -not [string]::IsNullOrWhiteSpace($_.serverInstance)))
    })
    if ($configurations.Count -eq 0) {
        throw 'No named Container, Cloud or OnPrem configurations found. No target was changed.'
    }
    foreach ($configuration in $configurations) {
        if (@($SettingsJSON.configurations | Where-Object name -eq $configuration.name).Count -ne 1) {
            throw 'Choose an exact unique configuration name. No target was changed.'
        }
    }

    $connectionId = Request-BcDevToolsetMcpPrompt -PromptId 'bcData.connectionId' -Type 'choice' `
        -Question 'Select the configuration to initialize' -Choices @($configurations.name)
    if ($null -eq $connectionId) {
        $index = Select-IndexFromList -Title 'Select the configuration to initialize BC Data on:' `
            -Options @($configurations | ForEach-Object { "$($_.name) ($($_.serverType), $($_.targetType))" })
        if ($null -eq $index -or $index -lt 0 -or $index -ge $configurations.Count) { throw 'Configuration selection cancelled.' }
        return $configurations[$index]
    }
    $selectedConfigurations = @($configurations | Where-Object { $_.name -ceq $connectionId })
    if ($selectedConfigurations.Count -ne 1) {
        throw 'Choose an exact unique configuration name from the available options. No target was changed.'
    }
    return $selectedConfigurations[0]
}

function Assert-BcDataConfiguration {
    param($Configuration)
    if ($Configuration.serverType -notin @('Container','Cloud','OnPrem') -or $Configuration.targetType -notin @('Dev','Test','Production') -or
        ($Configuration.serverType -eq 'Container' -and [string]$Configuration.container -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$') -or
        ($Configuration.serverType -eq 'Cloud' -and ([string]$Configuration.tenant -notmatch '^[a-zA-Z0-9.-]+$' -or [string]::IsNullOrWhiteSpace($Configuration.environmentName))) -or
        ($Configuration.serverType -eq 'OnPrem' -and [string]::IsNullOrWhiteSpace($Configuration.serverInstance)) -or
        ($Configuration.serverType -ne 'Cloud' -and $Configuration.authentication -notin @('UserPassword','Windows'))) {
        throw 'BC Data requires a configured Container, Cloud or OnPrem target with supported authentication.'
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
    if ($Configuration.serverType -eq 'Cloud') {
        $expectedUrl = "https://api.businesscentral.dynamics.com/v2.0/$([Uri]::EscapeDataString($Configuration.tenant))/$([Uri]::EscapeDataString($Configuration.environmentName))/ODataV4"
        if ($baseUrl -and $baseUrl -cne $expectedUrl) { throw 'Cloud baseUrl must match the configured tenant and environment.' }
        $baseUrl = $expectedUrl
    } elseif ([string]::IsNullOrWhiteSpace($baseUrl) -and $Configuration.serverType -eq 'Container') {
        $baseUrl = "http://$($Configuration.container):7048/BC/ODataV4"
    }
    $uri = $null
    if (-not [Uri]::TryCreate($baseUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https') -or
        $uri.UserInfo -ne '' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or -not $uri.AbsolutePath.EndsWith('/ODataV4')) {
        throw 'bcData.baseUrl must be an HTTP(S) ODataV4 URL without credentials, query or fragment.'
    }
    if ($Configuration.serverType -eq 'OnPrem') {
        $server = $null
        $serverAddress = [string]$Configuration.server
        if ($serverAddress -notmatch '^https?://') { $serverAddress = 'http://' + $serverAddress }
        if (-not [Uri]::TryCreate($serverAddress, [UriKind]::Absolute, [ref]$server) -or $server.Scheme -notin @('http','https') -or
            $uri.Host -ine $server.Host -or ($Configuration.authentication -eq 'UserPassword' -and $uri.Scheme -ne 'https')) {
            throw 'OnPrem bcData.baseUrl must use the configured server hostname and HTTPS for UserPassword.'
        }
    }
    if ($Configuration.bcCredential -eq $true -and $Configuration.serverType -eq 'Container' -and $uri.Host -ine $Configuration.container) {
        throw 'Stored BC credentials require an endpoint on the configured container hostname.'
    }
    $tenant = [string]$Configuration.bcData.tenant
    if (-not $tenant -and $Configuration.serverType -eq 'OnPrem') { $tenant = [string]$Configuration.tenant }
    if ([string]::IsNullOrWhiteSpace($tenant)) { $tenant = 'default' }
    return [pscustomobject]@{ BaseUrl = $baseUrl; Tenant = $tenant }
}

function Get-BcDataInitializationReadiness {
    param($Configuration, [pscredential] $Credential, $Expected, [string] $AccessToken)
    $endpoint = Get-BcDataEndpoint -Configuration $Configuration
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    if ($Configuration.authentication -eq 'Windows') {
        if ($Credential) { $handler.Credentials = $Credential.GetNetworkCredential() } else { $handler.UseDefaultCredentials = $true }
    }
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $client.MaxResponseContentBufferSize = 65536
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,
        "$($endpoint.BaseUrl)/BCDData_Readiness?tenant=$([Uri]::EscapeDataString($endpoint.Tenant))")
    $request.Version = [Version]'1.0'
    $request.VersionPolicy = [Net.Http.HttpVersionPolicy]::RequestVersionExact
    if ($AccessToken) {
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $AccessToken)
    } elseif ($Configuration.authentication -eq 'Windows') {
        $request.Version = [Version]'1.1'
    } else {
        $password = $Credential.GetNetworkCredential().Password
        $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Credential.UserName + ':' + $password))
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Basic', $basic)
    }
    $request.Headers.ConnectionClose = $Configuration.authentication -ne 'Windows'
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
    param([string] $ToolsetRoot, $Configuration, $SettingsJSON)
    Assert-BcDataConfiguration -Configuration $Configuration
    $endpoint = Get-BcDataEndpoint -Configuration $Configuration
    $bundle = Get-ValidatedBcDataPackage -ToolsetRoot $ToolsetRoot
    $credential = $null
    $authContext = $null
    if ($Configuration.serverType -eq 'Cloud') {
        $authContext = Invoke-BcPublishingStep -Configuration $Configuration -Stage Authentication -Operation 'BC Data initialization' -Action {
            $context = New-BcAuthContext -includeDeviceLogin -tenantID $Configuration.tenant -ErrorAction Stop
            if (-not $context.AccessToken) { throw 'Authentication did not return an access token.' }
            $context
        }
        $apps = @(Invoke-BcPublishingStep -Configuration $Configuration -Stage Inspection -Operation 'BC Data initialization' -Action {
            Get-BcDataCloudApps -Configuration $Configuration -AuthContext $authContext
        })
    } elseif ($Configuration.serverType -eq 'OnPrem') {
        . (Join-Path $PSScriptRoot 'PublishApps.ps1')
        $apps = @(Invoke-BcPublishingStep -Configuration $Configuration -Stage Inspection -Operation 'BC Data initialization' -Action {
            Get-BcDataOnPremApps -Configuration $Configuration -SettingsJSON $SettingsJSON
        })
    } else {
        $apps = @(Invoke-BcPublishingStep -Configuration $Configuration -Stage Inspection -Operation 'BC Data initialization' -Action {
            Get-BcContainerAppInfo -containerName $Configuration.container -tenant $endpoint.Tenant -tenantSpecificProperties -ErrorAction Stop
        })
    }
    if ($Configuration.serverType -ne 'Cloud' -and ($Configuration.authentication -ne 'Windows' -or $Configuration.bcCredential -eq $true -or $Configuration.bcUser)) {
        $credential = Get-BcConfigurationCredential -configuration $Configuration
    }
    $base = @($apps | Where-Object { $_.Name -eq 'Base Application' -and $_.Publisher -eq 'Microsoft' -and $_.IsInstalled })
    if ($base.Count -ne 1 -or [version]$base[0].Version -lt [version]$bundle.Manifest.application) { throw 'BC Data requires Business Central application 23 or newer.' }
    $installed = @($apps | Where-Object { [string]$_.AppId -eq $bundle.Manifest.appId -and $_.IsInstalled } | Sort-Object { [version]$_.Version } -Descending)
    $action = 'unchanged'
    if ($installed.Count -eq 0 -or [version]$installed[0].Version -lt [version]$bundle.Manifest.version) {
        $action = if ($installed.Count -eq 0) { 'installed' } else { 'upgraded' }
        # Reuse ordinary tenant app deployment; no Dev endpoint replacement,
        # force sync, uninstall, schema cleanup, container creation or downgrade.
        Invoke-BcPublishingStep -Configuration $Configuration -Stage Publishing -Operation 'BC Data initialization' -DeploymentState Unknown -Action {
            switch ($Configuration.serverType) {
                'Cloud' {
                    Publish-PerTenantExtensionApps -bcAuthContext $authContext -environment $Configuration.environmentName -appFiles @($bundle.Path) -schemaSyncMode Add -ErrorAction Stop
                }
                'OnPrem' {
                    Publish-BcDataOnPremCompanion -Configuration $Configuration -SettingsJSON $SettingsJSON -Bundle $bundle -Upgrade ($installed.Count -gt 0)
                }
                'Container' {
                    $parameters = @{ containerName = $Configuration.container; tenant = $endpoint.Tenant; appFile = $bundle.Path;
                        scope = 'Tenant'; skipVerification = $true; sync = $true; install = $true; upgrade = ($installed.Count -gt 0); ErrorAction = 'Stop' }
                    $null = Publish-BcContainerApp @parameters
                }
            }
        } | Out-Null
    }
    $readinessParameters = @{ Configuration=$Configuration; Credential=$credential; Expected=$bundle.Manifest }
    if ($authContext) { $readinessParameters.AccessToken = $authContext.AccessToken }
    $deploymentState = if ($action -eq 'unchanged') { 'NotStarted' } else { 'Returned' }
    $readiness = Invoke-BcPublishingStep -Configuration $Configuration -Stage Readiness -Operation 'BC Data initialization' -DeploymentState $deploymentState -Action {
        Get-BcDataInitializationReadiness @readinessParameters
    }
    Write-Host "BC Data $action on '$($Configuration.name)': contract $($readiness.contractVersion), app $($readiness.appVersion). MCP tool exposure is configured separately; no tool switches were changed."
    return [pscustomobject]@{ ConnectionId = [string]$Configuration.name; Action = $action; AppVersion = [string]$readiness.appVersion; ContractVersion = $readiness.contractVersion }
}

function Get-BcDataCloudApps {
    param($Configuration, $AuthContext)
    # The automation API also works in production; the developer API is sandbox-only.
    $root = "https://api.businesscentral.dynamics.com/v2.0/$([Uri]::EscapeDataString($Configuration.tenant))/$([Uri]::EscapeDataString($Configuration.environmentName))/api/microsoft/automation/v2.0"
    $headers = @{ Authorization = "Bearer $($AuthContext.AccessToken)" }
    $companies = Invoke-RestMethod -Uri "$root/companies" -Headers $headers -MaximumRedirection 0 -ErrorAction Stop
    $company = @($companies.value) | Select-Object -First 1
    if (-not $company -or [string]$company.id -notmatch '^[0-9a-f-]{36}$') { throw 'BC Data deployment requires an accessible company and automation API permissions.' }
    $response = Invoke-RestMethod -Uri "$root/companies($($company.id))/extensions" -Headers $headers -MaximumRedirection 0 -ErrorAction Stop
    if ($response.'@odata.nextLink') { throw 'Incomplete installed-extension metadata; no companion was deployed.' }
    foreach ($app in $response.value) {
        [pscustomobject]@{ Name=$app.displayName; Publisher=$app.publisher; AppId=$app.id; IsInstalled=$app.isInstalled;
            Version="$($app.versionMajor).$($app.versionMinor).$($app.versionBuild).$($app.versionRevision)" }
    }
}

function Get-BcDataOnPremApps {
    param($Configuration, $SettingsJSON)
    $endpoint = Get-BcDataEndpoint -Configuration $Configuration
    $hostName = if ($Configuration.managementServer) { $Configuration.managementServer } else { Get-RemoteComputerNameFromServer -server $Configuration.server }
    if (Test-IsLocalSqlServer -databaseServer $hostName) {
        Initialize-OnPremPublishingManagement -SettingsJSON $SettingsJSON -Configuration $Configuration
        return Get-NAVAppInfo -ServerInstance $Configuration.serverInstance -Tenant $endpoint.Tenant -TenantSpecificProperties -ErrorAction Stop
    }
    if ([string]$hostName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$') { throw 'BC Data requires a valid OnPrem management hostname.' }
    $session = New-RemoteBackupSession -computerName $hostName -configuration $Configuration -OperationName 'BC Data initialization'
    try {
        Initialize-RemoteOnPremManagement -Session $session -ServerInstance $Configuration.serverInstance -RequiredCommands @('Get-NAVAppInfo')
        Invoke-Command -Session $session -ErrorAction Stop -ArgumentList $Configuration.serverInstance,$endpoint.Tenant -ScriptBlock {
            param($instance,$tenant)
            Get-NAVAppInfo -ServerInstance $instance -Tenant $tenant -TenantSpecificProperties -ErrorAction Stop
        }
    } finally { Remove-PSSession -Session $session }
}

function Publish-BcDataOnPremCompanion {
    param($Configuration, $SettingsJSON, $Bundle, [bool] $Upgrade)
    $endpoint = Get-BcDataEndpoint -Configuration $Configuration
    $hostName = if ($Configuration.managementServer) { $Configuration.managementServer } else { Get-RemoteComputerNameFromServer -server $Configuration.server }
    if (-not (Test-IsLocalSqlServer -databaseServer $hostName)) {
        # Reuse the confined remote staging, tenant install/upgrade and cleanup path.
        $selected = @{}
        if ($Configuration -is [System.Collections.IDictionary]) {
            foreach ($key in $Configuration.Keys) { $selected[$key] = $Configuration[$key] }
        } else {
            foreach ($property in $Configuration.PSObject.Properties) { $selected[$property.Name] = $property.Value }
        }
        $selected.tenant = $endpoint.Tenant
        Publish-RemoteOnPremDependencies -Configuration ([pscustomobject]$selected) -AppFiles @($Bundle.Path)
        return
    }
    Initialize-OnPremPublishingManagement -SettingsJSON $SettingsJSON -Configuration $Configuration
    $app = Get-NAVAppInfo -Path $Bundle.Path -ErrorAction Stop
    $identity = @{ ServerInstance=$Configuration.serverInstance; Tenant=$endpoint.Tenant; Name=$app.Name;
        Publisher=$app.Publisher; Version=$app.Version; ErrorAction='Stop' }
    $published = @(Get-NAVAppInfo -ServerInstance $Configuration.serverInstance -Tenant $endpoint.Tenant -TenantSpecificProperties -ErrorAction Stop |
        Where-Object { [string]$_.AppId -eq $Bundle.Manifest.appId -and [version]$_.Version -eq [version]$Bundle.Manifest.version })
    if ($published.Count -eq 0) {
        Publish-NAVApp -ServerInstance $Configuration.serverInstance -Tenant $endpoint.Tenant -Path $Bundle.Path -Scope Tenant -SkipVerification -ErrorAction Stop | Out-Null
    }
    Sync-NAVApp @identity -Mode Add | Out-Null
    if ($Upgrade) { Start-NAVAppDataUpgrade @identity | Out-Null } else { Install-NAVApp @identity | Out-Null }
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
