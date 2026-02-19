function Invoke-Tests {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType
    )

    foreach ($configuration in $($settingsJSON.configurations | Where-Object  { $_.targetType -eq $targetType })) {
        Write-Host "Running tests on '$($configuration.name)'." -ForegroundColor Blue
        switch ($configuration.serverType) {
            'Container' {
                $params = @{
                    containerName = $configuration.container
                    credential = (New-Object System.Management.Automation.PSCredential ($configuration.admin, (ConvertTo-SecureString -String $configuration.password -AsPlainText -Force)))
                    detailed = $true
                }
                # if $configuration.testSuite has a value, add it to the parameters
                if ($configuration.testSuite -and $configuration.testSuite -ne "") {
                    $params.testSuite = $configuration.testSuite
                }                    

                Write-Host ""
                Write-Host "Running " -ForegroundColor green -NoNewline
                Write-Host "Run-TestsInBcContainer" -ForegroundColor Blue -NoNewline
                Write-Host ":" -ForegroundColor green
                Run-TestsInBcContainer -ErrorAction SilentlyContinue @params
            }
            Default {
                Write-Host "Cannot run tests on serverType $serverType." -ForegroundColor Blue
            }
        }
    }
}

function Invoke-PageScriptTests {
    Param (
        [Parameter(Mandatory=$true)]
        [PSObject] $settingsJSON,
        [Parameter(Mandatory=$true)]
        [ValidateSet("Dev", "Test", "Production")]
        [string] $targetType
    )

    # Verify recordings path exists
    $recordingsPath = $settingsJSON.recordingsPath
    if (-not (Test-Path $recordingsPath)) {
        Write-Host "No recordings folder found at $recordingsPath." -ForegroundColor Red
        return
    }

    # Verify recordingPath contains .yml files
    $ymlFiles = Get-ChildItem -Path $recordingsPath -Filter *.yml -ErrorAction SilentlyContinue
    if (-not $ymlFiles -or $ymlFiles.Count -eq 0) {
        Write-Host "No .yml recording files found in $recordingsPath." -ForegroundColor Red
        return
    }

    # Verify pageScriptTestResultsPath exists
    $testResultsPath = $settingsJSON.pageScriptTestResultsPath
    if (-not (Test-Path $testResultsPath)) {
        Write-Host "No test results folder found at $testResultsPath." -ForegroundColor Red
        return
    }

    # Check if node/npm is available
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error "npm is not installed or not in PATH. Please install Node.js."
        return
    }

    # Check minimum version for node.js is 24
    $nodeVersionOutput = node --version
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to get node.js version. Ensure node.js is installed and working."
        return
    }
    $nodeVersion = [version]($nodeVersionOutput.Trim() -replace "^v", "")
    if ($nodeVersion.Major -lt 24) {
        Write-Error "node.js version 24 or higher is required. Current version: $nodeVersion"
        return
    }

    Write-Host "Installing/Updating @microsoft/bc-replay..." -ForegroundColor Blue
    # Install latest version
    npm install @microsoft/bc-replay@latest
    
    # Loop 'npm audit fix --force' until 0 vulnerabilities or max retries reached
    $maxRetries = 50
    $retry = 0
    do {
        $retry++
        Write-Host "Running npm audit fix --force (Attempt $retry/$maxRetries)..." -ForegroundColor Blue
        npm audit fix --force # | Out-Null
        
        # Capture audit result
        try {
            $auditJson = npm audit --json | Out-String | ConvertFrom-Json
            $vulnCount = $auditJson.metadata.vulnerabilities.total
        } catch {
             $vulnCount = -1
        }
        
        if ($vulnCount -eq 0) {
            Write-Host "All vulnerabilities resolved." -ForegroundColor Green
            break
        }
        Write-Host "Remaining vulnerabilities: $vulnCount" -ForegroundColor Yellow
    } until ($vulnCount -eq 0 -or $retry -ge $maxRetries)

    foreach ($configuration in $($settingsJSON.configurations | Where-Object  { $_.targetType -eq $targetType })) {
        Write-Host "Running page script tests on '$($configuration.name)'." -ForegroundColor Blue
        
        $baseUrl = $null
        $user = ""
        $password = ""

        switch ($configuration.serverType) {
            'Container' {
                if (Get-Command Get-BcContainerUrl -ErrorAction SilentlyContinue) {
                     try {
                        $baseUrl = Get-BcContainerUrl -containerName $configuration.container -ErrorAction Stop
                     } catch {
                        Write-Host "Get-BcContainerUrl failed: $_" -ForegroundColor Yellow
                     }
                }
                
                if (-not $baseUrl) {
                     # Fallback logic
                     $baseUrl = "http://$($configuration.container)/BC/" 
                }
                $user = $configuration.admin
                $password = $configuration.password
            }
            Default {
                # Try to construct from config if fields exist
                if ($configuration.server -and $configuration.serverInstance) {
                    # e.g. http://server:port/instance/
                    # This is a guess, might need refinement for SaaS/OnPrem
                    $portPart = ""
                    if ($configuration.port) { $portPart = ":$($configuration.port)" }
                    $baseUrl = "http://$($configuration.server)$($portPart)/$($configuration.serverInstance)/"
                }
            }
        }
        
        if (-not $baseUrl) {
            Write-Host "Could not determine Base URL for configuration $($configuration.name)" -ForegroundColor Red
            continue
        }

        # Ensure trailing slash and web client path
        if (-not $baseUrl.EndsWith("/BC") -and -not $baseUrl.EndsWith("/BC/")) {
             $baseUrl = $baseUrl.TrimEnd('/') + "/BC/"
        } elseif (-not $baseUrl.EndsWith("/")) {
             $baseUrl = $baseUrl + "/"
        }

        # For Container, ensure tenant parameter is present
        if ($configuration.serverType -eq 'Container' -and $baseUrl -notmatch "tenant=") {
             $baseUrl = $baseUrl + "?tenant=default"
        }

        $user = $configuration.admin
        $password = $configuration.password

        # Env vars for credentials
        $env:BC_USER = $user
        $env:BC_PASSWORD = $password

        Write-Host "Running tests against $baseUrl" -ForegroundColor Cyan
        
        # Use relative path for tests to match manual execution success and ensure globbing works
        $relativeRecPath = Resolve-Path $recordingsPath -Relative
        $testPattern = Join-Path $relativeRecPath "*.yml"

        $npxArgs = @(
            "replay",
            "-Tests", $testPattern,
            "-StartAddress", $baseUrl,
            "-Authentication", "UserPassword",
            "-UserNameKey", "BC_USER",
            "-PasswordKey", "BC_PASSWORD",
            "-ResultDir", $testResultsPath
        )

        if ($settingsJSON.pageScriptTestHeaded) {
            $npxArgs += "-Headed"
        }

        npx $npxArgs
    }
}
