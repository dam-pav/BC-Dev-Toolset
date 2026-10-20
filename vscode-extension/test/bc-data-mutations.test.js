'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDataClient } = require('../bc-data-client');
const { DataTransportError } = require('../bc-data-http10');
const { dataTools, mutationToolNames, validateDataArguments } = require('../bc-data-tools');
const companyId = '11111111-2222-3333-4444-555555555555';
const systemId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const epoch = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const base = { connectionId: 'Dedicated', companyId, tableId: 50221 };
const existing = { ...base, systemId, expectedVersion: '9007199254740993' };
const fields = [{ fieldId: 4, value: '4.123456789012345678' }];
const reply = value => ({ status: 200, body: Buffer.from(JSON.stringify({ value: JSON.stringify({ companyId, ...value }) })) });
const rejected = message => ({ status: 400, body: Buffer.from(JSON.stringify({ error: { message } })) });
function fixture(hooks = {}) {
  const calls = [];
  const receipts = new Map();
  let applies = 0;
  const connection = { id: 'Dedicated', baseUrl: 'http://dedicated/BC/ODataV4', username: 'fixture', password: 'secret',
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'mutation-1' };
  const client = createDataClient({ resolveConnection: () => connection, now: () => 1000,
    transport: async call => {
      const input = JSON.parse(call.body.inputJson);
      calls.push({ url: call.url, input });
      if (call.url.includes('_Readiness')) {
        await hooks.ready?.();
        return reply({ contractVersion: 1, capabilities: ['mutation-scopes-v1', 'schema'], mutationsEnabled: true,
          mutationProtocolVersion: 1, ...hooks.capability });
      }
      if (call.url.includes('BCDData_GetTableSchema')) return reply({ tableId: base.tableId });
      if (call.url.includes('_Prepare')) return hooks.prepare?.(input) || reply({ ...input, epoch, retryUntil: '1970-01-01T00:05:01.000Z' });
      if (call.url.includes('_Close')) return hooks.close?.(input) || reply({ closed: true });
      assert.ok(call.url.includes('BCDDataWrite_Execute'));
      const apply = () => {
        if (!receipts.has(input.requestId)) {
          applies++;
          const p = input.request;
          receipts.set(input.requestId, { operation: p.operation, tableId: p.tableId, systemId, requestId: input.requestId,
            outcome: 'applied', ...(p.operation === 'delete' ? {} : { version: '9007199254740994',
              values: Object.fromEntries((p.fields || p.primaryKey).map(item => [item.fieldId, item.value])) }) });
        }
        return reply(receipts.get(input.requestId));
      };
      return hooks.execute ? hooks.execute(input, apply, calls) : apply();
    } });
  return { client, calls, connection, applies: () => applies };
}

test('each public mutation prepares, applies, validates and closes its own company scope', async () => {
  for (const [method, args] of [['insertRecord', { ...base, fields }], ['modifyRecord', { ...existing, fields }],
    ['renameRecord', { ...existing, primaryKey: [{ fieldId: 1, value: 'NEW' }] }], ['deleteRecord', existing]]) {
    const f = fixture();
    const result = await f.client[method](args);
    assert.equal(result.outcome, 'applied'); assert.equal(result.scopeCloseConfirmed, true); assert.equal(f.applies(), 1);
    assert.deepEqual(f.calls.map(call => new URL(call.url).pathname.split('_').at(-1)), ['Readiness', 'Prepare', 'Execute', 'Close']);
    assert.equal(f.calls[1].input.requestId, f.calls[2].input.requestId);
    assert.equal(f.calls[2].input.epoch, f.calls[3].input.epoch);
    assert.ok(f.calls.every(call => new URL(call.url).searchParams.get('company') === companyId));
    if (method === 'deleteRecord') { assert.equal(result.values, undefined); assert.equal(result.version, undefined); }
  }
});

test('lost committed response retries exactly the same ID epoch payload and target once', async () => {
  let first = true;
  const f = fixture({ execute: (input, apply) => {
    const response = apply();
    if (first) { first = false; throw new DataTransportError('timeout'); }
    return response;
  } });
  const result = await f.client.modifyRecord({ ...existing, fields });
  assert.equal(result.outcome, 'applied'); assert.equal(f.applies(), 1);
  const writes = f.calls.filter(call => call.url.includes('_Execute'));
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[0].input.request.expectedVersion, existing.expectedVersion);
});

test('unresolved writes report unknown with scope and never carry pending work into a later read', async () => {
  const f = fixture({ execute: () => { throw new DataTransportError('incomplete_response'); } });
  await assert.rejects(f.client.modifyRecord({ ...existing, fields }), error => {
    assert.equal(error.outcome, 'unknown'); assert.match(error.requestId, /^[\da-f-]{36}$/);
    assert.equal(error.epoch, epoch); assert.match(error.message, /do not repeat this tool operation blindly/); return true;
  });
  assert.equal(f.calls.filter(call => call.url.includes('_Execute')).length, 2);
  assert.equal(f.calls.some(call => call.url.includes('_Close')), false);
  await f.client.getTableSchema(base);
  assert.equal(f.calls.filter(call => call.url.includes('_Execute')).length, 2);
});

test('uncertainty survives a later denial or expired scope rather than becoming not_applied', async () => {
  let attempts = 0;
  const f = fixture({ execute: () => {
    if (++attempts === 1) throw new DataTransportError('timeout');
    return rejected('BCD_SCOPE_EXPIRED: prior outcome is uncertain.');
  } });
  await assert.rejects(f.client.deleteRecord(existing), { outcome: 'unknown' });
  assert.equal(attempts, 2); assert.equal(f.calls.some(call => call.url.includes('_Close')), false);
});

test('known conflict is not retried or refreshed and closes only the rejected command scope', async () => {
  const f = fixture({ execute: () => rejected('BCD_CONCURRENCY_CONFLICT: target changed.') });
  await assert.rejects(f.client.modifyRecord({ ...existing, fields }), { category: 'concurrency_conflict', outcome: 'not_applied' });
  assert.equal(f.calls.filter(call => call.url.includes('_Execute')).length, 1);
  assert.equal(f.calls.at(-1).url.includes('_Close'), true); assert.equal(f.applies(), 0);
});

test('generic server errors do not become rollback evidence even when a receipt committed', async () => {
  const f = fixture({ execute: (input, apply) => {
    apply();
    return { status: 500, body: Buffer.from(JSON.stringify({ error: { message: 'DB:Ok', code: 'Internal_ServerError' } })) };
  } });
  await assert.rejects(f.client.modifyRecord({ ...existing, fields }), { outcome: 'unknown' });
  assert.equal(f.applies(), 1);
  assert.equal(f.calls.filter(call => call.url.includes('_Execute')).length, 1);
  assert.equal(f.calls.some(call => call.url.includes('_Close')), false);
});

test('caller and active target changes during readiness cannot redirect a mutation', async () => {
  const request = { ...existing, fields: [{ fieldId: 12, value: 'before' }] };
  const f = fixture({ ready: () => {
    request.fields[0].value = 'after'; request.expectedVersion = '2'; f.connection.baseUrl = 'http://changed/BC/ODataV4';
  } });
  await f.client.modifyRecord(request);
  const write = f.calls.find(call => call.url.includes('_Execute'));
  assert.equal(write.input.request.fields[0].value, 'before');
  assert.equal(write.input.request.expectedVersion, existing.expectedVersion);
  assert.ok(f.calls.every(call => call.url.startsWith('http://dedicated/')));
});

test('missing capability and malformed preparation never submit a business mutation', async () => {
  for (const hooks of [{ capability: { mutationsEnabled: false } }, { capability: { mutationProtocolVersion: 2 } },
    { prepare: () => reply({ requestId: 1, epoch, retryUntil: '1970-01-01T00:05:01.000Z' }) },
    { prepare: input => reply({ ...input, epoch, retryUntil: '1970-01-01T00:00:00.000Z' }) }]) {
    const f = fixture(hooks);
    await assert.rejects(f.client.insertRecord({ ...base, fields }), { outcome: 'not_applied' });
    assert.equal(f.calls.some(call => call.url.includes('_Execute')), false);
  }
  const f = fixture({ ready: () => { throw new DataTransportError('timeout'); } });
  await assert.rejects(f.client.deleteRecord(existing), { outcome: 'not_applied' });
  assert.equal(f.calls.length, 1);
});

test('malformed acknowledgement IDs remain an unknown response rather than a configuration error', async () => {
  const f = fixture({ execute: (input, apply) => {
    const response = apply();
    const envelope = JSON.parse(response.body.toString('utf8'));
    return reply({ ...JSON.parse(envelope.value), requestId: 1 });
  } });
  await assert.rejects(f.client.modifyRecord({ ...existing, fields }), { category: 'invalid_response', outcome: 'unknown' });
  assert.equal(f.applies(), 1);
  assert.equal(f.calls.filter(call => call.url.includes('_Execute')).length, 2);
});

test('close failure preserves applied outcome without another write', async () => {
  const f = fixture({ close: () => { throw new DataTransportError('timeout'); } });
  const result = await f.client.deleteRecord(existing);
  assert.equal(result.outcome, 'applied'); assert.equal(result.scopeCloseConfirmed, false); assert.equal(f.applies(), 1);
});

test('invalid typed assignments identity versions and extras fail before any connection traffic', async () => {
  const invalid = [
    { ...existing, fields: [{ fieldId: 1, value: null }] },
    { ...existing, fields: [{ fieldId: 1, value: 1 }, { fieldId: 1, value: 2 }] },
    { ...existing, fields: [{ fieldId: 2000000000, value: 'system' }] },
    { ...existing, fields: [{ fieldId: 1, value: { arbitrary: true } }] },
    { ...existing, fields, expectedVersion: '9223372036854775808' },
    { ...existing, fields, expectedVersion: '01' }, { ...existing, fields, runTriggers: false },
    { ...existing, fields, systemId: '00000000-0000-0000-0000-000000000000' }
  ];
  const f = fixture();
  for (const request of invalid) await assert.rejects(f.client.modifyRecord(request), { category: 'invalid_input', outcome: 'not_applied' });
  assert.equal(f.calls.length, 0);
});

test('one mutation tool is a strict destructive opt-in with operation-specific schemas and no request-resume input', () => {
  const pkg = require('../package.json');
  const properties = pkg.contributes.configuration.find(group => group.properties.bcDevToolset).properties.bcDevToolset.properties.mcpTools.properties;
  assert.deepEqual(mutationToolNames, ['bc_dev_toolset_data_mutate_records']);
  for (const name of mutationToolNames) {
    const tool = dataTools.find(item => item.name === name);
    assert.equal(properties[name].default, false); assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true); assert.equal(tool.annotations.idempotentHint, false);
    assert.equal(tool.inputSchema.oneOf.length, 4);
    for (const branch of tool.inputSchema.oneOf) {
      assert.equal(branch.additionalProperties, false);
      assert.equal(Object.hasOwn(branch.properties, 'requestId'), false);
    }
  }
  assert.equal(validateDataArguments('bc_dev_toolset_data_mutate_records', { ...existing, operation: 'modify', fields }), true);
  assert.equal(validateDataArguments('bc_dev_toolset_data_mutate_records', { ...existing, operation: 'modify', fields: [{ fieldId: 1, value: { date: '2026-12-31', closing: true } }] }), true);
  assert.equal(validateDataArguments('bc_dev_toolset_data_mutate_records', { ...base, operation: 'insert', fields: [{ fieldId: 1, value: null }] }), false);
});

test('mutation dispatch schema rejects missing, mixed, unknown and legacy operations', () => {
  const tool = 'bc_dev_toolset_data_mutate_records';
  const requests = [
    { ...base, operation: 'insert', fields },
    { ...existing, operation: 'modify', fields },
    { ...existing, operation: 'rename', primaryKey: [{ fieldId: 1, value: 'A' }] },
    { ...existing, operation: 'delete' }
  ];
  for (const input of requests) {
    assert.equal(validateDataArguments(tool, input), true);
    for (const key of Object.keys(input)) {
      const missing = { ...input }; delete missing[key];
      assert.equal(validateDataArguments(tool, missing), false, `${input.operation} requires ${key}`);
    }
    for (const [key, value] of Object.entries({ fields, primaryKey: [{ fieldId: 1, value: 'A' }], systemId, expectedVersion: '1', requestId: companyId, endpoint: 'http://other' })) {
      if (!Object.hasOwn(input, key)) assert.equal(validateDataArguments(tool, { ...input, [key]: value }), false);
    }
    assert.equal(validateDataArguments(tool, { ...input, operation: 'upsert' }), false);
  }
  assert.equal(validateDataArguments('bc_data_insert_record', requests[0]), false);
  assert.equal(validateDataArguments('bc_dev_toolset_data_insert_record', requests[0]), false);
  assert.ok(dataTools.every(item => item.name.startsWith('bc_dev_toolset_data_')));
  assert.equal(dataTools.length, 7);
});

test('legacy data switches cannot expose renamed tools or consolidate write permission implicitly', () => {
  const { resolveToolSettings } = require('../mcp-tool-settings');
  const settings = resolveToolSettings({ bc_data_list_companies: true, bc_data_insert_record: true,
    bc_data_modify_record: true, bc_data_rename_record: true, bc_data_delete_record: true });
  assert.ok(dataTools.every(tool => settings[tool.name] === false));
  assert.ok(!Object.keys(settings).some(name => name.startsWith('bc_data_')));
  const { __test: server } = require('../mcp-server');
  assert.ok(!server.getAllTools().some(tool => tool.name.startsWith('bc_data_')));
});
