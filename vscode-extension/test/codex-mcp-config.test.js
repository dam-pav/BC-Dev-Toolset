'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  classifyCodexMcpConfiguration,
  removeCodexMcpConfigContent,
  resolveCodexMcpIntegrationState,
  runCodexMcpIntegrationTransition,
  updateCodexMcpConfigContent
} = require('../codex-mcp-config');

const oldServerPath = 'C:\\Users\\Developer\\.vscode\\extensions\\dam-pav.bc-dev-toolset-1.2.0\\mcp-server.js';
const currentServerPath = 'C:\\Users\\Developer\\.vscode\\extensions\\dam-pav.bc-dev-toolset-1.2.2\\mcp-server.js';
const toolsetPath = 'C:\\Users\\Developer\\AppData\\Local\\BC-Dev-Toolset\\toolset';

test('updates a managed Codex MCP section and preserves unrelated tables', () => {
  const source = [
    '[projects."C:\\\\Source"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.bc-dev-toolset]',
    'command = "node"',
    'args = ["C:\\\\old\\\\mcp-server.js"]',
    '',
    '[mcp_servers.bc-dev-toolset.env]',
    'BCDEVTOOLSET_MCP_TOOLSET_PATH = "C:\\\\old\\\\toolset"',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    ''
  ].join('\n');

  const updated = updateCodexMcpConfigContent(source, { mcpServerPath: currentServerPath, toolsetPath });

  assert.match(updated, /\[projects\."C:\\\\Source"\]/);
  assert.match(updated, /\[mcp_servers\.other\]/);
  assert.match(updated, /dam-pav\.bc-dev-toolset-1\.2\.2/);
  assert.doesNotMatch(updated, /C:\\\\old/);
  assert.equal(updateCodexMcpConfigContent(updated, { mcpServerPath: currentServerPath, toolsetPath }), updated);
});

test('classifies current and stale versioned extension paths', () => {
  const staleContent = updateCodexMcpConfigContent('', { mcpServerPath: oldServerPath, toolsetPath });
  const currentContent = updateCodexMcpConfigContent('', { mcpServerPath: currentServerPath, toolsetPath });

  assert.equal(classifyCodexMcpConfiguration(staleContent, currentServerPath).status, 'stale');
  assert.equal(classifyCodexMcpConfiguration(currentContent, currentServerPath).status, 'current');
});

test('does not classify an unrecognized custom server as migratable', () => {
  const content = updateCodexMcpConfigContent('', {
    mcpServerPath: 'C:\\Custom\\bc-dev-toolset\\mcp-server.js',
    toolsetPath
  });

  assert.equal(classifyCodexMcpConfiguration(content, currentServerPath).status, 'custom');
});

test('round-trips generated paths containing spaces', () => {
  const serverPath = 'C:\\Users\\Dev User\\.vscode\\extensions\\dam-pav.bc-dev-toolset-1.2.2\\mcp-server.js';
  const content = updateCodexMcpConfigContent('', {
    mcpServerPath: serverPath,
    toolsetPath: 'C:\\Users\\Dev User\\BC Dev Toolset'
  });

  assert.equal(classifyCodexMcpConfiguration(content, serverPath).status, 'current');
});

test('removes only the BC Dev Toolset MCP tables', () => {
  const source = updateCodexMcpConfigContent('[mcp_servers.other]\ncommand = "other"\n', {
    mcpServerPath: currentServerPath,
    toolsetPath
  });

  const updated = removeCodexMcpConfigContent(source);

  assert.match(updated, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(updated, /mcp_servers\.bc-dev-toolset/);
});

test('reports missing and invalid configurations separately', () => {
  assert.equal(classifyCodexMcpConfiguration('', currentServerPath).status, 'missing');
  assert.equal(
    classifyCodexMcpConfiguration('[mcp_servers.bc-dev-toolset]\ncommand = "node"\n', currentServerPath).status,
    'invalid'
  );
});

test('migrates only undefined legacy settings with recognized configuration', () => {
  assert.deepEqual(resolveCodexMcpIntegrationState({
    explicitValue: undefined,
    migrationCompleted: false,
    allowLegacyMigration: true,
    configurationStatus: 'stale'
  }), {
    enabled: true,
    persistSetting: true,
    completeMigration: true
  });

  assert.equal(resolveCodexMcpIntegrationState({
    explicitValue: false,
    migrationCompleted: false,
    allowLegacyMigration: true,
    configurationStatus: 'stale'
  }).enabled, false);

  assert.equal(resolveCodexMcpIntegrationState({
    explicitValue: undefined,
    migrationCompleted: true,
    allowLegacyMigration: true,
    configurationStatus: 'stale'
  }).enabled, false);
});

test('repairs configuration before persisting migration state and retries failed setting writes', async () => {
  const calls = [];
  const settingError = new Error('configuration is not registered');
  const result = await runCodexMcpIntegrationTransition({
    enabled: true,
    persistSetting: true,
    completeMigration: true
  }, {
    applyConfiguration: async () => {
      calls.push('apply-configuration');
      return { enabled: true, changed: true, configPath: 'config.toml' };
    },
    persistSetting: async () => {
      calls.push('persist-setting');
      throw settingError;
    },
    completeMigration: async () => calls.push('complete-migration')
  });

  assert.deepEqual(calls, ['apply-configuration', 'persist-setting']);
  assert.equal(result.changed, true);
  assert.equal(result.settingPersisted, false);
  assert.equal(result.settingError, settingError);
});
