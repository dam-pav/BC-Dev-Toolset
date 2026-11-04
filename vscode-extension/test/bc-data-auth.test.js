'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getCloudDataSession } = require('../bc-data-auth');

test('Cloud sign-in is explicit; routine calls silently reuse only the configured tenant scopes', async () => {
  const requests = [];
  const authentication = { async getSession(...args) {
    requests.push(args);
    return { accessToken: 'private-token', account: { id: 'principal' } };
  } };
  assert.deepEqual(await getCloudDataSession(authentication, 'tenant.example', true), { accessToken: 'private-token', accountId: 'principal' });
  await getCloudDataSession(authentication, 'tenant.example');
  assert.deepEqual(requests.map(request => request[2]), [{ createIfNone: true }, { silent: true }]);
  assert.ok(requests.every(request => request[0] === 'microsoft' && request[1].includes('VSCODE_TENANT:tenant.example') &&
    request[1].includes('https://api.businesscentral.dynamics.com/user_impersonation')));
});

test('missing or rejected Cloud sessions return actionable errors without backend secrets', async () => {
  for (const getSession of [async () => undefined, async () => { throw new Error('secret backend token'); }]) {
    await assert.rejects(getCloudDataSession({ getSession }, 'tenant.example'), error =>
      error.category === 'credential_unavailable' && /Sign in to BC Data/.test(error.message) && !error.message.includes('secret'));
  }
});

test('Cloud sign-in command is discoverable without an agent-triggered sign-in tool', () => {
  const pkg = require('../package.json');
  const operation = require('../../operations/operations.json').find(value => value.id === 'signInBcData');
  assert.equal(operation.command, 'signInBcData');
  assert.equal(operation.script, undefined);
  assert.ok(pkg.activationEvents.includes('onCommand:bcDevToolset.signInBcData'));
  assert.ok(pkg.contributes.commands.some(value => value.command === 'bcDevToolset.signInBcData'));
});
