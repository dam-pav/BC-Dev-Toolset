param([int]$Port, [string]$FixtureRoot, [switch]$StoredCredential)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../common/WorkspaceMgt.ps1')
. (Join-Path $PSScriptRoot '../../common/PublishApps.ps1')
$configuration = [pscustomobject]@{
    name='loopback'; server='http://127.0.0.1'; port=$Port; serverInstance='BC230'; authentication='Windows'
}
if ($StoredCredential) {
    $configuration | Add-Member remoteCredential $true
    function Get-ConfigurationCredential {
        param($configuration,$kind)
        if ($kind -ne 'remote') { throw 'Unexpected credential kind' }
        # The loopback fixture does not challenge for credentials or contact an external server.
        [pscredential]::new('fixture',(ConvertTo-SecureString 'fixture' -AsPlainText -Force))
    }
}
Publish-OnPremDevelopmentApps -Configuration $configuration -Packages @(
    @{Root=$FixtureRoot;Path=(Join-Path $FixtureRoot 'fixture.app')}
)
