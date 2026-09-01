const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = authorizeRoot(path.resolve(__dirname, '..', '..'), 'Repository root');
const installScriptPath = resolveWithinRoot(repositoryRoot, 'operations', 'initPrerequisites.ps1');
const uninstallScriptPath = resolveWithinRoot(repositoryRoot, 'operations', 'uninstallPrerequisites.ps1');
const operationsPath = resolveWithinRoot(repositoryRoot, 'operations', 'operations.json');
const packagePath = resolveWithinRoot(repositoryRoot, 'vscode-extension', 'package.json');
const extensionPath = resolveWithinRoot(repositoryRoot, 'vscode-extension', 'extension.js');

test('failed Windows container feature setup stops later prerequisite installation', () => {
  const source = fs.readFileSync(installScriptPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root
  const failureGate = source.indexOf('if (-not $windowsFeaturesReady)');
  const dockerPathStep = source.indexOf('# 3. ADD DOCKER TO PATH');
  const gitStep = source.indexOf('# 5. INSTALL GIT');
  const nodeStep = source.indexOf('# 6. INSTALL NODE.JS AND BC-REPLAY');
  const alRunnerStep = source.indexOf('# 7. INSTALL .NET SDK AND AL RUNNER');
  const helperStep = source.indexOf('# 8. INSTALL BCCONTAINERHELPER MODULE');

  assert.ok(failureGate > 0);
  assert.ok(failureGate < dockerPathStep);
  assert.ok(failureGate < gitStep);
  assert.ok(failureGate < nodeStep);
  assert.ok(failureGate < alRunnerStep);
  assert.ok(failureGate < helperStep);
  assert.match(source, /Open the Uninstall prerequisites flow now\? \[y\/N\]/);
  assert.match(source, /& \$uninstallScript -DockerPath \$DockerPath -NoPause/);
  assert.match(source, /if \(-not \$windowsFeaturesReady\)[\s\S]*?exit 1/);
});

test('uninstall prerequisites asks separately and defaults to keeping every component', () => {
  const source = fs.readFileSync(uninstallScriptPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root

  assert.match(source, /Uninstall \$\{Component\}\? \[y\/N\]/);
  assert.doesNotMatch(source, /Uninstall \$Component\? \[y\/N\]/);
  assert.match(source, /IsNullOrWhiteSpace\(\$answer\)[\s\S]*?return \$false/);
  for (const component of [
    'Docker Engine',
    '@microsoft/bc-replay',
    'MSDyn365BC.AL.Runner',
    'Node.js',
    'Git',
    'BcContainerHelper'
  ]) {
    assert.ok(source.includes(`Confirm-Uninstall -Component "${component}"`));
  }
  assert.match(source, /Confirm-Uninstall -Component "Windows feature '\$\(\$feature\.Name\)'"/);
  assert.match(source, /Docker Desktop is not removed/);
  assert.match(source, /The shared \.NET SDK is kept installed/);
  assert.match(source, /Refusing to remove a drive root as the Docker path/);
  assert.match(source, /Refusing to remove protected path/);
});

test('prerequisites install a compatible .NET SDK and install or update AL Runner', () => {
  const source = fs.readFileSync(installScriptPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root

  assert.match(source, /\.Major -in @\(9, 10\)/);
  assert.match(source, /Microsoft\.DotNet\.SDK\.10/);
  assert.match(source, /https:\/\/dot\.net\/v1\/dotnet-install\.ps1/);
  assert.match(source, /tool \$toolAction --global MSDyn365BC\.AL\.Runner/);
  assert.match(source, /\[switch\]\$SkipAlRunner/);
  assert.match(source, /Test-AlRunnerLaunch/);
  assert.match(source, /Microsoft-Windows-CodeIntegrity\/Operational/);
  assert.match(source, /BC Dev Toolset will not disable or bypass application-control policy/);
});

test('prerequisite upgrade prompts delimit the latest version before the question mark', () => {
  const source = fs.readFileSync(installScriptPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root

  assert.match(source, /to \$\{LatestVersion\}\? \[y\/N\]/);
  assert.doesNotMatch(source, /to \$LatestVersion\? \[y\/N\]/);
});

test('uninstall prerequisites is exposed consistently in metadata and VS Code commands', () => {
  const operations = JSON.parse(fs.readFileSync(operationsPath, 'utf8')); // nosemgrep -- path is resolved within the authorized repository root
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')); // nosemgrep -- path is resolved within the authorized repository root
  const extensionSource = fs.readFileSync(extensionPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root
  const operation = operations.find((candidate) => candidate.id === 'uninstallPrerequisites');

  assert.ok(operation);
  assert.equal(operation.script, 'operations/uninstallPrerequisites.bat');
  assert.equal(operation.category, 'Prerequisites');
  assert.equal(operation.requiresConfirmation, true);
  assert.equal(operation.promptInputs[0].agentAllowed, false);
  assert.ok(packageJson.activationEvents.includes('onCommand:bcDevToolset.operation.uninstallPrerequisites'));
  assert.ok(packageJson.contributes.commands.some(
    (command) => command.command === 'bcDevToolset.operation.uninstallPrerequisites'));
  assert.match(extensionSource, /'uninstallPrerequisites'/);
});
