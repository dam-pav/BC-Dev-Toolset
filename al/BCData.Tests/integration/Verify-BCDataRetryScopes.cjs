'use strict';
// Dedicated retry-scope fixture. Credentials stay in memory/private stdin.
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
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `e08-${container}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `e08-${container}-evidence.json`);
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
    const url = new URL(`${connection.baseUrl}/${rowOnly === 'legacy' ? 'BCDCompatibilityE06' : rowOnly === 'versioned' ? 'BCDCompatibilityEV' : 'BCDCompatibilityE08'}_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { code: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  async function stateFor(runId, total, applies, receipts) {
    const state = await call('Inspect', { runId });
    assert.equal(state.status, 200);
    assert.deepEqual(state.value, { total, applyCount: applies, receiptCount: receipts, pendingCount: 0 });
    return state.value;
  }
  function rejected(response, error) {
    assert.equal(response.status, 400);
    assert.ok(response.message.includes(error), response.message);
    assert.equal(response.text, undefined);
  }
  async function cleanup(runIds) {
    assert.ok(Array.isArray(runIds) && runIds.length <= 6);
    for (const runId of runIds) {
      assert.match(runId, guidPattern);
      assert.equal((await call('Cleanup', { runId }, 'versioned')).status, 200);
      const clean = await call('CleanState', { runId }, 'versioned');
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
  assert.ok(!fs.existsSync(statePath), 'Run -CleanupOnly after interrupted E08 qualification.');
  const runIds = Array.from({ length: 6 }, () => crypto.randomUUID());
  fs.writeFileSync(statePath, JSON.stringify({ target: input.target, companyId, runIds }), { flag: 'wx' });
  const results = [];
  const pending = [];
  async function check(name, index, work) {
    const result = { name, passed: false };
    results.push(result);
    try {
      const runId = runIds[index];
      const prepared = await call('Prepare', { runId });
      assert.equal(prepared.status, 200);
      assert.match(prepared.value.scopeEpoch, guidPattern);
      assert.ok(prepared.value.retryUntil);
      const request = { runId, requestId: crypto.randomUUID(), scopeEpoch: prepared.value.scopeEpoch, amount: 4 };
      Object.assign(result, await work(runId, request, result));
      result.passed = true;
    } catch (error) {
      result.failure = error.name === 'AssertionError' ? redact(error.message) : 'Qualification request failed.';
    }
  }
  try {
    await check('active scope replays exact history and refuses premature purge', 0, async (runId, request) => {
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      rejected(await call('PurgeExpired', request), 'BCD_E08_SCOPE_ACTIVE');
      const missing = { ...request }; delete missing.scopeEpoch;
      rejected(await call('Execute', missing), 'BCD_E08_SCOPE_REQUIRED');
      rejected(await call('Execute', { ...request, scopeEpoch: crypto.randomUUID() }), 'BCD_E08_SCOPE_RETIRED');
      return { observed: await stateFor(runId, 4, 1, 1) };
    });
    await check('expired context rejects old/new IDs after purge and rejects entry-point bypass', 1, async (runId, request) => {
      assert.equal((await call('Execute', request)).status, 200);
      assert.equal((await call('ExpireForTest', request)).status, 200);
      rejected(await call('Execute', request), 'BCD_E08_SCOPE_EXPIRED');
      assert.equal((await call('PurgeExpired', request)).status, 200);
      for (const candidate of [request, { ...request, requestId: crypto.randomUUID() }]) {
        rejected(await call('Execute', candidate), 'BCD_E08_SCOPE_EXPIRED');
        rejected(await call('Execute', candidate, 'legacy'), 'BCD_E08_SCOPE_EXPIRED');
      }
      const versioned = { ...request, operation: 'insert', systemId: crypto.randomUUID() };
      rejected(await call('Execute', versioned, 'versioned'), 'BCD_E08_SCOPE_EXPIRED');
      delete versioned.scopeEpoch;
      rejected(await call('Execute', versioned, 'versioned'), 'BCD_E08_SCOPE_REQUIRED');
      return { observed: await stateFor(runId, 4, 1, 0), noSecondApply: true };
    });
    await check('recreating a run cannot admit its retired epoch, including legacy recreation', 2, async (runId, request) => {
      assert.equal((await call('Execute', request)).status, 200);
      assert.equal((await call('Cleanup', request)).status, 200);
      assert.equal((await call('Prepare', { runId }, 'legacy')).status, 200);
      rejected(await call('Execute', request, 'legacy'), 'BCD_E08_SCOPE_RETIRED');
      const stripped = { ...request }; delete stripped.scopeEpoch;
      rejected(await call('Execute', stripped), 'BCD_E08_SCOPE_RETIRED');
      await stateFor(runId, 0, 0, 0);
      assert.equal((await call('Cleanup', { runId })).status, 200);
      const fresh = await call('Prepare', { runId });
      assert.equal(fresh.status, 200);
      assert.notEqual(fresh.value.scopeEpoch, request.scopeEpoch);
      rejected(await call('Execute', request), 'BCD_E08_SCOPE_RETIRED');
      const next = { ...request, scopeEpoch: fresh.value.scopeEpoch, requestId: crypto.randomUUID() };
      assert.equal((await call('Execute', next)).status, 200);
      return { observed: await stateFor(runId, 4, 1, 1) };
    });
    await check('crossing the server deadline during admitted work rolls back the reservation', 3, async (runId, request) => {
      assert.equal((await call('NearDeadlineForTest', request)).status, 200);
      const started = Date.now();
      const response = await call('Execute', { ...request, delayMs: 3000 });
      rejected(response, 'BCD_E08_SCOPE_EXPIRED');
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs >= 2500, 'Execution reached the intentional delay before the second expiry check.');
      return { elapsedMs, observed: await stateFor(runId, 0, 0, 0) };
    });
    await check('overlapping scoped duplicate requests replay once under the scope lock', 4, async (runId, request, diagnostics) => {
      let finished = false;
      const owner = call('Execute', { ...request, delayMs: 3000 }).finally(() => { finished = true; });
      pending.push(owner); owner.catch(() => {});
      let barrier;
      const deadline = Date.now() + 5000;
      while (!finished && Date.now() < deadline) {
        const observed = await call('ObservePending', request, 'legacy');
        diagnostics.lastObservation = observed;
        assert.equal(observed.status, 200);
        if (observed.value.found && !observed.value.completed) { barrier = observed.value; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(barrier && !finished, 'Observe the scoped owner still pending before competitor submission.');
      assert.notEqual(barrier.ownerSessionId, barrier.observerSessionId);
      const competitor = await call('Execute', request);
      const first = await owner;
      assert.equal(first.status, 200);
      assert.equal(competitor.status, 200);
      assert.equal(first.text, competitor.text);
      return { barrier, observed: await stateFor(runId, 4, 1, 1) };
    });
    await check('purge waits for admitted scoped work and cannot discard its active receipt', 5, async (runId, request, diagnostics) => {
      let finished = false;
      const owner = call('Execute', { ...request, delayMs: 3000 }).finally(() => { finished = true; });
      pending.push(owner); owner.catch(() => {});
      let barrier;
      const deadline = Date.now() + 5000;
      while (!finished && Date.now() < deadline) {
        const observed = await call('ObservePending', request, 'legacy');
        diagnostics.lastObservation = observed;
        assert.equal(observed.status, 200);
        if (observed.value.found && !observed.value.completed) { barrier = observed.value; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(barrier && !finished, 'Purge must be submitted while the owner is still pending.');
      assert.notEqual(barrier.ownerSessionId, barrier.observerSessionId);
      const purge = await call('PurgeExpired', request);
      const first = await owner;
      assert.equal(first.status, 200);
      rejected(purge, 'BCD_E08_SCOPE_ACTIVE');
      assert.equal((await call('Execute', request)).text, first.text);
      return { barrier, purgeStatus: purge.status, observed: await stateFor(runId, 4, 1, 1) };
    });
  } finally {
    await Promise.allSettled(pending);
    await cleanup(runIds);
    fs.unlinkSync(statePath);
  }
  const evidence = { target: input.target, companyId, checkedAt: new Date().toISOString(),
    transport: 'native-node-http10', companionVersion: readiness.appVersion, results, cleaned: true,
    passed: results.length === 6 && results.every(result => result.passed) };
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
  } catch { process.stderr.write('E08 failed; inspect credential-free evidence and cleanup state.'); process.exitCode = 1; }
});
