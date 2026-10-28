const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');
const pkg = require('../package.json');

test('activation registers every contributed operation command and dispatches credential setup and WinRM', async () => {
  const extensionRoot = authorizeRoot(path.resolve(__dirname, '..'), 'Extension source root');
  const source = fs.readFileSync(resolveWithinRoot(extensionRoot, 'extension.js'), 'utf8');
  const ids = source.match(/const directOperationIds = (\[[\s\S]*?\]);/)[1];
  const activation = source.match(/async function activate\([^]*?\n}/)[0];
  const commands = new Map();
  const invoked = [];
  const disposable = () => ({ dispose() {} });
  const dependencies = {
    vscode: {
      commands: { registerCommand: (id, handler) => {
        assert.ok(!commands.has(id), `Duplicate registration: ${id}`);
        commands.set(id, handler);
        return disposable();
      } },
      window: { createOutputChannel: disposable, onDidCloseTerminal: disposable },
      workspace: { onDidChangeConfiguration: disposable },
      languages: { registerCompletionItemProvider: disposable }
    },
    migrateSettingsOnStartup: async () => {},
    runOperationById: async id => { invoked.push(id); },
    syncRuntimeToolsetAfterExtensionUpdate: async () => {},
    queueCodexMcpReconciliation() {}
  };
  for (const name of ['writeOutput', 'openLocalSettingsJson', 'showObjectIdRangeVisualizationData',
    'showMcpStatus', 'configureMcpTools', 'configureCodexMcp', 'disableCodexMcp', 'runOperation',
    'startMcpBridgeServer', 'startMcpPromptSessionCleanup', 'resetBcDataCredentials',
    'registerMcpServerDefinitionProvider', 'provideSettingsCompletionItems']) {
    dependencies[name] = disposable;
  }
  const activate = vm.runInNewContext(`const directOperationIds = ${ids}; (${activation})`, dependencies);
  const context = { subscriptions: [] };
  await activate(context);
  for (const contribution of pkg.contributes.commands) {
    if (!contribution.command.startsWith('bcDevToolset.operation.')) continue;
    assert.equal(typeof commands.get(contribution.command), 'function', `${contribution.command} is contributed but unavailable`);
  }
  for (const id of ['configureStoredCredentials', 'configureWinRm']) {
    const command = `bcDevToolset.operation.${id}`;
    assert.ok(pkg.activationEvents.includes(`onCommand:${command}`));
    await commands.get(command)();
  }
  assert.deepEqual(invoked, ['configureStoredCredentials', 'configureWinRm']);
});
