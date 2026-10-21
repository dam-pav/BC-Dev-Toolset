'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createConfigurationAccess, affectsToolsetConfiguration } = require('../configuration-settings');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('BC Data discovers either legacy configuration prefix despite contributed current defaults', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
  const load = (name, dependencies) => vm.runInNewContext(`(${source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0]})`, dependencies);
  for (const prefix of ['dam-pav.bcdevtoolset', 'dam-pav.bcDevToolset']) {
    const shared = [{ name: 'Legacy' }];
    const local = [{ name: 'Local' }];
    const vscode = { workspace: { getConfiguration(section) {
      return {
        inspect: key => section === prefix && key === 'configurations' ? { workspaceValue: shared } : undefined,
        get: () => []
      };
    } } };
    const getConfiguration = load('getConfiguration', {
      vscode, createConfigurationAccess, configurationPrefix: 'bcDevToolset', legacyConfigurationPrefix: 'dam-pav.bcdevtoolset'
    });
    const discover = load('getBcDataConfigurations', { vscode, getConfiguration, getLocalMcpSettings: () => ({ settings: { configurations: local } }) });
    assert.deepEqual(Array.from(discover()), [...shared, ...local], prefix);
  }
});

const config = values => ({ inspect: () => values, get: () => 'default' });

// VS Code inserts setting IDs into a tree and assigns the final segment; it does
// not merge an explicitly registered parent object with previously inserted children.
// https://github.com/microsoft/vscode/blob/main/src/vs/platform/configuration/common/configuration.ts
function settingsTree(entries) {
  const tree = {};
  for (const [key, value] of entries) {
    const segments = key.split('.');
    let node = tree;
    for (const segment of segments.slice(0, -1)) node = node[segment] ??= {};
    node[segments.at(-1)] = structuredClone(value);
  }
  return tree;
}

test('registered parent and child defaults survive initial loading and reordered registration', () => {
  const properties = Object.assign({}, ...require('../package.json').contributes.configuration.map(group => group.properties));
  const entries = Object.entries(properties).map(([key, schema]) => [key, schema.default]);
  assert.equal(entries[0][0], 'bcDevToolset');
  for (const ordered of [entries, [...entries].reverse()]) {
    const tree = settingsTree(ordered);
    for (const [key, expected] of entries.filter(([key]) => key !== 'bcDevToolset')) {
      assert.deepEqual(key.split('.').reduce((node, segment) => node?.[segment], tree), expected, key);
    }
    assert.equal(tree.bcDevToolset.powershellExecutable, 'pwsh');
    assert.equal(tree.bcDevToolset.shortcuts, 'None');
    assert.equal(tree.bcDevToolset.localSettingsPath, '.bcdevtoolset/settings.json');
    assert.equal(tree.bcDevToolset.selectArtifact, 'Latest');
  }
});

test('all contributed settings share the bcDevToolset prefix', () => {
  const groups = require('../package.json').contributes.configuration;
  for (const group of groups) {
    for (const key of Object.keys(group.properties)) {
      assert.ok(key === 'bcDevToolset' || key.startsWith('bcDevToolset.'), key);
    }
  }
});

test('new settings win at the same scope and retain explicit false', () => {
  const access = createConfigurationAccess(
    config({ globalValue: false, workspaceValue: false }),
    config({ globalValue: true, workspaceValue: true })
  );
  assert.equal(access.get('mcp.tools.bc_dev_toolset_get_workspace'), false);
  assert.equal(access.inspect('codexMcpIntegration.enabled').globalValue, false);
});

test('legacy workspace values override new user defaults without accepting folder overrides', () => {
  const access = createConfigurationAccess(
    config({ globalValue: true }),
    config({ workspaceValue: false, workspaceFolderValue: true })
  );
  assert.equal(access.get('mcp.tools.bc_dev_toolset_get_workspace'), false);
});

test('legacy user selections survive renaming and machine settings ignore workspace values', () => {
  const access = createConfigurationAccess(config({}), config({ globalValue: false, workspaceValue: true }));
  assert.equal(access.get('codexMcpIntegration.enabled'), false);
  assert.equal(createConfigurationAccess(config({}), config({ globalValue: false }))
    .get('mcp.tools.bc_dev_toolset_get_workspace'), false);
  assert.equal(createConfigurationAccess(config({}), config(undefined)).get('toolsetPath'), 'default');
});

test('writes use the new configuration and changes under either prefix are observed', async () => {
  let saved;
  const access = createConfigurationAccess({ ...config({}), update: (...args) => { saved = args; } }, config({}));
  await access.update('codexMcpIntegration.enabled', false, 1);
  assert.deepEqual(saved, ['codexMcpIntegration.enabled', false, 1]);
  for (const prefix of ['dam-pav.bcdevtoolset', 'bcDevToolset']) {
    assert.equal(affectsToolsetConfiguration({ affectsConfiguration: key => key === `${prefix}.mcp.tools` }, 'mcp.tools'), true);
  }
});
