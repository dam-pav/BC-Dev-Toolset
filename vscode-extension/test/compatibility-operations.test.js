'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { __test: mcpServer } = require('../mcp-server');

const root = path.resolve(__dirname, '..', '..');
const operations = JSON.parse(fs.readFileSync(path.join(root, 'operations', 'operations.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

test('compatibility operations expose all three modes consistently', () => {
  const expected = [
    ['invokeCompatibilityTests', 'operations/Invoke-CompatibilityTests.ps1', 'bcDevToolset.operation.invokeCompatibilityTests'],
    ['invokeCompatibilityPageScriptTests', 'operations/Invoke-CompatibilityPageScriptTests.ps1', 'bcDevToolset.operation.invokeCompatibilityPageScriptTests'],
    ['alRunnerCompatibilityTest', 'operations/Invoke-CompatibilityAlRunnerTests.ps1', 'bcDevToolset.operation.alRunnerCompatibilityTest']
  ];
  const tools = mcpServer.getTools();

  for (const [id, script, command] of expected) {
    const operation = operations.find(candidate => candidate.id === id);
    assert.ok(operation, `${id} operation metadata exists`);
    assert.equal(operation.script, script);
    assert.ok(packageJson.activationEvents.includes(`onCommand:${command}`));
    assert.ok(packageJson.contributes.commands.some(entry => entry.command === command));
    assert.ok(tools.some(tool => tool.name === `bc_dev_toolset_${id.replace(/[A-Z]/g, value => `_${value.toLowerCase()}`)}`));
    assert.match(extensionSource, new RegExp(`'${id}'`));
    const wrapper = fs.readFileSync(path.join(root, script), 'utf8');
    assert.match(wrapper, /BCDEVTOOLSET_TEST_SUITE = 'Compatibility'/);
  }
});

test('compatibility runners use newer resolved targets sequentially and report per-target outcomes', () => {
  const alTests = fs.readFileSync(path.join(root, 'operations', 'Invoke-Tests.ps1'), 'utf8');
  const pageTests = fs.readFileSync(path.join(root, 'operations', 'Invoke-PageScriptTests.ps1'), 'utf8');
  const alRunner = fs.readFileSync(path.join(root, 'operations', 'Invoke-AlRunnerTests.ps1'), 'utf8');

  assert.match(alTests, /-Suite \$suite/);
  assert.match(alTests, /foreach \(\$selection in @\(\$testContainerSelection\.Targets\)\)/);
  assert.match(alTests, /actualApplicationVersion = ''/);
  assert.match(alTests, /One or more \$\(\$suite\.ToLowerInvariant\(\)\) test targets failed/);
  assert.match(pageTests, /foreach \(\$selection in @\(\$testContainerSelection\.Targets\)\)/);
  assert.match(pageTests, /BC-\$\(\$selection\.Platform\)/);
  assert.match(alRunner, /-Suite \$suite/);
  assert.match(alRunner, /foreach \(\$platformTarget in \$platformTargets\)/);
  assert.match(alRunner, /ToString\(2\)/);
});
