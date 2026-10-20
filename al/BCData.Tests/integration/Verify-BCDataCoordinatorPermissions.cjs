'use strict';
// Dedicated generic coordinator authorization phases. Secrets/history stay on private stdin.
const assert = require('node:assert/strict');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const s = input.state;
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, s.target));
  assert.equal(s.container, targets[s.target]);
  for (const id of [s.namespaceId, s.requestId]) assert.match(id, guid);
  assert.deepEqual(s.runs.map(run => run.kind).sort(), ['f', 'x']);
  for (const run of s.runs) assert.match(run.runId, guid);
  assert.ok(['insert', 'modify', 'rename', 'delete'].includes(s.operation));
  const users = Object.fromEntries((input.users || []).map(user => [user.kind, user]));
  const baseUrl = `http://${s.container}:7048/BC/ODataV4`;
  const connection = { id: s.target, baseUrl, ...input.admin, authentication: 'UserPassword', dataToolsEnabled: true, revision: 'coord-auth-1' };
  const client = createDataClient({ resolveConnection: () => connection });
  const companies = (await client.listCompanies(connection.id)).companies;
  const companyId = s.companyId || companies[0].id;
  assert.ok(companies.some(company => company.id === companyId));
  const runId = kind => s.runs.find(run => run.kind === kind).runId;
  const payload = { namespaceId: s.namespaceId, ownerRunId: runId('f'), otherRunId: runId('x'), operation: s.operation };
  function redact(value) {
    let safe = String(value);
    for (const user of [input.admin, ...Object.values(users)]) {
      for (const secret of [user.username, user.password, Buffer.from(`${user.username}:${user.password}`).toString('base64')]) {
        if (secret) safe = safe.split(secret).join('[redacted]');
      }
    }
    return safe.slice(0, 1536);
  }
  async function call(user, service, action, body) {
    const url = new URL(`${baseUrl}/${service}_${action}`);
    url.searchParams.set('company', companyId); url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: user.username, password: user.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(body) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { message: redact(envelope.error?.message) }) };
  }
  function success(response) { assert.equal(response.status, 200, response.message); return response; }
  function denied(response, table) {
    assert.ok([400, 403].includes(response.status), response.message);
    assert.equal(response.text, undefined);
    if (table) assert.ok(response.message.includes(table), response.message);
  }
  async function administration(action, extra = {}) {
    return success(await call(input.admin, 'BCDCompatibilityEVP', action, { ...payload, ...extra })).value;
  }
  const ownedAdmin = (action, extra = {}) => administration(action, { kind: 'f', runId: runId('f'), ...extra });
  if (input.phase === 'discover') return { companyId };
  if (input.phase === 'prepareRoles') return administration('PrepareCoordinatorRoles');
  if (input.phase === 'cleanupRoles') return administration('CleanupRoles');
  if (input.phase === 'cleanupData') {
    for (const run of s.runs) await administration('CleanupCoordinatorData', run);
    return { cleaned: true };
  }
  assert.deepEqual(Object.keys(users).sort(), ['f', 'x']);
  const results = [];
  async function check(name, test) {
    const result = { name, passed: false }; results.push(result);
    try { Object.assign(result, await test()); result.passed = true; }
    catch (error) { result.error = redact(error.message); }
  }
  const execute = (request, kind = 'f') => call(users[kind], 'BCDCompatibilityCoord', 'Execute', request);
  let history = input.expectedHistory;
  async function replay() {
    const response = success(await execute(history.request));
    assert.equal(response.text, history.result);
    return response;
  }
  function fresh(state) {
    return { ...history.request, slot: 2, epoch: history.otherEpoch, systemId: state.systemId,
      expectedVersion: state.version, quantity: '9', destination: 'C' };
  }
  if (input.phase === 'initial') {
    await check('owner applies generic mutation under native scoped grants', async () => {
      const prepared = success(await call(users.f, 'BCDCompatibilityCoord', 'Prepare', {
        runId: runId('f'), requestId: s.requestId, operation: s.operation, delayMs: 0 })).value;
      const request = { runId: runId('f'), epoch: prepared.epoch, systemId: prepared.systemId,
        expectedVersion: prepared.version, quantity: '4', destination: 'B' };
      const applied = success(await execute(request));
      assert.equal(applied.value.requestId.toLowerCase(), s.requestId.toLowerCase());
      history = { request, result: applied.text, otherEpoch: prepared.otherEpoch };
      return { observed: await ownedAdmin('CoordinatorDataState') };
    });
    if (!history) return { results };
    await check('same request ID under another principal produces independent history', async () => {
      const prepared = success(await call(users.x, 'BCDCompatibilityCoord', 'Prepare', {
        runId: runId('x'), requestId: s.requestId, operation: s.operation, delayMs: 0 })).value;
      const applied = success(await execute({ runId: runId('x'), epoch: prepared.epoch,
        systemId: prepared.systemId, expectedVersion: prepared.version, quantity: '4', destination: 'B' }, 'x'));
      assert.equal(applied.value.requestId.toLowerCase(), s.requestId.toLowerCase());
      assert.notEqual(applied.text, history.result);
      return { observed: await ownedAdmin('CoordinatorDataState', { kind: 'x', runId: runId('x') }) };
    });
    await check('owner history remains exact after another principal uses the same ID', () => replay().then(() => ({})));
    await check('foreign owned-run execution is denied without disclosing history', async () => denied(await execute(history.request, 'x')));
    await check('restricted caller cannot execute qualification administration', async () =>
      denied(await call(users.f, 'BCDCompatibilityEVP', 'CoordinatorDataState', { ...payload, kind: 'f', runId: runId('f') })));
    return { results, ownerHistory: history };
  }
  assert.ok(history?.request && typeof history.result === 'string');
  if (input.phase === 'r') {
    await check('completed history replays with target Read and no fresh-write rights', () => replay().then(() => ({})));
    let before;
    await check('fresh prepared command still requires native business write rights', async () => {
      if (s.operation === 'insert') await ownedAdmin('SetCoordinatorTarget', { mode: 'name', name: 'B' });
      if (s.operation === 'delete') await ownedAdmin('SetCoordinatorTarget', { mode: 'restore' });
      before = await ownedAdmin('CoordinatorDataState');
      const response = await execute(fresh(before));
      denied(response, 'BCD Mutation Fixture');
    });
    await check('denied fresh write leaves target logs and prepared receipt unchanged', async () => {
      assert.ok(before); const after = await ownedAdmin('CoordinatorDataState');
      assert.deepEqual(after, before); assert.equal(after.otherCompleted, false);
      return { observed: after };
    });
  } else if (input.phase === 'n') {
    const before = await ownedAdmin('CoordinatorDataState');
    await check(s.operation === 'delete' ? 'minimal delete acknowledgement survives target Read revocation' : 'target Read revocation denies stored business history', async () => {
      if (s.operation === 'delete') await replay();
      else denied(await execute(history.request), 'BCD Mutation Fixture');
    });
    await check('Read revocation preserves committed target and both receipt states', async () => {
      const after = await ownedAdmin('CoordinatorDataState'); assert.deepEqual(after, before); return { observed: after };
    });
  } else if (input.phase === 'v') {
    if (s.operation === 'delete') {
      const before = await ownedAdmin('CoordinatorDataState');
      await check('delete acknowledgement is denied when receipt Read is revoked', async () => denied(await execute(history.request), 'BCD Mutation Receipt'));
      await check('fresh deletion is also denied before receipt reservation without receipt Read', async () => denied(await execute(fresh(before)), 'BCD Mutation Receipt'));
      await check('receipt Read revocation changes neither replacement nor receipt', async () => {
        const after = await ownedAdmin('CoordinatorDataState'); assert.deepEqual(after, before); return { observed: after };
      });
    } else {
      await check('native Quantity filter permits current original target visibility', async () => {
        await ownedAdmin('SetCoordinatorTarget', { mode: 'quantity', quantity: '4' }); await replay();
      });
      await check('moving original SystemId outside native filter denies history', async () => {
        await ownedAdmin('SetCoordinatorTarget', { mode: 'quantity', quantity: '9' });
        try { denied(await execute(history.request)); }
        finally { await ownedAdmin('SetCoordinatorTarget', { mode: 'quantity', quantity: '4' }); }
      });
      await check('restoring visibility returns original result despite newer row version', () => replay().then(() => ({})));
    }
  } else if (input.phase === 'f') {
    await check('restored native rights return exact original acknowledgement/history', () => replay().then(() => ({})));
    let applied;
    let request;
    let after;
    await check('known denied scope can apply once after native write rights are restored', async () => {
      const before = await ownedAdmin('CoordinatorDataState');
      request = fresh(before);
      applied = success(await execute(request));
      after = await ownedAdmin('CoordinatorDataState');
      assert.equal(after.otherCompleted, true); assert.equal(after.logs, before.logs + 1);
      return { observed: after };
    });
    await check('new completed command replays without another native trigger', async () => {
      assert.ok(applied); assert.equal(success(await execute(request)).text, applied.text);
      assert.deepEqual(await ownedAdmin('CoordinatorDataState'), after);
    });
  } else throw new Error('Unknown coordinator authorization phase.');
  return { results };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try { const input = JSON.parse(raw); raw = ''; process.stdout.write(JSON.stringify(await main(input))); }
  catch { process.stderr.write('Coordinator authorization phase failed; use tagged recovery state for cleanup.'); process.exitCode = 1; }
});
