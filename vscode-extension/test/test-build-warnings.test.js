const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('test warning policy defaults off, honors local false, and gates compiler diagnostics', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    . ./common/TestMgt.ps1
    $empty = [pscustomobject]@{}
    $enabled = [pscustomobject]@{ settings = [pscustomobject]@{ bcDevToolset = [pscustomobject]@{ testBuildWarningsAsErrors = $true } } }
    if (Get-TestBuildWarningsAsErrors $empty $empty) { throw 'Default must be false' }
    if (-not (Get-TestBuildWarningsAsErrors $empty $enabled)) { throw 'Workspace true ignored' }
    if (Get-TestBuildWarningsAsErrors ([pscustomobject]@{ testBuildWarningsAsErrors = $false }) $enabled) { throw 'Local false ignored' }
    if (-not (Get-TestBuildWarningsAsErrors ([pscustomobject]@{ testBuildWarningsAsErrors = $true }) $empty)) { throw 'Local true ignored' }
    try {
      Get-TestBuildWarningsAsErrors ([pscustomobject]@{ testBuildWarningsAsErrors = 'false' }) $empty
      throw 'Invalid value accepted'
    } catch {
      if ($_.Exception.Message -notmatch 'must be a JSON boolean') { throw }
    }
    # Load only the warning gate from the real build script, without running a compiler.
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'operations/BuildAllApps.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw $errors[0] }
    $gate = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-NoBlockingBuildWarnings' }, $true)
    . ([scriptblock]::Create($gate.Extent.Text))
    $warning = 'src/app.al(5,2): warning AL0603: Implicit conversion'
    Assert-NoBlockingBuildWarnings -CompilerOutput @($warning)
    Assert-NoBlockingBuildWarnings -CompilerOutput @('0 warnings', 'info AL0603: Informational') -WarningsAsErrors
    Assert-NoBlockingBuildWarnings -CompilerOutput @() -WarningsAsErrors
    foreach ($diagnostic in @($warning, 'warning AA0001: Analyzer warning')) {
      try {
        Assert-NoBlockingBuildWarnings -CompilerOutput @($diagnostic) -WarningsAsErrors
        throw 'Warning did not block'
      } catch {
        if ($_.Exception.Message -notmatch 'Resolve the reported warnings, then rerun') { throw }
      }
    }
    exit 0
  `], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
