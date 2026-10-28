const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('remote dependencies use selected-service tools, order packages, upgrade safely and clean staging', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'onprem-dependencies.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('remote OnPrem unpublishing uses selected-service tools and closes sessions on failure', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'onprem-unpublishing.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('manual publishing recovers missing credentials while agents never prompt', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'publishing-credential-recovery.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('OnPrem Dev publishing uses the configured endpoint without a management-module setting', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'onprem-publishing.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('normal and runtime publishing exclude test apps while test preparation can include them', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'publishing-test-apps.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('publishing operations select exactly one eligible target across environment roles', () => {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'publishing-selection.tests.ps1')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('unified publishing operations replace target-specific commands and MCP settings', () => {
  const root = path.resolve(__dirname, '../..');
  const operations = JSON.parse(fs.readFileSync(path.join(root, 'operations/operations.json'), 'utf8'));
  const pkg = require('../package.json');
  const schema = require('../schemas/bcdevtoolset-settings.schema.json');
  const extension = fs.readFileSync(path.join(root, 'vscode-extension/extension.js'), 'utf8');
  const { __test: mcpServer } = require('../mcp-server');
  for (const id of ['publishApps', 'publishDependencies', 'publishRuntimeApps', 'unpublishApps']) {
    const operation = operations.find(item => item.id === id);
    assert.ok(operation);
    assert.ok(fs.existsSync(path.join(root, operation.script)));
    assert.ok(operation.promptInputs.some(input => input.inputName === 'configurationName'));
    assert.ok(pkg.contributes.commands.some(command => command.command === `bcDevToolset.operation.${id}`));
    assert.ok(pkg.activationEvents.includes(`onCommand:bcDevToolset.operation.${id}`));
    assert.ok(extension.includes(`'${id}'`));
    const tool = `bc_dev_toolset_${id.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;
    assert.ok(schema.properties.mcpTools.properties[tool]);
    const exposedTool = mcpServer.getTools().find(item => item.name === tool);
    assert.equal(exposedTool.inputSchema.properties.configurationName.type, 'string');
    assert.deepEqual(mcpServer.getOperationPromptAnswers(operation, { configurationName: 'test-b' }),
      { 'publishing.configurationName': 'test-b' });
  }
  const serialized = JSON.stringify({ operations, pkg, schema });
  assert.doesNotMatch(serialized, /publishApps2|publishDependencies2|publishRuntimeApps2|unpublishDockerApps|unpublishTestApps|publish_apps2|publish_dependencies2|publish_runtime_apps2|unpublish_docker_apps|unpublish_test_apps/);
});
