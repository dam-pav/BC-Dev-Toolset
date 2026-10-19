'use strict';
// E08 destructive SQL restoration is deliberately performed separately by Toolset MCP.
// This harness operates only on two owned GUID fixture scopes, using HTTP/1.0.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { resolveWithinRoot } = require('../../../vscode-extension/path-security');
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let stage = 'connection'; // Fixed diagnostic labels only; never include raw request/authentication errors.

async function main(input) {
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, input.target));
  assert.equal(input.container, targets[input.target]);
  assert.ok(['Prepare', 'Apply', 'AfterRestore', 'Cleanup'].includes(input.phase));
  const root = path.resolve(__dirname, '../../..');
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `e08-restore-${input.container}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `e08-restore-${input.container}-evidence.json`);
  const connection = { id: input.target, baseUrl: `http://${input.container}:7048/BC/ODataV4`,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'e08-restore-http-1',
    username: input.admin.username, password: input.admin.password };
  const client = createDataClient({ resolveConnection: () => connection });
  const companyId = (await client.listCompanies(connection.id)).companies[0].id;
  const readiness = await client.readiness(connection.id, companyId);
  stage = 'fixture-phase';
  async function call(action, payload) {
    assert.match(payload.runId, guidPattern);
    const url = new URL(`${connection.baseUrl}/BCDCompatibilityE08_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    if (response.status !== 200) return { status: response.status,
      expired: String(envelope.error?.message).includes('BCD_E08_SCOPE_EXPIRED') };
    return { status: response.status, text: envelope.value, value: JSON.parse(envelope.value) };
  }
  async function success(action, payload) {
    const result = await call(action, payload);
    assert.equal(result.status, 200, `Fixture action ${action} must succeed.`);
    return result;
  }
  async function checkCounter(request, total, applies, receipts) {
    const result = await success('Inspect', request);
    assert.deepEqual(result.value, { total, applyCount: applies, receiptCount: receipts, pendingCount: 0 });
    return result.value;
  }
  let state;
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const stamp = (phase, details) => {
    state.events.push({ phase, checkedAt: new Date().toISOString(), ...details });
    save();
    fs.writeFileSync(evidencePath, JSON.stringify(state, null, 2));
    return state.events.at(-1);
  };
  if (input.phase === 'Prepare') {
    assert.ok(!fs.existsSync(statePath), 'Clean the existing owned restore scopes first.');
    state = { target: input.target, container: input.container, companyId, companionVersion: readiness.appVersion,
      scopes: [false, true].map(expired => ({ expired,
        request: { runId: crypto.randomUUID(), requestId: crypto.randomUUID(), amount: 4 } })), events: [] };
    fs.writeFileSync(statePath, JSON.stringify(state), { flag: 'wx' });
    for (const scope of state.scopes) {
      const prepared = await success('PrepareRestoreForTest', scope.request);
      assert.match(prepared.value.scopeEpoch, guidPattern);
      scope.request.scopeEpoch = prepared.value.scopeEpoch;
      save();
      if (scope.expired) await success('ExpireForTest', scope.request);
      scope.metadata = (await success('InspectScopeForTest', scope.request)).value;
      assert.match(scope.metadata.principal, guidPattern);
      assert.equal(scope.metadata.scopeEpoch, scope.request.scopeEpoch);
      if (!scope.expired) assert.ok(Date.parse(scope.metadata.retryUntil) > Date.now() + 23 * 3600000);
      await checkCounter(scope.request, 0, 0, 0);
      save();
    }
    return stamp('prepared-before-backup', { readyForBackup: true, companyId });
  }
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.target, input.target);
  assert.equal(state.container, input.container);
  assert.equal(state.companyId, companyId, 'Restoration must preserve the original company identity.');
  assert.equal(state.companionVersion, readiness.appVersion);
  assert.equal(state.scopes.length, 2);
  for (const scope of state.scopes) assert.match(scope.request.runId, guidPattern);
  if (input.phase === 'Cleanup') {
    for (const scope of state.scopes) {
      await success('Cleanup', scope.request);
      assert.deepEqual((await success('CleanState', scope.request)).value, { runExists: false, receiptCount: 0 });
    }
    const result = stamp('cleanup', { cleaned: true });
    fs.unlinkSync(statePath);
    return result;
  }
  const active = state.scopes[0];
  const expired = state.scopes[1];
  assert.equal(active.expired, false);
  assert.equal(expired.expired, true);
  for (const scope of state.scopes) {
    assert.deepEqual((await success('InspectScopeForTest', scope.request)).value, scope.metadata,
      'Epoch, deadline and authenticated principal must match the external snapshot.');
  }
  assert.ok(Date.parse(active.metadata.retryUntil) > Date.now(), 'An expired window cannot qualify active-scope restoration.');
  if (input.phase === 'Apply') {
    assert.equal(state.events.at(-1).phase, 'prepared-before-backup');
    await checkCounter(active.request, 0, 0, 0);
    active.originalResult = (await success('Execute', active.request)).text;
    save();
    assert.equal((await success('Execute', active.request)).text, active.originalResult);
    return stamp('applied-fixture', { observed: await checkCounter(active.request, 4, 1, 1), exactReplay: true });
  }
  assert.equal(state.events.at(-1).phase, 'applied-fixture');
  assert.equal(typeof active.originalResult, 'string');
  stage = 'require-restored-zero-counter';
  const rewound = await checkCounter(active.request, 0, 0, 0);
  await checkCounter(expired.request, 0, 0, 0);
  stamp('restored-snapshot-observed', { rewound, scopeMetadataUnchanged: true });
  stage = 'deliberate-fixture-reexecution';
  const repeated = await success('Execute', active.request); // Deliberate fixture negative control only.
  assert.notEqual(repeated.text, active.originalResult, 'Restored missing history causes execution, not exact replay.');
  const afterRepeat = await checkCounter(active.request, 4, 1, 1);
  assert.equal((await success('Execute', active.request)).text, repeated.text);
  await success('PurgeExpired', expired.request);
  for (const request of [expired.request, { ...expired.request, requestId: crypto.randomUUID() }]) {
    assert.deepEqual(await call('Execute', request), { status: 400, expired: true });
  }
  await checkCounter(expired.request, 0, 0, 0);
  return stamp('restore-qualified', { negativeControlReexecuted: true, originalResult: active.originalResult,
    repeatedResult: repeated.text, afterRepeat, expiredScopeRejectedOldAndNewIds: true,
    companyId, productionWritesEnabled: false });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw); raw = '';
    process.stdout.write(JSON.stringify(await main(input), null, 2));
  } catch {
    process.stderr.write(`E08 restore fixture failed at ${stage}; preserve local state/evidence and inspect the current phase before cleanup.`);
    process.exitCode = 1;
  }
});
