'use strict';
// Dedicated generic coordinator fixture. Credentials arrive only on private stdin.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { resolveWithinRoot } = require('../../../vscode-extension/path-security');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC24 Matrix': 'bcdata24test', 'BC25 Matrix': 'bcdata25test', 'BC26 Matrix': 'bcdata26test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, input.target));
  assert.equal(input.container, targets[input.target]);
  const root = path.resolve(__dirname, '../../..');
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `coord-${input.container}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `coord-${input.container}-evidence.json`);
  const connection = { id: input.target, baseUrl: `http://${input.container}:7048/BC/ODataV4`,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'coord-http-1',
    username: input.admin.username, password: input.admin.password };
  const client = createDataClient({ resolveConnection: () => connection });
  const companyId = (await client.listCompanies(connection.id)).companies[0].id;
  const readiness = await client.readiness(connection.id, companyId);
  const redact = value => String(value).split(connection.password).join('[redacted]')
    .split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0, 1024);
  if (input.inspectLockingFeatures) {
    assert.notEqual(input.cleanupOnly, true);
    const url = new URL(`${connection.baseUrl}/BCDCompatibilityCoord_LockingFeatures`);
    url.searchParams.set('company', companyId); url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password, body: {} });
    assert.equal(response.status, 200, 'Native locking feature inspection failed.');
    const value = JSON.parse(JSON.parse(response.body.toString('utf8')).value);
    assert.ok(Array.isArray(value.features));
    return { target: input.target, companyId, appVersion: readiness.appVersion,
      utc: new Date().toISOString(), features: value.features };
  }
  const executions = new Map();
  async function call(action, payload, signal, maxResponseBytes) {
    assert.match(payload.runId, guid);
    const url = new URL(`${connection.baseUrl}/BCDCompatibilityCoord_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) }, signal, maxResponseBytes });
    const envelope = JSON.parse(response.body.toString('utf8'));
    if (action === 'Execute') {
      const entries = executions.get(payload.runId) || [];
      entries.push({ status: response.status, ...(envelope.error ? { message: redact(envelope.error.message) } : {}) });
      executions.set(payload.runId, entries);
    }
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { message: redact(envelope.error?.message) }) };
  }
  let state;
  async function cleanup() {
    for (const run of state.runs) {
      assert.match(run.runId, guid);
      // Inspect also recovers the secondary GUID if Prepare committed but its response was lost.
      const inspected = await call('Inspect', run);
      if (inspected.status !== 200) {
        const clean = await call('CleanState', { ...run, otherRequestId: run.otherRequestId || run.runId });
        assert.equal(clean.status, 200);
        assert.equal(clean.value.runExists, false);
        assert.equal(clean.value.rows, 0);
        assert.equal(clean.value.logs, 0);
        assert.equal(clean.value.receiptExists, false);
        assert.equal(clean.value.otherReceiptExists, false);
        continue;
      }
      run.otherRequestId = inspected.value.otherRequestId;
      assert.equal((await call('Cleanup', run)).status, 200);
      const clean = await call('CleanState', run);
      assert.equal(clean.status, 200);
      assert.deepEqual(clean.value, { runExists: false, rows: 0, logs: 0, receiptExists: false, otherReceiptExists: false });
    }
    fs.unlinkSync(statePath);
  }
  if (input.cleanupOnly) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.target, input.target);
    assert.equal(state.companyId, companyId);
    assert.ok(Array.isArray(state.runs) && state.runs.length <= 8);
    await cleanup();
    return { target: input.target, cleaned: true };
  }
  assert.ok(!fs.existsSync(statePath), 'Run -CleanupOnly for interrupted coordinator qualification.');
  state = { target: input.target, companyId, runs: [] };
  fs.writeFileSync(statePath, JSON.stringify(state), { flag: 'wx' });
  const results = [];
  const pendingCalls = [];
  function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }
  function rejected(response, code) {
    assert.ok(response.status >= 400);
    assert.ok(response.message.includes(code), response.message);
  }
  async function inspect(runId) {
    const response = await call('Inspect', { runId });
    assert.equal(response.status, 200);
    return response.value;
  }
  async function observedPending(runId, finished) {
    const deadline = Date.now() + 6000;
    while (!finished() && Date.now() < deadline) {
      const observed = await call('Observe', { runId });
      assert.equal(observed.status, 200);
      if (observed.value.pending) {
        assert.equal(finished(), false);
        assert.notEqual(observed.value.ownerSessionId, observed.value.observerSessionId);
        return observed.value;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Observe the receipt anchor from another session while its owner is pending.');
  }
  async function check(name, operation, test) {
    const run = { runId: crypto.randomUUID() };
    state.runs.push(run); save();
    const result = { name, passed: false };
    results.push(result);
    try {
      const prepared = await call('Prepare', { ...run, operation });
      assert.equal(prepared.status, 200);
      run.otherRequestId = prepared.value.otherRequestId; save();
      const request = { runId: run.runId, epoch: prepared.value.epoch, systemId: prepared.value.systemId,
        expectedVersion: prepared.value.version, quantity: '4', destination: 'B' };
      Object.assign(result, await test(request, prepared.value));
      result.passed = true;
    } catch (error) { result.error = redact(error.message); }
    result.executions = executions.get(run.runId) || [];
    fs.writeFileSync(evidencePath, JSON.stringify({ target: input.target, results, cleaned: false }, null, 2));
  }
  async function race(request, mode, prepared) {
    let finished = false;
    const owner = call('Execute', request).finally(() => { finished = true; });
    pendingCalls.push(owner); owner.catch(() => {});
    const barrier = await observedPending(request.runId, () => finished);
    const competitor = { ...request, ...(mode === 'mismatch' ? { quantity: '9' } : {}),
      ...(mode === 'distinct' ? { slot: 2, epoch: prepared.otherEpoch, quantity: '9' } : {}) };
    const second = await call('Execute', competitor);
    const first = await owner;
    assert.equal(first.status, 200);
    if (mode === 'identical') { assert.equal(second.status, 200); assert.equal(second.text, first.text); }
    else rejected(second, mode === 'mismatch' ? 'BCD_REQUEST_ID_REUSED' : 'BCD_CONCURRENCY_CONFLICT');
    const actual = await inspect(request.runId);
    assert.equal(actual.completed, true);
    assert.equal(actual.otherCompleted, false);
    assert.equal(actual.logs, prepared.logs + 1);
    return { barrier, observed: actual };
  }
  try {
    for (const operation of ['insert', 'modify', 'rename', 'delete']) {
      await check(`overlapping identical ${operation} applies once`, operation, async (request, prepared) => {
        const result = await race(request, 'identical', prepared);
        if (operation === 'delete') assert.equal(result.observed.rows, 0);
        else {
          assert.equal(result.observed.rows, 1);
          if (operation === 'insert') assert.equal(result.observed.insertCount, 1);
          if (operation === 'modify') assert.equal(result.observed.modifyCount, 1);
          if (operation === 'rename') assert.equal(result.observed.name, 'B');
        }
        return result;
      });
    }
    await check('overlapping different payload rejects ID reuse', 'modify', (request, prepared) => race(request, 'mismatch', prepared));
    await check('distinct requests serialize and reject the stale competitor', 'modify', (request, prepared) => race(request, 'distinct', prepared));
    await check('discarded committed response retains unknown outcome then replays one write', 'modify', async (request, prepared) => {
      let finished = false;
      // Fixture-only one-byte response bound discards the successful result on arrival.
      // Production response bounds stay unchanged. Do not equate pending cancellation
      // with response loss AFTER commit; independently verify the receipt below.
      const lost = call('Execute', request, undefined, 1).then(() => { throw new Error('Response should have been discarded.'); },
        error => ({ code: error.code, outcome: error.outcome, status: error.status })).finally(() => { finished = true; });
      pendingCalls.push(lost);
      lost.catch(() => {});
      const barrier = await observedPending(request.runId, () => finished);
      assert.deepEqual(await lost, { code: 'response_too_large', outcome: 'unknown', status: 200 });
      let committedBeforeReplay;
      const commitDeadline = Date.now() + 10000;
      do {
        committedBeforeReplay = await inspect(request.runId);
        if (committedBeforeReplay.completed) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < commitDeadline);
      assert.equal(committedBeforeReplay.completed, true, 'Independently observe committed receipt before retrying the lost response.');
      assert.equal(committedBeforeReplay.modifyCount, 1);
      const replay = await call('Execute', request);
      assert.equal(replay.status, 200);
      assert.equal((await call('Execute', request)).text, replay.text);
      const actual = await inspect(request.runId);
      assert.equal(actual.logs, prepared.logs + 1);
      assert.equal(actual.modifyCount, 1);
      return { barrier, observed: actual, transportOutcome: 'unknown' };
    });
    await check('known validation failure rolls back and permits corrected same-scope command', 'insert', async (request, prepared) => {
      rejected(await call('Execute', { ...request, quantity: '-1' }), 'BCD_GENERIC_QUANTITY_NEGATIVE');
      const failed = await inspect(request.runId);
      assert.equal(failed.completed, false);
      assert.equal(failed.rows, 0);
      assert.equal(failed.logs, 0);
      const applied = await call('Execute', request);
      assert.equal(applied.status, 200);
      assert.equal((await call('Execute', request)).text, applied.text);
      const actual = await inspect(request.runId);
      assert.equal(actual.logs, prepared.logs + 1);
      assert.equal(actual.insertCount, 1);
      return { observed: actual };
    });
  } finally {
    await Promise.allSettled(pendingCalls);
    await cleanup();
  }
  const evidence = { target: input.target, companyId, appVersion: readiness.appVersion,
    checkedAt: new Date().toISOString(), transport: 'native-node-http10', results, cleaned: true,
    passed: results.length === 8 && results.every(result => result.passed) };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return evidence;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw); raw = '';
    const result = await main(input);
    process.stdout.write(JSON.stringify(result, null, 2));
    if (result.passed === false) process.exitCode = 1;
  } catch { process.stderr.write('Coordinator qualification failed; inspect credential-free evidence/state and run -CleanupOnly.'); process.exitCode = 1; }
});
