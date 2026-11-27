'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const readline = require('node:readline');
process.env.BCDEVTOOLSET_MCP_TOOL_SETTINGS = JSON.stringify({"bc_dev_toolset_show_help": true, "bc_dev_toolset_invoke_tests": true, "bc_dev_toolset_invoke_page_script_tests": true});
const { afterEach, test } = require('node:test');

const { __test: mcpServer } = require('../mcp-server');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

afterEach(() => {
  mcpServer.resetState();
});

test('reads a single newline-delimited JSON object', () => {
  mcpServer.setInputBuffer('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

  assert.equal(mcpServer.tryReadRawJsonMessage(), true);
  assert.equal(mcpServer.getInputBuffer().length, 0);
});

test('reads multiple newline-delimited JSON objects from one buffer', () => {
  const first = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
  const second = '{"jsonrpc":"2.0","method":"notifications/cancelled"}';
  mcpServer.setInputBuffer(`${first}\n${second}\n`);

  assert.equal(mcpServer.tryReadRawJsonMessage(), true);
  assert.equal(mcpServer.getInputBuffer().toString('utf8'), `${second}\n`);
  assert.equal(mcpServer.tryReadRawJsonMessage(), true);
  assert.equal(mcpServer.getInputBuffer().length, 0);
});

test('skips malformed lines after raw JSON transport is established', () => {
  const valid = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
  mcpServer.setInputBuffer(`${valid}\n`);
  assert.equal(mcpServer.tryReadRawJsonMessage(), true);

  mcpServer.setInputBuffer(`not-json\n${valid}\n`);
  assert.equal(mcpServer.tryReadRawJsonMessage(), true);
  assert.equal(mcpServer.getInputBuffer().toString('utf8'), `${valid}\n`);
  assert.equal(mcpServer.tryReadRawJsonMessage(), true);
  assert.equal(mcpServer.getInputBuffer().length, 0);
});

test('reads a complete JSON object without a trailing newline', () => {
  mcpServer.setInputBuffer(' \t\r{"jsonrpc":"2.0","method":"notifications/initialized"}');

  assert.equal(mcpServer.tryReadRawJsonMessage(), true);
  assert.equal(mcpServer.getInputBuffer().length, 0);
});

test('rejects a non-JSON buffer before decoding it as text', () => {
  const value = ' \t\rContent-Length: 42';
  mcpServer.setInputBuffer(value);

  assert.equal(mcpServer.tryReadRawJsonMessage(), false);
  assert.equal(mcpServer.getInputBuffer().toString('utf8'), value);
});

test('returns false and preserves incomplete JSON fragments', () => {
  const fragments = [
    '{',
    '{"jsonrpc":',
    '{"jsonrpc":"2.0"'
  ];

  for (const fragment of fragments) {
    mcpServer.setInputBuffer(fragment);

    assert.equal(mcpServer.tryReadRawJsonMessage(), false, fragment);
    assert.equal(mcpServer.getInputBuffer().toString('utf8'), fragment);
  }
});

test('preserves boolean prompt answers for MCP clients', () => {
  assert.equal(mcpServer.normalizePromptToolAnswer(true), true);
  assert.equal(mcpServer.normalizePromptToolAnswer(false), false);
});

test('normalizes numeric and string prompt answers without dropping false-like values', () => {
  assert.equal(mcpServer.normalizePromptToolAnswer(0), '0');
  assert.equal(mcpServer.normalizePromptToolAnswer(1), '1');
  assert.equal(mcpServer.normalizePromptToolAnswer(' no '), 'no');
});

test('rejects empty prompt answers', () => {
  assert.throws(() => mcpServer.normalizePromptToolAnswer('   '), /answer is required/);
  assert.throws(() => mcpServer.normalizePromptToolAnswer(undefined), /answer is required/);
});

test('non-sensitive user-only MCP decisions are relayed from chat rather than terminal keyboard input', () => {
  const instructions = mcpServer.formatOperationStatus({ status: 'waiting_for_input', sessionId: 'pending',
    prompt: { id: 'backup.restoreBackupSet', type: 'confirm', agentAllowed: false, sensitive: false } });
  assert.match(instructions, /explicit user decision in chat/);
  assert.match(instructions, /bc_dev_toolset_answer_operation_prompt/);
  assert.match(instructions, /Terminal keyboard entry is not used/);
  assert.doesNotMatch(instructions, /type their answer directly/);
  const sensitive = mcpServer.formatOperationStatus({ status: 'waiting_for_input', sessionId: 'pending',
    prompt: { id: 'secret', type: 'text', agentAllowed: false, sensitive: true } });
  assert.match(sensitive, /type their answer directly in the VS Code terminal/);
  assert.doesNotMatch(sensitive, /relay that non-sensitive answer/);
  assert.match(mcpServer.getServerInstructions(), /Agent-disallowed non-sensitive prompts require an explicit user decision in chat/);
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'operations', 'operations.json'), 'utf8'));
  const restore = metadata.find(operation => operation.id === 'restoreBcContainerDatabases').promptInputs
    .find(prompt => prompt.promptId === 'backup.restoreBackupSet');
  assert.equal(restore.agentAllowed, false);
  assert.match(restore.question, /explicit user answer/);
  assert.doesNotMatch(restore.question, /in the terminal/);
});

test('lists prompt answer tool before operation tools', () => {
  const toolNames = mcpServer.getTools().map((tool) => tool.name);

  assert.ok(toolNames.indexOf('bc_dev_toolset_answer_operation_prompt') > -1);
  assert.ok(toolNames.indexOf('bc_dev_toolset_new_docker_container') > -1);
  assert.ok(
    toolNames.indexOf('bc_dev_toolset_answer_operation_prompt') < toolNames.indexOf('bc_dev_toolset_new_docker_container')
  );
});

test('operation tool descriptions explain preflight and resumable prompt answers', () => {
  const newDockerContainerTool = mcpServer.getTools().find((tool) => tool.name === 'bc_dev_toolset_new_docker_container');

  assert.match(newDockerContainerTool.description, /without execute:true/);
  assert.match(newDockerContainerTool.description, /resumes the same pending operation/);
  assert.equal(newDockerContainerTool.inputSchema.properties.execute.type, 'boolean');
  assert.equal(newDockerContainerTool.inputSchema.properties.clearTranslationFiles.type, 'boolean');
  assert.equal(newDockerContainerTool.inputSchema.properties.clearAppFiles.type, 'boolean');
  assert.equal(newDockerContainerTool.inputSchema.properties.pullFullArtifact.type, 'boolean');
});

test('build tool description directs AL compilation through workspace-aware tooling', () => {
  const buildTool = mcpServer.getTools().find((tool) => tool.name === 'bc_dev_toolset_build_all_apps');

  assert.ok(buildTool);
  assert.match(buildTool.description, /compile, build, or validate the AL apps/);
  assert.match(buildTool.description, /assembly probing paths/);
});

test('page script preflight exposes confirmation and creation questions without a container-name selector', async () => {
  const result = await mcpServer.callTool({ name: 'bc_dev_toolset_invoke_page_script_tests', arguments: {} });
  const preflight = JSON.parse(result.content[0].text);
  assert.equal(preflight.status, 'input_required');
  assert.ok(preflight.missingInputs.includes('executeTestsInContainer'));
  assert.equal(preflight.questions.some(input => input.inputName === 'testContainerSelection'), false);
  assert.ok(preflight.questions.some(input => input.inputName === 'pullFullArtifact'));
  assert.equal(Object.hasOwn(preflight, 'conditionalPrompts'), false);
});

test('AL test tool exposes the codeunit list input', () => {
  const tools = mcpServer.getTools();
  const testTool = tools.find(tool => tool.name === 'bc_dev_toolset_invoke_tests');
  assert.deepEqual(testTool.inputSchema.properties.codeunitIds.items, { type: 'integer', minimum: 1, maximum: 2 ** 31 - 1 });
  const pageScriptTool = tools.find(tool => tool.name === 'bc_dev_toolset_invoke_page_script_tests');
  assert.equal(pageScriptTool.inputSchema.properties.codeunitIds, undefined);
});

async function createOperationBridgeFixture(t, handleRequest) {
  const identity = { protocolVersion: 2, instanceId: randomUUID(), extensionHostPid: process.pid, workspace: { workspacePath: process.cwd() } };
  const token = randomUUID();
  const requests = [];
  const bridge = http.createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    const body = JSON.parse(input);
    if (request.headers.authorization !== `Bearer ${token}` || body.binding?.instanceId !== identity.instanceId) {
      response.writeHead(401).end('{}');
      return;
    }
    response.setHeader('content-type', 'application/json');
    requests.push({ route: request.url, body });
    handleRequest(request, response, identity);
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); bridge.closeAllConnections(); });
  const child = spawn(process.execPath, [path.join(__dirname, '../mcp-server.js')], { windowsHide: true, env: {
    ...process.env,
    BCDEVTOOLSET_MCP_TOOL_SETTINGS: JSON.stringify({
      bc_dev_toolset_invoke_tests: true,
      bc_dev_toolset_build_all_apps: true
    }),
    BCDEVTOOLSET_MCP_TOOL_SETTINGS_SOURCE: '',
    BCDEVTOOLSET_MCP_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`,
    BCDEVTOOLSET_MCP_BRIDGE_TOKEN: token,
    BCDEVTOOLSET_MCP_BRIDGE_INSTANCE_ID: identity.instanceId,
    BCDEVTOOLSET_MCP_BRIDGE_PROTOCOL_VERSION: '2',
    BCDEVTOOLSET_MCP_EXTENSION_HOST_PID: String(process.pid),
    BCDEVTOOLSET_MCP_WORKSPACE_CONTEXT: JSON.stringify(identity.workspace)
  } });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  t.after(() => { lines.close(); child.kill(); });
  let id = 0;
  async function invoke(args, name = 'bc_dev_toolset_invoke_tests') {
    const response = new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: {
      name, arguments: args
    } }) + '\n');
    return (await response).result;
  }
  return { invoke, requests };
}

test('generic terminal operations precheck authorized workspace folders before dispatch', { timeout: 10000 }, async t => {
  const { invoke, requests } = await createOperationBridgeFixture(t, (request, response, identity) => {
    if (request.url === '/handshake') response.end(JSON.stringify(identity));
    else response.end(JSON.stringify({ status: 'completed' }));
  });
  const buildTool = 'bc_dev_toolset_build_all_apps';
  const missingPath = path.join(process.cwd(), randomUUID());
  const outsidePath = path.resolve(process.cwd(), '..', randomUUID());

  const missing = await invoke({ workspacePath: missingPath }, buildTool);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Workspace path not found.*Check that the selected workspace folder still exists.*No operation was started/);

  const outside = await invoke({ workspacePath: outsidePath }, buildTool);
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /outside the workspace bound to the VS Code bridge.*Select a path in the bound workspace.*No operation was started/);
  assert.equal(requests.length, 0);

  const valid = await invoke({ workspacePath: __dirname }, buildTool);
  assert.equal(valid.isError, false);
  assert.deepEqual(requests.map(request => request.route), ['/handshake', '/run-operation']);
  assert.equal(requests[1].body.workspacePath, __dirname);
});

test('AL test preflight reads the grouped catalog, and execute forwards only validated inputs', { timeout: 10000 }, async t => {
  const catalog = [{ appId: 'app', appName: 'Test app', codeunits: [{ id: 60992, name: 'Sales test' }] }];
  let catalogAvailable = true;
  const { invoke, requests } = await createOperationBridgeFixture(t, (request, response, identity) => {
    if (request.url === '/handshake') response.end(JSON.stringify(identity));
    else if (request.url === '/test-codeunit-catalog' && catalogAvailable) response.end(JSON.stringify({ testCodeunitCatalog: catalog }));
    else if (request.url === '/run-operation') response.end(JSON.stringify({ status: 'completed' }));
    else response.writeHead(404).end('{}');
  });

  const preflight = JSON.parse((await invoke({ execute: false })).content[0].text);
  assert.deepEqual(preflight.testCodeunitCatalog, catalog);
  assert.deepEqual(preflight.questions.map(question => question.inputName), [
    'executeTestsInContainer', 'clearTranslationFiles', 'clearAppFiles', 'pullFullArtifact'
  ]);
  assert.deepEqual(requests.map(request => request.route), ['/handshake', '/test-codeunit-catalog']);

  const execute = { execute: true, executeTestsInContainer: true, clearTranslationFiles: false, clearAppFiles: false, pullFullArtifact: false };
  for (const invalid of [
    { ...execute, clearAppFiles: undefined }, { ...execute, pullFullArtifact: 'sometimes' },
    { ...execute, promptAnswers: { 'clearArtifacts.appFiles': 'maybe' } },
    ...[null, [], ['60992'], [Infinity], [2147483648], [1.5]].map(codeunitIds => ({ ...execute, codeunitIds }))
  ]) {
    const result = await invoke(invalid);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No test operation was started/);
  }
  assert.equal(requests.length, 2);

  assert.equal((await invoke({ ...execute, codeunitIds: [60992, 60992] })).isError, false);
  assert.deepEqual(requests[2].body.codeunitIds, [60992]);
  assert.equal(requests[2].body.promptAnswers['clearArtifacts.appFiles'], false);
  assert.equal((await invoke(execute)).isError, false);
  assert.equal(Object.hasOwn(requests[3].body, 'codeunitIds'), false);

  catalogAvailable = false;
  const unavailable = await invoke({ execute: false });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /HTTP 404.*Reload.*No test operation was started/);
  assert.equal(requests.filter(request => request.route === '/run-operation').length, 2);
});

const handshakeFailures = [
  {
    name: 'extension host identity mismatch',
    reply: (response, identity) => response.end(JSON.stringify({ ...identity, instanceId: randomUUID() })),
    diagnostic: /failed during the VS Code bridge handshake because the extension host identity did not match.*Reload the extension host.*restart the MCP client/
  },
  {
    name: 'workspace identity mismatch',
    reply: (response, identity) => response.end(JSON.stringify({
      ...identity, workspace: { workspacePath: path.join(process.cwd(), 'different-workspace') }
    })),
    diagnostic: /failed during the VS Code bridge handshake because the bridge workspace did not match.*Open the intended workspace and reconnect the MCP client/
  },
  {
    name: 'handshake HTTP rejection',
    reply: response => response.writeHead(401).end(JSON.stringify({ error: 'private-bridge-detail' })),
    diagnostic: /failed during the VS Code bridge handshake \(HTTP 401\).*rejected the current binding credentials.*restart the MCP client/
  }
];
for (const { name, reply, diagnostic } of handshakeFailures) {
  test(`AL test preflight reports ${name} before requesting the catalog`, { timeout: 10000 }, async t => {
    const { invoke, requests } = await createOperationBridgeFixture(t, (_request, response, identity) => reply(response, identity));
    const result = await invoke({ execute: false });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, diagnostic);
    assert.match(result.content[0].text, /No test operation was started/);
    assert.doesNotMatch(result.content[0].text, /private-bridge-detail/);
    assert.deepEqual(requests.map(request => request.route), ['/handshake']);
  });
}

test('AL test preflight reports a reset catalog connection with its safe transport code', { timeout: 10000 }, async t => {
  const { invoke, requests } = await createOperationBridgeFixture(t, (request, response, identity) => {
    if (request.url === '/handshake') response.end(JSON.stringify(identity));
    else request.socket.destroy();
  });
  const result = await invoke({ execute: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /workspace test catalog request \(ECONNRESET\).*connection closed.*Reload the extension host.*restart the MCP client.*No test operation was started/);
  assert.deepEqual(requests.map(request => request.route), ['/handshake', '/test-codeunit-catalog']);
});

test('AL test preflight reports the catalog HTTP failure without exposing the backend body', { timeout: 10000 }, async t => {
  const { invoke, requests } = await createOperationBridgeFixture(t, (request, response, identity) => {
    if (request.url === '/handshake') response.end(JSON.stringify(identity));
    else response.writeHead(500).end(JSON.stringify({ error: 'private-bridge-detail' }));
  });
  const result = await invoke({ execute: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /could not read the workspace test catalog \(HTTP 500\).*extension output.*No test operation was started/);
  assert.doesNotMatch(result.content[0].text, /private-bridge-detail/);
  assert.deepEqual(requests.map(request => request.route), ['/handshake', '/test-codeunit-catalog']);
});

test('test preflight no longer reads settings to select a named container', t => {
  const operation = { id: 'invokeTests', promptInputs: [{ inputName: 'executeTestsInContainer' }] };
  const read = t.mock.method(fs, 'readFileSync', () => { throw new Error('Unexpected filesystem access'); });
  const context = { workspaceBasePath: __dirname, workspacePath: __dirname };
  assert.deepEqual(mcpServer.getPreflightPromptInputs(operation, {}, context), operation.promptInputs);
  assert.equal(read.mock.callCount(), 0);
});

test('preflight rejects escaping paths before any filesystem read', t => {
  const root = authorizeRoot(__dirname, 'Test workspace');
  const context = { workspaceBasePath: root, workspacePath: root };
  const operation = { id: 'invokeTests', promptInputs: [{ inputName: 'executeTestsInContainer' }] };
  const read = t.mock.method(fs, 'readFileSync', () => { throw new Error('Unexpected filesystem access'); });
  for (const args of [
    { workspacePath: '..' },
    { workspaceFile: '../outside.code-workspace' },
    { localSettingsPath: '../outside.json' },
    { localSettingsPath: path.resolve(root, '../outside.json') }
  ]) {
    assert.deepEqual(mcpServer.getPreflightPromptInputs(operation, args, context), operation.promptInputs);
  }
  assert.equal(read.mock.callCount(), 0);
});

test('serves repository help as an agent tool and Markdown resource', async () => {
  const helpTool = mcpServer.getTools().find((tool) => tool.name === 'bc_dev_toolset_show_help');
  const helpResource = mcpServer.getResources().find((resource) => resource.uri === 'bcdevtoolset://help/readme');
  const helpToolResult = await mcpServer.callTool({ name: 'bc_dev_toolset_show_help', arguments: {} });
  const help = await mcpServer.readResource({ uri: 'bcdevtoolset://help/readme' });

  assert.ok(helpTool);
  assert.deepEqual(helpTool.inputSchema, { type: 'object', properties: {} });
  assert.match(helpTool.description, /repository README/);
  assert.equal(helpResource.mimeType, 'text/markdown');
  assert.equal(helpToolResult.isError, false);
  assert.match(helpToolResult.content[0].text, /^# Business Central Developer's Toolset/m);
  assert.equal(help.contents[0].mimeType, 'text/markdown');
  assert.match(help.contents[0].text, /^# Business Central Developer's Toolset/m);
  assert.match(help.contents[0].text, /BC Dev Toolset: Show Help/);
});

test('compiles successful test output without prerequisite stage chatter', () => {
  const report = {
    applicationCount: 2,
    selectedCodeunitIds: [60990, 60992],
    total: 12,
    passed: 11,
    failed: 0,
    skipped: 1,
    durationSeconds: 4.25,
    failures: [],
    omittedFailureCount: 0,
    allPassed: true
  };
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    'verbose successful compiler output',
    '__BCDEVTOOLSET_STAGE__build::succeeded',
    '__BCDEVTOOLSET_STAGE__prepare::started',
    'verbose successful deployment output',
    '__BCDEVTOOLSET_STAGE__prepare::succeeded',
    '__BCDEVTOOLSET_STAGE__tests::started',
    '__BCDEVTOOLSET_STAGE__tests::succeeded'
  ].join('\n');

  const compiled = mcpServer.compileInvokeTestsReport(output, 'completed', report);

  assert.match(compiled, /Test scope: codeunits 60990, 60992/);
  assert.match(compiled, /12 total, 11 passed, 0 failed, 1 skipped/);
  assert.match(compiled, /Build workspace apps: succeeded/);
  assert.doesNotMatch(compiled, /verbose successful compiler output/);
  assert.doesNotMatch(compiled, /verbose successful deployment output/);
});

test('compatibility AL test report lists configured and actual versions per target', () => {
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    '__BCDEVTOOLSET_STAGE__build::succeeded',
    '__BCDEVTOOLSET_STAGE__prepare::started',
    '__BCDEVTOOLSET_STAGE__prepare::succeeded',
    '__BCDEVTOOLSET_STAGE__tests::started',
    '__BCDEVTOOLSET_STAGE__tests::succeeded'
  ].join('\n');
  const report = mcpServer.compileInvokeTestsReport(output, 'completed', {
    total: 1, passed: 1, failed: 0, skipped: 0, applicationCount: 1, durationSeconds: 1,
    targets: [{ name: 'BC27.1', targetPlatform: '27.1.0.0', actualApplicationVersion: '27.1.0.0', status: 'passed' }]
  });
  assert.match(report, /Target BC27\.1: configured BC 27\.1\.0\.0, actual application 27\.1\.0\.0; passed/);
});

test('reports each completed AL test stage once while waiting for the final MCP result', () => {
  const messages = [];
  const progress = { report: (message) => messages.push(message) };
  const reportedStages = new Set();
  const buildOutput = [
    '__BCDEVTOOLSET_STAGE__build::started',
    '__BCDEVTOOLSET_STAGE__build::succeeded',
    '__BCDEVTOOLSET_STAGE__prepare::started'
  ].join('\n');
  assert.equal(mcpServer.reportCompletedTestStages(buildOutput, reportedStages, progress), true);
  assert.equal(mcpServer.reportCompletedTestStages(buildOutput, reportedStages, progress), false);
  assert.deepEqual(messages, ['Build workspace apps: succeeded']);

  const completedOutput = [
    buildOutput,
    '__BCDEVTOOLSET_STAGE__prepare::succeeded',
    '__BCDEVTOOLSET_STAGE__tests::started',
    '__BCDEVTOOLSET_STAGE__tests::failed'
  ].join('\n');
  assert.equal(mcpServer.reportCompletedTestStages(completedOutput, reportedStages, progress), true);
  assert.deepEqual(messages, [
    'Build workspace apps: succeeded',
    'Prepare test container and deploy apps: succeeded',
    'Execute AL tests: failed'
  ]);
});

test('AL test MCP wait sends interim stage reports and returns the final result', async () => {
  const messages = [];
  const outputs = [
    '__BCDEVTOOLSET_STAGE__build::succeeded',
    '__BCDEVTOOLSET_STAGE__build::succeeded\n__BCDEVTOOLSET_STAGE__prepare::succeeded',
    '__BCDEVTOOLSET_STAGE__build::succeeded\n__BCDEVTOOLSET_STAGE__prepare::succeeded\n__BCDEVTOOLSET_STAGE__tests::succeeded'
  ];
  let call = 0;
  const status = await mcpServer.waitForTestOperationWithProgress('test-session', {
    report: (message) => messages.push(message)
  }, {
    getStatus: async () => ({ statusCode: 200, body: {
      status: call === 2 ? 'completed' : 'running',
      sessionId: 'test-session',
      result: { output: outputs[call++] }
    } }),
    wait: async () => {}
  });
  assert.equal(status.status, 'completed');
  assert.equal(call, 3);
  assert.deepEqual(messages, [
    'Build workspace apps: succeeded',
    'Prepare test container and deploy apps: succeeded',
    'Execute AL tests: succeeded'
  ]);
});

test('resumed AL test MCP wait honors its completion timeout', async () => {
  let elapsedMs = 0;
  let polls = 0;
  const status = await mcpServer.waitForTestOperationWithProgress('resumed-session', { report: () => {} }, {
    timeoutSeconds: 2,
    now: () => elapsedMs,
    wait: async (milliseconds) => { elapsedMs += milliseconds; },
    getStatus: async () => {
      polls += 1;
      return { statusCode: 200, body: { status: 'running', sessionId: 'resumed-session' } };
    }
  });

  assert.equal(polls, 3);
  assert.equal(status.status, 'running');
  assert.equal(status.timedOutWaitingForCompletion, true);
  assert.match(mcpServer.formatOperationStatus(status), /use bc_dev_toolset_get_operation_status/);
});

test('combined test report exposes isolation groups and unmatched selections', () => {
  const compiled = mcpServer.compileInvokeTestsReport('__BCDEVTOOLSET_STAGE__tests::failed', 'failed', {
    applicationCount: 1, total: 3, passed: 1, failed: 1, skipped: 1, durationSeconds: 2,
    testIsolationDisabledCodeunits: [60990, 60992], unmatchedCodeunitIds: [60992],
    groups: [
      { app: 'Tests', container: 'bc23', isolation: 'Codeunit', runner: 130450, codeunitFilter: '60991', total: 1, passed: 0, failed: 1, skipped: 0, durationSeconds: 1, status: 'failed' },
      { app: 'Tests', container: 'bc23', isolation: 'Disabled', runner: 130451, codeunitFilter: '60990', total: 2, passed: 1, failed: 0, skipped: 1, durationSeconds: 1, status: 'passed' }
    ],
    failures: [{ app: 'Tests', codeunit: '60991', method: 'Regression', message: 'assertion' }],
    omittedFailureCount: 4, allPassed: false
  });
  assert.match(compiled, /Status: failed/);
  assert.match(compiled, /3 total, 1 passed, 1 failed, 1 skipped/);
  assert.match(compiled, /Applications tested: 1/);
  assert.match(compiled, /Isolation disabled for codeunits: 60990, 60992/);
  assert.match(compiled, /Codeunit, runner 130450, filter 60991/);
  assert.match(compiled, /Disabled, runner 130451, filter 60990/);
  assert.match(compiled, /Configured codeunits not discovered: 60992/);
  assert.match(compiled, /Failure details omitted: 4/);
  assert.match(compiled, /Regression/);
});

test('includes build diagnostics when the nested test build stage fails', () => {
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    "Building 'Payroll' using its isolated project package cache...",
    "src/codeunit.al(8,5): info AL0604: Compiling procedure 'PostPayroll'",
    "src/codeunit.al(9,5): warning AL0603: An implicit conversion is being performed",
    "src/codeunit.al(10,5): error AL0132: 'Record' does not contain a definition",
    '__BCDEVTOOLSET_STAGE__build::failed',
    "AL compilation failed for 'Payroll' (process exit code: 1)."
  ].join('\n');

  const compiled = mcpServer.compileInvokeTestsReport(output, 'failed');

  assert.match(compiled, /Build workspace apps: failed/);
  assert.match(compiled, /error AL0132/);
  assert.doesNotMatch(compiled, /info AL0604/);
  assert.doesNotMatch(compiled, /warning AL0603/);
  assert.doesNotMatch(compiled, /AL compilation failed for 'Payroll'/);
  assert.doesNotMatch(compiled, /Prepare test container/);
});

test('reports blocking build warnings with repair instructions and a bounded diagnostic list', () => {
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    ...Array.from({ length: 22 }, (_, index) => `src/app.al(${index + 1},5): warning AL0603: Conversion ${index + 1}`),
    '__BCDEVTOOLSET_BUILD_WARNINGS_BLOCKED__',
    '__BCDEVTOOLSET_STAGE__build::failed'
  ].join('\n');
  const compiled = mcpServer.compileInvokeTestsReport(output, 'failed');
  assert.match(compiled, /Build workspace apps: failed/);
  assert.match(compiled, /testBuildWarningsAsErrors=true/);
  assert.match(compiled, /Resolve the reported compiler warnings, then rerun the AL test operation/);
  assert.match(compiled, /app.al\(20,5\): warning AL0603/);
  assert.doesNotMatch(compiled, /app.al\(21,5\)/);
  assert.match(compiled, /Build warning diagnostics omitted: 2/);
  assert.doesNotMatch(compiled, /Prepare test container/);
});

test('limits build diagnostics to the first 20 AL compiler errors', () => {
  const compilerErrors = Array.from(
    { length: 22 },
    (_, index) => `src/codeunit-${index + 1}.al(10,5): error AL9${String(index + 1).padStart(4, '0')}: Failure ${index + 1}`
  );
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    ...compilerErrors,
    '__BCDEVTOOLSET_STAGE__build::failed'
  ].join('\n');

  const compiled = mcpServer.compileInvokeTestsReport(output, 'failed');

  assert.match(compiled, /error AL90020: Failure 20/);
  assert.doesNotMatch(compiled, /error AL90021: Failure 21/);
  assert.match(compiled, /Build error diagnostics omitted: 2 \(the first 20 are shown\)/);
});

test('retains complete build output when no AL compiler errors can be recognized', () => {
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    'The configured ALTool executable could not be started.',
    '__BCDEVTOOLSET_STAGE__build::failed',
    'Access to the executable was denied.'
  ].join('\n');

  const compiled = mcpServer.compileInvokeTestsReport(output, 'failed');

  assert.match(compiled, /configured ALTool executable could not be started/);
  assert.match(compiled, /Access to the executable was denied/);
});

test('includes prepare diagnostics when test container preparation fails', () => {
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    '__BCDEVTOOLSET_STAGE__build::succeeded',
    '__BCDEVTOOLSET_STAGE__prepare::started',
    "Container 'bc-test' could not be created.",
    '__BCDEVTOOLSET_STAGE__prepare::failed',
    'Docker reported that the requested artifact was unavailable.'
  ].join('\n');

  const compiled = mcpServer.compileInvokeTestsReport(output, 'failed');

  assert.match(compiled, /Prepare test container and deploy apps: failed/);
  assert.match(compiled, /Container 'bc-test' could not be created/);
  assert.match(compiled, /requested artifact was unavailable/);
  assert.doesNotMatch(compiled, /Execute AL tests/);
});

test('reports bounded individual AL test failures from the compiled result', () => {
  const report = {
    applicationCount: 1,
    total: 3,
    passed: 1,
    failed: 2,
    skipped: 0,
    durationSeconds: 1.5,
    omittedFailureCount: 4,
    failures: [{
      app: 'Payroll Tests',
      codeunit: '50100 Payroll Tests',
      method: 'RejectsInvalidPeriod',
      message: 'Expected an error.',
      stackTrace: 'PayrollTests.RejectsInvalidPeriod line 42'
    }]
  };
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    '__BCDEVTOOLSET_STAGE__build::succeeded',
    '__BCDEVTOOLSET_STAGE__prepare::started',
    '__BCDEVTOOLSET_STAGE__prepare::succeeded',
    '__BCDEVTOOLSET_STAGE__tests::started',
    '__BCDEVTOOLSET_STAGE__tests::failed',
    '2 of 3 AL tests failed.'
  ].join('\n');

  const compiled = mcpServer.compileInvokeTestsReport(output, 'failed', report);

  assert.match(compiled, /3 total, 1 passed, 2 failed/);
  assert.match(compiled, /Payroll Tests \/ 50100 Payroll Tests \/ RejectsInvalidPeriod/);
  assert.match(compiled, /Expected an error/);
  assert.match(compiled, /Failure details omitted: 4/);
  assert.match(compiled, /Execute AL tests diagnostics:/);
  assert.match(compiled, /2 of 3 AL tests failed/);
});

test('pre-supplies testing prompt answers for test operations', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers({ id: 'invokeTests' }, {}),
    {
      'tests.executeInContainer': 'yes',
      'tests.createMissingContainer.pullFullArtifact': 'no'
    }
  );
});

test('does not pre-supply testing prompt answers for non-test operations', () => {
  assert.deepEqual(mcpServer.getOperationPromptAnswers({ id: 'newDockerContainer' }, {}), {});
});

test('maps every declared operation input to its canonical PowerShell prompt id', () => {
  const operation = JSON.parse(fs.readFileSync( // nosemgrep -- fixed segments resolve to a repository-owned test fixture beneath __dirname
    path.join(__dirname, '..', '..', 'operations', 'operations.json'), 'utf8'))
    .find((candidate) => candidate.id === 'newDockerContainer');

  assert.deepEqual(
    mcpServer.getOperationPromptAnswers(operation, {
      clearTranslationFiles: false,
      clearAppFiles: false,
      pullFullArtifact: true
    }),
    {
      'clearArtifacts.translationFiles': false,
      'clearArtifacts.appFiles': false,
      'newDockerContainer.pullFullArtifact': true
    }
  );
});

test('exposes the workspace name on the initialization MCP tool', () => {
  const initializeWorkspaceTool = mcpServer.getTools().find((tool) => tool.name === 'bc_dev_toolset_initialize_workspace');

  assert.equal(initializeWorkspaceTool.inputSchema.properties.workspaceName.type, 'string');
});

test('maps the workspace name to the initialization prompt', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers({ id: 'initializeWorkspace' }, { workspaceName: 'Sales Workspace' }),
    { 'initializeWorkspace.workspaceName': 'Sales Workspace' }
  );
});

test('maps test operation prompt aliases to prompt answers', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers(
      { id: 'invokeTests' },
      {
        executeTestsInContainer: true,
        pullFullArtifact: false
      }
    ),
    {
      'tests.executeInContainer': 'yes',
      'tests.createMissingContainer.pullFullArtifact': 'no'
    }
  );
});

test('lets explicit prompt answers override operation defaults', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers(
      { id: 'invokeTests' },
      {
        promptAnswers: {
          'tests.executeInContainer': 'no',
          'custom.prompt': false
        }
      }
    ),
    {
      'tests.executeInContainer': 'no',
      'tests.createMissingContainer.pullFullArtifact': 'no',
      'custom.prompt': false
    }
  );
});

test('maps backup container selection aliases to prompt answers', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers(
      { id: 'backupBcContainerDatabases' },
      {
        containerSelection: 2
      }
    ),
    {
      'selectIndex.Select.container.for.SQL.backup.export.': '2',
      'selectIndex.Select.container.for.SQL.backup.restore.': '2'
    }
  );
});

test('exposes and maps the Add Test Toolkit container selection', () => {
  const tool = mcpServer.getTools().find((candidate) =>
    candidate.name === 'bc_dev_toolset_add_test_toolkit_to_bc_container');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.containerSelection.type, 'string');

  const operation = JSON.parse(fs.readFileSync( // nosemgrep -- fixed segments resolve to a repository-owned test fixture beneath __dirname
    path.join(__dirname, '..', '..', 'operations', 'operations.json'), 'utf8'))
    .find((candidate) => candidate.id === 'addTestToolkitToBcContainer');
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers(operation, { containerSelection: '2' }),
    { 'selectIndex.Select.the.container.configuration.to.add.Test.Toolkit.to.': '2' }
  );
});

test('does not map empty backup container selection aliases', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers(
      { id: 'backupBcContainerDatabases' },
      {
        containerSelection: ''
      }
    ),
    {}
  );
});

test('maps backup container name aliases so choice prompts can reject them', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers(
      { id: 'backupBcContainerDatabases' },
      {
        containerSelection: 'newdritest'
      }
    ),
    {
      'selectIndex.Select.container.for.SQL.backup.export.': 'newdritest',
      'selectIndex.Select.container.for.SQL.backup.restore.': 'newdritest'
    }
  );
});
