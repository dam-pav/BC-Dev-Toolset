'use strict';

const crypto = require('node:crypto');
const { isDataConfiguration, resolveDataTarget } = require('./bc-data-target');
const { dataMethods, mutationMethods, mutationToolNames, validateDataArguments } = require('./bc-data-tools');

// Extension-host boundary: settings and credentials never enter MCP tool results
// or the bridge payload. No network access or client import until an enabled call.
function createDataRuntime({ getConfigurations, getToolSettings, createClient, getStoredCredential, getCloudSession, windowsTransport, invalidateCredentials }) {
  let revision = crypto.randomUUID();
  let client;
  function configurations() {
    const values = getConfigurations();
    if (!Array.isArray(values)) throw new Error('Invalid configurations.');
    return values;
  }
  function allowed(value) {
    return isDataConfiguration(value);
  }
  async function resolveConnection(id, operation) {
    const matches = configurations().filter(value => typeof value?.name === 'string' && value.name.toLowerCase() === id.toLowerCase());
    if (matches.length !== 1 || !allowed(matches[0]) || matches[0].name !== id) throw error('invalid_configuration', 'Select a unique configured connection name from bc_dev_toolset_data_list_connections.');
    const value = matches[0];
    if (value.bcCredential !== undefined && typeof value.bcCredential !== 'boolean') throw error('invalid_configuration', 'bcCredential must be a boolean.');
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
    let target;
    try { target = resolveDataTarget(value); }
    catch { throw error('invalid_configuration', 'Check the configured BC Data endpoint and authentication. OnPrem requires bcData.baseUrl on its server hostname (HTTPS for UserPassword); Cloud requires tenant and environmentName.'); }
    const { baseUrl, tenant, authentication } = target;
    const captured = { id, baseUrl, tenant, username: value.bcUser, password: value.bcPassword,
      authentication, revision, dataToolsEnabled: true, windowsTransport };
    if (authentication === 'AAD') {
      if (typeof getCloudSession !== 'function') throw error('credential_unavailable', 'Cloud authentication is unavailable. Reload the extension host.');
      const session = await getCloudSession({ tenant: value.tenant });
      if (!session?.accessToken || !session?.accountId) throw error('credential_unavailable', 'Sign into Microsoft for this configured tenant in VS Code before using BC Data.');
      captured.accessToken = session.accessToken;
      captured.username = session.accountId;
      captured.password = undefined;
      return captured;
    }
    const onPrem = value.serverType === 'OnPrem';
    const source = onPrem ? (value.useDataCredentials === undefined ? 'bc' : value.useDataCredentials) : 'bc';
    if (!['bc', 'remote', 'currentWindows'].includes(source)) throw error('invalid_configuration', 'useDataCredentials must be bc, remote or currentWindows.');
    if (source === 'currentWindows') {
      if (authentication !== 'Windows') throw error('invalid_configuration', 'useDataCredentials currentWindows requires Windows authentication.');
      captured.username = undefined; captured.password = undefined;
      return captured;
    }
    const flag = value[source + 'Credential'];
    if (flag !== undefined && typeof flag !== 'boolean') throw error('invalid_configuration', source + 'Credential must be a boolean.');
    const legacyBc = source === 'bc' && value.bcUser === undefined && value.bcPassword === undefined;
    captured.username = legacyBc ? value.admin : value[source + 'User'];
    captured.password = legacyBc ? value.password : value[source + 'Password'];
    if (flag === true) {
      const label = source === 'remote' ? 'remote' : 'BC';
      // Endpoint host authorization is established by resolveDataTarget; container
      // overrides must also remain on the configured container hostname.
      const endpoint = new URL(baseUrl);
      if (value.serverType === 'Container' && endpoint.hostname.toLowerCase() !== value.container.toLowerCase()) {
        throw error('invalid_configuration', 'Stored BC credentials require an endpoint on the configured container hostname.');
      }
      if (typeof getStoredCredential !== 'function') throw error('credential_unavailable', `Stored ${label} credential support is unavailable. Reload the matching extension host; no alternate identity was attempted.`);
      const credential = await getStoredCredential(value.serverType === 'Container' ? { container: value.container } : {
        configuration: { serverType: value.serverType, server: value.server, managementServer: value.managementServer, serverInstance: value.serverInstance },
        ...(source === 'remote' ? { kind: source } : {})
      });
      if (typeof credential?.username !== 'string' || !credential.username || typeof credential.password !== 'string' || !credential.password) {
        throw error('credential_unavailable', `Selected ${label} credentials could not be read; no alternate identity was attempted.`);
      }
      captured.username = credential.username; captured.password = credential.password;
    } else if (!onPrem && authentication === 'Windows' && !captured.username && !captured.password) {
      // The explicit selectors apply to OnPrem; retain container Windows auth.
      captured.username = undefined; captured.password = undefined;
    } else if (typeof captured.username !== 'string' || !captured.username || typeof captured.password !== 'string' || !captured.password) {
      throw error('credential_unavailable', 'Selected data credentials (' + source + ') are missing or incomplete. Configure their username/password or stored credential entry, or explicitly set useDataCredentials to remote or currentWindows as appropriate. No alternate identity was attempted.');
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
          return result({ connections: all.filter(allowed).map(value => ({ id: value.name, serverType: value.serverType, container: value.container, environmentName: value.environmentName,
            targetType: value.targetType, authentication: value.serverType === 'Cloud' ? 'AAD' : value.authentication, readiness: 'not_checked',
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
