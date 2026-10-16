const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
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

test('runtime staging copies the companion into an isolated destination alongside scripts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdata-runtime-copy-'));
  const bundled = path.join(directory, 'bundled');
  const target = path.join(directory, 'target');
  const runtimeDirectories = vm.runInNewContext(source.match(/const runtimeDirectories = (\[[^]*?\]);/)[1]);
  try {
    for (const name of runtimeDirectories) fs.mkdirSync(path.join(bundled, name), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'README.md'), 'fixture');
    fs.writeFileSync(path.join(bundled, 'Invoke-BcDevToolsetOperation.ps1'), 'fixture');
    fs.writeFileSync(path.join(bundled, 'bc-data', 'BCData.app'), 'synthetic companion');
    fs.writeFileSync(path.join(bundled, 'bc-data', 'manifest.json'), '{"contractVersion":1}');
    const dependencies = { fs, path, process, Date, resolveWithinRoot: require('../path-security').resolveWithinRoot };
    dependencies.copyDirectoryRecursive = loadFunction('copyDirectoryRecursive', dependencies);
    const sync = loadFunction('syncRuntimeToolsetQuietly', { fs, runtimeDirectories,
      getToolsetPath: () => target, getBundledRuntimePath: () => bundled,
      getMissingBundledRuntimeItems: () => [], getMissingRuntimeFiles: () => [], writeOutput() {},
      copyRuntimeFile: loadFunction('copyRuntimeFile', dependencies),
      copyRuntimeDirectory: loadFunction('copyRuntimeDirectory', dependencies) });
    await sync();
    assert.equal(fs.readFileSync(path.join(target, 'bc-data', 'BCData.app'), 'utf8'), 'synthetic companion');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'bc-data', 'manifest.json'), 'utf8')), { contractVersion: 1 });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
