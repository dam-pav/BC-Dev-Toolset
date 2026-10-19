'use strict';
// Dedicated EVP phases only. Credentials/history arrive through private stdin.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const s = input.state;
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, s.target));
  assert.equal(s.container, targets[s.target]);
  assert.match(s.namespaceId, guid); assert.match(s.requestId, guid);
  assert.deepEqual(s.runs.map(r => r.kind).sort(), ['f','x']);
  for (const run of s.runs) assert.match(run.runId, guid);
  const admin = input.admin;
  const users = Object.fromEntries((input.users || []).map(user => [user.kind, user]));
  const baseUrl = `http://${s.container}:7048/BC/ODataV4`;
  const connection = { id: s.target, baseUrl, ...admin, authentication: 'UserPassword', dataToolsEnabled: true, revision: 'evp-1' };
  const client = createDataClient({ resolveConnection: () => connection });
  const companies = await client.listCompanies(connection.id);
  const companyId = s.companyId || companies.companies[0].id;
  assert.ok(companies.companies.some(company => company.id === companyId));
  function redact(text) {
    let safe = String(text);
    for (const user of [admin, ...Object.values(users)]) {
      for (const secret of [user.password, user.username, Buffer.from(`${user.username}:${user.password}`).toString('base64')]) {
        if (secret) safe = safe.split(secret).join('[redacted]');
      }
    }
    return safe.slice(0, 2048);
  }
  const runId = kind => s.runs.find(run => run.kind === kind).runId;
  const payload = { namespaceId: s.namespaceId, runs: s.runs };
  async function call(user, service, action, request) {
    const url = new URL(`${baseUrl}/${service}_${action}`);
    url.searchParams.set('company', companyId); url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: user.username, password: user.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(request) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { code: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  function success(response) { assert.equal(response.status, 200, response.message || 'Fixture request must succeed.'); return response; }
  async function administration(action, extra = {}) {
    const response = await call(admin, 'BCDCompatibilityEVP', action, { ...payload, ...extra });
    if (response.status !== 200) { const error = new Error('Fixture administration failed.'); error.safeMessage = response.message; throw error; }
    return response.value;
  }
  if (input.phase === 'discover') return { companyId };
  if (input.phase === 'prepareRoles') return administration('PrepareRoles');
  if (input.phase === 'cleanupRoles') return administration('CleanupRoles');
  if (input.phase === 'cleanupData') {
    await administration('CleanupData');
    const state = await administration('DataState');
    assert.equal(state.rows.length, 2);
    for (const row of state.rows) {
      assert.equal(row.runExists, false);
      for (const field of ['receiptCount','targetCount','barrierCount','pendingCount']) assert.equal(row[field], 0);
    }
    return { cleaned: true };
  }
  assert.deepEqual(Object.keys(users).sort(), ['f','x']);
  const receipt = (kind, action, request = {}) => call(users[kind], 'BCDCompatibilityEV', action, { runId: runId(kind), ...request });
  async function stateFor(kind, amount) {
    const state = (await administration('DataState')).rows.find(row => row.kind === kind);
    assert.equal(state.runExists, true);
    assert.equal(state.targetCount, 1);
    assert.equal(state.amount, amount);
    assert.equal(state.applyCount, 1);
    assert.equal(state.receiptCount, 1);
    assert.equal(state.pendingCount, 0);
    return state;
  }
  function nativeDenied(response, operation) {
    assert.ok([400,403].includes(response.status));
    assert.ok(response.message.includes('BCD Conflict Fixture'));
    assert.ok(response.message.toLowerCase().includes(operation));
    assert.equal(response.text, undefined);
    return { status: response.status, code: response.code, operation };
  }
  const results = [];
  async function check(name, work) {
    try { results.push({ name, passed: true, ...await work() }); }
    catch (error) { results.push({ name, passed: false, failure: error.name === 'AssertionError' ? redact(error.message) : 'Qualification request failed.' }); }
  }
  let ownerHistory = input.expectedHistory;
  if (ownerHistory) { assert.match(ownerHistory.request.systemId, guid); assert.match(ownerHistory.request.expectedVersion, /^[1-9][0-9]*$/); }
  const replay = () => receipt('f','Execute',ownerHistory.request);
  if (input.phase === 'initial') {
    await check('restricted owner modifies and replays exactly', async () => {
      const prepared = success(await receipt('f','Prepare'));
      const request = { runId: runId('f'), requestId: s.requestId, systemId: prepared.value.systemId,
        expectedVersion: prepared.value.version, operation: 'modify', amount: 4 };
      const applied = success(await receipt('f','Execute',request));
      ownerHistory = { request, text: applied.text };
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
    if (!ownerHistory) return { results };
    await check('another principal uses the same request ID in its own run', async () => {
      const prepared = success(await receipt('x','Prepare'));
      const applied = success(await receipt('x','Execute',{ requestId: s.requestId, systemId: prepared.value.systemId,
        expectedVersion: prepared.value.version, operation: 'modify', amount: 4 }));
      assert.notEqual(applied.text, ownerHistory.text);
      return { observed: await stateFor('x',4) };
    });
    for (const action of ['Execute','Inspect','ObservePending','Cleanup','CleanState']) {
      await check(`another principal cannot ${action} the owner run`, async () => {
        const denied = await receipt('x', action, ownerHistory.request);
        assert.equal(denied.status, 400);
        assert.ok(denied.message.includes(action === 'ObservePending' ? 'BCD_E06_RUN_OWNER_MISMATCH' :
          action === 'CleanState' ? 'BCD_E04_OWNER_MISMATCH' : 'BCD_EV_OWNER_MISMATCH'));
        assert.equal(denied.text, undefined);
        return { status: denied.status, observed: await stateFor('f',4) };
      });
    }
    await check('restricted caller cannot execute replay administration', async () => {
      const denied = await call(users.x, 'BCDCompatibilityEVP','DataState',payload);
      assert.ok([400,403].includes(denied.status));
      assert.match(denied.message, /execute|permission|codeunit/i);
      assert.equal(denied.text, undefined);
      return { status: denied.status, code: denied.code };
    });
  } else if (input.phase === 'r') {
    await check('same principal replays with target Read and no Modify', async () => {
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
    await check('same principal without Modify cannot apply a fresh request', async () => {
      const state = await stateFor('f',4);
      const denied = nativeDenied(await receipt('f','Execute',{ ...ownerHistory.request, requestId: crypto.randomUUID(), expectedVersion: state.version }), 'modify');
      return { ...denied, observed: await stateFor('f',4) };
    });
  } else if (input.phase === 'n') {
    for (const action of ['Execute','Inspect']) {
      await check(`same principal without target Read cannot ${action}`, async () => {
        const denied = nativeDenied(await receipt('f',action,ownerHistory.request),'read');
        return { ...denied, observed: await stateFor('f',4) };
      });
    }
  } else if (input.phase === 'v') {
    await check('target inside the Amount security filter permits exact replay', async () => {
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
    await check('target moved outside the security filter cannot disclose history', async () => {
      await administration('SetTargetAmount',{ runId: runId('f'), amount: 9 });
      const denied = await replay();
      assert.equal(denied.status, 400);
      assert.ok(denied.message.includes('BCD_EV_REPLAY_TARGET_UNAVAILABLE'));
      assert.equal(denied.text, undefined);
      return { status: denied.status, code: denied.code, observed: await stateFor('f',9) };
    });
    await check('target restored inside the filter returns the original historical result', async () => {
      await administration('SetTargetAmount',{ runId: runId('f'), amount: 4 });
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
  } else if (input.phase === 'f') {
    await check('restored full profile replays without another write', async () => {
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
  } else throw new Error('Invalid EVP phase.');
  return { results, ...(input.phase === 'initial' ? { ownerHistory } : {}) };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try { const input = JSON.parse(raw); raw = ''; process.stdout.write(JSON.stringify(await main(input))); }
  catch (error) { process.stderr.write(error.safeMessage || 'EVP failed; retain cleanup state.'); process.exitCode = 1; }
});
