'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCredentialProvider } = require('../bc-data-credentials');
const root = path.resolve(__dirname, '../..');
function fixture(options = {}) {
  const starts = [], requests = [], children = [];
  const provider = createCredentialProvider({ toolsetRoot: root, platform: 'win32', ...options,
    spawnWorker(command, args, config) {
      starts.push({ command, args, config });
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(data, encoding, done) {
        const request = JSON.parse(data.toString());
        requests.push(request); done();
      } });
      child.killed = false;
      child.kill = () => { child.killed = true; child.emit('close', 1); return true; };
      children.push(child);
      return child;
    } });
  const reply = (request, value, child = children.at(-1)) => child.stdout.write(JSON.stringify({ id: request.id, ...value }) + '\n');
  return { provider, starts, requests, children, reply };
}
test('credential worker is lazy, private and reused; each read receives the current value', async () => {
  const f = fixture();
  assert.equal(f.starts.length, 0);
  const first = f.provider.read('fixture');
  f.reply(f.requests[0], { username: 'stored-user', password: 'one' });
  assert.equal((await first).password, 'one');
  const second = f.provider.read('fixture');
  f.reply(f.requests[1], { username: 'stored-user', password: 'two' });
  assert.equal((await second).password, 'two');
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].config.shell, false);
  assert.equal(f.starts[0].config.windowsHide, true);
  assert.deepEqual(f.starts[0].config.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(f.starts[0].args.includes('-NoProfile') && f.starts[0].args.includes('-NonInteractive'));
  assert.ok(f.starts[0].args.at(-1).endsWith(path.join('common', 'ReadBcDataCredential.ps1')));
  assert.ok(f.requests.every(request => Object.keys(request).sort().join() === 'container,id'));
  f.provider.dispose();
  assert.equal(f.children[0].killed, true);
});
test('concurrent replies are matched by request ID rather than arrival order', async () => {
  const f = fixture();
  const first = f.provider.read('one'), second = f.provider.read('two');
  f.reply(f.requests[1], { username: 'two', password: 'two-secret' });
  f.reply(f.requests[0], { username: 'one', password: 'one-secret' });
  assert.equal((await first).username, 'one');
  assert.equal((await second).username, 'two');
  f.provider.dispose();
});
test('missing credentials are explicit, never retried, and do not kill a healthy worker', async () => {
  const f = fixture();
  const missing = f.provider.read('fixture');
  f.reply(f.requests[0], { error: 'credential_missing' });
  await assert.rejects(missing, { category: 'credential_missing' });
  assert.equal(f.children[0].killed, false);
  const next = f.provider.read('fixture');
  f.reply(f.requests[1], { username: 'newly-configured', password: 'new-secret' });
  assert.equal((await next).username, 'newly-configured');
  assert.equal(f.starts.length, 1);
  f.provider.dispose();
});
test('malformed, oversized, unsolicited and secret-bearing error replies fail closed', async () => {
  for (const malformed of [request => '{bad json}\n', request => 'x'.repeat(16385), request => JSON.stringify({ id: 'wrong-id', username: 'secret', password: 'secret' }) + '\n',
    request => JSON.stringify({ id: request.id, error: 'backend leaked secret' }) + '\n']) {
    const f = fixture();
    const pending = f.provider.read('fixture');
    f.children[0].stderr.write('backend leaked secret');
    f.children[0].stdout.write(malformed(f.requests[0]));
    await assert.rejects(pending, error => error.category === 'credential_unavailable' && !error.message.includes('backend leaked secret'));
    assert.equal(f.children[0].killed, true);
    f.provider.dispose();
  }
});
test('deadlines, worker exit and disposal reject pending calls without retrying', async () => {
  const f = fixture({ timeoutMs: 30 });
  await assert.rejects(f.provider.read('fixture'), { category: 'credential_unavailable' });
  assert.equal(f.starts.length, 1);
  const restarted = f.provider.read('fixture');
  f.children[1].emit('error', new Error('backend secret'));
  await assert.rejects(restarted, { category: 'credential_unavailable' });
  assert.equal(f.starts.length, 2);
  const pending = f.provider.read('fixture');
  f.provider.dispose();
  await assert.rejects(pending, { category: 'credential_unavailable' });
  await assert.rejects(f.provider.read('fixture'), { category: 'credential_unavailable' });
  assert.equal(f.starts.length, 3);
});
test('invalid container names and excessive concurrency cannot bypass the bounded protocol', async () => {
  const f = fixture();
  for (const container of ['../escape', '--all', 'x'.repeat(64), 'host\nrequest', null]) await assert.rejects(f.provider.read(container), { category: 'credential_unavailable' });
  assert.equal(f.starts.length, 0);
  const pending = Array.from({ length: 16 }, () => f.provider.read('fixture'));
  const results = Promise.allSettled(pending);
  await assert.rejects(f.provider.read('fixture'), { category: 'credential_unavailable' });
  assert.equal(f.requests.length, 16);
  f.provider.dispose();
  assert.ok((await results).every(result => result.status === 'rejected'));
});
test('native helper reuses Toolset credential identity, supports Unicode/rotation and never falls back', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const container = 'fixture-' + crypto.randomUUID();
  const manager = path.join(root, 'common', 'CredentialMgt.ps1').replaceAll("'", "''");
  const identity = `$configuration=[pscustomobject]@{name='synthetic';serverType='Container';container='${container}';bcCredential=$true}; $target=Get-ConfigurationCredentialTarget -configuration $configuration -kind bc`;
  function store(action, password) {
    const source = `$ErrorActionPreference='Stop'; . '${manager}'; Initialize-WindowsCredentialStore; ${identity}; ` + (action === 'delete'
      ? '[BcDevToolset.CredentialStore]::Delete($target)'
      : `[BcDevToolset.CredentialStore]::Write($target,'fixture-Ž-user',(ConvertTo-SecureString ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(password).toString('base64')}'))) -AsPlainText -Force))`);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', source], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    // Do not include stderr/command text in failures: native tests handle only
    // random synthetic credentials, and apply the same redaction discipline.
    assert.equal(result.status, 0, 'Synthetic credential-store setup/cleanup failed.');
  }
  let starts = 0;
  const provider = createCredentialProvider({ toolsetRoot: root, spawnWorker: (...args) => { starts++; return spawn(...args); } });
  try {
    store('write', 'synthetic-世界-😀-one');
    assert.deepEqual(await provider.read(container), { username: 'fixture-Ž-user', password: 'synthetic-世界-😀-one' });
    store('write', 'synthetic-Ž-two\n"\\');
    assert.deepEqual(await provider.read(container), { username: 'fixture-Ž-user', password: 'synthetic-Ž-two\n"\\' });
    store('delete');
    await assert.rejects(provider.read(container), { category: 'credential_missing' });
    assert.equal(starts, 1);
  } finally { provider.dispose(); store('delete'); }
});
