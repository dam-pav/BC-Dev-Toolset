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
    assert.ok(!rowOnly || ['Inspect', 'Execute'].includes(action));
    const url = new URL(`${connection.baseUrl}/${rowOnly ? 'BCDCompatibilityE04' : 'BCDCompatibilityEV'}_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { code: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  async function receiptState(runId, count) {
    const response = await call('Inspect', { runId });
    assert.equal(response.status, 200);
    assert.equal(response.value.applyCount, count);
    assert.equal(response.value.receiptCount, count);
    assert.equal(response.value.pendingCount, 0);
    return response.value;
  }
  async function stateFor(runId, amount, count) {
    const state = await receiptState(runId, count);
    assert.equal(state.row.exists, true);
    assert.equal(state.row.amount, amount);
    return state;
  }
  async function cleanup(runIds) {
    assert.ok(Array.isArray(runIds) && runIds.length <= 24);
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
  const runIds = Array.from({ length: 24 }, () => crypto.randomUUID());
  fs.writeFileSync(statePath, JSON.stringify({ target: input.target, companyId, runIds }), { flag: 'wx' });
  const results = [];
  const pendingCalls = [];
  let cleaned = false;
  function mutation(runId, row, amount = 4, requestId = crypto.randomUUID()) {
    assert.match(row.version, /^[1-9][0-9]*$/);
    return { runId, requestId, systemId: row.systemId, expectedVersion: row.version, operation: 'modify', amount };
  }
  function insertion(runId, systemId = crypto.randomUUID(), requestId = crypto.randomUUID(), amount = 4) {
    return { runId, systemId, requestId, operation: 'insert', amount };
  }
  function deletion(runId, row, requestId = crypto.randomUUID()) {
    return { runId, requestId, systemId: row.systemId, expectedVersion: row.version, operation: 'delete' };
  }
  function assertDeleteAck(ack, systemId) {
    assert.deepEqual(Object.keys(ack).sort(), ['applyCount','deletedSystemId','outcome','requestId','resultId']);
    assert.equal(ack.deletedSystemId.toLowerCase(), systemId.toLowerCase());
    assert.equal(ack.outcome, 'applied');
  }
  function rejected(response, code) {
    assert.equal(response.status, 400);
    assert.ok(response.message.includes(code));
  }
  async function check(name, index, test) {
    const result = { name, passed: false };
    results.push(result);
    try {
      const prepared = await call(index >= 14 && index <= 18 ? 'PrepareEmpty' : 'Prepare', { runId: runIds[index] });
      assert.equal(prepared.status, 200);
      Object.assign(result, await test(runIds[index], prepared.value, result));
      result.passed = true;
    } catch (error) {
      result.failure = error.name === 'AssertionError' ? redact(error.message) : 'Qualification request failed.';
    }
  }
  async function race(runId, row, kind, diagnostics, operation = 'modify') {
    const request = operation === 'insert' ? insertion(runId) : { ...mutation(runId, row), operation };
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
      kind === 'mismatch' ? (operation === 'delete' ? { systemId: crypto.randomUUID() } : { amount: 9 }) : {}) };
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
    if (operation === 'delete') {
      const observed = await receiptState(runId, 1);
      assert.equal(observed.row.exists, false);
      assertDeleteAck(first.value, request.systemId);
      return { barrier, observed };
    }
    return { barrier, observed: await stateFor(runId, operation === 'rename' ? 0 : 4, 1) };
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
    await check('deleted target blocks historical disclosure and new writes without changing receipts', 7, async (runId, row) => {
      const request = mutation(runId, row);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal((await call('Execute', { ...mutation(runId, first.value.row), operation: 'delete' }, true)).status, 200);
      const replay = await call('Execute', request);
      rejected(replay, 'BCD_EV_REPLAY_TARGET_UNAVAILABLE');
      assert.equal(replay.text, undefined);
      rejected(await call('Execute', mutation(runId, first.value.row)), 'BCD_E04_NOT_FOUND');
      const state = await receiptState(runId, 1);
      assert.equal(state.row.exists, false);
      return { replayStatus: replay.status, observed: state };
    });
    await check('same-key replacement cannot authorize the old SystemId result', 8, async (runId, row) => {
      const request = mutation(runId, row);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal((await call('Execute', { ...mutation(runId, first.value.row), operation: 'delete' }, true)).status, 200);
      const replacement = await call('PrepareReplacement', { runId });
      assert.equal(replacement.status, 200);
      assert.equal(replacement.value.name, row.name);
      assert.notEqual(replacement.value.systemId, row.systemId);
      const replay = await call('Execute', request);
      rejected(replay, 'BCD_EV_REPLAY_TARGET_UNAVAILABLE');
      assert.equal(replay.text, undefined);
      const state = await stateFor(runId, 0, 1);
      assert.equal(state.row.systemId, replacement.value.systemId);
      return { originalSystemId: row.systemId, replacementSystemId: state.row.systemId, observed: state };
    });
    await check('rename retains readable identity and exact historical replay', 9, async (runId, row) => {
      const request = mutation(runId, row);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      const renamed = await call('Execute', { ...mutation(runId, first.value.row), operation: 'rename' }, true);
      assert.equal(renamed.status, 200);
      assert.equal(renamed.value.systemId, row.systemId);
      assert.equal(renamed.value.name, 'RENAMED');
      assert.notEqual(renamed.value.version, first.value.row.version);
      assert.equal((await call('Execute', request)).text, first.text);
      const state = await stateFor(runId, 4, 1);
      assert.equal(state.row.name, 'RENAMED');
      assert.equal(state.row.version, renamed.value.version);
      return { historicalName: first.value.row.name, currentName: state.row.name, observed: state };
    });
    await check('rename receipt preserves identity and exact history after later modify', 10, async (runId, row) => {
      const request = { ...mutation(runId, row), operation: 'rename' };
      delete request.amount;
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal(first.value.row.systemId, row.systemId);
      assert.equal(first.value.row.name, 'RENAMED');
      assert.notEqual(first.value.row.version, row.version);
      assert.equal((await call('Execute', request)).text, first.text);
      rejected(await call('Execute', { ...request, operation: 'modify', amount: 4 }), 'BCD_EV_REQUEST_ID_REUSED');
      assert.equal((await call('Execute', mutation(runId, first.value.row, 9))).status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      return { observed: await stateFor(runId, 9, 2), historicalName: first.value.row.name };
    });
    await check('rename failure restores key, identity, version and reservation', 11, async (runId, row) => {
      const request = { ...mutation(runId, row), operation: 'rename' };
      rejected(await call('Execute', { ...request, failAfterMutation: true }), 'BCD_EV_AFTER_MUTATION');
      const rolledBack = await stateFor(runId, 0, 0);
      assert.equal(rolledBack.row.name, row.name);
      assert.equal(rolledBack.row.systemId, row.systemId);
      assert.equal(rolledBack.row.version, row.version);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      return { observed: await stateFor(runId, 0, 1) };
    });
    await check('stale rename reserves no ID and fresh same-ID retry succeeds', 12, async (runId, row) => {
      const modified = await call('Execute', mutation(runId, row));
      assert.equal(modified.status, 200);
      const request = { ...mutation(runId, row), operation: 'rename' };
      rejected(await call('Execute', request), 'BCD_E04_CONFLICT');
      await stateFor(runId, 4, 1);
      const fresh = { ...request, expectedVersion: modified.value.row.version };
      const renamed = await call('Execute', fresh);
      assert.equal(renamed.status, 200);
      assert.equal((await call('Execute', fresh)).text, renamed.text);
      return { observed: await stateFor(runId, 4, 2) };
    });
    await check('overlapping identical rename IDs apply once and replay exact result', 13,
      (runId, row, diagnostics) => race(runId, row, 'identical', diagnostics, 'rename'));
    await check('insert binds caller identity and amount; replay survives later modify', 14, async (runId) => {
      const request = insertion(runId);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal(first.value.row.systemId.toLowerCase(), request.systemId.toLowerCase());
      assert.equal(first.value.row.name, 'ORIGINAL');
      assert.match(first.value.row.version, /^[1-9][0-9]*$/);
      assert.equal((await call('Execute', request)).text, first.text);
      for (const changed of [{ amount: 9 }, { systemId: crypto.randomUUID() }]) {
        rejected(await call('Execute', { ...request, ...changed }), 'BCD_EV_REQUEST_ID_REUSED');
      }
      const changed = await call('Execute', mutation(runId, first.value.row, 9));
      assert.equal(changed.status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      return { observed: await stateFor(runId, 9, 2) };
    });
    await check('failed insert rolls back target and reservation; same-ID retry applies once', 15, async (runId) => {
      const request = insertion(runId);
      rejected(await call('Execute', { ...request, failAfterMutation: true }), 'BCD_EV_AFTER_MUTATION');
      const rolledBack = await receiptState(runId, 0);
      assert.equal(rolledBack.row.exists, false);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      return { observed: await stateFor(runId, 4, 1) };
    });
    await check('identity/key conflicts leave no receipt; replacement cannot disclose old insert history', 16, async (runId) => {
      const original = insertion(runId);
      const first = await call('Execute', original);
      assert.equal(first.status, 200);
      rejected(await call('Execute', { ...original, requestId: crypto.randomUUID() }), 'BCD_EV_INSERT_CONFLICT');
      const conflict = insertion(runId);
      rejected(await call('Execute', conflict), 'BCD_EV_INSERT_CONFLICT');
      await stateFor(runId, 4, 1);
      const deleted = await call('Execute', { ...mutation(runId, first.value.row), operation: 'delete' }, true);
      assert.equal(deleted.status, 200);
      rejected(await call('Execute', original), 'BCD_EV_REPLAY_TARGET_UNAVAILABLE');
      const replacement = await call('Execute', conflict);
      assert.equal(replacement.status, 200);
      assert.notEqual(replacement.value.row.systemId, first.value.row.systemId);
      assert.equal((await call('Execute', conflict)).text, replacement.text);
      rejected(await call('Execute', original), 'BCD_EV_REPLAY_TARGET_UNAVAILABLE');
      return { observed: await stateFor(runId, 4, 2), failedRequestIdReusable: true };
    });
    await check('overlapping identical insert IDs apply once with exact replay', 17,
      (runId, row, diagnostics) => race(runId, row, 'identical', diagnostics, 'insert'));
    await check('overlapping insert same-ID different payload is rejected', 18,
      (runId, row, diagnostics) => race(runId, row, 'mismatch', diagnostics, 'insert'));
    await check('delete minimal acknowledgement replays and never deletes a replacement', 19, async (runId, row) => {
      const request = deletion(runId, row);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assertDeleteAck(first.value, row.systemId);
      assert.equal((await call('Execute', request)).text, first.text);
      rejected(await call('Execute', { ...request, systemId: crypto.randomUUID() }), 'BCD_EV_REQUEST_ID_REUSED');
      const deleted = await receiptState(runId, 1);
      assert.equal(deleted.row.exists, false);
      const replacement = await call('PrepareReplacement', { runId });
      assert.equal(replacement.status, 200);
      assert.notEqual(replacement.value.systemId, row.systemId);
      assert.equal((await call('Execute', request)).text, first.text);
      const observed = await stateFor(runId, 0, 1);
      assert.equal(observed.row.systemId, replacement.value.systemId);
      assert.equal(observed.row.version, replacement.value.version);
      return { observed };
    });
    await check('failed delete restores row/version and releases request reservation', 20, async (runId, row) => {
      const request = deletion(runId, row);
      rejected(await call('Execute', { ...request, failAfterMutation: true }), 'BCD_EV_AFTER_MUTATION');
      const rolledBack = await stateFor(runId, 0, 0);
      assert.equal(rolledBack.row.systemId, row.systemId);
      assert.equal(rolledBack.row.version, row.version);
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assertDeleteAck(first.value, row.systemId);
      assert.equal((await call('Execute', request)).text, first.text);
      const observed = await receiptState(runId, 1);
      assert.equal(observed.row.exists, false);
      return { observed };
    });
    await check('stale delete leaves no receipt and fresh same-ID retry binds the version', 21, async (runId, row) => {
      const modified = await call('Execute', mutation(runId, row));
      assert.equal(modified.status, 200);
      const request = deletion(runId, row);
      rejected(await call('Execute', request), 'BCD_E04_CONFLICT');
      await stateFor(runId, 4, 1);
      const fresh = { ...request, expectedVersion: modified.value.row.version };
      const first = await call('Execute', fresh);
      assert.equal(first.status, 200);
      rejected(await call('Execute', request), 'BCD_EV_REQUEST_ID_REUSED');
      assert.equal((await call('Execute', fresh)).text, first.text);
      const observed = await receiptState(runId, 2);
      assert.equal(observed.row.exists, false);
      return { observed };
    });
    await check('overlapping identical delete IDs apply once and replay acknowledgement', 22,
      (runId, row, diagnostics) => race(runId, row, 'identical', diagnostics, 'delete'));
    await check('overlapping delete same-ID different target rejects payload reuse', 23,
      (runId, row, diagnostics) => race(runId, row, 'mismatch', diagnostics, 'delete'));
  } finally {
    await Promise.allSettled(pendingCalls);
    await cleanup(runIds);
    fs.unlinkSync(statePath);
    cleaned = true;
  }
  const evidence = { target: input.target, companyId, checkedAt: new Date().toISOString(),
    appVersion: readiness.appVersion, transport: 'native-node-http10', results, cleaned,
    passed: results.length === 24 && results.every(result => result.passed) };
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
