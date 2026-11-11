'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { resolveWithinRoot, authorizeRoot } = require('../path-security');
const { redactContainerHelperCommandLines } = require('../operation-output');
const root = authorizeRoot(path.resolve(__dirname, '..'), 'Extension test source');
const source = fs.readFileSync(resolveWithinRoot(root, 'extension.js'), 'utf8');
const failure = 'docker: hcs::CreateComputeSystem: The paging file is too small for this operation to complete.\nExitCode: 125\nCommandline: docker run --name selected --env securePassword=ENCRYPTED_FIXTURE --env passwordKeyFile="c:\\run\\my\\aes.key"';
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}
const context = {
  redactContainerHelperCommandLines,
  stripAnsi: value => String(value).replace(/\x1b\[[0-9;]*m/g, ''),
  assertMcpCapturePath: value => value,
  readJsonFileIfExists: () => undefined
};

test('helper credential command lines are omitted while native failure cause and code remain', () => {
  const output = redactContainerHelperCommandLines(failure);
  assert.match(output, /paging file is too small/);
  assert.match(output, /ExitCode: 125/);
  assert.match(output, /command line omitted/);
  assert.doesNotMatch(output, /ENCRYPTED_FIXTURE|aes\.key|--env|docker run/);
});

test('credential argument continuations are omitted without hiding adjacent stages', () => {
  const output = redactContainerHelperCommandLines('Creation failed\r\n --env SECUREPASSWORD=OTHER_FIXTURE\r\n --env passwordKeyFile=private.key\r\nReconcile the selected target');
  assert.doesNotMatch(output, /OTHER_FIXTURE|private\.key|--env/);
  assert.match(output, /Creation failed/);
  assert.match(output, /Reconcile the selected target/);
});

test('completed MCP capture redacts transcript and appended error and preserves failed exit status', () => {
  const files = { result: JSON.stringify({ exitCode: 1, error: failure }), transcript: '\u001b[31m' + failure + '\u001b[0m' };
  const result = vm.runInNewContext(
    functionSource('cleanPowerShellTranscript') + '\n' + functionSource('readMcpCaptureResult') + '\nreadMcpCaptureResult({id:"newDockerContainer",title:"Create container"},"BC Dev Toolset: pwsh",{resultPath:"result",transcriptPath:"transcript"})',
    { ...context, readTextFileIfExists: name => files[name] }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.exitCodeSource, 'mcp-capture-file');
  assert.equal(result.operationId, 'newDockerContainer');
  assert.match(result.output, /paging file is too small/);
  assert.match(result.output, /125/);
  assert.doesNotMatch(result.output, /ENCRYPTED_FIXTURE|aes\.key|--env|\x1b/);
});

test('MCP timeout capture also omits credential arguments and retains uncertain failure status', async () => {
  const start = source.indexOf('async function waitForMcpCaptureResult(');
  const end = source.indexOf('\nfunction readMcpCaptureResult(', start);
  assert.ok(start >= 0 && end > start);
  const result = await vm.runInNewContext(
    functionSource('cleanPowerShellTranscript') + '\n' + source.slice(start, end) + '\nwaitForMcpCaptureResult({id:"newDockerContainer",title:"Create container"},"BC Dev Toolset: pwsh",{sessionId:"owned",transcriptPath:"transcript"},{timeoutMs:0})',
    { ...context, fs: { existsSync: () => true }, readTextFileIfExists: () => failure, getOrCreateMcpPromptSession: () => ({}), touchMcpPromptSession: () => {} }
  );
  assert.equal(result.status, 'timeout');
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.match(result.output, /paging file is too small/);
  assert.doesNotMatch(result.output, /ENCRYPTED_FIXTURE|aes\.key|--env/);
});
