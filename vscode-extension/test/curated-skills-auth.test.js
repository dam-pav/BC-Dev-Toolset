'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const nativeFs = require('node:fs/promises');
const { BcQualityFiles } = require('../bcquality-files');
const { authorizeRoot, assertWithinRoot, resolveWithinRoot } = require('../path-security');
const { CuratedSkillsIntegration } = require('../curated-skills-integration');
const { createCuratedSkillsAuthentication, repositoryKey, validateAccessToken, CuratedSkillsAuthenticationFailure } = require('../curated-skills-auth');

const repository = 'https://github.com/Example/Private-Skills';
const canonical = 'https://github.com/example/private-skills.git';
const token = 'synthetic_test_token_123';
const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
const root = path.join(os.tmpdir(), 'isolated private clone');

function fixture(options = {}) {
  const calls = [];
  const keys = [];
  const secrets = options.secrets || { get: async key => { keys.push(key); return options.absent ? undefined : token; } };
  const execute = async (file, args, execution) => {
    calls.push({ file, args, options: execution });
    if (args.includes('bcdevtoolset.authenticationProbe')) {
      if (options.probeError) throw options.probeError;
      return { stdout: options.unsupported ? '' : execution.env.GIT_CONFIG_VALUE_0 };
    }
    if (options.run) return options.run(file, args, execution);
    return { stdout: args.includes('--get-url') ? canonical : '' };
  };
  return { auth: createCuratedSkillsAuthentication({ secrets, execute }), calls, keys };
}

function settings(env) {
  return Array.from({ length: Number(env.GIT_CONFIG_COUNT || 0) }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]);
}

function headerCall(calls) { return calls.find(call => settings(call.options.env).some(([, value]) => value.includes(encoded))); }

test('token keys bind canonical repository identity and token values reject multiline/empty input', () => {
  assert.equal(repositoryKey(repository), repositoryKey('git@github.com:example/private-skills.git'));
  assert.notEqual(repositoryKey(repository), repositoryKey('https://github.com/example/different.git'));
  assert.equal(validateAccessToken(token), token);
  for (const value of ['', ' token', 'token ', 'a\nb', 'a\rb', 'a\u0000b', undefined]) assert.throws(() => validateAccessToken(value), CuratedSkillsAuthenticationFailure);
});

test('HTTPS selects stored token but local inspection commands never receive it', async () => {
  const { auth, calls, keys } = fixture();
  const git = await auth.getGit(repository);
  await git(['-C', root, 'rev-parse', 'HEAD']);
  assert.equal(git.authentication, 'stored-token');
  assert.deepEqual(keys, [repositoryKey(repository)]);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(`${token}|${encoded}`));
});

test('without a stored token existing Git authentication is retained; SSH does not read token storage', async () => {
  const { auth, calls } = fixture({ absent: true });
  const git = await auth.getGit(repository);
  await git(['clone', '--', repository, root]);
  assert.equal(git.authentication, 'git');
  assert.deepEqual(calls[0].args, ['clone', '--', repository, root]);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  const ssh = fixture({ secrets: { get() { assert.fail('SSH read token storage'); } } });
  assert.deepEqual(await ssh.auth.checkAccess('git@github.com:example/private-skills.git'), { authentication: 'git' });
});

test('unavailable encrypted storage fails closed with safe code and no Git fallback', async () => {
  const { auth, calls } = fixture({ secrets: { get: async () => { throw Object.assign(new Error(`backend ${token}`), { code: 'EACCES' }); } } });
  await assert.rejects(auth.getGit(repository), error => {
    assert.ok(error instanceof CuratedSkillsAuthenticationFailure);
    assert.match(error.message, /retrieval failed.*EACCES/);
    assert.match(error.message, /secret storage|secret-storage/);
    assert.doesNotMatch(error.message, new RegExp(token));
    assert.equal(error.sideEffects, 'not-started');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('private clone separates credential-bearing no-checkout transfer from credential-free checkout', async () => {
  const { auth, calls } = fixture();
  const git = await auth.getGit(repository);
  await git(['clone', '--', repository, root]);
  assert.deepEqual(calls[1].args, ['ls-remote', '--get-url', '--', canonical]);
  assert.deepEqual(calls[2].args, ['clone', '--no-checkout', '--', canonical, root]);
  assert.deepEqual(calls[3].args, ['-C', root, '-c', 'core.hooksPath=/dev/null', 'checkout', '--force']);
  assert.equal(headerCall(calls), calls[2]);
  assert.doesNotMatch(JSON.stringify(calls.map(call => call.args)), new RegExp(`${token}|${encoded}`));
  assert.doesNotMatch(JSON.stringify(calls[3]), new RegExp(`${token}|${encoded}`));
});

test('private update fetches only canonical HTTPS source then merges without credentials', async () => {
  const { auth, calls } = fixture();
  const git = await auth.getGit(repository);
  await git(['-C', root, 'pull', '--ff-only', 'origin', 'main']);
  assert.deepEqual(calls[2].args, ['-C', root, 'fetch', '--no-recurse-submodules', '--no-tags', '--', canonical, 'main']);
  assert.deepEqual(calls[3].args, ['-C', root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', 'FETCH_HEAD']);
  assert.equal(headerCall(calls), calls[2]);
  assert.doesNotMatch(JSON.stringify(calls[3]), new RegExp(`${token}|${encoded}`));
});

test('access check is read-only and scopes headers, redirects, TLS and credential sources', async () => {
  const originalConfigurationCount = process.env.GIT_CONFIG_COUNT;
  const { auth, calls } = fixture();
  assert.deepEqual(await auth.checkAccess(repository), { authentication: 'stored-token' });
  assert.deepEqual(calls.map(call => call.args), [['config', '--get', 'bcdevtoolset.authenticationProbe'], ['ls-remote', '--get-url', '--', canonical], ['ls-remote', '--', canonical]]);
  const env = calls[2].options.env;
  const config = settings(env);
  for (const [key, value] of [
    ['credential.helper', ''], ['core.askPass', ''], ['http.followRedirects', 'false'],
    [`http.${canonical}.followRedirects`, 'false'], ['http.sslVerify', 'true'],
    [`http.${canonical}.sslVerify`, 'true'], ['core.hooksPath', '/dev/null'],
    ['maintenance.auto', 'false'], ['gc.auto', '0'], ['fetch.recurseSubmodules', 'false']
  ]) assert.ok(config.some(pair => pair[0] === key && pair[1] === value), key);
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
  assert.deepEqual(config.filter(([key]) => key === `http.${canonical}.extraHeader`).map(([, value]) => value), ['', `Authorization: Basic ${encoded}`]);
  assert.equal(process.env.GIT_CONFIG_COUNT, originalConfigurationCount);
});

test('private Git children remove inherited traces, askpass, config overrides and insecure TLS case-insensitively', async t => {
  const additions = { Git_Trace: 'trace.log', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1', Git_Config_Count: '1', GIT_CONFIG_VALUE_0: 'old-secret', Git_AskPass: 'old-helper', SSH_ASKPASS: 'old-helper', Git_SSL_No_Verify: '1', Git_Allow_Protocol: 'ext' };
  const old = new Map(Object.keys(additions).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, additions);
  const { auth, calls } = fixture();
  await auth.checkAccess(repository);
  const env = calls[2].options.env;
  assert.ok(!Object.keys(env).some(key => key.toUpperCase().startsWith('GIT_TRACE') && !['GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF'].includes(key)));
  for (const key of ['GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']) assert.equal(env[key], '0');
  assert.ok(!Object.keys(env).some(key => ['GIT_CURL_VERBOSE', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSL_NO_VERIFY'].includes(key.toUpperCase())));
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
  assert.ok(!Object.values(env).includes('old-secret'));
});

test('Git URL rewrites fail before any secret-bearing child starts', async () => {
  const { auth, calls } = fixture({ run: async () => ({ stdout: 'https://other.example/skills.git' }) });
  await assert.rejects(auth.checkAccess(repository), /rewriting changes.*endpoint/);
  assert.equal(calls.length, 2);
  assert.equal(headerCall(calls), undefined);
});

test('unsupported runtime configuration fails before token delivery or alternate credentials', async () => {
  const { auth, calls } = fixture({ unsupported: true });
  await assert.rejects(auth.checkAccess(repository), error => {
    assert.match(error.message, /did not honor process-local authentication settings/);
    assert.match(error.message, /no token was sent.*no alternate credentials were tried/);
    assert.equal(error.sideEffects, 'not-started');
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(headerCall(calls), undefined);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(`${token}|${encoded}`));
});

test('runtime authentication capability probes use fresh non-secret sentinels per request', async () => {
  const { auth, calls } = fixture();
  await auth.checkAccess(repository);
  await auth.checkAccess(repository);
  const probes = calls.filter(call => call.args.includes('bcdevtoolset.authenticationProbe'));
  assert.equal(probes.length, 2);
  assert.notEqual(probes[0].options.env.GIT_CONFIG_VALUE_0, probes[1].options.env.GIT_CONFIG_VALUE_0);
  for (const probe of probes) assert.doesNotMatch(JSON.stringify(probe), new RegExp(`${token}|${encoded}`));
});

test('capability probe timeout preserves its reviewed cause without exposing backend payloads', async () => {
  const { auth, calls } = fixture({ probeError: Object.assign(new Error(token), { killed: true }) });
  await assert.rejects(auth.checkAccess(repository), error => {
    assert.match(error.message, /configuration support failed/);
    assert.match(error.message, /timed out or was stopped/);
    assert.match(error.message, /no token was sent/);
    assert.doesNotMatch(JSON.stringify({ message: error.message, stack: error.stack, ...error }), new RegExp(`${token}|${encoded}`));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(headerCall(calls), undefined);
});

test('clone/fetch/checkout failures preserve safe stages and stop dependents without retries', async () => {
  for (const failedCommand of ['clone', 'fetch', 'checkout', 'merge']) {
    const { auth, calls } = fixture({ run: async (_file, args) => {
      if (args.includes(failedCommand)) throw Object.assign(new Error(`backend ${token} ${encoded}`), { code: 128, stderr: token });
      return { stdout: args.includes('--get-url') ? canonical : '' };
    } });
    const git = await auth.getGit(repository);
    await assert.rejects(git(['fetch', 'merge'].includes(failedCommand) ? ['-C', root, 'pull', '--ff-only', 'origin', 'main'] : ['clone', '--', repository, root]), error => {
      assert.ok(error instanceof CuratedSkillsAuthenticationFailure);
      assert.match(error.message, /code 128/);
      assert.doesNotMatch(JSON.stringify({ message: error.message, stack: error.stack, ...error }), new RegExp(`${token}|${encoded}`));
      assert.equal(error.sideEffects, 'unknown');
      return true;
    });
    if (failedCommand === 'clone') assert.equal(calls.length, 3);
    if (failedCommand === 'fetch') assert.ok(!calls.some(call => call.args.includes('merge')));
    assert.equal(calls.filter(call => call.args.includes(failedCommand)).length, 1);
  }
});

test('unknown backend code strings cannot become a secret-bearing diagnostic', async () => {
  const secretCode = 'PRIVATE_TOKEN_VALUE';
  const { auth } = fixture({ run: async (_file, args) => {
    if (args.includes('--get-url')) return { stdout: canonical };
    throw Object.assign(new Error(token), { code: secretCode, stdout: token, stderr: encoded });
  } });
  await assert.rejects(auth.checkAccess(repository), error => {
    assert.equal(error.code, undefined);
    assert.doesNotMatch(JSON.stringify({ message: error.message, stack: error.stack, ...error }), new RegExp(`${token}|${encoded}|${secretCode}`));
    assert.match(error.message, /cause is unknown/);
    return true;
  });
});

async function localFixture(t) {
  const temporaryParent = authorizeRoot(os.tmpdir(), 'Owned authentication test parent');
  const prefix = resolveWithinRoot(temporaryParent, 'curated-auth-');
  const temporary = assertWithinRoot(temporaryParent, await nativeFs.mkdtemp(prefix)); // nosemgrep -- temporary prefix and result confined to explicitly authorized OS test parent
  const files = new BcQualityFiles(temporary);
  t.after(() => files.rm(temporary, { recursive: true, force: true }));
  return { temporary, files };
}

test('real local Git clone/checkout and fetch/merge preserve the main branch and complete content', async t => {
  const { temporary, files } = await localFixture(t);
  const source = resolveWithinRoot(temporary, 'source');
  const target = resolveWithinRoot(temporary, 'target clone');
  await files.mkdir(source);
  const execute = promisify(execFile);
  const fixtureEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  fixtureEnvironment.GIT_CONFIG_NOSYSTEM = '1';
  fixtureEnvironment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  fixtureEnvironment.GIT_CONFIG_COUNT = '0';
  fixtureEnvironment.GIT_CEILING_DIRECTORIES = temporary;
  const realGit = async args => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { windowsHide: true, env: fixtureEnvironment });
  await realGit(['init', '--initial-branch=main', source]);
  const marker = resolveWithinRoot(source, 'marker.txt');
  await files.writeFile(marker, 'initial');
  await realGit(['-C', source, 'add', '--', 'marker.txt']);
  await realGit(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial fixture']);
  const calls = [];
  const auth = createCuratedSkillsAuthentication({ secrets: { get: async () => token }, execute: async (file, args, options) => {
    calls.push({ args, env: options.env });
    if (args.includes('bcdevtoolset.authenticationProbe')) return execute(file, args, options);
    if (args.includes('--get-url')) return { stdout: canonical };
    // Test-only transport maps the synthetic GitHub endpoint to an owned local fixture.
    // Production still restricts the credential-bearing process to HTTPS only.
    const mapped = args.map(arg => arg === canonical ? source : arg);
    return execute(file, mapped, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } });
  } });
  const git = await auth.getGit(repository);
  await git(['clone', '--', repository, target]);
  assert.equal(await files.readFile(resolveWithinRoot(target, 'marker.txt'), 'utf8'), 'initial');
  assert.equal((await realGit(['-C', target, 'branch', '--show-current'])).stdout.trim(), 'main');
  await files.writeFile(marker, 'updated');
  await realGit(['-C', source, 'add', '--', 'marker.txt']);
  await realGit(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Updated fixture']);
  await git(['-C', target, 'pull', '--ff-only', 'origin', 'main']);
  assert.equal(await files.readFile(resolveWithinRoot(target, 'marker.txt'), 'utf8'), 'updated');
  const persistedConfiguration = await files.readFile(resolveWithinRoot(target, '.git', 'config'), 'utf8');
  assert.doesNotMatch(persistedConfiguration, new RegExp(`${token}|${encoded}|extraheader|Authorization`, 'i'));
  for (const call of calls.filter(call => call.args.includes('checkout') || call.args.includes('merge'))) assert.doesNotMatch(JSON.stringify(call.env), new RegExp(`${token}|${encoded}`));
});

test('explicit trace2 disable prevents global trace configuration from recording authentication headers', async t => {
  const { temporary, files } = await localFixture(t);
  const globalConfiguration = resolveWithinRoot(temporary, 'global.gitconfig');
  const traceFile = resolveWithinRoot(temporary, 'trace.json');
  await files.writeFile(globalConfiguration, `[trace2]\n\teventTarget = ${JSON.stringify(traceFile)}\n\tconfigParams = http.*\n`);
  const { auth, calls } = fixture();
  await auth.checkAccess(repository);
  const selected = headerCall(calls).options.env;
  const execute = promisify(execFile);
  const environment = { ...selected, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfiguration, GIT_CEILING_DIRECTORIES: temporary };
  const baseline = { ...environment };
  for (const key of ['GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']) delete baseline[key];
  await execute('git', ['config', '--get-urlmatch', 'http.extraHeader', canonical], { env: baseline, cwd: temporary, windowsHide: true });
  // Prove the configured tracing would expose the synthetic header without the guard.
  assert.ok((await files.readFile(traceFile, 'utf8')).includes(encoded));
  await files.unlink(traceFile);
  await execute('git', ['config', '--get-urlmatch', 'http.extraHeader', canonical], { env: environment, cwd: temporary, windowsHide: true });
  await assert.rejects(files.lstat(traceFile), { code: 'ENOENT' });
});

test('integration authentication failure preserves safe stage/code and stops before filesystem or Git work', async t => {
  const { temporary, files } = await localFixture(t);
  const home = resolveWithinRoot(temporary, 'home');
  const target = resolveWithinRoot(temporary, 'checkout');
  await files.mkdir(home);
  let nativeCalls = 0;
  const auth = createCuratedSkillsAuthentication({ secrets: { get: async () => { throw Object.assign(new Error(token), { code: 'EACCES' }); } }, execute: async () => { nativeCalls++; assert.fail('Git ran after secret retrieval failed'); } });
  const manager = new CuratedSkillsIntegration({ homeDirectory: home, gitFactory: value => auth.getGit(value) });
  const status = await manager.reconcile({ repositoryUrl: repository, path: target });
  assert.equal(status.state, 'error');
  assert.equal(status.sideEffects, 'not-started');
  assert.match(status.error, /access token retrieval failed.*EACCES/);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(token));
  assert.deepEqual(await files.readdir(home), []);
  assert.equal(nativeCalls, 0);
});

test('queued integration source changes select a distinct authenticated transport inside each update', async t => {
  const { temporary, files } = await localFixture(t);
  const home = resolveWithinRoot(temporary, 'home');
  await files.mkdir(home);
  const firstRoot = resolveWithinRoot(temporary, 'first');
  const secondRoot = resolveWithinRoot(temporary, 'second');
  for (const target of [firstRoot, secondRoot]) {
    await files.mkdir(resolveWithinRoot(target, 'skills', 'review'), { recursive: true });
    await files.writeFile(resolveWithinRoot(target, 'skills', 'entry.md'), 'Route the actual task to applicable native skills.');
    await files.writeFile(resolveWithinRoot(target, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review fixture.\n---\n');
  }
  const secondRepository = 'https://github.com/example/second.git';
  const factories = [];
  const calls = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  let firstEntered;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  const manager = new CuratedSkillsIntegration({ homeDirectory: home, gitFactory: async url => {
    factories.push(url);
    const target = url === repository ? firstRoot : secondRoot;
    return async args => {
      calls.push({ url, args });
      if (url === repository && args.includes('--show-toplevel')) { firstEntered(); await gate; }
      if (args.includes('--show-toplevel')) return target;
      if (args.includes('get-url')) return url;
      if (args.includes('--show-current')) return 'main';
      if (args.includes('HEAD')) return url === repository ? 'first-revision' : 'second-revision';
      return '';
    };
  } });
  const first = manager.reconcile({ repositoryUrl: repository, path: firstRoot });
  await entered;
  const second = manager.reconcile({ repositoryUrl: secondRepository, path: secondRoot });
  assert.deepEqual(factories, [repository]);
  releaseFirst();
  assert.equal((await first).state, 'ready');
  assert.equal((await second).state, 'ready');
  assert.deepEqual(factories, [repository, secondRepository]);
  for (const call of calls) assert.equal(call.args[1], call.url === repository ? firstRoot : secondRoot);
  const installed = await files.readFile(resolveWithinRoot(home, '.agents', 'skills', 'bcdevtoolset-curated-source', 'SKILL.md'), 'utf8');
  assert.ok(installed.includes(JSON.stringify(secondRoot)));
});

test('actual Git URL matching confines runtime headers to the configured repository', async t => {
  const { temporary } = await localFixture(t);
  let env;
  const { auth } = fixture({ run: async (_file, args, execution) => { if (!args.includes('--get-url')) env = execution.env; return { stdout: args.includes('--get-url') ? canonical : '' }; } });
  await auth.checkAccess(repository);
  const exec = promisify(execFile);
  const options = { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: temporary }, cwd: temporary, windowsHide: true };
  const selected = await exec('git', ['config', '--get-urlmatch', 'http.extraHeader', canonical], options);
  assert.equal(selected.stdout.trim(), `Authorization: Basic ${encoded}`);
  const unrelated = await exec('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://github.com/example/other.git'], options);
  assert.equal(unrelated.stdout.trim(), '');
  const redirects = await exec('git', ['config', '--get-urlmatch', 'http.followRedirects', canonical], options);
  assert.equal(redirects.stdout.trim(), 'false');
});

test('isolated URL matching cannot consult an enclosing checkout host authorization setting', async t => {
  const { temporary, files } = await localFixture(t);
  const enclosingCheckout = resolveWithinRoot(temporary, 'checkout');
  const nestedCheckoutDirectory = resolveWithinRoot(enclosingCheckout, 'nested');
  const isolatedDirectory = resolveWithinRoot(temporary, 'isolated');
  await files.mkdir(nestedCheckoutDirectory, { recursive: true });
  await files.mkdir(isolatedDirectory);
  const execute = promisify(execFile);
  const setupEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(setupEnvironment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CEILING_DIRECTORIES: temporary });
  await execute('git', ['init', '--initial-branch=main', enclosingCheckout], { env: setupEnvironment, cwd: isolatedDirectory, windowsHide: true });
  const checkoutHeader = 'Authorization: Basic synthetic_checkout_host_credential';
  await execute('git', ['config', '--local', 'http.https://github.com/.extraheader', checkoutHeader], { env: setupEnvironment, cwd: enclosingCheckout, windowsHide: true });
  const { auth, calls } = fixture();
  await auth.checkAccess(repository);
  const env = { ...headerCall(calls).options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: temporary };
  const query = (key, url, cwd) => execute('git', ['config', '--get-urlmatch', key, url], { env, cwd, windowsHide: true });
  const unrelatedUrl = 'https://github.com/example/other.git';
  // Demonstrate the same local-header contamination installed by actions/checkout.
  assert.equal((await query('http.extraHeader', unrelatedUrl, nestedCheckoutDirectory)).stdout.trim(), checkoutHeader);
  assert.equal((await query('http.extraHeader', canonical, isolatedDirectory)).stdout.trim(), `Authorization: Basic ${encoded}`);
  assert.equal((await query('http.extraHeader', unrelatedUrl, isolatedDirectory)).stdout.trim(), '');
  assert.equal((await query('http.followRedirects', canonical, isolatedDirectory)).stdout.trim(), 'false');
});
