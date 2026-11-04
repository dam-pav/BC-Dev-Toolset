'use strict';

async function getCloudDataSession(authentication, tenant, interactive = false) {
  const unavailable = () => Object.assign(new Error('Run BC Dev Toolset: Sign in to BC Data for this Cloud configuration. Check the tenant, account access and consent if sign-in fails.'),
    { name: 'DataCredentialError', category: 'credential_unavailable' });
  if (typeof tenant !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(tenant)) throw unavailable();
  try {
    const session = await authentication.getSession('microsoft', [
      'https://api.businesscentral.dynamics.com/user_impersonation', `VSCODE_TENANT:${tenant}`
    ], interactive ? { createIfNone: true } : { silent: true });
    if (!session?.accessToken || !session?.account?.id) throw unavailable();
    return { accessToken: session.accessToken, accountId: session.account.id };
  } catch { throw unavailable(); }
}
module.exports = { getCloudDataSession };
