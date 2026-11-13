'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');
const { validateRepositoryUrl } = require('../curated-skills-integration');
const root = authorizeRoot(path.resolve(__dirname, '..'), 'Extension test source root');
const source = fs.readFileSync(resolveWithinRoot(root, 'curated-skills-vscode.js'), 'utf8'); // nosemgrep -- fixed source file is contained by the authorized extension root
const registerSource = source.match(/function registerCuratedSkillsIntegration\([^]*?\n}/)[0];
class AuthenticationFailure extends Error {}

function fixture(options = {}) {
  const commands = new Map();
  const writes = [];
  const removals = [];
  const prompts = [];
  const errors = [];
  const information = [];
  const checks = [];
  const reconciliations = [];
  const logs = [];
  const values = new Map();
  const secrets = options.noStorage ? undefined : {
    async store(key, value) {
      writes.push([key, value]);
      if (options.storeFailure) throw options.storeFailure;
      values.set(key, value);
    },
    async delete(key) {
      removals.push(key);
      if (options.deleteFailure) throw options.deleteFailure;
      values.delete(key);
    }
  };
  let configuration = { repositoryUrl: options.url || 'https://github.com/Example/Skills.git', path: '' };
  let configurationReads = 0;
  let authenticationOptions;
  let integrationOptions;
  class FakeIntegration {
    constructor(supplied) { integrationOptions = supplied; this.status = { state: 'disabled', adapters: [] }; }
    async reconcile(value) { reconciliations.push(value); return this.status; }
  }
  const authentication = {
    async getGit(url) { return `git:${url}`; },
    async checkAccess(url) {
      checks.push(url);
      if (options.checkFailure) throw options.checkFailure;
      return { authentication: options.authentication || 'stored-token', stdout: 'secret backend output' };
    }
  };
  const register = vm.runInNewContext(`(${registerSource})`, {
    CuratedSkillsIntegration: FakeIntegration,
    validateRepositoryUrl,
    repositoryKey: value => `test-token:${validateRepositoryUrl(value).identity}`,
    validateAccessToken(value) {
      if (typeof value !== 'string' || !value || /\s/.test(value)) throw new AuthenticationFailure('Enter a nonempty access token without whitespace or control characters.');
      return value;
    },
    CuratedSkillsAuthenticationFailure: AuthenticationFailure,
    createCuratedSkillsAuthentication(supplied) { authenticationOptions = supplied; return authentication; }
  });
  const disposable = { dispose() {} };
  register({
    commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable; } },
    workspace: { onDidChangeConfiguration() { return disposable; } },
    window: {
      async showInputBox(supplied) {
        prompts.push(supplied);
        if (options.changeDuringPrompt) configuration = { ...configuration, repositoryUrl: options.changeDuringPrompt };
        return options.cancel ? undefined : options.input === undefined ? 'github_pat_example' : options.input;
      },
      async showErrorMessage(message) { errors.push(message); },
      async showInformationMessage(message) {
        if (options.informationFailure) throw options.informationFailure;
        information.push(message);
      }
    }
  }, { subscriptions: [], secrets }, {
    getConfiguration() { configurationReads++; return configuration; },
    isDevelopment: () => options.development || false,
    log: message => logs.push(message)
  });
  return {
    commands, writes, removals, prompts, errors, information, checks, reconciliations, logs, values, secrets,
    configurationReads: () => configurationReads, authenticationOptions: () => authenticationOptions,
    integrationOptions: () => integrationOptions
  };
}

const configure = fixture => fixture.commands.get('bcDevToolset.configureCuratedSkillsAccessToken')();
const remove = fixture => fixture.commands.get('bcDevToolset.removeCuratedSkillsAccessToken')();
const check = fixture => fixture.commands.get('bcDevToolset.checkCuratedSkillsAccess')();

test('token setup uses masked input without a prefilled token and stores only under repository identity', async () => {
  const f = fixture();
  assert.equal(await configure(f), true);
  assert.equal(f.prompts[0].password, true);
  assert.equal(f.prompts[0].ignoreFocusOut, true);
  assert.equal(f.prompts[0].value, undefined);
  assert.deepEqual(f.writes, [['test-token:example/skills', 'github_pat_example']]);
  assert.doesNotMatch(JSON.stringify([f.information, f.errors, f.logs, f.reconciliations]), /github_pat_example/);
  assert.equal(f.checks.length, 0);
  assert.equal(f.reconciliations.length, 1, 'Token setup must not update a checkout or adapters');
});

test('cancelled token entry makes no credential or network changes', async () => {
  const f = fixture({ cancel: true });
  assert.equal(await configure(f), false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.removals, []);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.information, []);
  assert.deepEqual(f.checks, []);
});

test('repository changes during token entry cannot store a token for the wrong source', async () => {
  const f = fixture({ changeDuringPrompt: 'https://github.com/example/other.git' });
  assert.equal(await configure(f), false);
  assert.deepEqual(f.writes, []);
  assert.match(f.errors[0], /repository changed/);
  assert.match(f.errors[0], /No token was stored/);
});

test('SSH source token setup directs users to HTTPS or SSH authentication before prompting', async () => {
  const f = fixture({ url: 'git@github.com:example/skills.git' });
  assert.equal(await configure(f), false);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.writes.length, 0);
  assert.match(f.errors[0], /HTTPS|SSH key/);
});

test('removal targets the same canonical repository identity even with an SSH URL', async () => {
  const f = fixture({ url: 'git@github.com:EXAMPLE/Skills.git' });
  f.values.set('test-token:example/skills', 'old-token');
  f.values.set('test-token:example/other', 'other-token');
  assert.equal(await remove(f), true);
  assert.deepEqual(f.removals, ['test-token:example/skills']);
  assert.equal(f.values.has('test-token:example/skills'), false);
  assert.equal(f.values.get('test-token:example/other'), 'other-token');
  assert.equal(f.checks.length, 0);
  assert.equal(f.reconciliations.length, 1);
});

test('unavailable secret storage fails before token input or any credential write', async () => {
  const f = fixture({ noStorage: true });
  assert.equal(await configure(f), false);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.writes.length, 0);
  assert.match(f.errors[0], /secret storage is unavailable/);
  assert.match(f.errors[0], /Reload|credential service/);
});

test('failed secret writes preserve failed result, safe status and an uncertain write outcome', async () => {
  for (const action of ['store', 'delete']) {
    const f = fixture({ [`${action}Failure`]: Object.assign(new Error('secret backend payload'), { code: 'EACCES' }) });
    assert.equal(await (action === 'store' ? configure(f) : remove(f)), false);
    assert.match(f.errors[0], /EACCES/);
    assert.match(f.errors[0], /credential-write outcome is unknown/);
    assert.match(f.errors[0], /replace\/remove|inspect/);
    assert.doesNotMatch(f.errors[0], /secret backend payload|github_pat_example/);
    assert.deepEqual(f.information, []);
    assert.deepEqual(f.checks, []);
  }
});

test('credential-bearing repository URLs are rejected without token input or backend payload disclosure', async () => {
  const f = fixture({ url: 'https://secret-user:secret-password@github.com/example/skills.git' });
  assert.equal(await configure(f), false);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(f.errors), /secret-user|secret-password/);
});

test('arbitrary SecretStorage error codes cannot disclose token-shaped backend payloads', async () => {
  for (const action of ['store', 'delete']) {
    const f = fixture({ [`${action}Failure`]: Object.assign(new Error('untrusted storage backend payload'), { code: 'SYNTHETIC_SECRET_TOKEN' }) });
    assert.equal(await (action === 'store' ? configure(f) : remove(f)), false);
    assert.match(f.errors[0], /unknown reason/);
    assert.match(f.errors[0], /credential-write outcome is unknown/);
    assert.doesNotMatch(JSON.stringify([f.errors, f.information, f.logs]), /SYNTHETIC_SECRET_TOKEN|untrusted storage backend payload/);
    assert.deepEqual(f.information, []);
    assert.deepEqual(f.checks, []);
  }
});

test('invalid tokens cannot be stored and their content is not shown in validation diagnostics', async () => {
  const f = fixture({ input: 'secret-token\ninvalid' });
  assert.equal(await configure(f), false);
  assert.equal(f.writes.length, 0);
  assert.match(f.errors[0], /whitespace|control/);
  assert.doesNotMatch(JSON.stringify(f.errors), /secret-token/);
});

test('development-host authentication commands skip personal configuration, secrets and network access', async () => {
  const f = fixture({ development: true });
  assert.equal(await configure(f), false);
  assert.equal(await remove(f), false);
  assert.equal(await check(f), false);
  assert.equal(f.configurationReads(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.removals.length, 0);
  assert.equal(f.checks.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.reconciliations.length, 0);
});

test('access check needs only the repository URL and never starts checkout or adapter maintenance', async () => {
  const f = fixture();
  assert.equal(await check(f), true);
  assert.deepEqual(f.checks, ['https://github.com/Example/Skills.git']);
  assert.equal(f.reconciliations.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.removals.length, 0);
  assert.match(f.information[0], /stored access token/);
  assert.match(f.information[0], /No checkout or adapters were changed/);
  assert.doesNotMatch(f.information[0], /secret backend output/);
});

test('development-host skip notification failure never rejects or exposes a raw UI error', async () => {
  const f = fixture({ development: true, informationFailure: new Error('secret UI backend payload') });
  assert.equal(await configure(f), false);
  assert.equal(await remove(f), false);
  assert.equal(await check(f), false);
  assert.equal(f.configurationReads(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.checks.length, 0);
  assert.match(f.logs[0], /notification could not be displayed/);
  assert.doesNotMatch(JSON.stringify([f.logs, f.errors]), /secret UI backend payload/);
});

test('access-check failure preserves reviewed causes or safe unknown guidance without secret disclosure', async () => {
  for (const checkFailure of [new AuthenticationFailure('The stored token could not authenticate. Replace it and check repository access.'), Object.assign(new Error('secret-backend-token'), { code: 128 })]) {
    const f = fixture({ checkFailure });
    assert.equal(await check(f), false);
    assert.equal(f.checks.length, 1);
    assert.equal(f.reconciliations.length, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.information.length, 0);
    assert.match(f.errors[0], /Check Curated Skills Access/);
    assert.match(f.errors[0], /Replace|Reload|check/);
    assert.doesNotMatch(f.errors[0], /secret-backend-token/);
  }
});

test('maintenance factory receives secret storage and binds authentication to the requested repository', async () => {
  const f = fixture();
  assert.equal(f.authenticationOptions().secrets, f.secrets);
  assert.equal(await f.integrationOptions().gitFactory('https://github.com/example/skills.git'), 'git:https://github.com/example/skills.git');
});
