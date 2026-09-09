 'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { __test: mcp } = require('../mcp-server');
const root = path.resolve(__dirname, '../..');
test('service backup MCP preflight collects both configuration names before execution', async () => {
  const name = 'bc_dev_toolset_backup_bc_service_databases';
  const tool = mcp.getTools().find(tool => tool.name === name);
  assert.equal(tool.inputSchema.properties.sourceConfiguration.type, 'string');
  assert.equal(tool.inputSchema.properties.destinationConfiguration.type, 'string');
  const result = await mcp.callTool({ name, arguments: { execute: true, sourceConfiguration: 'Source' } });
  const preflight = JSON.parse(result.content[0].text);
  assert.equal(preflight.status, 'input_required');
  assert.deepEqual(preflight.missingInputs, ['destinationConfiguration']);
  assert.deepEqual(mcp.getOperationPromptAnswers({ id: 'backupBcServiceDatabases' }, {
    sourceConfiguration: 'Source', destinationConfiguration: 'Local',
    promptAnswers: { 'serviceBackup.destination': 'Test' }
  }), { 'serviceBackup.source': 'Source', 'serviceBackup.destination': 'Local' });
});
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function run(script) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('agent and non-interactive backups abort without prompting, repairing or retrying', () => {
  for (const environment of ["$env:BCDEVTOOLSET_MCP_SESSION_ID = 'agent'", "$env:BCDEVTOOLSET_NON_INTERACTIVE = 'true'"]) {
    const result = run(`
      . ${quote(path.join(root, 'common/BackupMgt.ps1'))}
      $env:BCDEVTOOLSET_MCP_SESSION_ID = ''; $env:BCDEVTOOLSET_NON_INTERACTIVE = ''
      ${environment}
      $script:calls = 0; $script:prompts = 0
      function New-PSSession { $script:calls++; throw 'TrustedHosts required' }
      function Read-Host { $script:prompts++; throw 'Unexpected prompt' }
      function Get-Credential { $script:prompts++; throw 'Unexpected credentials' }
      function Invoke-BackupRemotingRepair { throw 'Unexpected repair' }
      try { New-RemoteBackupSession -computerName taopaipai -configuration ([pscustomobject]@{}) }
      catch { @{ Error=$_.Exception.Message; Calls=$script:calls; Prompts=$script:prompts } | ConvertTo-Json -Compress }
    `);
    assert.equal(result.Calls, 1);
    assert.equal(result.Prompts, 0);
    assert.match(result.Error, /bc_dev_toolset_configure_win_rm/);
    assert.match(result.Error, /trust\/authentication failed/);
  }
});
test('agent configuration executes supplied inputs without prompts or UAC', () => {
  for (const elevated of [false, true]) {
    const result = run(`
      . ${quote(path.join(root, 'common/RemotingMgt.ps1'))}
      $env:BCDEVTOOLSET_MCP_SESSION_ID = 'agent'
      function Test-RemotingAdministrator { $${elevated} }
      $script:started = 0
      function Start-Process {
        param($FilePath, $Verb, $WindowStyle, $Wait, $PassThru, $ErrorAction, $ArgumentList)
        if ($Verb) { throw 'Unexpected UAC' }
        $script:started++
        $code = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ArgumentList[-1]))
        $tokens=$null; $errors=$null
        $null = [Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
        if ($errors.Count -or $code -notmatch '-Concatenate -Force') { throw 'Invalid repair script' }
        @{ ExitCode=0 }
      }
      try { Invoke-WinRmConfiguration -computerName taopaipai -addTrustedHost $true 6>$null; @{ Started=$script:started; Error='' } | ConvertTo-Json -Compress }
      catch { @{ Started=$script:started; Error=$_.Exception.Message } | ConvertTo-Json -Compress }
    `);
    assert.equal(result.Started, elevated ? 1 : 0);
    if (elevated) assert.equal(result.Error, '');
    else assert.match(result.Error, /administrator rights/);
  }
});
test('WinRM operation exposes all decisions before starting and rejects invalid execution', async () => {
  const tool = mcp.getTools().find(tool => tool.name === 'bc_dev_toolset_configure_win_rm');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.addTrustedHost.type, 'boolean');
  const preflight = await mcp.callTool({ name: tool.name, arguments: {} });
  const content = JSON.parse(preflight.content[0].text);
  assert.equal(content.status, 'input_required');
  assert.deepEqual(content.missingInputs, ['computerName', 'addTrustedHost']);
  const invalid = await mcp.callTool({ name: tool.name, arguments: { computerName: '*', addTrustedHost: true, confirm: true, execute: true } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /No operation was started/);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'operations/operations.json'))).find(op => op.id === 'configureWinRm');
  assert.equal(metadata.requiresConfirmation, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'vscode-extension/package.json')));
  assert.ok(pkg.contributes.commands.some(command => command.command === 'bcDevToolset.operation.configureWinRm'));
});
