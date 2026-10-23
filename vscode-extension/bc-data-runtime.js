'use strict';

const crypto = require('node:crypto');
const { dataMethods, mutationMethods, mutationToolNames, validateDataArguments } = require('./bc-data-tools');

// Extension-host boundary: settings and credentials never enter MCP tool results
// or the bridge payload. No network access or client import until an enabled call.
function createDataRuntime({ getConfigurations, getToolSettings, createClient, getStoredCredential, invalidateCredentials }) {
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
  async function resolveConnection(id, operation) {
    const matches = configurations().filter(value => typeof value?.name === 'string' && value.name.toLowerCase() === id.toLowerCase());
    if (matches.length !== 1 || !allowed(matches[0]) || matches[0].name !== id) throw error('invalid_configuration', 'Select a unique Dev/Test Container configuration name from bc_dev_toolset_data_list_connections.');
    const value = matches[0];
    if (value.bcCredential !== undefined && typeof value.bcCredential !== 'boolean') throw error('invalid_configuration', 'bcCredential must be a boolean.');
    if (typeof value.container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value.container) || value.authentication !== 'UserPassword') {
      throw error('invalid_configuration', 'This BC Data slice requires a named development container with UserPassword authentication.');
    }
    const settings = value.bcData || {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['baseUrl', 'tenant', 'provisioningEnabled', 'allowedAllMutationOperations', 'allowedMutationOperations'].includes(key)) ||
        (settings.provisioningEnabled !== undefined && typeof settings.provisioningEnabled !== 'boolean') ||
        (settings.allowedAllMutationOperations !== undefined && typeof settings.allowedAllMutationOperations !== 'boolean')) {
      throw error('invalid_configuration', 'bcData accepts baseUrl, tenant, boolean provisioningEnabled, boolean allowedAllMutationOperations and allowedMutationOperations.');
    }
    const permitted = settings.allowedAllMutationOperations === true ? Object.keys(mutationMethods)
      : settings.allowedMutationOperations === undefined ? [] : settings.allowedMutationOperations;
    if (!Array.isArray(permitted) || new Set(permitted).size !== permitted.length || permitted.some(item => typeof item !== 'string' || !Object.hasOwn(mutationMethods, item))) {
      throw error('invalid_configuration', 'bcData.allowedMutationOperations must be a unique list of insert, modify, rename and delete.');
    }
    if (operation !== undefined && !permitted.includes(operation)) throw error('disabled', 'This mutation operation is not enabled by the connection bcData.allowedAllMutationOperations or bcData.allowedMutationOperations.');
    // Custom endpoint is explicit configuration, never a tool argument. Retain
    // configured endpoint/tenant/principal in cursor scope, not filesystem data.
    const baseUrl = settings.baseUrl ?? `http://${value.container}:7048/BC/ODataV4`;
    const tenant = settings.tenant ?? 'default';
    const captured = { id, baseUrl, tenant, username: value.bcUser, password: value.bcPassword,
      authentication: value.authentication, revision, dataToolsEnabled: true };
    const container = value.container;
    if (value.bcCredential === true) {
      // Stored credentials are scoped to the container, so a workspace endpoint
      // override must not redirect that identity to another host.
      let endpoint;
      try { endpoint = new URL(baseUrl); } catch { throw error('invalid_configuration', 'Stored BC credentials require a valid ODataV4 endpoint.'); }
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          !endpoint.pathname.endsWith('/ODataV4') || endpoint.hostname.toLowerCase() !== container.toLowerCase()) {
        throw error('invalid_configuration', 'Stored BC credentials require an ODataV4 endpoint on the configured container hostname.');
      }
      if (typeof getStoredCredential !== 'function') throw error('credential_unavailable', 'Stored BC credential support is unavailable. Reload the matching extension host; plaintext settings are ignored.');
      const credential = await getStoredCredential({ container });
      if (typeof credential?.username !== 'string' || !credential.username || typeof credential.password !== 'string' || !credential.password) {
        throw error('credential_unavailable', 'Stored BC credentials could not be read; plaintext settings are ignored.');
      }
      captured.username = credential.username;
      captured.password = credential.password;
    }
    return captured;
  }
  function error(category, message) { return Object.assign(new Error(message), { name: 'DataClientError', category }); }
  function result(value, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError }; }
  return {
    invalidate() { revision = crypto.randomUUID(); client = undefined; invalidateCredentials?.(); },
    async call(name, args = {}) {
      const correlationId = crypto.randomUUID();
      const fail = (category, message, extra = {}) => result({ error: { category, message, correlationId, outcome: 'not_applied', ...extra } }, true);
      if (!Object.hasOwn(dataMethods, name) || getToolSettings()[name] !== true) return fail('disabled', 'This BC Data tool is disabled. Enable it in Configure MCP Tools and restart the MCP client.');
      if (!validateDataArguments(name, args)) return fail('invalid_input', 'Arguments do not match this BC Data tool schema.');
      const mutation = mutationToolNames.includes(name);
      try {
        if (name === 'bc_dev_toolset_data_list_connections') {
          const all = configurations();
          return result({ connections: all.filter(allowed).map(value => ({ id: value.name, container: value.container,
            targetType: value.targetType, authentication: value.authentication, readiness: 'not_checked',
            ambiguous: all.filter(other => other?.name?.toLowerCase() === value.name.toLowerCase()).length !== 1 })) });
        }
        client ||= (createClient || require('./bc-data-client').createDataClient)({ resolveConnection });
        const method = dataMethods[name];
        const { operation, ...mutationRequest } = mutation ? args : {};
        const value = mutation ? await client[mutationMethods[operation]](mutationRequest)
          : method === 'listCompanies' ? await client.listCompanies(args.connectionId)
          : method === 'readiness' ? await client.readiness(args.connectionId, args.companyId) : await client[method](args);
        return result(value);
      } catch (failure) {
        if (failure.name === 'DataClientError' || failure.name === 'DataCredentialError') return fail(failure.category, failure.message,
          { outcome: failure.outcome || 'not_applied', ...(failure.requestId ? { requestId: failure.requestId, epoch: failure.epoch, retryUntil: failure.retryUntil } : {}) });
        if (failure.name === 'DataTransportError') return fail('connection_failure', mutation ? 'BC Data mutation preparation transport failed; no business mutation was submitted.' : 'BC Data transport failed; inspect the target and retry the read explicitly.', { outcome: 'not_applied', transportCode: failure.code, status: failure.status, receivedBytes: failure.receivedBytes });
        return fail('invalid_configuration', 'BC Data could not resolve this configuration. Check local/shared settings; no credentials are included in diagnostics.');
      }
    }
  };
}
module.exports = { createDataRuntime };
