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
  const operation = s.operation || 'modify';
  assert.ok(['modify','rename','insert','delete'].includes(operation));
  const rename = operation === 'rename';
  const insert = operation === 'insert';
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
  const payload = { namespaceId: s.namespaceId, runs: s.runs, renamePolicy: rename, deletePolicy: operation === 'delete' };
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
  if (operation === 'delete') {
    let history = input.expectedHistory;
    const replayDelete = () => receipt('f', 'Execute', history.request);
    async function deleteState(kind, targetCount) {
      const state = (await administration('DataState')).rows.find(row => row.kind === kind);
      assert.equal(state.runExists, true);
      assert.equal(state.targetCount, targetCount);
      assert.equal(state.receiptCount, 1);
      assert.equal(state.applyCount, 1);
      assert.equal(state.pendingCount, 0);
      return state;
    }
    function ack(response, systemId) {
      success(response);
      assert.deepEqual(Object.keys(response.value).sort(), ['applyCount','deletedSystemId','outcome','requestId','resultId']);
      assert.equal(response.value.deletedSystemId.toLowerCase(), systemId.toLowerCase());
      assert.equal(response.value.outcome, 'applied');
    }
    function receiptDenied(response) {
      assert.ok([400,403].includes(response.status));
      assert.ok(response.message.includes('BCD Receipt Fixture'));
      assert.match(response.message, /read/i);
      assert.equal(response.text, undefined);
      return { status: response.status, code: response.code };
    }
    if (input.phase === 'initial') {
      await check('restricted owner deletes and replays only minimal acknowledgement', async () => {
        const row = success(await receipt('f', 'Prepare')).value;
        const request = { runId: runId('f'), requestId: s.requestId, systemId: row.systemId, expectedVersion: row.version, operation };
        const applied = await receipt('f', 'Execute', request);
        ack(applied, row.systemId);
        history = { request, text: applied.text };
        assert.equal(success(await replayDelete()).text, history.text);
        return { observed: await deleteState('f', 0) };
      });
      if (!history) return { results };
      await check('another principal independently deletes with the same request ID', async () => {
        const row = success(await receipt('x', 'Prepare')).value;
        const applied = await receipt('x', 'Execute', { requestId: s.requestId, systemId: row.systemId, expectedVersion: row.version, operation });
        ack(applied, row.systemId);
        assert.notEqual(applied.text, history.text);
        return { observed: await deleteState('x', 0) };
      });
      for (const action of ['Execute','Inspect','ObservePending','Cleanup','CleanState']) {
        await check(`another principal cannot ${action} owner delete history`, async () => {
          const denied = await receipt('x', action, history.request);
          assert.equal(denied.status, 400);
          assert.ok(denied.message.includes(action === 'ObservePending' ? 'BCD_E06_RUN_OWNER_MISMATCH' :
            action === 'CleanState' ? 'BCD_E04_OWNER_MISMATCH' : 'BCD_EV_OWNER_MISMATCH'));
          assert.equal(denied.text, undefined);
          return { status: denied.status, observed: await deleteState('f', 0) };
        });
      }
      await check('restricted caller cannot administer deleted targets', async () => {
        const denied = await call(users.x, 'BCDCompatibilityEVP', 'DataState', payload);
        assert.ok([400,403].includes(denied.status));
        assert.equal(denied.text, undefined);
        return { status: denied.status, code: denied.code };
      });
    } else if (input.phase === 'r') {
      await check('own delete acknowledgement replays without current Delete', async () => {
        assert.equal(success(await replayDelete()).text, history.text);
        return { observed: await deleteState('f', 0) };
      });
      await check('fresh delete without Delete cannot remove same-key replacement', async () => {
        await administration('RestoreDeletedTarget', { runId: runId('f') });
        const before = await deleteState('f', 1);
        assert.notEqual(before.systemId, history.request.systemId);
        const denied = nativeDenied(await receipt('f', 'Execute', { ...history.request,
          requestId: crypto.randomUUID(), systemId: before.systemId, expectedVersion: before.version }), 'delete');
        const observed = await deleteState('f', 1);
        assert.equal(observed.systemId, before.systemId);
        assert.equal(observed.version, before.version);
        assert.equal(success(await replayDelete()).text, history.text);
        return { ...denied, observed };
      });
    } else if (input.phase === 'n') {
      await check('loss of business-row Read still permits own minimal acknowledgement', async () => {
        assert.equal(success(await replayDelete()).text, history.text);
        return { observed: await deleteState('f', 1) };
      });
      await check('business-row inspection still requires current target Read', async () => {
        const denied = nativeDenied(await receipt('f', 'Inspect'), 'read');
        return { ...denied, observed: await deleteState('f', 1) };
      });
    } else if (input.phase === 'v') {
      for (const action of ['Execute','Inspect','ObservePending']) {
        await check(`receipt Read revocation blocks ${action}`, async () => {
          const denied = receiptDenied(await receipt('f', action, history.request));
          return { ...denied, observed: await deleteState('f', 1) };
        });
      }
    } else if (input.phase === 'f') {
      await check('restored receipt Read returns exact acknowledgement and preserves replacement', async () => {
        assert.equal(success(await replayDelete()).text, history.text);
        return { observed: await deleteState('f', 1) };
      });
    } else throw new Error('Invalid delete phase.');
    return { results, ...(input.phase === 'initial' ? { ownerHistory: history } : {}) };
  }
  let ownerHistory = input.expectedHistory;
  if (ownerHistory) {
    assert.match(ownerHistory.request.systemId, guid);
    if (insert) assert.equal(ownerHistory.request.expectedVersion, undefined);
    else assert.match(ownerHistory.request.expectedVersion, /^[1-9][0-9]*$/);
  }
  const replay = () => receipt('f','Execute',ownerHistory.request);
  if (input.phase === 'initial') {
    await check(`restricted owner ${operation} applies and replays exactly`, async () => {
      let prepared = success(await receipt('f', insert ? 'PrepareEmpty' : 'Prepare'));
      if (insert) prepared = { value: { systemId: crypto.randomUUID() } };
      if (rename) {
        await administration('SetTargetAmount', { runId: runId('f'), amount: 4 });
        const inspected = success(await receipt('f','Inspect'));
        prepared = { value: inspected.value.row };
      }
      const request = { runId: runId('f'), requestId: s.requestId, systemId: prepared.value.systemId,
        ...(insert ? {} : { expectedVersion: prepared.value.version }), operation, ...(rename ? {} : { amount: 4 }) };
      const applied = success(await receipt('f','Execute',request));
      if (rename || insert) {
        assert.equal(applied.value.row.name, rename ? 'RENAMED' : 'ORIGINAL');
        assert.equal(applied.value.row.systemId.toLowerCase(), prepared.value.systemId.toLowerCase());
      }
      ownerHistory = { request, text: applied.text };
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
    if (!ownerHistory) return { results };
    await check('another principal uses the same request ID in its own run', async () => {
      let prepared = success(await receipt('x', insert ? 'PrepareEmpty' : 'Prepare'));
      if (insert) prepared = { value: { systemId: crypto.randomUUID() } };
      const applied = success(await receipt('x','Execute',{ requestId: s.requestId, systemId: prepared.value.systemId,
        ...(insert ? {} : { expectedVersion: prepared.value.version }), operation, ...(rename ? {} : { amount: 4 }) }));
      assert.notEqual(applied.text, ownerHistory.text);
      return { observed: await stateFor('x',rename ? 0 : 4) };
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
    await check(`same principal replays with target Read and no ${insert ? 'Insert' : 'Modify'}`, async () => {
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
    await check(`same principal without ${insert ? 'Insert' : 'Modify'} cannot apply a fresh ${operation}`, async () => {
      // Keep the old SystemId/history. Rename must change its key; insert must
      // have a free ORIGINAL key so a conflict cannot mask a native denial.
      if (rename || insert) await administration('SetTargetName', { runId: runId('f'), name: insert ? 'RENAMED' : 'ORIGINAL' });
      try {
        const state = await stateFor('f',4);
        const request = { ...ownerHistory.request, requestId: crypto.randomUUID(),
          ...(insert ? { systemId: crypto.randomUUID() } : { expectedVersion: state.version }) };
        const denied = nativeDenied(await receipt('f','Execute',request), insert ? 'insert' : 'modify');
        const observed = await stateFor('f',4);
        assert.equal(observed.version, state.version);
        assert.equal(observed.systemId, state.systemId);
        return { ...denied, observed };
      } finally {
        if (rename || insert) await administration('SetTargetName', { runId: runId('f'), name: insert ? 'ORIGINAL' : 'RENAMED' });
      }
    });
  } else if (input.phase === 'n') {
    for (const action of ['Execute','Inspect']) {
      await check(`same principal without target Read cannot ${action}`, async () => {
        const denied = nativeDenied(await receipt('f',action,ownerHistory.request),'read');
        return { ...denied, observed: await stateFor('f',4) };
      });
    }
  } else if (input.phase === 'v') {
    await check(`target inside the ${rename ? 'Name' : 'Amount'} security filter permits exact replay`, async () => {
      assert.equal(success(await replay()).text, ownerHistory.text);
      return { observed: await stateFor('f',4) };
    });
    await check('target moved outside the security filter cannot disclose history', async () => {
      await administration(rename ? 'SetTargetName' : 'SetTargetAmount', { runId: runId('f'), ...(rename ? { name: 'ORIGINAL' } : { amount: 9 }) });
      const denied = await replay();
      assert.equal(denied.status, 400);
      assert.ok(denied.message.includes('BCD_EV_REPLAY_TARGET_UNAVAILABLE'));
      assert.equal(denied.text, undefined);
      return { status: denied.status, code: denied.code, observed: await stateFor('f',rename ? 4 : 9) };
    });
    await check('target restored inside the filter returns the original historical result', async () => {
      await administration(rename ? 'SetTargetName' : 'SetTargetAmount', { runId: runId('f'), ...(rename ? { name: 'RENAMED' } : { amount: 4 }) });
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
