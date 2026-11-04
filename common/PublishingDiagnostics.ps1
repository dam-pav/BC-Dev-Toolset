# Shared by ordinary SaaS publishing and BC Data initialization. Keep diagnostics
# actionable without copying backend exception bodies, tokens or credentials.
function Invoke-BcPublishingStep {
    param($Configuration,
        [ValidateSet('Authentication','Inspection','Publishing','Readiness')][string] $Stage,
        [string] $Operation = 'App publishing',
        [ValidateSet('NotStarted','Unknown','Returned')][string] $DeploymentState = 'NotStarted',
        [Parameter(Mandatory)][scriptblock] $Action)

    $ErrorActionPreference = 'Stop'
    try { & $Action }
    catch {
        $status = 0
        $cause = $_.Exception
        for ($depth = 0; $null -ne $cause -and $depth -lt 8; $depth++) {
            foreach ($candidate in @($cause.Response.StatusCode, $cause.StatusCode)) {
                $code = 0
                if ([int]::TryParse([string]$candidate, [ref]$code) -and $code -ge 400 -and $code -le 599) { $status = $code }
                elseif ($null -ne $candidate.value__ -and [int]$candidate.value__ -ge 400 -and [int]$candidate.value__ -le 599) { $status = [int]$candidate.value__ }
            }
            $cause = $cause.InnerException
        }
        $guidance = switch ($status) {
            401 { 'Sign in again to the configured tenant and check the account or application credentials.' }
            403 { 'Check account consent and Business Central permissions for the selected environment, company and extension management.' }
            404 { 'Check the configured tenant and environment name, environment availability and API endpoint.' }
            409 { 'Check for an existing extension deployment or conflicting installed app/version before retrying.' }
            429 { 'The service is throttling requests. Wait for its retry window, inspect deployment status, then retry explicitly.' }
            default {
                if ($status -ge 500) { 'Check Business Central service health and environment availability, then inspect deployment status before retrying.' }
                elseif ($Stage -eq 'Authentication') { 'Complete sign-in for the configured tenant; check account access, consent and network connectivity.' }
                else { 'Check endpoint connectivity, authentication, permissions, app compatibility, dependencies and object-ID conflicts.' }
            }
        }
        $target = switch ($Configuration.serverType) {
            'Cloud' { 'Cloud/SaaS' }
            'OnPrem' { 'OnPrem' }
            default { 'Container' }
        }
        $targetGuidance = switch ($Configuration.serverType) {
            'Cloud' { 'For SaaS publishing errors, inspect Extension Deployment Status Details in Business Central; authentication/inspection also require automation API access and an accessible company.' }
            'OnPrem' { 'Check the shared publishing/WinRM prerequisites, service-host administration tools, selected server instance and tenant.' }
            default { 'Check container availability, the selected tenant and container app-deployment diagnostics.' }
        }
        $stateGuidance = switch ($DeploymentState) {
            'Unknown' { 'Deployment may have been submitted or partially completed. Inspect the installed app version and deployment status before retrying.' }
            'Returned' { 'Deployment returned, but readiness was not verified. Inspect the installed app version before attempting another deployment.' }
            default { 'No app was submitted by this step.' }
        }
        if ($Stage -eq 'Readiness') { $guidance = 'Check for an incompatible companion contract, service BCDData registration, the OData endpoint, credentials and execute/table permissions.' }
        $http = if ($status) { " HTTP $status." } else { '' }
        $failure = [InvalidOperationException]::new("$Operation failed during $Stage ($target).$http $guidance $targetGuidance $stateGuidance No automatic retry or alternate deployment was attempted.")
        $failure.Data['Stage'] = $Stage
        $failure.Data['HttpStatus'] = $status
        $failure.Data['DeploymentState'] = $DeploymentState
        throw $failure
    }
}
