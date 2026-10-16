'use strict';
const crypto = require('node:crypto');
const { requestHttp10 } = require('./bc-data-http10');

const actions = Object.freeze({ Readiness: null, ListCompanies: 'companies', FindTables: 'table-search', GetTableSchema: 'schema', ReadRecords: 'read-primary-key' });
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
class DataClientError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'DataClientError';
    this.category = category;
    // This module exposes read-only operations; no mutation is attempted.
    this.outcome = 'not_applied';
  }
}

function createDataClient({ resolveConnection, transport = requestHttp10, now = Date.now }) {
  if (typeof resolveConnection !== 'function') throw new Error('A target resolver is required.');
  const cursorKey = crypto.randomBytes(32); // Session-local: never stored in files or derived from paths.
  async function capture(connectionId) {
    const resolved = await resolveConnection(connectionId);
    if (!resolved || resolved.id !== connectionId || resolved.dataToolsEnabled !== true) {
      throw new DataClientError('disabled', 'BC Data tools are disabled for this connection.');
    }
    const connection = Object.freeze({ id: resolved.id, baseUrl: resolved.baseUrl, username: resolved.username,
      password: resolved.password, authentication: resolved.authentication, revision: resolved.revision || '', tenant: resolved.tenant ?? 'default' });
    let url;
    try { url = new URL(connection.baseUrl); }
    catch { throw new DataClientError('invalid_configuration', 'BC Data requires a valid configured ODataV4 base URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search ||
        !url.pathname.endsWith('/ODataV4') || connection.authentication !== 'UserPassword' ||
        typeof connection.username !== 'string' || !connection.username ||
        typeof connection.password !== 'string' || !connection.password ||
        typeof connection.revision !== 'string' || !connection.revision || typeof connection.tenant !== 'string' || !connection.tenant) {
      throw new DataClientError('invalid_configuration', 'BC Data requires a configured ODataV4 base URL, UserPassword credentials, tenant and explicit connection revision.');
    }
    return connection;
  }
  function company(value) {
    if (typeof value !== 'string' || !guid.test(value)) throw new DataClientError('invalid_input', 'An explicit company GUID is required.');
    return value.toLowerCase();
  }
  async function send(connection, companyId, action, input) {
    const url = new URL(`${connection.baseUrl}/BCDData_${action}`);
    url.searchParams.set('tenant', connection.tenant);
    if (companyId) url.searchParams.set('company', companyId);
    const response = await transport({ url: url.href, username: connection.username, password: connection.password,
      body: { inputJson: JSON.stringify(input) } });
    if ([401, 403].includes(response.status)) {
      throw new DataClientError('permission_denied', 'BC Data authentication or authorization was rejected.');
    }
    let envelope;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
    catch {
      if (response.status === 404) throw new DataClientError('initialization_required', 'BC Data is not initialized. Deploy the compatible companion app and register BCDData on this target.');
      throw new DataClientError('invalid_response', 'BC Data returned an invalid JSON envelope.');
    }
    if (response.status !== 200) {
      const original = typeof envelope?.error?.message === 'string' ? envelope.error.message : '';
      const category = envelope?.error?.code === 'Internal_RecordNotFound' ? 'record_not_found' :
        original.includes('BCD_INVALID_INPUT') ? 'invalid_input' : original.includes('BCD_UNSUPPORTED') ? 'unsupported_operation' :
        original.includes('BCD_RESPONSE_TOO_LARGE') ? 'response_too_large' : response.status === 404 ? 'initialization_required' : 'bc_error';
      const message = original
        ? original.split(connection.password).join('[redacted]').split(Buffer.from(`${connection.username}:${connection.password}`).toString('base64')).join('[redacted]').slice(0, 2048)
        : 'BC Data request was rejected.';
      throw new DataClientError(category, category === 'initialization_required'
        ? 'BC Data is not initialized. Deploy the compatible companion app and register BCDData on this target.' : message);
    }
    let value;
    try {
      if (typeof envelope.value !== 'string') throw new Error();
      value = JSON.parse(envelope.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch { throw new DataClientError('invalid_response', 'BC Data returned an invalid service envelope.'); }
    if (companyId && (typeof value.companyId !== 'string' || value.companyId.toLowerCase() !== companyId)) {
      throw new DataClientError('target_mismatch', 'BC Data response company does not match the requested company.');
    }
    return value;
  }
  async function checked(connection, companyId, action, input) {
    const readiness = await send(connection, companyId, 'Readiness', {});
    if (readiness.contractVersion !== 1 || !Array.isArray(readiness.capabilities) || typeof readiness.mutationsEnabled !== 'boolean' ||
        (actions[action] && !readiness.capabilities.includes(actions[action]))) {
      throw new DataClientError('incompatible_app', 'BC Data companion contract/capability is incompatible.');
    }
    if (action === 'Readiness') return readiness;
    return send(connection, companyId, action, input);
  }
  const scope = (connection, companyId, input) => digest({ id: connection.id, baseUrl: connection.baseUrl,
    principal: connection.username, revision: connection.revision, tenant: connection.tenant, companyId, input });
  function encodeCursor(position, query) {
    const data = Buffer.from(JSON.stringify({ position, query, expires: now() + 30 * 60 * 1000 })).toString('base64url');
    return `${data}.${crypto.createHmac('sha256', cursorKey).update(data).digest('base64url')}`;
  }
  function decodeCursor(token, query) {
    try {
      if (typeof token !== 'string' || token.length > 32768 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new Error();
      const [data, signature] = token.split('.');
      const expected = crypto.createHmac('sha256', cursorKey).update(data).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error();
      const decoded = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      if (decoded.query !== query || decoded.expires <= now() || typeof decoded.position !== 'string') throw new Error();
      return decoded.position;
    } catch { throw new DataClientError('invalid_cursor', 'Continuation token expired or does not match this target, company, query, or client session.'); }
  }
  return Object.freeze({
    async readiness(connectionId, companyId) {
      return checked(await capture(connectionId), company(companyId), 'Readiness', {});
    },
    async listCompanies(connectionId) {
      return checked(await capture(connectionId), null, 'ListCompanies', {});
    },
    async findTables({ connectionId, companyId, query = '', afterId = 0, pageSize = 25 }) {
      return checked(await capture(connectionId), company(companyId), 'FindTables', { query, afterId, pageSize });
    },
    async getTableSchema({ connectionId, companyId, tableId }) {
      return checked(await capture(connectionId), company(companyId), 'GetTableSchema', { tableId });
    },
    async readRecords(request) {
      const allowed = ['connectionId', 'companyId', 'tableId', 'fieldIds', 'filters', 'flowFilters', 'pageSize', 'continuationToken'];
      if (!request || Object.keys(request).some(key => !allowed.includes(key))) {
        throw new DataClientError('invalid_input', 'Unsupported record query option; this slice supports primary-key ascending order only.');
      }
      const { connectionId, companyId, tableId, fieldIds, filters = [], flowFilters = [], pageSize = 25, continuationToken } = request;
      if (!Number.isSafeInteger(tableId) || tableId <= 0 || tableId >= 2000000000 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Array.isArray(fieldIds) ||
          fieldIds.length < 1 || fieldIds.length > 50 || new Set(fieldIds).size !== fieldIds.length ||
          fieldIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) {
        throw new DataClientError('invalid_input', 'Select 1-50 unique field IDs, an ordinary table, and a page size from 1 to 100.');
      }
      for (const group of [filters, flowFilters]) {
        if (!Array.isArray(group) || group.length > 50 || new Set(group.map(filter => filter?.fieldId)).size !== group.length ||
            group.some(filter => !Number.isSafeInteger(filter?.fieldId) || filter.fieldId <= 0 ||
              typeof filter.expression !== 'string' || filter.expression.length > 4000)) {
          throw new DataClientError('invalid_input', 'Filters require unique positive field IDs and bounded BC filter expressions.');
        }
      }
      // Caller mutation during the readiness await must not change an in-flight query.
      const input = JSON.parse(JSON.stringify({ tableId, fieldIds, filters, flowFilters, pageSize }));
      const connection = await capture(connectionId);
      const companyIdValue = company(companyId);
      const query = scope(connection, companyIdValue, input);
      if (continuationToken) input.position = decodeCursor(continuationToken, query);
      const result = await checked(connection, companyIdValue, 'ReadRecords', input);
      if (result.tableId !== tableId || !Array.isArray(result.records) || typeof result.hasMore !== 'boolean' ||
          result.records.length > pageSize || (result.hasMore && (typeof result.position !== 'string' || !result.position || !result.records.length)) ||
          result.records.some(record => !record || !guid.test(record.systemId) || typeof record.version !== 'string' || !/^[0-9]+$/.test(record.version) ||
            !record.values || Array.isArray(record.values) || Object.keys(record.values).length !== input.fieldIds.length || input.fieldIds.some(id => !Object.hasOwn(record.values, id)))) {
        throw new DataClientError('invalid_response', 'BC Data returned an invalid record page.');
      }
      const { position, ...page } = result;
      if (result.hasMore) page.continuationToken = encodeCursor(position, query);
      return page;
    }
  });
}
module.exports = { createDataClient, DataClientError };
