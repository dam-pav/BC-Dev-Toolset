'use strict';
// Dedicated two-company fixture phases. Credentials arrive through private stdin.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const s = input.state;
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets, s.target)); assert.equal(s.container, targets[s.target]);
  for (const value of [s.namespaceId,s.runId,s.exclusiveRunId,s.requestId]) assert.match(value, guid);
  assert.equal(s.primaryName, 'CRONUS International Ltd.');
  assert.equal(s.secondaryName, `BCD_CT_${s.namespaceId.replaceAll('-','').slice(0,12)}`);
  const connection = { id: s.target, baseUrl: `http://${s.container}:7048/BC/ODataV4`, ...input.admin,
    authentication: 'UserPassword', dataToolsEnabled: true, revision: 'evc-1' };
  const client = createDataClient({ resolveConnection: id => id === s.target ? connection : undefined });
  const companies = (await client.listCompanies(s.target)).companies;
  const primary = companies.find(company => company.name === s.primaryName);
  const secondary = companies.find(company => company.name === s.secondaryName);
  assert.ok(primary);
  if (s.primaryId) assert.equal(primary.id, s.primaryId);
  if (s.secondaryId && secondary) assert.equal(secondary.id, s.secondaryId, 'Temporary company identity changed.');
  const a = primary.id;
  const b = secondary?.id;
  if (input.phase === 'discover') return { primaryId: a };
  if (input.phase === 'bind') {
    assert.ok(secondary); assert.notEqual(a, b);
    return { secondaryId: b };
  }
  if (input.phase === 'verifyAbsent') { assert.equal(secondary, undefined); return { absent: true, primaryId: a }; }
  function redact(value) {
    return String(value).split(connection.password).join('[redacted]')
      .split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0,2048);
  }
  async function call(companyId, action, payload) {
    assert.match(companyId, guid); assert.match(payload.runId, guid);
    const url = new URL(`${connection.baseUrl}/BCDCompatibilityEV_${action}`);
    url.searchParams.set('company',companyId); url.searchParams.set('tenant','default');
    const response = await requestHttp10({ url: url.href, username: connection.username, password: connection.password,
      acceptLanguage: 'en-US', body: { inputJson: JSON.stringify(payload) } });
    const envelope = JSON.parse(response.body.toString('utf8'));
    return { status: response.status, ...(response.status === 200 ? { text: envelope.value, value: JSON.parse(envelope.value) } :
      { code: redact(envelope.error?.code), message: redact(envelope.error?.message) }) };
  }
  function success(response) { assert.equal(response.status,200,response.message || 'Fixture request must succeed.'); return response; }
  async function clean(companyId, runId) {
    success(await call(companyId,'Cleanup',{runId}));
    const cleanState = success(await call(companyId,'CleanState',{runId}));
    assert.deepEqual(cleanState.value,{runExists:false,rows:0,barriers:0,receiptCount:0});
  }
  if (input.phase === 'cleanup') {
    for (const companyId of [a,b].filter(Boolean)) for (const runId of [s.runId,s.exclusiveRunId]) await clean(companyId,runId);
    return { cleaned: true };
  }
  assert.equal(input.phase,'qualify'); assert.ok(b); assert.notEqual(a,b);
  const results = [];
  async function check(name, work) {
    try { results.push({name,passed:true,...await work()}); }
    catch (error) { results.push({name,passed:false,failure:error.name === 'AssertionError' ? redact(error.message) : 'Qualification request failed.'}); }
  }
  async function state(companyId, amount, count, runId = s.runId) {
    const response = success(await call(companyId,'Inspect',{runId}));
    assert.equal(response.value.row.amount,amount);
    assert.equal(response.value.applyCount,count);
    assert.equal(response.value.receiptCount,count);
    assert.equal(response.value.pendingCount,0);
    return response.value;
  }
  function request(row, amount, runId = s.runId, requestId = s.requestId) {
    return {runId,requestId,systemId:row.systemId,expectedVersion:row.version,operation:'modify',amount};
  }
  function rejected(response, expected) {
    assert.equal(response.status,400);
    assert.ok(response.message.includes(expected)); assert.equal(response.text,undefined);
  }
  const preparedA = success(await call(a,'Prepare',{runId:s.runId})).value;
  const preparedB = success(await call(b,'Prepare',{runId:s.runId})).value;
  const exclusive = success(await call(a,'Prepare',{runId:s.exclusiveRunId})).value;
  const reqA = request(preparedA,4);
  const reqB = request(preparedB,9);
  let firstA; let firstB;
  await check('readiness reports the explicitly selected company',async () => {
    for (const [companyId,name] of [[a,s.primaryName],[b,s.secondaryName]]) {
      const ready = await client.readiness(s.target,companyId);
      assert.equal(ready.companyId,companyId); assert.equal(ready.companyName,name); assert.equal(ready.mutationsEnabled,false);
    }
    return {primaryId:a,secondaryId:b};
  });
  await check('same principal run and request IDs produce independent company receipts',async () => {
    firstA = success(await call(a,'Execute',reqA));
    firstB = success(await call(b,'Execute',reqB));
    assert.notEqual(preparedA.systemId,preparedB.systemId);
    assert.notEqual(firstA.text,firstB.text);
    assert.notEqual(firstA.value.resultId,firstB.value.resultId);
    return {primary:await state(a,4,1),secondary:await state(b,9,1)};
  });
  // Stop dependent scenarios if setup cannot establish both company receipts.
  if (!firstA || !firstB) return {results};
  await check('each company replays its own exact result and rejects the other payload',async () => {
    assert.equal(success(await call(a,'Execute',reqA)).text,firstA.text);
    assert.equal(success(await call(b,'Execute',reqB)).text,firstB.text);
    rejected(await call(b,'Execute',reqA),'BCD_EV_REQUEST_ID_REUSED');
    rejected(await call(a,'Execute',reqB),'BCD_EV_REQUEST_ID_REUSED');
    return {primary:await state(a,4,1),secondary:await state(b,9,1)};
  });
  await check('borrowed target SystemId cannot mutate another company',async () => {
    rejected(await call(b,'Execute',{...reqA,requestId:crypto.randomUUID()}),'BCD_E04_NOT_FOUND');
    return {primary:await state(a,4,1),secondary:await state(b,9,1)};
  });
  await check('borrowed rowversion cannot authorize the other company target',async () => {
    assert.notEqual(firstA.value.row.version,firstB.value.row.version);
    rejected(await call(b,'Execute',{...request(firstB.value.row,9),requestId:crypto.randomUUID(),expectedVersion:firstA.value.row.version}),'BCD_E04_CONFLICT');
    return {secondary:await state(b,9,1)};
  });
  await check('a run existing only in the primary company cannot be used in the second',async () => {
    const denied = await call(b,'Execute',request(exclusive,6,s.exclusiveRunId,crypto.randomUUID()));
    assert.notEqual(denied.status,200); assert.equal(denied.text,undefined);
    const cleanState = success(await call(b,'CleanState',{runId:s.exclusiveRunId}));
    assert.deepEqual(cleanState.value,{runExists:false,rows:0,barriers:0,receiptCount:0});
    success(await call(a,'Execute',request(exclusive,6,s.exclusiveRunId,crypto.randomUUID())));
    return {status:denied.status,code:denied.code,primary:await state(a,6,1,s.exclusiveRunId)};
  });
  const query = {connectionId:s.target,companyId:a,tableId:50206,fieldIds:[1,2,4],pageSize:100,
    filters:[{fieldId:1,expression:`${s.runId}|${s.exclusiveRunId}`}]};
  await check('the companion reads only fixture rows in the explicitly selected company',async () => {
    const primaryRows = await client.readRecords(query);
    const secondaryRows = await client.readRecords({...query,companyId:b});
    assert.equal(primaryRows.companyId,a); assert.equal(secondaryRows.companyId,b);
    assert.deepEqual(primaryRows.records.map(row=>row.values['4']).sort((x,y)=>x-y),[4,6]);
    assert.deepEqual(secondaryRows.records.map(row=>row.values['4']),[9]);
    return {primaryRows:primaryRows.records.length,secondaryRows:secondaryRows.records.length};
  });
  await check('a primary-company continuation token is rejected for the secondary company',async () => {
    const page = await client.readRecords({...query,pageSize:1});
    assert.equal(page.hasMore,true); assert.ok(page.continuationToken);
    await assert.rejects(client.readRecords({...query,pageSize:1,companyId:b,continuationToken:page.continuationToken}),{category:'invalid_cursor',outcome:'not_applied'});
    const next = await client.readRecords({...query,pageSize:1,continuationToken:page.continuationToken});
    assert.equal(next.companyId,a); assert.equal(next.records.length,1);
    assert.notEqual(next.records[0].systemId,page.records[0].systemId);
    return {category:'invalid_cursor',outcome:'not_applied'};
  });
  await check('the read client rejects a missing explicit company',async () => {
    await assert.rejects(client.readRecords({...query,companyId:''}),{category:'invalid_input',outcome:'not_applied'});
    return {category:'invalid_input',outcome:'not_applied'};
  });
  await check('an unknown company ID does not fall back to either existing company',async () => {
    const unknown = crypto.randomUUID();
    assert.ok(!companies.some(company=>company.id===unknown));
    const denied = await call(unknown,'Execute',reqA);
    assert.notEqual(denied.status,200); assert.equal(denied.text,undefined);
    return {status:denied.status,code:denied.code,primary:await state(a,4,1),secondary:await state(b,9,1)};
  });
  await check('a later primary mutation leaves secondary state and both historical replays unchanged',async () => {
    success(await call(a,'Execute',request(firstA.value.row,5,s.runId,crypto.randomUUID())));
    assert.equal(success(await call(a,'Execute',reqA)).text,firstA.text);
    assert.equal(success(await call(b,'Execute',reqB)).text,firstB.text);
    return {primary:await state(a,5,2),secondary:await state(b,9,1)};
  });
  await check('cleaning the shared run in one company leaves the second receipt and target intact',async () => {
    await clean(a,s.runId);
    assert.equal(success(await call(b,'Execute',reqB)).text,firstB.text);
    const missing = await call(a,'Execute',reqA);
    assert.notEqual(missing.status,200); assert.equal(missing.text,undefined);
    return {primaryRemoved:true,secondary:await state(b,9,1)};
  });
  return {results};
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{raw+=chunk;});
process.stdin.on('end',async()=>{
  try {const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await main(input)));}
  catch {process.stderr.write('EVC phase failed; retain metadata-only cleanup state.');process.exitCode=1;}
});
