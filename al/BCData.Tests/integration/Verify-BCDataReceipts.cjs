'use strict';
// Test-only HTTP receipts. Credentials arrive over private stdin; never log input or socket bytes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { resolveWithinRoot } = require('../../../vscode-extension/path-security');
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, input.target));
  const container = targets[input.target];
  assert.equal(input.container, container);
  const root = path.resolve(__dirname, '../../..');
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `e06-${container}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `e06-${container}-evidence.json`);
  const connection = { id: input.target, baseUrl: `http://${container}:7048/BC/ODataV4`,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'e06-http-1',
    username: input.admin.username, password: input.admin.password };
  const client = createDataClient({ resolveConnection: () => connection });
  const companies = await client.listCompanies(connection.id);
  const companyId = companies.companies[0].id;
  const readiness = await client.readiness(connection.id, companyId);
  const redact = value => String(value).split(connection.password).join('[redacted]')
    .split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0, 2048);
  function requestOptions(action, payload, proxyPort) {
    assert.match(payload.runId, guidPattern);
    const url = new URL(`${proxyPort ? `http://127.0.0.1:${proxyPort}/BC/ODataV4` : connection.baseUrl}/BCDCompatibilityE06_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    return { url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) } };
  }
  async function call(action, payload) {
    const response = await requestHttp10(requestOptions(action, payload));
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { errorCode: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  async function stateFor(runId, total, applyCount, receiptCount) {
    const state = await call('Inspect', { runId });
    assert.equal(state.status, 200);
    assert.deepEqual(state.value, { total, applyCount, receiptCount, pendingCount: 0 });
    return state.value;
  }
  async function cleanup(runIds) {
    assert.ok(Array.isArray(runIds) && runIds.length <= 7);
    for (const runId of runIds) assert.match(runId, guidPattern);
    for (const runId of runIds) {
      assert.equal((await call('Cleanup', { runId })).status, 200);
      const state = await call('CleanState', { runId });
      assert.equal(state.status, 200);
      assert.deepEqual(state.value, { runExists: false, receiptCount: 0 });
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
  assert.ok(!fs.existsSync(statePath), 'Use -CleanupOnly for interrupted E06 qualification.');
  const runIds = Array.from({ length: 7 }, () => crypto.randomUUID());
  fs.writeFileSync(statePath, JSON.stringify({ target: input.target, companyId, runIds }), { flag: 'wx' });
  const results = [];
  const owners = [];
  let cleaned = false;
  async function check(name, runId, test) {
    const result = { name, passed: false };
    results.push(result);
    try {
      assert.equal((await call('Prepare', { runId })).status, 200);
      Object.assign(result, await test(runId, result));
      result.passed = true;
    } catch (error) {
      // Assertion operands here contain only controlled fixture values; never log input or socket bytes.
      result.failure = error.name === 'AssertionError' ? redact(error.message) : 'Qualification request failed.';
    }
  }
  async function race(runId, secondAmount, sameId, diagnostics) {
    const requestId = crypto.randomUUID();
    let ownerFinished = false;
    const ownerStarted = Date.now();
    const owner = call('Execute', { runId, requestId, amount: 4, delayMs: 3000 })
      .then(response => { diagnostics.owner = response; return response; })
      .finally(() => { ownerFinished = true; diagnostics.ownerElapsedMs = Date.now() - ownerStarted; });
    // Retain and settle outstanding calls before cleanup even if a diagnostic assertion fails.
    owners.push(owner); owner.catch(() => {});
    let pending;
    const deadline = Date.now() + 5000;
    while (!ownerFinished && Date.now() < deadline) {
      const pollStarted = Date.now();
      const observed = await call('ObservePending', { runId, requestId });
      diagnostics.lastObservation = { ...observed, elapsedMs: Date.now() - pollStarted, ownerFinished };
      assert.equal(observed.status, 200);
      if (observed.value.found && !observed.value.completed) { pending = observed.value; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!pending || ownerFinished) await owner;
    assert.ok(pending && !ownerFinished, 'A separate request must observe the owner transaction pending.');
    assert.notEqual(pending.ownerSessionId, pending.observerSessionId);
    const started = Date.now();
    let secondElapsedMs;
    const duplicate = call('Execute', { runId, requestId: sameId ? requestId : crypto.randomUUID(), amount: secondAmount })
      .finally(() => { secondElapsedMs = Date.now() - started; });
    const [first, second] = await Promise.all([owner, duplicate]);
    assert.equal(first.status, 200);
    if (sameId && secondAmount !== 4) {
      assert.equal(second.status, 400);
      assert.ok(second.message.includes('BCD_E06_REQUEST_ID_REUSED'));
    } else {
      assert.equal(second.status, 200);
      if (sameId) assert.equal(second.text, first.text);
    }
    const observed = await stateFor(runId, sameId ? 4 : 4 + secondAmount, sameId ? 1 : 2, sameId ? 1 : 2);
    return { pending, overlappingRequests: true, secondElapsedMs, secondStatus: second.status, observed };
  }
  try {
    await check('exact replay stays stable after a later mutation', runIds[0], async runId => {
      const request = { runId, requestId: crypto.randomUUID(), amount: 4 };
      const first = await call('Execute', request);
      assert.equal(first.status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      assert.equal((await call('Execute', { ...request, requestId: crypto.randomUUID(), amount: 6 })).status, 200);
      assert.equal((await call('Execute', request)).text, first.text);
      return { observed: await stateFor(runId, 10, 2, 2) };
    });
    await check('changed payload for a completed request is rejected', runIds[1], async runId => {
      const request = { runId, requestId: crypto.randomUUID(), amount: 4 };
      assert.equal((await call('Execute', request)).status, 200);
      const rejected = await call('Execute', { ...request, amount: 5 });
      assert.equal(rejected.status, 400);
      assert.ok(rejected.message.includes('BCD_E06_REQUEST_ID_REUSED'));
      return { status: rejected.status, observed: await stateFor(runId, 4, 1, 1) };
    });
    await check('overlapping identical requests apply once and return the same result', runIds[2], (runId, result) => race(runId, 4, true, result));
    await check('overlapping mismatched requests reject the loser without a second write', runIds[3], (runId, result) => race(runId, 5, true, result));
    await check('overlapping distinct requests preserve both counter updates', runIds[4], (runId, result) => race(runId, 6, false, result));
    await check('failure rolls back receipt and mutation before same-ID retry', runIds[5], async runId => {
      const request = { runId, requestId: crypto.randomUUID(), amount: 4 };
      const failed = await call('Execute', { ...request, failAfterMutation: true });
      assert.equal(failed.status, 400);
      assert.ok(failed.message.includes('BCD_E06_AFTER_MUTATION'));
      await stateFor(runId, 0, 0, 0);
      assert.equal((await call('Execute', request)).status, 200);
      return { observed: await stateFor(runId, 4, 1, 1) };
    });
    await check('lost completed response replays without repeating the mutation', runIds[6], async runId => {
      const request = { runId, requestId: crypto.randomUUID(), amount: 4 };
      const dropped = await discardResponse(container, port => requestHttp10(requestOptions('Execute', request, port)));
      assert.ok(dropped.callerFailed && dropped.upstreamComplete);
      const boundary = dropped.response.indexOf('\r\n\r\n');
      assert.ok(boundary > 0);
      assert.match(dropped.response.subarray(0, boundary).toString('ascii'), /^HTTP\/1\.[01] 200 /);
      const originalResult = JSON.parse(dropped.response.subarray(boundary + 4).toString('utf8')).value;
      const replay = await call('Execute', request);
      assert.equal(replay.status, 200);
      assert.equal(replay.text, originalResult);
      return { callerFailed: true, completeResponseDiscarded: true, discardedBytes: dropped.response.length,
        observed: await stateFor(runId, 4, 1, 1) };
    });
  } finally {
    await Promise.allSettled(owners);
    try {
      await cleanup(runIds);
      fs.unlinkSync(statePath);
      cleaned = true;
    } finally {
      fs.writeFileSync(evidencePath, JSON.stringify({ target: input.target, companyId, utc: new Date().toISOString(),
        appVersion: readiness.appVersion, transport: 'native-node-http10', results, cleaned,
        passed: cleaned && results.length === 7 && results.every(r => r.passed) }, null, 2));
    }
  }
  return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
}

async function discardResponse(container, request) {
  // Loopback-only proxy forwards to one fixed dedicated target and discards all response bytes.
  assert.ok(['bcdata23test', 'bcdata271'].includes(container));
  const sockets = new Set();
  const chunks = [];
  let bytes = 0;
  let upstreamComplete = false;
  const server = net.createServer(downstream => {
    const upstream = net.connect({ host: container, port: 7048 });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => downstream.destroy());
    }
    downstream.pipe(upstream);
    upstream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 131072) { upstream.destroy(); downstream.destroy(); return; }
      chunks.push(chunk);
    });
    upstream.on('end', () => { upstreamComplete = true; downstream.destroy(); });
    downstream.on('close', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let callerFailed = false;
  try {
    try { await request(server.address().port); } catch { callerFailed = true; }
    return { callerFailed, upstreamComplete, response: Buffer.concat(chunks) };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
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
  } catch { process.stderr.write('E06 failed; inspect credential-free evidence and cleanup state.'); process.exitCode = 1; }
});
