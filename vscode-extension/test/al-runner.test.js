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
});

test('AL Runner Test passes every app.json-rooted workspace folder in one invocation', () => {
  const source = fs.readFileSync(operationScriptPath, 'utf8'); // nosemgrep -- path is resolved within the authorized repository root

  assert.match(source, /Resolve-BcDevToolsetWorkspaceFile/);
  assert.match(source, /Join-Path \$_ 'app\.json'/);
  assert.match(source, /& \$runnerCommand\.Source @appPaths/);
  assert.match(source, /No AL apps with an app\.json file were found/);
  assert.match(source, /Microsoft-Windows-CodeIntegrity\/Operational/);
  assert.match(source, /BC Dev Toolset will not disable or bypass that protection/);
  assert.match(source, /AL Runner exited with code \$runnerExitCode/);
});
