'use strict';

const crypto = require('node:crypto');
const { dataMethods, validateDataArguments } = require('./bc-data-tools');

// Extension-host boundary: settings and credentials never enter MCP tool results
// or the bridge payload. No network access or client import until an enabled call.
function createDataRuntime({ getConfigurations, getToolSettings, createClient }) {
  let revision = crypto.randomUUID();
  let client;
  function configurations() {
    const values = getConfigurations();
    if (!Array.isArray(values)) throw new Error('Invalid configurations.');
    return values;
  }
  function allowed(value) {
    return value && value.serverType === 'Container' && ['Dev', 'Test'].includes(value.targetType) &&
      typeof value.name === 'string' && value.name.length > 0;
  }
  function resolveConnection(id) {
    const matches = configurations().filter(value => typeof value?.name === 'string' && value.name.toLowerCase() === id.toLowerCase());
    if (matches.length !== 1 || !allowed(matches[0]) || matches[0].name !== id) throw error('invalid_configuration', 'Select a unique Dev/Test Container configuration name from bc_data_list_connections.');
    const value = matches[0];
    if (value.bcCredential !== undefined && typeof value.bcCredential !== 'boolean') throw error('invalid_configuration', 'bcCredential must be a boolean.');
    if (value.bcCredential === true) throw error('unsupported_authentication', 'BC Data stored-credential access is not implemented yet. Existing stored credentials are unchanged; no plaintext fallback is used.');
    if (typeof value.container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value.container) || value.authentication !== 'UserPassword') {
      throw error('invalid_configuration', 'This BC Data slice requires a named development container with UserPassword authentication.');
    }
    const settings = value.bcData || {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['baseUrl', 'tenant'].includes(key))) {
      throw error('invalid_configuration', 'bcData accepts only baseUrl and tenant.');
    }
    // Custom endpoint is explicit configuration, never a tool argument. Retain
    // configured endpoint/tenant/principal in cursor scope, not filesystem data.
    const baseUrl = settings.baseUrl ?? `http://${value.container}:7048/BC/ODataV4`;
    const tenant = settings.tenant ?? 'default';
    return { id, baseUrl, tenant, username: value.bcUser, password: value.bcPassword,
      authentication: value.authentication, revision, dataToolsEnabled: true };
  }
  function error(category, message) { return Object.assign(new Error(message), { name: 'DataClientError', category }); }
  function result(value, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError }; }
  return {
    invalidate() { revision = crypto.randomUUID(); client = undefined; },
    async call(name, args = {}) {
      const correlationId = crypto.randomUUID();
      const fail = (category, message, extra = {}) => result({ error: { category, message, correlationId, outcome: 'not_applied', ...extra } }, true);
      if (!Object.hasOwn(dataMethods, name) || getToolSettings()[name] !== true) return fail('disabled', 'This BC Data tool is disabled. Enable it in Configure MCP Tools and restart the MCP client.');
      if (!validateDataArguments(name, args)) return fail('invalid_input', 'Arguments do not match this read-only BC Data tool schema.');
      try {
        if (name === 'bc_data_list_connections') {
          const all = configurations();
          return result({ connections: all.filter(allowed).map(value => ({ id: value.name, container: value.container,
            targetType: value.targetType, authentication: value.authentication, readiness: 'not_checked',
            ambiguous: all.filter(other => other?.name?.toLowerCase() === value.name.toLowerCase()).length !== 1 })) });
        }
        client ||= (createClient || require('./bc-data-client').createDataClient)({ resolveConnection });
        const method = dataMethods[name];
        const value = method === 'listCompanies' ? await client.listCompanies(args.connectionId)
          : method === 'readiness' ? await client.readiness(args.connectionId, args.companyId) : await client[method](args);
        return result(value);
      } catch (failure) {
        if (failure.name === 'DataClientError') return fail(failure.category, failure.message);
        if (failure.name === 'DataTransportError') return fail('connection_failure', 'BC Data transport failed; inspect the target and retry the read explicitly.', { transportCode: failure.code, status: failure.status, receivedBytes: failure.receivedBytes });
        return fail('invalid_configuration', 'BC Data could not resolve this configuration. Check local/shared settings; no credentials are included in diagnostics.');
      }
    }
  };
}
module.exports = { createDataRuntime };
