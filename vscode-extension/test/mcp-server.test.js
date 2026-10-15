'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('test preflight exposes confirmation and creation questions without a container-name selector', async () => {
  for (const name of ['bc_dev_toolset_invoke_tests', 'bc_dev_toolset_invoke_page_script_tests']) {
    const result = await mcpServer.callTool({ name, arguments: {} });
    const preflight = JSON.parse(result.content[0].text);
    assert.equal(preflight.status, 'input_required');
    assert.ok(preflight.missingInputs.includes('executeTestsInContainer'));
    assert.equal(preflight.questions.some(input => input.inputName === 'testContainerSelection'), false);
    assert.ok(preflight.questions.some(input => input.inputName === 'pullFullArtifact'));
    assert.equal(Object.hasOwn(preflight, 'conditionalPrompts'), false);
  }
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
