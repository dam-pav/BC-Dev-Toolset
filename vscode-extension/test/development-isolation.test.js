const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function loadFunction(name, dependencies) {
  const definition = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))?.[0];
  assert.ok(definition, `Missing ${name}`);
  return vm.runInNewContext(`(${definition})`, dependencies);
}

test('development host activation cannot synchronize the shared production runtime', async () => {
  const synchronize = loadFunction('syncRuntimeToolsetAfterExtensionUpdate', {
    isExtensionDevelopmentMode: () => true,
    getRuntimeSyncStateKey: () => assert.fail('Development host accessed production runtime state'),
    syncRuntimeToolsetQuietly: () => assert.fail('Development host overwrote production scripts')
  });
  await synchronize({});
});

test('development host automatic MCP reconciliation leaves global configuration untouched', async () => {
  const reconcile = loadFunction('reconcileCodexMcpConfiguration', {
    waitForRuntimeSync: async () => {},
    isExtensionDevelopmentMode: () => true,
    getCodexMcpIntegrationSetting: () => true,
    getCodexConfigPath: () => assert.fail('Development host accessed global MCP configuration')
  });
  const result = await reconcile({});
  assert.equal(result.changed, false);
  assert.equal(result.skipped, 'extension development mode');
});
