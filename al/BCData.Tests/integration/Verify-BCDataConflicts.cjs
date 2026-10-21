'use strict';
// Dedicated E04 fixtures only. Credentials arrive through private stdin.
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
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `e04-${container}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `e04-${container}-evidence.json`);
  const connection = { id: input.target, baseUrl: `http://${container}:7048/BC/ODataV4`,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'e04-http-1',
    username: input.admin.username, password: input.admin.password };
  const client = createDataClient({ resolveConnection: () => connection });
  const companyId = (await client.listCompanies(connection.id)).companies[0].id;
  const readiness = await client.readiness(connection.id, companyId);
  const redact = value => String(value).split(connection.password).join('[redacted]')
    .split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0, 2048);
  async function call(action, payload) {
    assert.match(payload.runId, guidPattern);
    const url = new URL(`${connection.baseUrl}/BCDCompatibilityE04_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { value: JSON.parse(envelope.value) } :
      { code: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  async function inspect(runId) {
    const response = await call('Inspect', { runId });
    assert.equal(response.status, 200);
    return response.value;
  }
  async function cleanup(runIds) {
    assert.ok(Array.isArray(runIds) && runIds.length <= 6);
    for (const runId of runIds) assert.match(runId, guidPattern);
    for (const runId of runIds) {
      assert.equal((await call('Cleanup', { runId })).status, 200);
      const clean = await call('CleanState', { runId });
      assert.equal(clean.status, 200);
      assert.deepEqual(clean.value, { runExists: false, rows: 0, barriers: 0 });
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
  assert.ok(!fs.existsSync(statePath), 'Run -CleanupOnly for interrupted E04 qualification.');
  const runIds = Array.from({ length: 6 }, () => crypto.randomUUID());
  fs.writeFileSync(statePath, JSON.stringify({ target: input.target, companyId, runIds }), { flag: 'wx' });
  const results = [];
  const pendingCalls = [];
  let cleaned = false;
  function mutation(runId, state, operation = 'modify', amount = 9) {
    assert.match(state.version, /^[1-9][0-9]*$/);
    return { runId, systemId: state.systemId, expectedVersion: state.version, operation, amount };
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
  async function race(runId, state, operation, guarded, diagnostics) {
    let finished = false;
    const owner = call(guarded ? 'Execute' : 'UncheckedControl', { ...mutation(runId, state, operation, 4), delayMs: 3000 })
      .then(response => { diagnostics.owner = response; return response; })
      .finally(() => { finished = true; });
    pendingCalls.push(owner); owner.catch(() => {});
    let barrier;
    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) {
      const observed = await call('Observe', { runId });
      diagnostics.lastObservation = observed;
      assert.equal(observed.status, 200);
      if (observed.value.found) { barrier = observed.value; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(barrier && !finished, 'Observe owner after its initial version check and before protected reread.');
    assert.notEqual(barrier.ownerSessionId, barrier.observerSessionId);
    const started = Date.now();
    const competitor = await call('Execute', mutation(runId, state));
    diagnostics.competitor = competitor;
    diagnostics.competitorElapsedMs = Date.now() - started;
    assert.equal(competitor.status, 200);
    assert.equal(finished, false, 'Competitor must commit before sleeping owner resumes.');
    assert.notEqual(competitor.value.sessionId, barrier.ownerSessionId);
    assert.notEqual(competitor.value.version, state.version);
    const committedWhileOwnerPending = await inspect(runId);
    diagnostics.committedWhileOwnerPending = committedWhileOwnerPending;
    assert.equal(finished, false, 'Independent committed read must finish before the owner resumes.');
    assert.equal(committedWhileOwnerPending.amount, 9);
    assert.equal(committedWhileOwnerPending.version, competitor.value.version);
    assert.notEqual(committedWhileOwnerPending.sessionId, barrier.ownerSessionId);
    const response = await owner;
    const actual = await inspect(runId);
    if (guarded) {
      assert.equal(response.status, 400);
      assert.ok(response.message.includes('BCD_E04_CONFLICT'));
      assert.equal(actual.exists, true);
      assert.equal(actual.amount, 9);
      assert.equal(actual.name, 'ORIGINAL');
      assert.equal(actual.systemId, state.systemId);
      assert.equal(actual.version, competitor.value.version);
    } else {
      assert.equal(response.status, 200);
      assert.equal(actual.amount, 4, 'Initial-check-only control overwrites the competing value.');
      assert.notEqual(actual.version, competitor.value.version);
    }
    return { barrier, competitorCommittedBeforeOwnerResumed: true, observed: actual };
  }
  try {
    for (const [index, operation] of ['modify', 'delete', 'rename'].entries()) {
      await check(`protected ${operation} rejects an intervening committed write`, index,
        (runId, state, diagnostics) => race(runId, state, operation, true, diagnostics));
    }
    await check('initial-check-only control loses the competing update', 3,
      (runId, state, diagnostics) => race(runId, state, 'modify', false, diagnostics));
    await check('fresh modify, rename and delete use successive string versions', 4, async (runId, original) => {
      const modified = await call('Execute', mutation(runId, original));
      assert.equal(modified.status, 200);
      const renamed = await call('Execute', mutation(runId, modified.value, 'rename'));
      assert.equal(renamed.status, 200);
      assert.equal(renamed.value.systemId, original.systemId);
      assert.equal(renamed.value.name, 'RENAMED');
      assert.notEqual(renamed.value.version, modified.value.version);
      assert.equal((await call('Execute', mutation(runId, renamed.value, 'delete'))).status, 200);
      assert.equal((await inspect(runId)).exists, false);
      const missing = await call('Execute', mutation(runId, original));
      assert.equal(missing.status, 400);
      assert.ok(missing.message.includes('BCD_E04_NOT_FOUND'));
      return { originalVersion: original.version, modifiedVersion: modified.value.version,
        renamedVersion: renamed.value.version, missingStatus: missing.status };
    });
    await check('malformed version strings cannot mutate the row', 5, async (runId, state) => {
      for (const version of ['0', '-1', `0${state.version}`, '9223372036854775808', '1e3']) {
        const response = await call('Execute', { ...mutation(runId, state), expectedVersion: version });
        assert.equal(response.status, 400);
        assert.ok(response.message.includes('BCD_E04_INVALID_VERSION'));
        const actual = await inspect(runId);
        assert.equal(actual.version, state.version);
        assert.equal(actual.amount, 0);
      }
      return { rejectedVersions: 5 };
    });
  } finally {
    await Promise.allSettled(pendingCalls);
    await cleanup(runIds);
    fs.unlinkSync(statePath);
    cleaned = true;
  }
  const evidence = { target: input.target, container, companyId, checkedAt: new Date().toISOString(),
    appVersion: readiness.appVersion, transport: 'native-node-http10', results, cleaned,
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
  } catch { process.stderr.write('E04 failed; inspect credential-free evidence and cleanup state.'); process.exitCode = 1; }
});
