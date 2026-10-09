$previousSuite = $env:BCDEVTOOLSET_TEST_SUITE
try {
    $env:BCDEVTOOLSET_TEST_SUITE = 'Compatibility'
    . (Join-Path $PSScriptRoot 'Invoke-PageScriptTests.ps1')
} finally {
    $env:BCDEVTOOLSET_TEST_SUITE = $previousSuite
}
