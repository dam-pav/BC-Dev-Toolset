'use strict';
// Dedicated receipt/version fixture. Credentials stay in memory/private stdin.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { resolveWithinRoot } = require('../../../vscode-extension/path-security');
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, input.target));
  const container = targets[input.target];
  assert.equal(container, input.container);
  const root = path.resolve(__dirname, '../../..');
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `ev-${container}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `ev-${container}-evidence.json`);
  const connection = { id: input.target, baseUrl: `http://${container}:7048/BC/ODataV4`,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'ev-http-1',
    username: input.admin.username, password: input.admin.password };
  const client = createDataClient({ resolveConnection: () => connection });
  const companyId = (await client.listCompanies(connection.id)).companies[0].id;
  const readiness = await client.readiness(connection.id, companyId);
  const redact = value => String(value).split(connection.password).join('[redacted]')
    .split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0, 2048);
  async function call(action, payload, rowOnly = false) {
    assert.match(payload.runId, guidPattern);
    assert.ok(!rowOnly || action === 'Inspect');
    const url = new URL(`${connection.baseUrl}/${rowOnly ? 'BCDCompatibilityE04' : 'BCDCompatibilityEV'}_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { code: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  async function stateFor(runId, amount, count) {
    const response = await call('Inspect', { runId });
    assert.equal(response.status, 200);
    assert.equal(response.value.row.exists, true);
    assert.equal(response.value.row.amount, amount);
    assert.equal(response.value.applyCount, count);
    assert.equal(response.value.receiptCount, count);
    assert.equal(response.value.pendingCount, 0);
    return response.value;
  }
  async function cleanup(runIds) {
    assert.ok(Array.isArray(runIds) && runIds.length <= 7);
    for (const runId of runIds) assert.match(runId, guidPattern);
    for (const runId of runIds) {
      assert.equal((await call('Cleanup', { runId })).status, 200);
      const clean = await call('CleanState', { runId });
      assert.equal(clean.status, 200);
      assert.deepEqual(clean.value, { runExists: false, rows: 0, barriers: 0, receiptCount: 0 });
    }
  }
  if (input.cleanupOnly) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.target, input.target);
    assert.equal(state.companyId, companyId);
    await cleanup(state.runIds);
    fs.unlinkSync(statePath);
    return { target: input.target, cleaned: true };
  }
  assert.ok(!fs.existsSync(statePath), 'Run -CleanupOnly for interrupted EV qualification.');
  const runIds = Array.from({ length: 7 }, () => crypto.randomUUID());
  fs.writeFileSync(statePath, JSON.stringify({ target: input.target, companyId, runIds }), { flag: 'wx' });
  const results = [];
  const pendingCalls = [];
  let cleaned = false;
  function mutation(runId, row, amount = 4, requestId = crypto.randomUUID()) {
    assert.match(row.version, /^[1-9][0-9]*$/);
    return { runId, requestId, systemId: row.systemId, expectedVersion: row.version, operation: 'modify', amount };
  }
  function rejected(response, code) {
    assert.equal(response.status, 400);
    assert.ok(response.message.includes(code));
  }
  async function check(name, index, test) {
    const result = { name, passed: false };
    results.push(result);
    try {
      const prepared = await call('Prepare', { runId: runIds[index] });
      assert.equal(prepared.status, 200);
      Object.assign(result, await test(runIds[index], prepared.value, result));
      result.passed = true;
    } catch (error) {
      result.failure = error.name === 'AssertionError' ? redact(error.message) : 'Qualification request failed.';
    }
  }
  async function race(runId, row, kind, diagnostics) {
    const request = mutation(runId, row);
    let finished = false;
    const owner = call('Execute', { ...request, delayMs: 3000 })
      .then(response => { diagnostics.owner = response; return response; }).finally(() => { finished = true; });
    pendingCalls.push(owner); owner.catch(() => {});
    let barrier;
    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) {
      const observed = await call('ObservePending', { runId, requestId: request.requestId });
      diagnostics.lastObservation = observed;
      assert.equal(observed.status, 200);
      if (observed.value.found && !observed.value.completed) { barrier = observed.value; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(barrier && !finished, 'Observe the pending owner receipt before competitor submission.');
    assert.notEqual(barrier.ownerSessionId, barrier.observerSessionId);
    const secondRequest = { ...request, ...(kind === 'distinct' ? { requestId: crypto.randomUUID(), amount: 9 } :
      kind === 'mismatch' ? { amount: 9 } : {}) };
    const started = Date.now();
    const second = await call('Execute', secondRequest);
    diagnostics.competitor = second;
    diagnostics.competitorElapsedMs = Date.now() - started;
    if (kind === 'distinct') {
      assert.equal(second.status, 200);
      assert.equal(finished, false, 'Different-ID writer must finish while the owner is paused.');
      const committed = await call('Inspect', { runId }, true);
      assert.equal(committed.status, 200);
      assert.equal(committed.value.amount, 9);
      assert.equal(committed.value.version, second.value.row.version);
      assert.equal(finished, false);
      assert.notEqual(committed.value.sessionId, barrier.ownerSessionId);
      diagnostics.committedWhileOwnerPending = committed.value;
    }
    const first = await owner;
    if (kind === 'distinct') {
      rejected(first, 'BCD_E04_CONFLICT');
      const state = await stateFor(runId, 9, 1);
      assert.equal(state.row.version, second.value.row.version);
      const retry = mutation(runId, state.row, 4, request.requestId);
      const applied = await call('Execute', retry);
      assert.equal(applied.status, 200);
      assert.equal((await call('Execute', retry)).text, applied.text);
      return { barrier, observed: await stateFor(runId, 4, 2), retryAppliedOnce: true };
    }
    assert.equal(first.status, 200);
    if (kind === 'mismatch') rejected(second, 'BCD_EV_REQUEST_ID_REUSED');
    else { assert.equal(second.status, 200); assert.equal(second.text, first.text); }
    return { barrier, observed: await stateFor(runId, 4, 1) };
  }
  try {
    await check('historical replay precedes stale-version checks after later mutation', 0, async (runId, row) => {
      const request = mutation(runId, row);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.notEqual(first.value.row.version, row.version);
      assert.equal((await call('Execute', request)).text, first.text);
      const later = await call('Execute', mutation(runId, first.value.row, 9));
      assert.equal(later.status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      return { observed: await stateFor(runId, 9, 2) };
    });
    await check('completed ID binds target, expected version and amount', 1, async (runId, row) => {
      const request = mutation(runId, row);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      for (const changed of [{ amount: 9 }, { expectedVersion: first.value.row.version }, { systemId: crypto.randomUUID() }]) {
        rejected(await call('Execute', { ...request, ...changed }), 'BCD_EV_REQUEST_ID_REUSED');
      }
      return { mismatches: 3, observed: await stateFor(runId, 4, 1) };
    });
    await check('new stale ID leaves no receipt and accepts a fresh same-ID retry', 2, async (runId, row) => {
      const first = await call('Execute', mutation(runId, row));
      assert.equal(first.status, 200);
      const stale = mutation(runId, row, 9);
      rejected(await call('Execute', stale), 'BCD_E04_CONFLICT');
      rejected(await call('Execute', stale), 'BCD_E04_CONFLICT');
      const beforeRetry = await stateFor(runId, 4, 1);
      const fresh = { ...stale, expectedVersion: beforeRetry.row.version };
      const applied = await call('Execute', fresh);
      assert.equal(applied.status, 200);
      assert.equal((await call('Execute', fresh)).text, applied.text);
      return { observed: await stateFor(runId, 9, 2) };
    });
    await check('post-mutation failure rolls back row version, apply count and receipt', 3, async (runId, row) => {
      const request = mutation(runId, row);
      rejected(await call('Execute', { ...request, failAfterMutation: true }), 'BCD_EV_AFTER_MUTATION');
      const rolledBack = await stateFor(runId, 0, 0);
      assert.equal(rolledBack.row.version, row.version);
      const applied = await call('Execute', request);
      assert.equal(applied.status, 200);
      assert.equal((await call('Execute', request)).text, applied.text);
      return { observed: await stateFor(runId, 4, 1) };
    });
    await check('overlapping identical IDs replay despite the token becoming stale', 4,
      (runId, row, diagnostics) => race(runId, row, 'identical', diagnostics));
    await check('overlapping same-ID payload mismatches reject before target version checks', 5,
      (runId, row, diagnostics) => race(runId, row, 'mismatch', diagnostics));
    await check('different IDs compete on one version; loser rolls back receipt and can retry', 6,
      (runId, row, diagnostics) => race(runId, row, 'distinct', diagnostics));
  } finally {
    await Promise.allSettled(pendingCalls);
    await cleanup(runIds);
    fs.unlinkSync(statePath);
    cleaned = true;
  }
  const evidence = { target: input.target, companyId, checkedAt: new Date().toISOString(),
    appVersion: readiness.appVersion, transport: 'native-node-http10', results, cleaned,
    passed: results.length === 7 && results.every(result => result.passed) };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return evidence;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw); raw = '';
    const evidence = await main(input);
    process.stdout.write(JSON.stringify(evidence, null, 2));
    if (evidence.passed === false) process.exitCode = 1;
  } catch { process.stderr.write('EV failed; inspect credential-free evidence and cleanup state.'); process.exitCode = 1; }
});
