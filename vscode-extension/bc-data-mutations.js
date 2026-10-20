'use strict';
const crypto = require('node:crypto');
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const nonzeroGuid = value => typeof value === 'string' && guid.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const version = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function scalar(value) {
  return typeof value === 'boolean' || (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) ||
    (typeof value === 'string' && value.length <= 32768) ||
    (object(value) && Object.keys(value).length === 2 && typeof value.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.date) && typeof value.closing === 'boolean');
}
function assignments(values, maximum) {
  return Array.isArray(values) && values.length > 0 && values.length <= maximum &&
    values.every(item => object(item) && Object.keys(item).length === 2 && Number.isSafeInteger(item.fieldId) &&
      item.fieldId > 0 && item.fieldId < 2000000000 && Object.hasOwn(item, 'value') && scalar(item.value)) &&
    new Set(values.map(item => item.fieldId)).size === values.length;
}

async function executeMutation({ capture, company, send, now, ErrorType }, operation, request) {
  const fail = (category, message) => new ErrorType(category, message);
  const keys = ['connectionId', 'companyId', 'tableId', ...(operation === 'insert' ? ['fields'] :
    ['systemId', 'expectedVersion', ...(operation === 'modify' ? ['fields'] : operation === 'rename' ? ['primaryKey'] : [])])];
  if (!object(request) || Object.keys(request).length !== keys.length || keys.some(key => !Object.hasOwn(request, key)) ||
      Object.keys(request).some(key => !keys.includes(key)) || typeof request.connectionId !== 'string' || !request.connectionId ||
      !Number.isSafeInteger(request.tableId) || request.tableId <= 0 || request.tableId >= 2000000000 ||
      (operation !== 'insert' && (!nonzeroGuid(request.systemId) || !version(request.expectedVersion))) ||
      (['insert', 'modify'].includes(operation) && !assignments(request.fields, 50)) ||
      (operation === 'rename' && !assignments(request.primaryKey, 16))) {
    throw fail('invalid_input', 'Supply an ordinary table, ordered typed fields/key and a positive string version for existing records. Null, system fields and extra options are unsupported.');
  }
  const companyId = company(request.companyId);
  // Freeze the actual wire payload BEFORE any resolver/readiness await.
  const payload = JSON.parse(JSON.stringify(Object.fromEntries([
    ['operation', operation], ...keys.filter(key => !['connectionId', 'companyId'].includes(key)).map(key => [key, request[key]])
  ])));
  if (JSON.stringify(payload).length > 32768) throw fail('invalid_input', 'Mutation JSON exceeds32768 characters.');
  const connection = await capture(request.connectionId);
  let ready;
  try { ready = await send(connection, companyId, 'Readiness', {}); }
  catch (failure) { failure.outcome = 'not_applied'; throw failure; }
  if (ready.contractVersion !== 1 || ready.mutationsEnabled !== true || ready.mutationProtocolVersion !== 1 ||
      !Array.isArray(ready.capabilities) || !ready.capabilities.includes('mutation-scopes-v1')) {
    throw fail('incompatible_app', 'Initialize the companion with mutation scope protocol1 and published BCDDataWrite. Existing read-only installations cannot execute mutations.');
  }
  // One operation owns one UUID/epoch. No queue, cross-call resume or fresh-ID retry.
  const requestId = crypto.randomUUID();
  let prepared;
  try { prepared = await send(connection, companyId, 'Prepare', { requestId }, 'BCDDataWrite'); }
  catch (failure) { failure.outcome = 'not_applied'; throw failure; } // No business Execute has been submitted.
  const deadline = typeof prepared.retryUntil === 'string' ? Date.parse(prepared.retryUntil) : NaN;
  if (typeof prepared.requestId !== 'string' || prepared.requestId.toLowerCase() !== requestId || !nonzeroGuid(prepared.epoch) ||
      typeof prepared.retryUntil !== 'string' || !Number.isFinite(deadline) || deadline <= now()) {
    throw fail('invalid_response', 'BC Data returned an invalid or expired preparation scope; no mutation was submitted.');
  }
  const scope = { requestId, epoch: prepared.epoch };
  const body = { ...scope, request: payload };
  let uncertain = false;
  let outcome;
  let result;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await send(connection, companyId, 'Execute', body, 'BCDDataWrite');
        const selected = payload.fields || payload.primaryKey;
        if (value.operation !== operation || value.tableId !== payload.tableId || typeof value.requestId !== 'string' || value.requestId.toLowerCase() !== requestId ||
            value.outcome !== 'applied' || !nonzeroGuid(value.systemId) ||
            (operation !== 'insert' && value.systemId.toLowerCase() !== payload.systemId.toLowerCase()) ||
            (operation === 'delete' ? Object.hasOwn(value, 'version') || Object.hasOwn(value, 'values') :
              !version(value.version) || !object(value.values) || Object.keys(value.values).length !== selected.length ||
                selected.some(item => !Object.hasOwn(value.values, item.fieldId)))) {
          throw fail('invalid_response', 'BC Data returned an invalid mutation acknowledgement.');
        }
        result = value;
        outcome = 'applied';
        break;
      } catch (failure) {
        const scopeHistoryUnknown = /BCD_(?:SCOPE_|REQUEST_ID_REUSED|RECEIPT_UNAVAILABLE|REPLAY_TARGET_UNAVAILABLE)/.test(failure.message || '');
        const rejected = failure.bcRejected === true && !scopeHistoryUnknown;
        if (!rejected) uncertain = true;
        const retryable = failure.name === 'DataTransportError' || failure.category === 'invalid_response';
        // Only retry the identical frozen body in this still-active operation.
        if (attempt === 0 && retryable && now() < deadline) continue;
        const error = failure.name === 'DataClientError' ? failure : fail('connection_failure', 'BC Data mutation transport failed.');
        error.outcome = uncertain ? 'unknown' : 'not_applied';
        error.requestId = requestId;
        error.epoch = prepared.epoch;
        error.retryUntil = prepared.retryUntil;
        if (error.outcome === 'unknown') error.message += ' Outcome is unknown. Reconcile the target; do not repeat this tool operation blindly or substitute a fresh request ID/version.';
        outcome = error.outcome;
        throw error;
      }
    }
  } finally {
    if (outcome === 'applied' || outcome === 'not_applied') {
      try {
        const closed = await send(connection, companyId, 'Close', scope, 'BCDDataWrite');
        if (result) result.scopeCloseConfirmed = closed.closed === true;
      } catch { if (result) result.scopeCloseConfirmed = false; }
    }
    // Scope/body exist only in this invocation. Unknown calls keep server history
    // until its fixed expiry; clearing local state does not cancel server work.
  }
  return result;
}

module.exports = { executeMutation };
