'use strict';
// Company-scoped authenticated fixture phases. No credentials/history are persisted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDataClient } = require('../../../vscode-extension/bc-data-client');
const { requestHttp10 } = require('../../../vscode-extension/bc-data-http10');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function main(input) {
  const s = input.state;
  const targets = { 'BC23 Baseline': 'bcdata23test', 'BC27.1': 'bcdata271' };
  assert.ok(Object.hasOwn(targets,s.target)); assert.equal(s.container,targets[s.target]);
  for (const value of [s.namespaceId,s.runId,s.exclusiveRunId,s.requestId]) assert.match(value,guid);
  assert.equal(s.primaryName,'CRONUS International Ltd.');
  assert.equal(s.secondaryName,`BCD_CT_${s.namespaceId.replaceAll('-','').slice(0,12)}`);
  assert.deepEqual(s.runs,[{kind:'f',runId:s.runId},{kind:'x',runId:s.exclusiveRunId}]);
  const admin = input.admin;
  const users = Object.fromEntries((input.users || []).map(user=>[user.kind,user]));
  const connection = {id:s.target,baseUrl:`http://${s.container}:7048/BC/ODataV4`,...admin,
    authentication:'UserPassword',dataToolsEnabled:true,revision:'evca-1'};
  const client = createDataClient({resolveConnection:id=>id===s.target?connection:undefined});
  const companies = (await client.listCompanies(s.target)).companies;
  const primary = companies.find(company=>company.name===s.primaryName);
  const secondary = companies.find(company=>company.name===s.secondaryName);
  assert.ok(primary);
  if (s.primaryId) assert.equal(primary.id,s.primaryId);
  if (s.secondaryId && secondary) assert.equal(secondary.id,s.secondaryId,'Temporary company identity changed.');
  const a = primary.id; const b = secondary?.id;
  if (input.phase==='discover') return {primaryId:a};
  if (input.phase==='bind') {assert.ok(b);assert.notEqual(a,b);return {secondaryId:b};}
  if (input.phase==='verifyAbsent') {assert.equal(secondary,undefined);return {absent:true,primaryId:a};}
  function redact(value) {
    let safe = String(value);
    for (const user of [admin,...Object.values(users)]) for (const secret of [user.password,user.username,
      Buffer.from(`${user.username}:${user.password}`).toString('base64')]) {
      if (secret) safe=safe.split(secret).join('[redacted]');
    }
    return safe.slice(0,2048);
  }
  async function call(user,companyId,service,action,request) {
    assert.match(companyId,guid);
    const url = new URL(`${connection.baseUrl}/${service}_${action}`);
    url.searchParams.set('company',companyId);url.searchParams.set('tenant','default');
    const response = await requestHttp10({url:url.href,username:user.username,password:user.password,
      acceptLanguage:'en-US',body:{inputJson:JSON.stringify(request)}});
    const envelope = JSON.parse(response.body.toString('utf8'));
    return {status:response.status,...(response.status===200?{text:envelope.value,value:JSON.parse(envelope.value)}:
      {code:redact(envelope.error?.code),message:redact(envelope.error?.message)})};
  }
  function success(response) {assert.equal(response.status,200,response.message||'Fixture request must succeed.');return response;}
  const payload = {namespaceId:s.namespaceId,runs:s.runs};
  async function administration(companyId,action) {
    const response=await call(admin,companyId,'BCDCompatibilityEVP',action,{...payload,companyId});
    if (response.status!==200) {const error=new Error('Administration failed.');error.safeMessage=response.message;throw error;}
    return response.value;
  }
  if (input.phase==='prepareRoles') return administration(a,'PrepareRoles');
  if (input.phase==='cleanupRoles') return administration(a,'CleanupRoles');
  if (input.phase==='removeExecutionA') return administration(a,'RemoveCompanyExecution');
  if (input.phase==='cleanup') {
    for (const companyId of [a,b].filter(Boolean)) {
      await administration(companyId,'CleanupData');
      const state=await administration(companyId,'DataState');
      assert.equal(state.rows.length,2);
      for (const row of state.rows) {
        assert.equal(row.runExists,false);
        for (const field of ['receiptCount','targetCount','barrierCount','pendingCount']) assert.equal(row[field],0);
      }
    }
    return {cleaned:true};
  }
  assert.ok(b);assert.notEqual(a,b);
  assert.deepEqual(Object.keys(users).sort(),['f','x']);
  const userClients=Object.fromEntries(Object.keys(users).map(kind=>[kind,createDataClient({
    resolveConnection:id=>id===s.target?{...connection,...users[kind]}:undefined
  })]));
  const readQuery=(companyId,runId)=>({connectionId:s.target,companyId,tableId:50206,fieldIds:[1,2,4],
    filters:[{fieldId:1,expression:runId}],pageSize:10});
  async function readAllowed(kind,companyId,runId,amount) {
    const page=await userClients[kind].readRecords(readQuery(companyId,runId));
    assert.equal(page.companyId,companyId);assert.equal(page.records.length,1);assert.equal(page.records[0].values['4'],amount);
    return {companyId,rows:page.records.length,amount};
  }
  async function readDenied(kind,companyId,runId) {
    try {
      await userClients[kind].readRecords(readQuery(companyId,runId));
      assert.fail('A company without an assignment must not return read data.');
    } catch(error) {
      assert.ok(['bc_error','permission_denied'].includes(error.category));
      assert.equal(error.outcome,'not_applied');
      assert.match(error.message,/permission|access|company|codeunit/i);
      return {category:error.category,outcome:error.outcome};
    }
  }
  const receipt = (kind,companyId,action,request={})=>call(users[kind],companyId,'BCDCompatibilityEV',action,
    {runId:kind==='f'?s.runId:s.exclusiveRunId,...request});
  async function stateFor(companyId,kind,amount,count=1) {
    const row=(await administration(companyId,'DataState')).rows.find(row=>row.kind===kind);
    assert.equal(row.runExists,true);assert.equal(row.targetCount,1);assert.equal(row.amount,amount);
    assert.equal(row.applyCount,count);assert.equal(row.receiptCount,count);assert.equal(row.pendingCount,0);
    return row;
  }
  function denied(response) {
    assert.ok([400,401,403].includes(response.status));
    assert.match(response.message,/permission|access|company|codeunit/i);
    assert.equal(response.text,undefined);
    return {status:response.status,code:response.code};
  }
  const results=[];
  async function check(name,work) {
    try {results.push({name,passed:true,...await work()});}
    catch(error) {results.push({name,passed:false,failure:error.name==='AssertionError'?redact(error.message):'Qualification request failed.'});}
  }
  let ownerHistory=input.expectedHistory || {};
  function request(row,amount,runId,requestId=s.requestId) {
    return {runId,requestId,systemId:row.systemId,expectedVersion:row.version,operation:'modify',amount};
  }
  if (input.phase==='initial') {
    await check('primary-only user modifies and replays in its granted company',async()=>{
      const row=success(await receipt('f',a,'Prepare')).value;
      const inputRequest=request(row,4,s.runId);
      const applied=success(await receipt('f',a,'Execute',inputRequest));
      ownerHistory.primary={request:inputRequest,text:applied.text};
      assert.equal(success(await receipt('f',a,'Execute',inputRequest)).text,applied.text);
      return {read:await readAllowed('f',a,s.runId,4),observed:await stateFor(a,'f',4)};
    });
    await check('secondary-only user modifies and replays in its granted company',async()=>{
      const row=success(await receipt('x',b,'Prepare')).value;
      const inputRequest=request(row,9,s.exclusiveRunId);
      const applied=success(await receipt('x',b,'Execute',inputRequest));
      ownerHistory.other={request:inputRequest,text:applied.text};
      assert.equal(success(await receipt('x',b,'Execute',inputRequest)).text,applied.text);
      return {read:await readAllowed('x',b,s.exclusiveRunId,9),observed:await stateFor(b,'x',9)};
    });
    if (!ownerHistory.primary || !ownerHistory.other) return {results};
    for (const [kind,companyId,history] of [['f',b,ownerHistory.primary],['x',a,ownerHistory.other]]) {
      for (const action of ['Prepare','Execute','Inspect']) {
        await check(`${kind} cannot ${action} in the company without an assignment`,async()=>{
          const outcome=denied(await receipt(kind,companyId,action,history.request));
          const absent=(await administration(companyId,'DataState')).rows.find(row=>row.kind===kind);
          assert.equal(absent.runExists,false);assert.equal(absent.receiptCount,0);assert.equal(absent.targetCount,0);
          return {...outcome,granted:await stateFor(kind==='f'?a:b,kind,kind==='f'?4:9)};
        });
      }
      await check(`${kind} read client rejects the company without an assignment`,async()=>{
        return readDenied(kind,companyId,history.request.runId);
      });
    }
    await check('company-scoped fixture users cannot execute administration',async()=>{
      const outcomes=[];
      for (const [kind,companyId] of [['f',a],['x',b]]) outcomes.push(denied(await call(users[kind],companyId,'BCDCompatibilityEVP','DataState',payload)));
      return {outcomes};
    });
  } else if (input.phase==='grantB') {
    await check('granting secondary access to the same identity creates an independent receipt',async()=>{
      const row=success(await receipt('f',b,'Prepare')).value;
      const inputRequest=request(row,6,s.runId);
      const applied=success(await receipt('f',b,'Execute',inputRequest));
      assert.notEqual(applied.text,ownerHistory.primary.text);
      ownerHistory.secondary={request:inputRequest,text:applied.text};
      assert.equal(success(await receipt('f',b,'Execute',inputRequest)).text,applied.text);
      return {primary:await stateFor(a,'f',4),secondary:await stateFor(b,'f',6)};
    });
    if (!ownerHistory.secondary) return {results};
    await check('the same read client can read both explicitly granted companies',async()=>({
      primary:await readAllowed('f',a,s.runId,4),secondary:await readAllowed('f',b,s.runId,6)
    }));
    await check('company access does not grant another principal receipt ownership',async()=>{
      const response=await receipt('f',b,'Execute',ownerHistory.other.request);
      assert.equal(response.status,400);assert.ok(response.message.includes('BCD_EV_OWNER_MISMATCH'));assert.equal(response.text,undefined);
      return {observed:await stateFor(b,'x',9)};
    });
    await check('the granted second company never replays the primary company payload',async()=>{
      const response=await receipt('f',b,'Execute',ownerHistory.primary.request);
      assert.equal(response.status,400);assert.ok(response.message.includes('BCD_EV_REQUEST_ID_REUSED'));assert.equal(response.text,undefined);
      return {primary:await stateFor(a,'f',4),secondary:await stateFor(b,'f',6)};
    });
  } else if (input.phase==='revokeA') {
    await check('the read client rejects revoked primary access while secondary reads still work',async()=>({
      denied:await readDenied('f',a,s.runId),retained:await readAllowed('f',b,s.runId,6)
    }));
    for (const action of ['Execute','Inspect']) {
      await check(`revoked primary access blocks ${action} of existing history`,async()=>{
        const outcome=denied(await receipt('f',a,action,ownerHistory.primary.request));
        return {...outcome,observed:await stateFor(a,'f',4)};
      });
    }
    await check('revoked primary access blocks a fresh mutation request',async()=>{
      const current=await stateFor(a,'f',4);
      const outcome=denied(await receipt('f',a,'Execute',request(current,5,s.runId,crypto.randomUUID())));
      return {...outcome,observed:await stateFor(a,'f',4)};
    });
    await check('retained secondary assignment still permits exact replay',async()=>{
      assert.equal(success(await receipt('f',b,'Execute',ownerHistory.secondary.request)).text,ownerHistory.secondary.text);
      return {read:await readAllowed('f',b,s.runId,6),observed:await stateFor(b,'f',6)};
    });
  } else if (input.phase==='restoreA') {
    await check('restoring the primary assignment returns both original company histories',async()=>{
      assert.equal(success(await receipt('f',a,'Execute',ownerHistory.primary.request)).text,ownerHistory.primary.text);
      assert.equal(success(await receipt('f',b,'Execute',ownerHistory.secondary.request)).text,ownerHistory.secondary.text);
      await readAllowed('f',a,s.runId,4);await readAllowed('f',b,s.runId,6);
      return {primary:await stateFor(a,'f',4),secondary:await stateFor(b,'f',6)};
    });
  } else throw new Error('Invalid EVCA phase.');
  return {results,...(['initial','grantB'].includes(input.phase)?{ownerHistory}:{})};
}
let raw='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{raw+=chunk;});
process.stdin.on('end',async()=>{
  try {const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await main(input)));}
  catch(error) {process.stderr.write(error.safeMessage || 'EVCA phase failed; retain metadata-only recovery state.');process.exitCode=1;}
});
