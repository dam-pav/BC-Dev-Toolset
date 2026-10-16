'use strict';
// Private-stdin fixture phases. No credentials or unrestricted response bodies enter evidence.
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
  assert.deepEqual(s.runs.map(r => r.kind).sort(), ['f','m','n','r','x']);
  for (const r of s.runs) assert.match(r.runId, guid);
  const baseUrl = `http://${s.container}:7048/BC/ODataV4`;
  const admin = input.admin;
  const users = Object.fromEntries((input.users || []).map(user => [user.kind, user]));
  const connection = { id: s.target, baseUrl, ...admin, authentication: 'UserPassword', dataToolsEnabled: true, revision: 'e6p-1' };
  const client = createDataClient({ resolveConnection: () => connection });
  const companies = await client.listCompanies(connection.id);
  const companyId = s.companyId || companies.companies[0].id;
  assert.ok(companies.companies.some(c => c.id === companyId));
  const secrets = [admin, ...Object.values(users)];
  function redact(text) {
    let safe = String(text);
    for (const user of secrets) for (const secret of [user.password,
      Buffer.from(`${user.username}:${user.password}`).toString('base64'), user.username]) {
      if (secret) safe = safe.split(secret).join('[redacted]');
    }
    return safe.slice(0, 2048);
  }
  const runId = kind => s.runs.find(r => r.kind === kind).runId;
  const payload = { namespaceId: s.namespaceId, runs: s.runs };
  async function call(user, service, action, request) {
    const url = new URL(`${baseUrl}/${service}_${action}`);
    url.searchParams.set('company', companyId); url.searchParams.set('tenant','default');
    const response = await requestHttp10({ url: url.href, username: user.username, password: user.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(request) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { errorCode: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  const adminCall = action => call(admin, 'BCDCompatibilityE6P', action, payload);
  async function requireAdmin(action) {
    const result = await adminCall(action);
    if (result.status !== 200) { const error = new Error('Fixture administration failed.'); error.safeMessage = result.message; throw error; }
    return result.value;
  }
  if (input.phase === 'discover') return { companyId };
  if (input.phase === 'prepareRoles') return requireAdmin('PrepareRoles');
  if (input.phase === 'cleanupRoles') return requireAdmin('CleanupRoles');
  if (input.phase === 'cleanupData') {
    await requireAdmin('CleanupData');
    const state = await requireAdmin('DataState');
    assert.equal(state.rows.length, 5);
    for (const row of state.rows) { assert.equal(row.runExists, false); assert.equal(row.receiptCount, 0); }
    return { cleaned: true };
  }
  assert.deepEqual(Object.keys(users).sort(), ['f','m','n','r','x']);
  const receipt = (kind, action, data = {}) => call(users[kind], 'BCDCompatibilityE06', action, { runId: runId(kind), ...data });
  const mutation = (kind, requestId = s.requestId, amount = 4, targetRun = runId(kind)) =>
    receipt(kind, 'Execute', { runId: targetRun, requestId, amount });
  async function inspect(kind, count) {
    const state = await receipt(kind, 'Inspect');
    assert.equal(state.status, 200);
    assert.deepEqual(state.value, { total: count * 4, applyCount: count, receiptCount: count, pendingCount: 0 });
    return state.value;
  }
  async function adminState(kind, count) {
    const state = (await requireAdmin('DataState')).rows.find(r => r.kind === kind);
    assert.equal(state.runExists, true);
    assert.equal(state.applyCount, count); assert.equal(state.total, count * 4); assert.equal(state.receiptCount, count);
    return state;
  }
  function nativeDenied(response, table, operation) {
    assert.ok([400,403].includes(response.status));
    assert.ok(response.message.includes(table));
    assert.ok(response.message.toLowerCase().includes(operation));
    assert.equal(response.text, undefined);
    return { status: response.status, errorCode: response.errorCode, operation };
  }
  function successful(response) {
    assert.equal(response.status, 200, response.message || 'Fixture request must succeed.');
    return response;
  }
  const results = [];
  async function check(name, work) {
    try { results.push({ name, passed: true, ...await work() }); }
    catch (error) { results.push({ name, passed: false, failure: error.name === 'AssertionError' ? redact(error.message) : 'Qualification request failed.' }); }
  }
  let ownerResult = input.expectedResult;
  if (input.phase === 'initial') {
    await check('restricted owner applies once and replays exactly', async () => {
      successful(await receipt('f','Prepare'));
      const applied = successful(await mutation('f')); ownerResult = applied.text;
      assert.equal((await mutation('f')).text, ownerResult);
      return { observed: await inspect('f',1) };
    });
    if (!ownerResult) return { results };
    await check('another principal uses the same ID in its own run', async () => {
      successful(await receipt('x','Prepare'));
      const applied = successful(await mutation('x')); assert.notEqual(applied.text, ownerResult);
      return { observed: await inspect('x',1) };
    });
    for (const action of ['Execute','Inspect','ObservePending','Cleanup','CleanState']) {
      await check(`another principal cannot ${action} the owner run`, async () => {
        const result = await receipt('x', action, { runId: runId('f'), requestId: s.requestId, amount: 4 });
        assert.equal(result.status, 400); assert.ok(result.message.includes('BCD_E06_RUN_OWNER_MISMATCH'));
        await inspect('f',1);
        return { status: result.status };
      });
    }
    await check('receipt security filters hide the other principal rows', async () => {
      for (const [caller, target, expected] of [['f','f',1],['x','f',0],['x','x',1],['f','x',0]]) {
        const visible = await receipt(caller, 'ReceiptVisibility', { runId: runId(target) });
        assert.equal(visible.status, 200); assert.equal(visible.value.visibleReceipts, expected);
      }
      return { own: 1, other: 0 };
    });
    for (const [kind, table, operation] of [['n','BCD Receipt Fixture','insert'],['m','BCD Receipt Run','modify'],['r','BCD Receipt Fixture','insert']]) {
      await check(`profile ${kind} cannot perform the missing ${operation}`, async () => {
        successful(await receipt(kind, 'Prepare'));
        const denied = nativeDenied(await mutation(kind), table, operation);
        return { ...denied, observed: await adminState(kind,0) };
      });
    }
    await check('restricted caller cannot execute receipt administration', async () => {
      const denied = await call(users.x, 'BCDCompatibilityE6P','DataState',payload);
      assert.ok([400,403].includes(denied.status));
      assert.match(denied.message, /execute|permission|codeunit/i); assert.equal(denied.text, undefined);
      return { status: denied.status, errorCode: denied.errorCode };
    });
  } else if (input.phase === 'fm') {
    await check('same principal can confirm history after losing counter Modify', async () => {
      const replay = await mutation('f'); assert.equal(replay.status, 200); assert.equal(replay.text, ownerResult);
      return { observed: await inspect('f',1) };
    });
    await check('same principal without Modify cannot apply a new ID', async () => {
      const denied = nativeDenied(await mutation('f',crypto.randomUUID()),'BCD Receipt Run','modify');
      return { ...denied, observed: await inspect('f',1) };
    });
    await check('changed payload is rejected after losing Modify', async () => {
      const denied = await mutation('f',s.requestId,5);
      assert.equal(denied.status,400); assert.ok(denied.message.includes('BCD_E06_REQUEST_ID_REUSED'));
      return { observed: await inspect('f',1) };
    });
  } else if (input.phase === 'fr') {
    await check('same principal with receipt Read alone cannot replay insert-first protocol', async () => {
      const denied = nativeDenied(await mutation('f'),'BCD Receipt Fixture','insert');
      return { ...denied, observed: await inspect('f',1) };
    });
  } else if (input.phase === 'fn') {
    for (const action of ['Execute','Inspect']) {
      await check(`same principal without counter Read cannot ${action}`, async () => {
        const denied = nativeDenied(await receipt('f',action,{requestId:s.requestId,amount:4}),'BCD Receipt Run','read');
        return { ...denied, observed: await adminState('f',1) };
      });
    }
  } else if (input.phase === 'f') {
    await check('restored permissions replay the original result without another write', async () => {
      const replay = await mutation('f'); assert.equal(replay.status, 200); assert.equal(replay.text,ownerResult);
      return { observed: await inspect('f',1) };
    });
  } else throw new Error('Invalid phase.');
  return { results, ...(input.phase === 'initial' ? { ownerResult } : {}) };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try { const input = JSON.parse(raw); raw = ''; process.stdout.write(JSON.stringify(await main(input))); }
  catch (error) { process.stderr.write(error.safeMessage || 'E6P failed; retain cleanup state.'); process.exitCode = 1; }
});
