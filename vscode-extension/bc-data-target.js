'use strict';

// Endpoint derivation is shared by discovery and calls. OData ports are distinct
// from the configured developer-services port, so OnPrem requires an explicit URL.
function isDataConfiguration(value) {
  const present = field => typeof value?.[field] === 'string' && value[field].trim().length > 0;
  return !!value && ['Container', 'Cloud', 'OnPrem'].includes(value.serverType) &&
    ['Dev', 'Test', 'Production'].includes(value.targetType) && present('name') &&
    (value.serverType === 'Container' ? present('container') : value.serverType === 'Cloud' ? present('environmentName') : present('serverInstance'));
}

function resolveDataTarget(value) {
  if (!isDataConfiguration(value)) {
    throw new Error('Select a named Container, Cloud or OnPrem configuration.');
  }
  const settings = value.bcData || {};
  let baseUrl = settings.baseUrl;
  let authentication = value.authentication;
  if (value.serverType === 'Container') {
    if (typeof value.container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value.container)) throw new Error('Invalid container name.');
    baseUrl ??= `http://${value.container}:7048/BC/ODataV4`;
  } else if (value.serverType === 'Cloud') {
    if (typeof value.tenant !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(value.tenant) ||
        typeof value.environmentName !== 'string' || !value.environmentName.trim()) throw new Error('Cloud requires tenant and environmentName.');
    authentication = 'AAD';
    const expected = `https://api.businesscentral.dynamics.com/v2.0/${encodeURIComponent(value.tenant)}/${encodeURIComponent(value.environmentName)}/ODataV4`;
    if (baseUrl !== undefined && baseUrl !== expected) throw new Error('Cloud baseUrl must match the configured tenant and environment.');
    baseUrl = expected;
  }
  if (!['UserPassword', 'Windows', 'AAD'].includes(authentication) || (authentication === 'AAD' && value.serverType !== 'Cloud')) throw new Error('Unsupported BC Data authentication.');
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('Set bcData.baseUrl to an HTTP(S) ODataV4 URL.'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !endpoint.pathname.endsWith('/ODataV4')) throw new Error('Set bcData.baseUrl to an HTTP(S) ODataV4 URL.');
  if (value.serverType === 'OnPrem') {
    const server = new URL(/^https?:\/\//i.test(value.server) ? value.server : `http://${value.server}`);
    if (endpoint.hostname.toLowerCase() !== server.hostname.toLowerCase()) throw new Error('BC Data endpoint must use the configured server hostname.');
    if (authentication === 'UserPassword' && endpoint.protocol !== 'https:') throw new Error('OnPrem UserPassword requires HTTPS.');
  }
  const tenant = settings.tenant ?? (value.serverType === 'OnPrem' ? value.tenant || 'default' : 'default');
  if (typeof tenant !== 'string' || !tenant) throw new Error('Invalid BC Data tenant.');
  return { baseUrl, tenant, authentication };
}
module.exports = { isDataConfiguration, resolveDataTarget };
