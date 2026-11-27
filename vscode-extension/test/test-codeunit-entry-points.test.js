const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const extensionRoot = authorizeRoot(path.resolve(__dirname, '..'), 'Extension source root');
const source = fs.readFileSync(resolveWithinRoot(extensionRoot, 'extension.js'), 'utf8'); // nosemgrep -- The fixed filename is contained by the authorized extension root.
const operation = { id: 'invokeTests', title: 'Run AL test tool tests', script: 'operations/Invoke-Tests.ps1' };
const testScopeQuestion = 'Do you want to select test codeunits to run? Select No to run all the tests. (y/N)';

function loadExtensionFunction(name, dependencies) {
  const functions = source.matchAll(/^(?:async )?function (\w+)\([^]*?^}/gm);
  const definition = functions.find(match => match[1] === name)?.[0];
  assert.ok(definition, `Expected extension function ${name}`);
  return vm.runInNewContext(`(${definition})`, dependencies);
}

function mockManualTestCommand({ decision, select }) {
  const calls = { prompts: [], picker: 0, launches: [] };
  const execute = loadExtensionFunction('executeOperation', {
    vscode: { window: { showInformationMessage: async (...args) => {
      calls.prompts.push(args);
      return decision;
    } } },
    selectAlTestCodeunits: async () => {
      calls.picker++;
      return select();
    },
    buildOperationTerminalCommand: (selectedOperation, _toolsetPath, options) => {
      assert.equal(selectedOperation.id, operation.id);
      return { command: JSON.stringify(options.codeunitIds ?? null), powershellExecutable: 'pwsh' };
    },
    bcDataRuntime: undefined,
    getOperationTerminal: () => ({ sendText: command => calls.launches.push(JSON.parse(command)) })
  });
  return { execute, calls };
}

test('manual No launches one comprehensive run and leaves the picker untouched', async () => {
  const { execute, calls } = mockManualTestCommand({ decision: 'No' });
  await execute(operation, extensionRoot);
  assert.equal(calls.prompts.length, 1);
  const [question, options, ...choices] = calls.prompts[0];
  assert.equal(question, testScopeQuestion);
  assert.equal(options.modal, true);
  assert.deepEqual(choices, ['Yes', 'No']);
  assert.equal(calls.picker, 0);
  assert.deepEqual(calls.launches, [null]);
});

test('manual Yes launches once with the IDs returned by the picker', async () => {
  for (const ids of [[60990, 60992], [60991]]) {
    const { execute, calls } = mockManualTestCommand({ decision: 'Yes', select: () => ids });
    await execute(operation, extensionRoot);
    assert.equal(calls.picker, 1);
    assert.deepEqual(calls.launches, [ids]);
  }
});

test('manual dismissal or absence of a saved picker selection stops before terminal launch', async () => {
  const noDecision = mockManualTestCommand({});
  await noDecision.execute(operation, extensionRoot);
  assert.equal(noDecision.calls.picker, 0);
  assert.deepEqual(noDecision.calls.launches, []);

  const noSelection = mockManualTestCommand({ decision: 'Yes', select: () => undefined });
  await noSelection.execute(operation, extensionRoot);
  assert.equal(noSelection.calls.picker, 1);
  assert.deepEqual(noSelection.calls.launches, []);
});

test('the standalone picker passes the workspace base and configured local settings path', async () => {
  const workspace = path.join(extensionRoot, 'test');
  const settings = path.join(workspace, 'custom', 'settings.json');
  const vscode = {};
  const calls = [];
  const pickTestCodeunits = async (...args) => {
    calls.push(args);
    return [60990];
  };
  const select = loadExtensionFunction('selectAlTestCodeunits', {
    vscode,
    pickTestCodeunits,
    getWorkspaceBasePath: () => workspace,
    getOptionalLocalSettingsPath: () => settings
  });
  assert.deepEqual(await select(), [60990]);
  assert.deepEqual(calls, [[vscode, workspace, settings]]);
});

test('terminal launch serializes test IDs and clears the selection for a later comprehensive run', () => {
  const build = loadExtensionFunction('buildOperationTerminalCommand', {
    path,
    getWorkspacePath: () => extensionRoot,
    getOperationBridgePath: () => './mcp-operation.ps1',
    getConfiguration: () => ({ get: () => undefined }),
    getWorkspaceFileName: () => '',
    getConfigPath: () => path.join(extensionRoot, '.bcdevtoolset'),
    resolveWorkspaceBasePath: () => undefined,
    quotePowerShellArgument: value => `'${String(value).replace(/'/g, "''")}'`,
    operationsRequiringAlTool: new Set(),
    getShortcutMode: () => '',
    getHostHelperFolder: () => ''
  });
  const selected = build(operation, extensionRoot, { codeunitIds: [60990, 60992] });
  assert.match(selected.command, /\$env:BCDEVTOOLSET_TEST_CODEUNIT_IDS = '\[60990,60992\]';/);
  assert.match(build(operation, extensionRoot).command, /\$env:BCDEVTOOLSET_TEST_CODEUNIT_IDS = (?:''|\$null);/);
});

test('MCP dispatch follows the terminal route with the supplied IDs and no interactive picker', async () => {
  const observedOptions = [];
  const sent = [];
  const session = {};
  const execute = loadExtensionFunction('executeOperationInTerminalForMcp', {
    bcDataRuntime: undefined,
    createMcpCapturePaths: () => ({ sessionId: 'test' }),
    getOrCreateMcpPromptSession: () => session,
    normalizeMcpPromptAnswers: answers => answers,
    touchMcpPromptSession: () => {},
    buildOperationTerminalCommand: (_, __, options) => {
      observedOptions.push(options);
      return { command: 'test command', powershellExecutable: 'pwsh' };
    },
    getOperationTerminal: () => ({ sendText: command => sent.push(command) }),
    getPowerShellTerminalName: () => 'test',
    waitForTerminalShellIntegration: async () => undefined,
    monitorMcpTestCapture: async () => {},
    getMcpPromptSessionSnapshot: () => session
  });
  const codeunitIds = [60990, 60992];
  await execute(operation, extensionRoot, { codeunitIds });
  await execute(operation, extensionRoot);
  assert.equal(observedOptions.length, 2);
  assert.deepEqual(observedOptions[0].codeunitIds, codeunitIds);
  assert.equal(observedOptions[1].codeunitIds, undefined);
  assert.deepEqual(sent, ['test command', 'test command']);
});

function mockTestBridge(body, { activeScope, pending = false } = {}) {
  const launches = [];
  const replies = [];
  const workspace = { workspacePath: extensionRoot, workspaceFilePath: path.join(extensionRoot, 'current.code-workspace') };
  const catalog = [{
    appId: '00000000-0000-0000-0000-000000000001',
    appName: 'App A',
    codeunits: [{ id: 60990, name: 'First test' }, { id: 60992, name: 'Second test' }]
  }];
  let catalogReads = 0;
  let promptResumes = 0;
  const vscode = {};
  const handle = loadExtensionFunction('handleMcpBridgeRequest', {
    mcpBridgeToken: 'test-token',
    mcpBridgeWorkspace: workspace,
    mcpAlTestStartPending: pending,
    mcpPromptSessions: new Map(activeScope === undefined ? [] : [['active', { codeunitIds: activeScope }]]),
    path,
    bridgeIdentity: { workspaceOwnsPath: (bound, candidate) => bound === workspace && candidate.startsWith(extensionRoot) },
    readRequestBody: async () => body,
    validateMcpBridgeBinding: () => '',
    vscode,
    normalizeTestCodeunitIds: ids => [...new Set(ids)],
    getTestCodeunitCatalog: async host => {
      assert.equal(host, vscode);
      catalogReads++;
      return catalog;
    },
    assertKnownTestCodeunits: (ids, groups) => {
      assert.equal(groups, catalog);
      if (ids.includes(99999)) {
        throw new Error('Codeunit 99999 is missing from workspace tests. Select a codeunit from the catalog.');
      }
    },
    answerWaitingMcpPromptFromPromptAnswers: () => { promptResumes++; },
    getExistingMcpOperationForPromptAnswers: () => activeScope === undefined ? undefined : { sessionId: 'active', status: 'running' },
    getBlockingMcpPromptForOperationStart: () => undefined,
    runOperationByIdForMcp: async (id, options) => {
      launches.push({ id, options });
      return { status: 'running' };
    },
    writeMcpBridgeResponse: (_, status, payload) => replies.push({ status, payload })
  });
  return {
    launches, replies, catalog,
    get catalogReads() { return catalogReads; },
    get promptResumes() { return promptResumes; },
    request: (url, authorization = 'Bearer test-token') => handle({ method: 'POST', url, headers: { authorization } }, {})
  };
}

test('the authenticated workspace-bound bridge forwards codeunit IDs into the test operation', async () => {
  const codeunitIds = [60990, 60992];
  const promptAnswers = { 'tests.executeInContainer': 'yes' };
  const { request, launches, replies } = mockTestBridge({ operationId: operation.id, codeunitIds: [...codeunitIds, 60990], promptAnswers });
  await request('/run-operation');
  assert.equal(replies[0].status, 200);
  assert.equal(replies[0].payload.status, 'running');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].id, operation.id);
  assert.deepEqual(launches[0].options.codeunitIds, codeunitIds);
  assert.deepEqual(launches[0].options.promptAnswers, promptAnswers);
});

test('an unknown selected ID is rejected by the extension bridge before terminal launch', async () => {
  const { request, launches, replies } = mockTestBridge({ operationId: operation.id, codeunitIds: [60990, 99999] });
  await request('/run-operation');
  assert.equal(replies[0].status, 400);
  assert.match(replies[0].payload.error, /99999.*Select a codeunit from the catalog.*No test operation was started/);
  assert.equal(launches.length, 0);
});

test('a distinct scope cannot resume or reuse an active MCP test run', async () => {
  for (const codeunitIds of [[60990], undefined]) {
    const bridge = mockTestBridge({ operationId: operation.id, codeunitIds }, { activeScope: [60992] });
    await bridge.request('/run-operation');
    assert.equal(bridge.replies[0].status, 409);
    assert.match(bridge.replies[0].payload.error, /'active'.*different codeunit selection.*bc_dev_toolset_get_operation_status.*No new test operation was started/);
    assert.equal(bridge.promptResumes, 0);
    assert.equal(bridge.launches.length, 0);
  }
  const matching = mockTestBridge({ operationId: operation.id, codeunitIds: [60992] }, { activeScope: [60992] });
  await matching.request('/run-operation');
  assert.equal(matching.replies[0].payload.sessionId, 'active');
  assert.equal(matching.launches.length, 0);
});

test('a second MCP test request cannot start while the first is resolving the runtime', async () => {
  const bridge = mockTestBridge({ operationId: operation.id }, { pending: true });
  await bridge.request('/run-operation');
  assert.equal(bridge.replies[0].status, 409);
  assert.match(bridge.replies[0].payload.error, /already starting.*Check the existing request.*No new test operation was started/);
  assert.equal(bridge.launches.length, 0);
});

test('catalog preflight enforces bridge authentication and workspace binding without launching an operation', async () => {
  const bound = mockTestBridge({ workspacePath: extensionRoot });
  await bound.request('/test-codeunit-catalog', '');
  assert.equal(bound.replies[0].status, 401);
  assert.equal(bound.catalogReads, 0);
  await bound.request('/test-codeunit-catalog');
  assert.equal(bound.replies[1].status, 200);
  assert.equal(bound.replies[1].payload.testCodeunitCatalog, bound.catalog);
  assert.equal(bound.catalogReads, 1);
  assert.equal(bound.launches.length, 0);

  const foreign = mockTestBridge({ workspacePath: path.dirname(extensionRoot) });
  await foreign.request('/test-codeunit-catalog');
  assert.equal(foreign.replies[0].status, 409);
  assert.match(foreign.replies[0].payload.error, /bound BC Dev Toolset bridge/);
  assert.equal(foreign.catalogReads, 0);
  assert.equal(foreign.launches.length, 0);
});

test('a different workspace file within a bound root cannot change which apps the AL test operation sees', async () => {
  for (const route of ['/test-codeunit-catalog', '/run-operation']) {
    const bridge = mockTestBridge({ operationId: operation.id, workspaceFile: path.join(extensionRoot, 'different.code-workspace') });
    await bridge.request(route);
    assert.equal(bridge.replies[0].status, 409);
    assert.match(bridge.replies[0].payload.error, /open VS Code workspace.*Omit the workspace path overrides.*No test operation was started/);
    assert.equal(bridge.catalogReads, 0);
    assert.equal(bridge.launches.length, 0);
  }
});
