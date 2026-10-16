'use strict';
// Invoked by Invoke-E12Permissions.ps1 over private stdin/stdout. Never log input.
const assert = require('node:assert/strict');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');

async function main(input) {
  assert.ok(['prepare', 'verify', 'cleanup'].includes(input.phase));
  assert.ok(['bcdata23test', 'bcdata271'].includes(input.container));
  assert.match(input.runId, /^[0-9a-f-]{36}$/i);
  const connection = user => ({ id: user.username, baseUrl: `http://${input.container}:7048/BC/ODataV4`,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: input.runId,
    username: user.username, password: user.password });
  const clientFor = user => createDataClient({ resolveConnection: () => connection(user) });
  const admin = connection(input.admin);
  const adminClient = clientFor(input.admin);
  const companies = await adminClient.listCompanies(admin.id);
  const companyId = input.companyId || companies.companies[0].id;
  assert.ok(companies.companies.some(company => company.id === companyId));
  const filters = [{ fieldId: 1, expression: input.runId }];
  const query = { companyId, tableId: 50200, fieldIds: [2], filters, pageSize: 1 };
  async function fixture(action) {
    const url = new URL(`${admin.baseUrl}/BCDCompatibilityE12_${action}`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const response = await requestHttp10({ url: url.href, username: admin.username, password: admin.password,
      body: { inputJson: JSON.stringify({ runId: input.runId }) } });
    if (response.status !== 200) {
      let message = `E12 fixture ${action} HTTP ${response.status}`;
      try { message += `: ${JSON.parse(response.body.toString('utf8')).error.message}`; } catch {}
      const error = new Error(message.split(admin.password).join('[redacted]')
        .split(Buffer.from(`${admin.username}:${admin.password}`).toString('base64')).join('[redacted]').slice(0, 2048));
      error.name = 'FixtureError';
      throw error;
    }
    return JSON.parse(JSON.parse(response.body.toString('utf8')).value);
  }
  if (input.phase === 'prepare') {
    await fixture('Prepare');
    await fixture('PrepareRoles');
    return { companyId };
  }
  if (input.phase === 'cleanup') {
    await fixture('Cleanup');
    await fixture('CleanupRoles');
    const result = await adminClient.readRecords({ ...query, connectionId: admin.id });
    assert.equal(result.records.length, 0);
    const entries = await adminClient.readRecords({ ...query, connectionId: admin.id, tableId: 50203,
      fieldIds: [2], filters: [{ fieldId: 2, expression: input.runId }] });
    assert.equal(entries.records.length, 0);
    return { cleaned: true };
  }
  const results = [];
  async function check(name, run) {
    try { results.push({ name, passed: true, ...await run() }); }
    catch (error) {
      results.push({ name, passed: false, category: error.category || 'assertion_failed',
        // No arbitrary assertion operands, raw response bodies, or stack traces.
        message: error.name === 'DataClientError' ? error.message : 'Qualification assertion failed.' });
    }
  }
  async function denied(user, fieldIds, expectedTable) {
    const target = connection(user);
    const url = new URL(`${target.baseUrl}/BCDData_ReadRecords`);
    url.searchParams.set('company', companyId);
    url.searchParams.set('tenant', 'default');
    const raw = await requestHttp10({ url: url.href, username: target.username, password: target.password,
      body: { inputJson: JSON.stringify({ tableId: 50200, fieldIds, filters, pageSize: 1 }) } });
    const envelope = JSON.parse(raw.body.toString('utf8'));
    assert.notEqual(raw.status, 200);
    assert.ok(envelope.error.message.includes(expectedTable), 'Denial must name the expected table.');
    const diagnosticUrl = new URL(url);
    diagnosticUrl.pathname = diagnosticUrl.pathname.replace('BCDData_ReadRecords', 'BCDCompatibilityE12_ReadError');
    const diagnostic = await requestHttp10({ url: diagnosticUrl.href, username: target.username, password: target.password,
      body: { inputJson: JSON.stringify({ tableId: 50200, fieldIds, filters, pageSize: 1 }) } });
    assert.equal(diagnostic.status, 200);
    const errorCode = JSON.parse(JSON.parse(diagnostic.body.toString('utf8')).value).errorCode;
    assert.equal(errorCode, 'DB:ClientReadDenied', 'Native classification must be measured independently.');
    let failure;
    try { await clientFor(user).readRecords({ ...query, connectionId: user.username, fieldIds }); }
    catch (error) { failure = error; }
    assert.equal(failure?.outcome, 'not_applied');
    assert.equal(failure?.category, 'permission_denied');
    assert.ok(failure.message.includes(expectedTable), 'Client denial preserves table context.');
    assert.ok(!failure.message.includes(user.password));
    assert.ok(!failure.message.includes(Buffer.from(`${user.username}:${user.password}`).toString('base64')));
    return { httpStatus: raw.status, bcCode: envelope.error.code, alErrorCode: errorCode, category: failure.category };
  }
  const users = Object.fromEntries(input.users.map(user => [user.kind, user]));
  const read = (kind, extra = {}) => clientFor(users[kind]).readRecords({ ...query,
    connectionId: users[kind].username, ...extra });
  await check('admin fixture has two headers and full child total', async () => {
    const result = await adminClient.readRecords({ ...query, connectionId: admin.id, pageSize: 10, fieldIds: [2, 11] });
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].values['11'], '30');
  });
  await check('missing parent read is denied', () => denied(users.none, [2], 'BCD Probe Header'));
  await check('stored fields need no child read', async () => {
    const client = clientFor(users.header);
    const first = await client.readRecords({ ...query, connectionId: users.header.username });
    assert.equal(first.records[0].values['2'], 1);
    assert.equal(first.hasMore, true);
    const second = await client.readRecords({ ...query, connectionId: users.header.username,
      continuationToken: first.continuationToken });
    assert.equal(second.records[0].values['2'], 2);
    assert.equal(second.hasMore, false);
  });
  await check('missing child read is denied', () => denied(users.header, [11], 'BCD Probe Sum Entry'));
  await check('read-only parent and child calculate full total', async () => {
    const result = await read('related', { fieldIds: [11] });
    assert.equal(result.records[0].values['11'], '30');
  });
  await check('security filter hides second header and continuation', async () => {
    const result = await read('filtered');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].values['2'], 1);
    assert.equal(result.hasMore, false);
    assert.ok(!result.continuationToken);
  });
  await check('caller filter cannot widen security filter', async () => {
    const result = await read('filtered', { filters: [...filters, { fieldId: 2, expression: '1|2' }], pageSize: 10 });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].values['2'], 1);
  });
  await check('explicit inaccessible header returns no rows', async () => {
    const result = await read('filtered', { filters: [...filters, { fieldId: 2, expression: '2' }] });
    assert.equal(result.records.length, 0);
  });
  await check('FlowField total respects source security filter', async () => {
    const result = await read('filtered', { fieldIds: [11] });
    assert.equal(result.records[0].values['11'], '10');
  });
  await check('date/time, closing, zero and precision values preserve their wire types', async () => {
    const result = await read('related', { fieldIds: [20, 21, 22, 23, 24, 25, 26], pageSize: 10 });
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records[0].values, { '20': '2024-02-29', '21': '12:34:56.010',
      '22': '2026-10-25T01:30:00.123Z', '23': '', '24': '', '25': '9223372036854775807', '26': 'MIXED CODE' });
    assert.deepEqual(result.records[1].values, { '20': { date: '2026-12-31', closing: true },
      '21': '00:00:00.000', '22': '', '23': '', '24': '', '25': '0', '26': '' });
  });
  const readiness = await adminClient.readiness(admin.id, companyId);
  return { companyId, appVersion: readiness.appVersion, results, passed: results.every(result => result.passed) };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 65536) process.exit(1); });
process.stdin.on('end', () => {
  Promise.resolve().then(() => main(JSON.parse(raw))).then(result => process.stdout.write(JSON.stringify(result)))
    .catch(error => { process.stderr.write(error.name === 'FixtureError' ? error.message :
      'E12 qualification failed; credentials and response bodies omitted.'); process.exitCode = 1; });
});
