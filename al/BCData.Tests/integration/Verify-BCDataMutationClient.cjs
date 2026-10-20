'use strict';
// Actual Node mutation client against fixed, owned fixture records only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10, DataTransportError } = require('../../../vscode-extension/bc-data-http10');
const { resolveWithinRoot } = require('../../../vscode-extension/path-security');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC24 Matrix': 'bcdata24test', 'BC25 Matrix': 'bcdata25test', 'BC26 Matrix': 'bcdata26test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, input.target)); assert.equal(input.container, targets[input.target]);
  const root = path.resolve(__dirname, '../../..');
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `mutation-client-${input.container}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `mutation-client-${input.container}-evidence.json`);
  const connection = { id: input.target, baseUrl: `http://${input.container}:7048/BC/ODataV4`, ...input.admin,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'mutation-client-http-1' };
  const readClient = createDataClient({ resolveConnection: () => connection });
  const companyId = (await readClient.listCompanies(connection.id)).companies[0].id;
  const readiness = await readClient.readiness(connection.id, companyId);
  function redact(value) { return String(value).split(connection.password).join('[redacted]')
    .split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0, 1024); }
  async function fixture(action, payload) {
    assert.match(payload.runId, guid);
    const url = new URL(`${connection.baseUrl}/BCDCompatibilityCoord_${action}`);
    url.searchParams.set('tenant', 'default'); url.searchParams.set('company', companyId);
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      body: { inputJson: JSON.stringify(payload) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    assert.equal(response.status, 200, redact(envelope.error?.message));
    return JSON.parse(envelope.value);
  }
  let state;
  async function cleanup() {
    for (const run of state.runs) {
      // Prepare/registration are atomic and owned. Inspect recovers a lost preparation reply.
      let inspected;
      try { inspected = await fixture('Inspect', run); } catch {
        const absent = await fixture('CleanState', { ...run, otherRequestId: run.otherRequestId || run.runId });
        assert.deepEqual(absent, { runExists: false, rows: 0, logs: 0, receiptExists: false, otherReceiptExists: false,
          ...(run.clientRequestId ? { clientReceiptExists: false } : {}) });
        continue;
      }
      run.otherRequestId = inspected.otherRequestId;
      assert.equal((await fixture('Cleanup', run)).cleaned, true);
      assert.deepEqual(await fixture('CleanState', run), { runExists: false, rows: 0, logs: 0, receiptExists: false,
        otherReceiptExists: false, ...(run.clientRequestId ? { clientReceiptExists: false } : {}) });
    }
    fs.unlinkSync(statePath);
  }
  if (input.cleanupOnly) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.target, input.target); assert.equal(state.companyId, companyId);
    assert.ok(Array.isArray(state.runs) && state.runs.length <= 10);
    await cleanup(); return { cleaned: true, target: input.target };
  }
  assert.ok(!fs.existsSync(statePath), 'Recover the previous mutation-client run with -CleanupOnly.');
  state = { target: input.target, companyId, runs: [] };
  fs.writeFileSync(statePath, JSON.stringify(state), { flag: 'wx' });
  const results = [];
  async function check(name, operation, options = {}) {
    const run = { runId: crypto.randomUUID() }; state.runs.push(run);
    const save = () => fs.writeFileSync(statePath, JSON.stringify(state)); save();
    const result = { name, passed: false }; results.push(result);
    try {
      const prepared = await fixture('Prepare', { ...run, operation, delayMs: 0 });
      run.otherRequestId = prepared.otherRequestId; save();
      let executeCount = 0;
      const bodies = [];
      let dropped = 0;
      const client = createDataClient({ resolveConnection: () => connection, transport: async call => {
        const request = JSON.parse(call.body.inputJson);
        if (call.url.includes('BCDDataWrite_Prepare')) {
          run.clientRequestId = request.requestId; save();
          await fixture('RegisterClientRequest', { ...run, requestId: request.requestId });
        }
        if (call.url.includes('BCDDataWrite_Execute')) { executeCount++; bodies.push(call.body.inputJson); }
        const response = await requestHttp10(call);
        if (call.url.includes('BCDDataWrite_Execute') && response.status === 200 && dropped < (options.drop || 0)) {
          dropped++;
          // Actual server response arrived; intentionally discard it before decoding.
          throw new DataTransportError('incomplete_response', response.status, response.body.length);
        }
        return response;
      } });
      const request = { connectionId: connection.id, companyId, tableId: 50221 };
      if (operation !== 'insert') Object.assign(request, { systemId: prepared.systemId, expectedVersion: prepared.version });
      if (operation === 'insert') request.fields = [{ fieldId: 1, value: run.runId }, { fieldId: 2, value: 'A' }, { fieldId: 3, value: 1 },
        { fieldId: 4, value: options.validation ? '-1' : '4' }];
      if (operation === 'modify') request.fields = [{ fieldId: options.flowField ? 21 : 4, value: '4' }];
      if (operation === 'rename') request.primaryKey = [{ fieldId: 1, value: run.runId }, { fieldId: 2, value: 'B' }, { fieldId: 3, value: 1 }];
      if (options.stale) request.expectedVersion = String(BigInt(prepared.version) - 1n);
      if (options.invalid) request.fields = [{ fieldId: 4, value: null }];
      const method = { insert: 'insertRecord', modify: 'modifyRecord', rename: 'renameRecord', delete: 'deleteRecord' }[operation];
      let value;
      let failure;
      try { value = await client[method](request); } catch (error) { failure = error; }
      const observed = await fixture('Inspect', run);
      if (options.unknown) {
        assert.equal(failure?.outcome, 'unknown'); assert.equal(failure.requestId, run.clientRequestId);
        assert.equal(executeCount, 2); assert.equal(bodies[0], bodies[1]);
        assert.equal(observed.logs, prepared.logs + 1); assert.equal(observed.modifyCount, 1);
        assert.equal(observed.clientCompleted, true); assert.equal(observed.clientClosed, false);
      } else if (options.stale || options.validation || options.flowField || options.invalid) {
        assert.equal(failure?.outcome, 'not_applied');
        if (options.stale) assert.equal(failure.category, 'concurrency_conflict');
        if (options.flowField) assert.equal(failure.category, 'unsupported_operation');
        if (options.invalid) assert.equal(failure.category, 'invalid_input');
        assert.equal(executeCount, options.invalid ? 0 : 1);
        assert.equal(observed.logs, prepared.logs); assert.equal(observed.rows, prepared.rows);
        if (!options.invalid) { assert.equal(observed.clientCompleted, false); assert.equal(observed.clientClosed, true); }
      } else {
        assert.equal(failure, undefined, failure && redact(failure.message));
        assert.equal(value.outcome, 'applied'); assert.equal(value.scopeCloseConfirmed, true);
        assert.equal(value.requestId, run.clientRequestId);
        assert.equal(observed.clientCompleted, true); assert.equal(observed.clientClosed, true);
        assert.equal(executeCount, options.drop ? 2 : 1);
        if (options.drop) assert.equal(bodies[0], bodies[1]);
        assert.equal(observed.logs, prepared.logs + 1);
        assert.equal(observed.rows, operation === 'delete' ? 0 : 1);
        if (operation === 'rename') assert.equal(observed.name, 'B');
        if (operation === 'delete') { assert.equal(value.values, undefined); assert.equal(value.version, undefined); }
        else assert.equal(value.version, observed.version);
      }
      Object.assign(result, { passed: true, executeCount, observed, ...(failure ? { outcome: failure.outcome } : {}) });
    } catch (error) { result.error = redact(error.message); }
    fs.writeFileSync(evidencePath, JSON.stringify({ target: input.target, results, cleaned: false }, null, 2));
  }
  try {
    for (const operation of ['insert', 'modify', 'rename', 'delete']) await check(`public client ${operation} uses native persisted state`, operation);
    await check('committed response loss replays one immutable request then closes scope', 'modify', { drop: 1 });
    await check('stale public modification is not retried with a fresh version', 'modify', { stale: true });
    await check('native validation rollback returns not_applied without another attempt', 'insert', { validation: true });
    await check('unqualified FlowField change returns unsupported without writing', 'modify', { flowField: true });
    await check('invalid local typed input makes no business HTTP request', 'modify', { invalid: true });
    await check('two discarded replies preserve unknown despite one actual application', 'modify', { drop: 2, unknown: true });
  } finally { await cleanup(); }
  const evidence = { target: input.target, companyId, appVersion: readiness.appVersion, utc: new Date().toISOString(),
    results, cleaned: true, passed: results.length === 10 && results.every(result => result.passed) };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); return evidence;
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try { const input = JSON.parse(raw); raw = ''; const result = await main(input); process.stdout.write(JSON.stringify(result)); if (result.passed === false) process.exitCode = 1; }
  catch { process.stderr.write('Public mutation-client qualification failed; recover with -CleanupOnly.'); process.exitCode = 1; }
});
