'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { __test: mcpServer } = require('../mcp-server');

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

test('includes build diagnostics when the nested test build stage fails', () => {
  const output = [
    '__BCDEVTOOLSET_STAGE__build::started',
    "Building 'Payroll' using its isolated project package cache...",
    "src/codeunit.al(10,5): error AL0132: 'Record' does not contain a definition",
    '__BCDEVTOOLSET_STAGE__build::failed',
    "AL compilation failed for 'Payroll' (process exit code: 1)."
  ].join('\n');

  const compiled = mcpServer.compileInvokeTestsReport(output, 'failed');

  assert.match(compiled, /Build workspace apps: failed/);
  assert.match(compiled, /error AL0132/);
  assert.match(compiled, /AL compilation failed for 'Payroll'/);
  assert.doesNotMatch(compiled, /Prepare test container/);
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
  assert.doesNotMatch(compiled, /2 of 3 AL tests failed/);
});

test('pre-supplies testing prompt answers for test operations', () => {
  assert.deepEqual(
    mcpServer.getOperationPromptAnswers({ id: 'invokeTests' }, {}),
    {
      'selectIndex.Select.the.container.configuration.to.execute.tests.in.': '1',
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
        testContainerSelection: 2,
        executeTestsInContainer: true,
        pullFullArtifact: false
      }
    ),
    {
      'selectIndex.Select.the.container.configuration.to.execute.tests.in.': '2',
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
        testContainerSelection: 2,
        promptAnswers: {
          'tests.executeInContainer': 'no',
          'custom.prompt': false
        }
      }
    ),
    {
      'selectIndex.Select.the.container.configuration.to.execute.tests.in.': '2',
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
