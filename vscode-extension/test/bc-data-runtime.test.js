'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDataRuntime } = require('../bc-data-runtime');
const { createDataClient } = require('../bc-data-client');
const { dataTools, validateDataArguments } = require('../bc-data-tools');
const { resolveToolSettings } = require('../mcp-tool-settings');
const companyId = '11111111-2222-3333-4444-555555555555';
const query = { connectionId: 'Test A', companyId, tableId: 4, fieldIds: [1], pageSize: 1 };
function fixture(options = {}) {
  const configurations = [{ name: 'Test A', serverType: 'Container', targetType: 'Test', container: 'test-a', authentication: 'UserPassword', bcUser: 'fixture', bcPassword: 'fixture-secret' },
    { name: 'Test B', serverType: 'Container', targetType: 'Dev', container: 'test-b', authentication: 'UserPassword', bcUser: 'fixture-b', bcPassword: 'fixture-secret-b' }];
  let settings = resolveToolSettings(Object.fromEntries(dataTools.map(tool => [tool.name, true])));
  const requests = [];
  let imports = 0;
  const runtime = createDataRuntime({ getConfigurations: () => configurations, getToolSettings: () => settings,
    createClient: options => {
      imports++;
      return createDataClient({ ...options, transport: async request => {
        requests.push(request);
        const value = request.url.includes('_Readiness') ? { contractVersion: 1, capabilities: ['read-primary-key', 'companies'], mutationsEnabled: false }
          : request.url.includes('_ListCompanies') ? { companies: [{ id: companyId, name: 'Fixture Company' }] }
            : { tableId: 4, records: [{ systemId: companyId, version: '12345678901234567', values: { 1: 'ABC' } }], hasMore: true, position: '1=CONST(ABC)' };
        return { status: 200, body: Buffer.from(JSON.stringify({ value: JSON.stringify({ ...value, companyId }) })) };
      } });
    }, ...options });
  return { runtime, configurations, requests, get imports() { return imports; }, setSettings: value => { settings = resolveToolSettings(value); } };
}
test('disabled runtime neither resolves targets nor imports or connects the client', async () => {
  const runtime = createDataRuntime({ getConfigurations: () => assert.fail('resolved disabled targets'), getToolSettings: () => ({}) });
  const result = await runtime.call('bc_data_list_companies', { connectionId: 'x' });
  assert.equal(result.structuredContent.error.category, 'disabled');
  assert.equal(result.isError, true);
});
test('connection discovery is offline, omits credentials and excludes production/remote targets', async () => {
  const f = fixture();
  f.configurations.push({ ...f.configurations[0], name: 'Production', targetType: 'Production' }, { ...f.configurations[0], name: 'Remote', serverType: 'OnPrem' });
  const result = await f.runtime.call('bc_data_list_connections');
  assert.deepEqual(result.structuredContent.connections.map(item => item.id), ['Test A', 'Test B']);
  assert.equal(f.imports, 0);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  assert.ok(result.structuredContent.connections.every(item => item.readiness === 'not_checked'));
});
test('ambiguous configuration names and stored credentials fail without plaintext fallback', async () => {
  const f = fixture();
  f.configurations.push({ ...f.configurations[0], name: 'test a' });
  assert.equal((await f.runtime.call('bc_data_list_connections')).structuredContent.connections[0].ambiguous, true);
  assert.equal((await f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' })).structuredContent.error.category, 'invalid_configuration');
  f.configurations.pop();
  f.configurations[0].bcCredential = true;
  const result = await f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' });
  assert.equal(result.structuredContent.error.category, 'credential_unavailable');
  assert.equal(f.requests.length, 0);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

test('stored identities ignore plaintext traps and are resolved afresh without exposure in results', async () => {
  const reads = [];
  let password = 'stored-secret-one';
  const f = fixture({ getStoredCredential: async input => { reads.push(input); return { username: 'stored-user', password }; } });
  f.configurations[0].bcCredential = true;
  const first = await f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' });
  password = 'stored-secret-two';
  const second = await f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' });
  assert.ok(!first.isError && !second.isError);
  assert.deepEqual(reads, [{ container: 'test-a' }, { container: 'test-a' }]);
  assert.ok(f.requests.every(request => request.username === 'stored-user'));
  assert.deepEqual(f.requests.map(request => request.password), ['stored-secret-one', 'stored-secret-one', 'stored-secret-two', 'stored-secret-two']);
  assert.ok(!JSON.stringify([first, second]).includes('stored-secret'));
});

test('stored-credential awaits preserve captured target and invalidation disposes its provider', async () => {
  let release;
  let invalidated = 0;
  const f = fixture({ getStoredCredential: () => new Promise(resolve => { release = resolve; }), invalidateCredentials: () => { invalidated++; } });
  f.configurations[0].bcCredential = true;
  const pending = f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' });
  f.configurations[0].container = 'changed-target';
  f.configurations[0].bcData = { baseUrl: 'http://changed-target/BC/ODataV4' };
  release({ username: 'stored-user', password: 'stored-secret' });
  assert.equal((await pending).isError, false);
  assert.ok(f.requests.every(request => request.url.startsWith('http://test-a:7048/')));
  f.runtime.invalidate();
  assert.equal(invalidated, 1);
});

test('missing or failed stored credentials never trigger HTTP or plaintext fallback', async () => {
  const { DataCredentialError } = require('../bc-data-credentials');
  const f = fixture({ getStoredCredential: async () => { throw new DataCredentialError('credential_missing'); } });
  f.configurations[0].bcCredential = true;
  const result = await f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' });
  assert.equal(result.structuredContent.error.category, 'credential_missing');
  assert.equal(f.requests.length, 0);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

test('stored identity cannot be redirected through endpoint overrides to a different host', async () => {
  const f = fixture({ getStoredCredential: () => assert.fail('Read credentials for a redirected endpoint') });
  f.configurations[0].bcCredential = true;
  for (const baseUrl of ['http://elsewhere:7048/BC/ODataV4', 'http://user:password@test-a/BC/ODataV4', 'not a URL']) {
    f.configurations[0].bcData = { baseUrl };
    const result = await f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' });
    assert.equal(result.structuredContent.error.category, 'invalid_configuration');
  }
  assert.equal(f.requests.length, 0);
});
test('tool schemas reject credentials, endpoints, writes, unknown options and oversized inputs', async () => {
  const f = fixture();
  for (const input of [{ ...query, password: 'secret' }, { ...query, url: 'http://elsewhere' }, { ...query, sort: 'descending' }, { ...query, fieldIds: [1, 1] }, { ...query, pageSize: 101 }, { ...query, flowFilters: [{ fieldId: 1, expression: 'x'.repeat(4001) }] }]) {
    assert.equal((await f.runtime.call('bc_data_read_records', input)).structuredContent.error.category, 'invalid_input');
  }
  assert.equal((await f.runtime.call('bc_data_modify_record', query)).structuredContent.error.category, 'disabled');
  assert.equal(f.requests.length, 0);
  assert.equal(f.imports, 0);
  assert.equal(validateDataArguments('bc_data_find_tables', { connectionId: 'Test A', companyId, afterId: -1 }), false);
});
test('runtime captures configured targets and endpoint overrides without returning credentials', async () => {
  const f = fixture();
  f.configurations[1].bcData = { baseUrl: 'https://test-b:7448/Custom/ODataV4', tenant: 'fixture-tenant' };
  const results = await Promise.all([f.runtime.call('bc_data_list_companies', { connectionId: 'Test A' }), f.runtime.call('bc_data_list_companies', { connectionId: 'Test B' })]);
  assert.ok(results.every(result => !result.isError));
  assert.deepEqual(new Set(f.requests.map(request => new URL(request.url).host)), new Set(['test-a:7048', 'test-b:7448']));
  assert.ok(f.requests.filter(request => request.username === 'fixture-b').every(request => request.url.includes('tenant=fixture-tenant')));
  assert.ok(!JSON.stringify(results).includes('fixture-secret'));
});
test('disabling after discovery blocks the existing runtime; lifecycle invalidation rejects old cursors', async () => {
  const f = fixture();
  const first = await f.runtime.call('bc_data_read_records', query);
  assert.equal(first.isError, false);
  const continuationToken = first.structuredContent.continuationToken;
  assert.equal((await f.runtime.call('bc_data_read_records', { ...query, continuationToken })).isError, false);
  f.runtime.invalidate();
  const count = f.requests.length;
  assert.equal((await f.runtime.call('bc_data_read_records', { ...query, continuationToken })).structuredContent.error.category, 'invalid_cursor');
  assert.equal(f.requests.length, count);
  f.setSettings({});
  assert.equal((await f.runtime.call('bc_data_read_records', query)).structuredContent.error.category, 'disabled');
  assert.equal(f.requests.length, count);
});
test('unexpected errors never expose configuration secrets; transport errors retain bounded diagnostics', async () => {
  const runtime = createDataRuntime({ getConfigurations: () => [], getToolSettings: () => ({ bc_data_list_companies: true }), createClient: () => ({ listCompanies() { throw new Error('fixture-secret'); } }) });
  const result = await runtime.call('bc_data_list_companies', { connectionId: 'x' });
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  assert.match(result.structuredContent.error.correlationId, /^[0-9a-f-]{36}$/);
  const transport = createDataRuntime({ getConfigurations: () => [], getToolSettings: () => ({ bc_data_list_companies: true }), createClient: () => ({ listCompanies() { throw Object.assign(new Error('fixture-secret'), { name: 'DataTransportError', code: 'timeout', status: 200, receivedBytes: 84000 }); } }) });
  assert.equal((await transport.call('bc_data_list_companies', { connectionId: 'x' })).structuredContent.error.receivedBytes, 84000);
});

async function bridgeSession(t, { mismatch = false } = {}) {
  const f = fixture();
  const identity = { protocolVersion: 2, instanceId: crypto.randomUUID(), extensionHostPid: process.pid, workspace: { workspacePath: process.cwd() } };
  const token = crypto.randomUUID();
  const forwarded = [];
  const bridge = http.createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    const body = JSON.parse(input);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(body.binding.instanceId, identity.instanceId);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/handshake') response.end(JSON.stringify({ ...identity, instanceId: mismatch ? 'wrong-window' : identity.instanceId }));
    else if (request.url === '/data-call') {
      forwarded.push(body);
      response.end(JSON.stringify(await f.runtime.call(body.name, body.arguments)));
    } else response.writeHead(404).end('{}');
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => bridge.close());
  const child = spawn(process.execPath, [path.join(__dirname, '../mcp-server.js')], { windowsHide: true, env: { ...process.env,
    BCDEVTOOLSET_MCP_TOOL_SETTINGS_SOURCE: '', BCDEVTOOLSET_MCP_TOOL_SETTINGS: JSON.stringify(Object.fromEntries(dataTools.map(tool => [tool.name, true]))),
    BCDEVTOOLSET_MCP_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`, BCDEVTOOLSET_MCP_BRIDGE_TOKEN: token,
    BCDEVTOOLSET_MCP_BRIDGE_INSTANCE_ID: identity.instanceId, BCDEVTOOLSET_MCP_BRIDGE_PROTOCOL_VERSION: '2',
    BCDEVTOOLSET_MCP_EXTENSION_HOST_PID: String(process.pid), BCDEVTOOLSET_MCP_WORKSPACE_CONTEXT: JSON.stringify(identity.workspace) } });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  t.after(() => { lines.close(); child.kill(); });
  let id = 0;
  return { ...f, forwarded, request: (method, params) => new Promise(resolve => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }) };
}
test('real MCP process routes read-only calls through the bound bridge with no credentials or operation launch', { timeout: 10000 }, async t => {
  const f = await bridgeSession(t);
  const tools = (await f.request('tools/list')).result.tools.filter(tool => tool.name.startsWith('bc_data_'));
  assert.equal(tools.length, 6);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  const result = (await f.request('tools/call', { name: 'bc_data_list_companies', arguments: { connectionId: 'Test A' } })).result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.companies[0].id, companyId);
  assert.equal(f.forwarded.length, 1);
  assert.ok(!JSON.stringify(f.forwarded).includes('fixture-secret'));
  const denied = (await f.request('tools/call', { name: 'bc_data_read_records', arguments: { ...query, endpoint: 'http://other' } })).result;
  assert.equal(denied.structuredContent.error.category, 'invalid_input');
  assert.equal(f.forwarded.length, 1);
  f.setSettings({});
  const revoked = (await f.request('tools/call', { name: 'bc_data_list_companies', arguments: { connectionId: 'Test A' } })).result;
  assert.equal(revoked.structuredContent.error.category, 'disabled');
});
test('data calls reject a different workspace bridge before forwarding', { timeout: 10000 }, async t => {
  const f = await bridgeSession(t, { mismatch: true });
  const result = (await f.request('tools/call', { name: 'bc_data_list_companies', arguments: { connectionId: 'Test A' } })).result;
  assert.equal(result.structuredContent.error.category, 'bridge_unavailable');
  assert.equal(f.forwarded.length, 0);
});
