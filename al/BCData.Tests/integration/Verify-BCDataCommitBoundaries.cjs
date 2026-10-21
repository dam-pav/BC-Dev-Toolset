'use strict';
// Dedicated fixtures only. Credentials arrive through private stdin and are never persisted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { resolveWithinRoot } = require('../../../vscode-extension/path-security');

async function main(input) {
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, input.target));
  assert.equal(input.container, targets[input.target]);
  const root = path.resolve(__dirname, '../../..');
  const statePath = resolveWithinRoot(root, '.bcdevtoolset', `e07-${targets[input.target]}-state.json`);
  const evidencePath = resolveWithinRoot(root, '.bcdevtoolset', `e07-${targets[input.target]}-evidence.json`);
  const connection = { id: input.target, baseUrl: `http://${input.container}:7048/BC/ODataV4`,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'e07-http-1',
    username: input.admin.username, password: input.admin.password };
  const client = createDataClient({ resolveConnection: () => connection });
  const companies = await client.listCompanies(connection.id);
  const companyId = companies.companies[0].id;
  const readiness = await client.readiness(connection.id, companyId);
  const redact = value => String(value).split(connection.password).join('[redacted]')
    .split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0, 2048);
  async function call(action, runId, mode) {
    assert.match(runId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    const url = new URL(`${connection.baseUrl}/BCDCompatibilityE07_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify({ runId, mode }) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { value: JSON.parse(envelope.value) } :
      { errorCode: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  async function cleanup(runIds) {
    assert.ok(Array.isArray(runIds) && runIds.length <= 7);
    for (const runId of runIds) assert.match(runId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    for (const runId of runIds) {
      assert.equal((await call('Cleanup', runId)).status, 200);
      const inspected = await call('Inspect', runId);
      assert.equal(inspected.status, 200);
      assert.deepEqual(inspected.value, { mutation: false, receipt: false, rowCount: 0 });
    }
  }
  if (input.cleanupOnly) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.target, input.target);
    assert.equal(state.companyId, companyId);
    assert.ok(Array.isArray(state.runIds) && state.runIds.length <= 7);
    await cleanup(state.runIds);
    fs.unlinkSync(statePath);
    return { cleaned: true, target: input.target };
  }
  assert.ok(!fs.existsSync(statePath), 'An interrupted E07 run requires -CleanupOnly first.');
  const scenarios = [
    ['unguarded-explicit-error', 400, true, false],
    ['guarded-implicit-error', 400, true, false],
    ['receipt-first-implicit', 400, false, false],
    ['receipt-first-unguarded-implicit', 400, false, false],
    ['receipt-first-explicit', 400, false, false],
    ['receipt-first-ordinary', 200, true, true],
    ['receipt-first-ordinary-error', 400, false, false]
  ];
  const state = { target: input.target, companyId, runIds: scenarios.map(() => crypto.randomUUID()) };
  fs.writeFileSync(statePath, JSON.stringify(state), { flag: 'wx' });
  const results = [];
  let cleaned = false;
  try {
    for (const [index, [mode, status, mutation, receipt]] of scenarios.entries()) {
      const runId = state.runIds[index];
      const executed = await call('Execute', runId, mode);
      // A fresh HTTP/1.0 connection observes state after the action's transaction ended.
      const inspected = await call('Inspect', runId);
      const result = { mode, ...executed, observed: inspected.value, passed: false };
      results.push(result);
      try {
        assert.equal(executed.status, status);
        assert.equal(inspected.status, 200);
        assert.deepEqual(inspected.value, { mutation, receipt, rowCount: Number(mutation) + Number(receipt) });
        if (mode.endsWith('-error')) assert.ok(executed.message.includes('BCD_E07_AFTER_MUTATION'));
        if (mode === 'receipt-first-explicit') assert.match(executed.message, /commit/i);
        if (mode === 'receipt-first-implicit' || mode === 'receipt-first-unguarded-implicit') {
          assert.ok(!executed.message.includes('BCD_E07_AFTER_MUTATION'));
          assert.match(executed.message, /transaction|codeunit\.run/i);
        }
        result.passed = true;
      } catch { /* Retain measured state and sanitized native errors, without assertion operands. */ }
    }
  } finally {
    try {
      await cleanup(state.runIds);
      fs.unlinkSync(statePath);
      cleaned = true;
    } finally {
      const evidence = { target: input.target, companyId, utc: new Date().toISOString(), appVersion: readiness.appVersion,
        transport: 'native-node-http10', results, cleaned, passed: cleaned && results.length === scenarios.length && results.every(r => r.passed) };
      fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    }
  }
  return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
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
  } catch { process.stderr.write('E07 failed; inspect credential-free evidence and cleanup state.'); process.exitCode = 1; }
});
