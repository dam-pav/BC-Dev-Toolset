'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { __test: mcpServer } = require('../mcp-server');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = authorizeRoot(path.resolve(__dirname, '..', '..'), 'Repository root');
const operationScriptPath = resolveWithinRoot(repositoryRoot, 'operations', 'Invoke-AlRunnerTests.ps1');
const operationsPath = resolveWithinRoot(repositoryRoot, 'operations', 'operations.json');
const packagePath = resolveWithinRoot(repositoryRoot, 'vscode-extension', 'package.json');
const extensionPath = resolveWithinRoot(repositoryRoot, 'vscode-extension', 'extension.js');

test('AL Runner Test is exposed consistently through metadata, VS Code, and MCP', () => {
  const operations = JSON.parse(fs.readFileSync(operationsPath, 'utf8')); // nosemgrep -- path is resolved within the authorized repository root
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')); // nosemgrep -- path is resolved within the authorized repository root
  const extensionSource = fs.readFileSync(extensionPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root
  const operation = operations.find((candidate) => candidate.id === 'alRunnerTest');
  const mcpTool = mcpServer.getTools().find((tool) => tool.name === 'bc_dev_toolset_al_runner_test');

  assert.ok(operation);
  assert.equal(operation.title, 'AL Runner Test');
  assert.equal(operation.script, 'operations/Invoke-AlRunnerTests.ps1');
  assert.equal(operation.category, 'Tests');
  assert.ok(packageJson.activationEvents.includes('onCommand:bcDevToolset.operation.alRunnerTest'));
  assert.ok(packageJson.contributes.commands.some(
    (command) => command.command === 'bcDevToolset.operation.alRunnerTest'));
  assert.match(extensionSource, /'alRunnerTest'/);
  assert.ok(mcpTool);
  assert.match(mcpTool.description, /without a Business Central container/);
  assert.match(mcpTool.description, /bc_dev_toolset_invoke_tests/);
});

test('AL Runner Test passes every app.json-rooted workspace folder in one invocation', () => {
  const source = fs.readFileSync(operationScriptPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root

  assert.match(source, /Resolve-BcDevToolsetWorkspaceFile/);
  assert.match(source, /Join-Path \$_ 'app\.json'/);
  assert.match(source, /@\('--bc-version', \$bcVersionPrefix\) \+ \$appPaths/);
  assert.match(source, /& \$runnerCommand\.Source @runnerArguments/);
  assert.match(source, /must target the same Business Central application major/);
  assert.match(source, /Get-AlRunnerShippedEngineVersions/);
  assert.match(source, /does not ship a Business Central \$bcVersionPrefix engine variant/);
  assert.match(source, /no artifacts were downloaded/);
  assert.match(source, /__BCDEVTOOLSET_AL_RUNNER_TOOL_FAILURE__::\$Code/);
  assert.match(source, /Suggested fallback:.*bc_dev_toolset_invoke_tests/);
  assert.match(source, /Write-AlRunnerToolFailure[\s\S]*-Code 'unsupported_engine'/);
  assert.match(source, /No AL apps with an app\.json file were found/);
  assert.match(source, /Microsoft-Windows-CodeIntegrity\/Operational/);
  assert.match(source, /BC Dev Toolset will not disable or bypass that protection/);
  assert.match(source, /AL Runner exited with code \$runnerExitCode/);
});

test('AL Runner MCP report distinguishes a runner-tool failure from AL test results', () => {
  const output = [
    'Runner diagnostic that should not become the summary',
    '__BCDEVTOOLSET_AL_RUNNER_TOOL_FAILURE__::unsupported_engine',
    'AL Runner tool failure: The installed package does not ship the required BC engine.',
    'AL Runner tests were not executed.',
    "Suggested fallback: run 'Run AL test tool tests' (MCP: bc_dev_toolset_invoke_tests)."
  ].join('\n');

  const report = mcpServer.compileAlRunnerTestReport(output);

  assert.match(report, /Status: tool failure \(AL tests were not executed\)/);
  assert.match(report, /Reason code: unsupported_engine/);
  assert.match(report, /does not ship the required BC engine/);
  assert.match(report, /bc_dev_toolset_invoke_tests/);
  assert.match(report, /do not invoke it automatically/i);
  assert.doesNotMatch(report, /Runner diagnostic that should not become the summary/);
});

test('AL Runner MCP report does not relabel genuine AL failures as tool failures', () => {
  const output = 'AL Runner exited with code 3 (AL compilation errors).';

  assert.equal(mcpServer.compileAlRunnerTestReport(output), '');
});
