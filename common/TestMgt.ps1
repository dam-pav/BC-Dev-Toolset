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
