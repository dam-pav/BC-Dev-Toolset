'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { resolveWithinRoot } = require('../../../vscode-extension/path-security');
const root = path.resolve(__dirname, '../../..');
const settings = JSON.parse(fs.readFileSync(resolveWithinRoot(root, '.bcdevtoolset', 'settings.json'), 'utf8'));

async function main() {
  const evidence = [];
  const selected = process.argv.slice(2);
  assert.ok(selected.every(name => ['BC23 Baseline', 'BC27.1'].includes(name)), 'Only dedicated qualification targets are accepted.');
  for (const [name, container] of [['BC23 Baseline', 'bcdata23test'], ['BC27.1', 'bcdata271']]) {
    if (selected.length && !selected.includes(name)) continue;
    const matches = settings.configurations.filter(configuration => configuration.name === name);
    assert.equal(matches.length, 1);
    const configuration = matches[0];
    assert.equal(configuration.container, container);
    assert.equal(configuration.authentication, 'UserPassword');
    assert.ok(!configuration.bcCredential, 'This qualification harness requires its dedicated local credentials.');
    const connection = Object.freeze({ id: name, baseUrl: `http://${container}:7048/BC/ODataV4`,
      username: configuration.bcUser, password: configuration.bcPassword,
      authentication: 'UserPassword', dataToolsEnabled: true, revision: 'qualification-1' });
    const client = createDataClient({ resolveConnection: id => id === name ? connection : undefined });
    const companies = await client.listCompanies(name);
    assert.ok(companies.companies.length > 0);
    const companyId = companies.companies[0].id;
    const measurements = [];
    for (const randomBytes of [65536, 262144]) {
      const payload = { random: crypto.randomBytes(randomBytes).toString('base64'), unicode: 'Živjo 世界 😀',
        escaped: 'quote: " slash: \\ newline: \n', empty: '', boolean: true, number: 123.456, null: null };
      const inputJson = JSON.stringify(payload);
      const url = new URL(`${connection.baseUrl}/BCDCompatibilityE01_Echo`);
      url.searchParams.set('tenant', 'default');
      url.searchParams.set('company', companyId);
      const started = Date.now();
      const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password, body: { inputJson } });
      assert.equal(response.status, 200);
      const echo = JSON.parse(JSON.parse(response.body.toString('utf8')).value);
      assert.equal(echo.inputJson, inputJson);
      assert.deepEqual(echo.payload, payload);
      measurements.push({ randomBytes, requestBytes: Buffer.byteLength(JSON.stringify({ inputJson })),
        responseBytes: response.body.length, elapsedMs: Date.now() - started });
    }
    const readiness = await client.readiness(name, companyId);
    assert.equal(readiness.mutationsEnabled, false);
    const discovery = await client.findTables({ connectionId: name, companyId, query: 'Currency', pageSize: 3 });
    assert.ok(discovery.tables.some(table => table.id === 4));
    const schema = await client.getTableSchema({ connectionId: name, companyId, tableId: 4 });
    assert.ok(schema.fields.some(field => field.id === 50203), 'Installed test extension field is visible.');
    assert.ok(schema.fields.find(field => field.id === 50204).members.some(member => member.ordinal === 50242));
    const fieldIds = schema.fields.filter(field => field.class === 'Normal' && ['Text', 'Code', 'Integer', 'Decimal', 'Boolean', 'Guid', 'GUID'].includes(field.type)).slice(0, 3).map(field => field.id);
    assert.ok(fieldIds.length > 0);
    const query = { connectionId: name, companyId, tableId: 4, fieldIds, pageSize: 1 };
    const first = await client.readRecords(query);
    if (first.hasMore) {
      const second = await client.readRecords({ ...query, continuationToken: first.continuationToken });
      assert.notEqual(first.records[0].systemId, second.records[0].systemId);
    }
    const record = { utc: new Date().toISOString(), target: name, companyId, transport: 'native-node-http10',
      appVersion: readiness.appVersion, measurements, tablesDiscovered: discovery.tables.length,
      schemaFields: schema.fields.length, firstPageRows: first.records.length, continuationVerified: first.hasMore, passed: true };
    evidence.push(record);
    // Preserve an earlier target's successful evidence if a later target fails.
    fs.writeFileSync(resolveWithinRoot(root, '.bcdevtoolset', 'bc-data-client-qualification.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(record));
  }
}
main().catch(error => {
  console.error(`${error.name}: ${error.code || error.category || 'qualification_failed'}${error.name === 'DataClientError' ? `: ${error.message}` : ''}`);
  process.exitCode = 1;
});
