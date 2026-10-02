function Invoke-ConfiguredContainerDocker {
    param([string[]] $DockerArguments)

    $output = & docker @DockerArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed: $($output -join ' ')"
    }
    return ($output -join "`n")
}

function Get-ConfiguredContainerState {
    param([string] $ContainerName)

    $json = Invoke-ConfiguredContainerDocker -DockerArguments @('container', 'inspect', '--format', '{"Name":{{json .Name}},"State":{{json .State}}}', '--', $ContainerName)
    $container = $json | ConvertFrom-Json -ErrorAction Stop
    if ($container.Name -cne "/$ContainerName") {
        throw "Docker did not resolve the exact configured container name '$ContainerName'."
    }
    return $container.State
}

function Ensure-ConfiguredContainers {
    param(
        $SettingsJSON,
        [ValidateRange(0, 600)] [int] $TimeoutSeconds = 120,
        [switch] $SkipMissing
    )

    # Validate every target before issuing Docker commands. Reject option-like values.
    $names = @($SettingsJSON.configurations | Where-Object { $_.serverType -eq 'Container' } |
        ForEach-Object {
            $name = ([string]$_.container).Trim()
            if ($name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') {
                throw "Container configuration '$($_.name)' requires a valid, non-empty container name."
            }
            $name
        } | Select-Object -Unique)
    if ($names.Count -eq 0) {
        Write-Host 'No Container configurations found. Nothing to start.'
        return
    }

    $dockerOS = Invoke-ConfiguredContainerDocker -DockerArguments @('info', '--format', '{{.OSType}}')
    if ($dockerOS.Trim() -ne 'windows') {
        throw 'Docker must be running and switched to Windows containers before checking configured BC containers.'
    }

    $failed = @()
    foreach ($name in $names) {
        $action = 'None'
        try {
            try {
                $state = Get-ConfiguredContainerState -ContainerName $name
            } catch {
                if ($SkipMissing -and $_.Exception.Message -match '(?i)No such (container|object)') {
                    Write-Host "Container '$name': missing; skipped."
                    continue
                }
                throw
            }
            $before = "$($state.Status)/$($state.Health.Status)"
            if ($state.Status -in @('created', 'exited')) {
                $action = 'Start'
                $null = Invoke-ConfiguredContainerDocker -DockerArguments @('container', 'start', '--', $name)
            } elseif ($state.Status -eq 'running' -and $state.Health.Status -eq 'unhealthy') {
                $action = 'Restart'
                $null = Invoke-ConfiguredContainerDocker -DockerArguments @('container', 'restart', '--', $name)
            } elseif ($state.Status -notin @('running', 'restarting')) {
                throw "Container state '$($state.Status)' requires manual recovery."
            }

            $timer = [System.Diagnostics.Stopwatch]::StartNew()
            do {
                $state = Get-ConfiguredContainerState -ContainerName $name
                $health = [string]$state.Health.Status
                if ($state.Status -eq 'running' -and ($health -eq '' -or $health -eq 'healthy')) {
                    Write-Host "Container '$name': before=$before; action=$action; after=$($state.Status)/$health; ready."
                    break
                }
                if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                    throw "Readiness timed out after $TimeoutSeconds seconds; state=$($state.Status)/$health."
                }
                Start-Sleep -Seconds 2
            } while ($true)
        } catch {
            $failed += $name
            Write-Host "Container '$name': action=$action; failed: $($_.Exception.Message)"
        }
    }
    if ($failed.Count -gt 0) {
        throw "Configured containers not ready: $($failed -join ', '). Missing containers must be created separately; this operation never creates or replaces containers."
    }
}
