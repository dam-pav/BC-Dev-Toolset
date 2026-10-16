'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDataClient } = require('../bc-data-client');
const company = '11111111-2222-3333-4444-555555555555';
const target = id => ({ id, baseUrl: `http://${id}/BC/ODataV4`, username: 'fixture', password: 'secret', authentication: 'UserPassword', dataToolsEnabled: true, revision: 'fixture-1' });
const reply = data => ({ status: 200, body: Buffer.from(JSON.stringify({ value: JSON.stringify({ companyId: company, ...data }) })) });
const readiness = { contractVersion: 1, capabilities: ['read-primary-key', 'schema', 'companies'], mutationsEnabled: false };
function fixture(options = {}) {
  const calls = [];
  const connection = target('a');
  const client = createDataClient({ resolveConnection: () => connection, transport: async call => {
    calls.push(call);
    const input = JSON.parse(call.body.inputJson);
    return call.url.includes('_Readiness') ? reply(readiness) : reply({ tableId: 50200,
      records: [{ systemId: company, version: '12345678901234567', values: Object.fromEntries(input.fieldIds.map(id => [id, 'fixture'])) }],
      hasMore: true, position: '1=CONST(secret position)' });
  }, ...options });
  return { client, calls, connection };
}
test('disabled calls do not initialize transport or make HTTP requests', async () => {
  const { client, connection, calls } = fixture();
  connection.dataToolsEnabled = false;
  await assert.rejects(client.listCompanies('a'), { category: 'disabled' });
  assert.equal(calls.length, 0);
});
test('read-only client has no mutation API and checks the companion before a read', async () => {
  const { client, calls } = fixture();
  const page = await client.readRecords({ connectionId: 'a', companyId: company, tableId: 50200, fieldIds: [1] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /BCDData_Readiness/);
  assert.equal(client.modifyRecord, undefined);
  assert.equal(page.position, undefined);
  assert.equal(typeof page.continuationToken, 'string');
});
test('continuations bind target, principal, company, fields, filters and client session', async () => {
  const { client, calls, connection } = fixture();
  const input = { connectionId: 'a', companyId: company, tableId: 50200, fieldIds: [1], filters: [] };
  const first = await client.readRecords(input);
  await client.readRecords({ ...input, continuationToken: first.continuationToken });
  assert.equal(JSON.parse(calls.at(-1).body.inputJson).position, '1=CONST(secret position)');
  for (const alteration of [{ fieldIds: [2] }, { companyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, { filters: [{ fieldId: 1, expression: 'changed' }] }]) {
    await assert.rejects(client.readRecords({ ...input, ...alteration, continuationToken: first.continuationToken }), { category: 'invalid_cursor' });
  }
  connection.username = 'another-principal';
  await assert.rejects(client.readRecords({ ...input, continuationToken: first.continuationToken }), { category: 'invalid_cursor' });
  await assert.rejects(fixture().client.readRecords({ ...input, continuationToken: first.continuationToken }), { category: 'invalid_cursor' });
});
test('captures each connection once and does not follow a mutable active target', async () => {
  const connections = { a: target('a'), b: target('b') };
  const calls = [];
  const client = createDataClient({ resolveConnection: id => connections[id], transport: async call => {
    calls.push(call.url);
    connections.a.baseUrl = 'http://changed/BC/ODataV4';
    await new Promise(resolve => setImmediate(resolve));
    return reply(readiness);
  } });
  await Promise.all([client.getTableSchema({ connectionId: 'a', companyId: company, tableId: 1 }), client.getTableSchema({ connectionId: 'b', companyId: company, tableId: 1 })]);
  assert.equal(calls.filter(url => url.startsWith('http://a/')).length, 2);
  assert.equal(calls.filter(url => url.startsWith('http://b/')).length, 2);
  assert.equal(calls.some(url => url.includes('changed')), false);
});
test('rejects incompatible or wrong-company replies without continuing or retrying', async () => {
  let calls = 0;
  const { client } = fixture({ transport: async () => { calls++; return reply({ ...readiness, contractVersion: 2 }); } });
  await assert.rejects(client.getTableSchema({ connectionId: 'a', companyId: company, tableId: 1 }), { category: 'incompatible_app' });
  assert.equal(calls, 1);
  const wrong = fixture({ transport: async () => reply({ ...readiness, companyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) });
  await assert.rejects(wrong.client.readiness('a', company), { category: 'target_mismatch' });
});
test('cursor expiry is explicit and malformed replies are not accepted', async () => {
  let clock = 1000;
  const { client } = fixture({ now: () => clock });
  const input = { connectionId: 'a', companyId: company, tableId: 50200, fieldIds: [1] };
  const first = await client.readRecords(input);
  clock += 30 * 60 * 1000;
  await assert.rejects(client.readRecords({ ...input, continuationToken: first.continuationToken }), { category: 'invalid_cursor' });
  const malformed = fixture({ transport: async () => ({ status: 200, body: Buffer.from('{"value":') }) });
  await assert.rejects(malformed.client.readiness('a', company), { category: 'invalid_response' });
});
test('unsupported sorting cannot be silently ignored', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.readRecords({ connectionId: 'a', companyId: company, tableId: 50200, fieldIds: [1], sort: 'descending' }), { category: 'invalid_input' });
  assert.equal(calls.length, 0);
});
test('authentication and missing initialization remain actionable with non-JSON error bodies', async () => {
  for (const [status, category] of [[401, 'permission_denied'], [403, 'permission_denied'], [404, 'initialization_required']]) {
    const { client } = fixture({ transport: async () => ({ status, body: Buffer.from('<html>error</html>') }) });
    await assert.rejects(client.readiness('a', company), { category });
  }
});
test('compatible newer companion capabilities do not enable client mutation APIs', async () => {
  const { client } = fixture({ transport: async () => reply({ ...readiness, appVersion: '0.9.0.0', mutationsEnabled: true }) });
  const result = await client.readiness('a', company);
  assert.equal(result.appVersion, '0.9.0.0');
  assert.equal(client.insertRecord, undefined);
});

test('BC23 read denial markers classify independently of localized text and retain redacted table context', async () => {
  for (const status of [400, 403]) {
    const { client } = fixture({ transport: async () => ({ status, body: Buffer.from(JSON.stringify({
      error: { code: 'Internal_ServerError', message: 'BCD_PERMISSION_DENIED: Zugriff verweigert: BCD Probe Header secret Zml4dHVyZTpzZWNyZXQ=' }
    })) }) });
    await assert.rejects(client.readiness('a', company), error => {
      assert.equal(error.category, 'permission_denied');
      assert.equal(error.outcome, 'not_applied');
      assert.match(error.message, /BCD Probe Header/);
      assert.ok(!error.message.includes('secret'));
      assert.ok(!error.message.includes('Zml4dHVyZTpzZWNyZXQ='));
      return true;
    });
  }
});

test('generic BC23 server errors and permission words are not guessed to be authorization failures', async () => {
  for (const message of ['An unrelated server failure.', 'Permission denied in caller text.', 'prefix BCD_PERMISSION_DENIED: not a service marker']) {
    const { client } = fixture({ transport: async () => ({ status: 400, body: Buffer.from(JSON.stringify({
      error: { code: 'Internal_ServerError', message }
    })) }) });
    await assert.rejects(client.readiness('a', company), { category: 'bc_error', message });
  }
});

test('JSON authorization errors retain BC context and malformed authorization bodies stay actionable', async () => {
  for (const body of ['{}', 'null', '[]', '{"error":{"message":4}}']) {
    const { client } = fixture({ transport: async () => ({ status: 403, body: Buffer.from(body) }) });
    await assert.rejects(client.readiness('a', company), { category: 'permission_denied' });
  }
  const { client } = fixture({ transport: async () => ({ status: 403, body: Buffer.from(JSON.stringify({
    error: { code: 'Internal_ServerError', message: 'BCD Probe Sum Entry read rejected.' }
  })) }) });
  await assert.rejects(client.readiness('a', company), { category: 'permission_denied', message: 'BCD Probe Sum Entry read rejected.' });
});
test('a BC record-not-found HTTP 404 is not mislabeled as a missing companion', async () => {
  const { client } = fixture({ transport: async () => ({ status: 404, body: Buffer.from(JSON.stringify({
    error: { code: 'Internal_RecordNotFound', message: 'The Company does not exist.' }
  })) }) });
  await assert.rejects(client.readiness('a', company), { category: 'record_not_found' });
});
test('captures the query before asynchronous resolution and rejects missing fields in a response', async () => {
  const input = { connectionId: 'a', companyId: company, tableId: 50200, fieldIds: [1] };
  const { client, calls } = fixture({ resolveConnection: async () => {
    input.fieldIds[0] = 2;
    return target('a');
  } });
  await client.readRecords(input);
  assert.deepEqual(JSON.parse(calls.at(-1).body.inputJson).fieldIds, [1]);
  const broken = fixture({ transport: async call => call.url.includes('_Readiness') ? reply(readiness) :
    reply({ tableId: 50200, records: [{ systemId: company, version: '1', values: {} }], hasMore: false }) });
  await assert.rejects(broken.client.readRecords({ ...input, fieldIds: [1] }), { category: 'invalid_response' });
});
