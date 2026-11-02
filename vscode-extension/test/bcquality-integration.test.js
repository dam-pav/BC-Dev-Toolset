'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const { BcQualityIntegration, validateClonePath, acquireLock } = require('../bcquality-integration');
const { registerBcQualityIntegration } = require('../bcquality-vscode');

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bcquality-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home');
  const root = path.join(temporary, 'knowledge with spaces');
  await fs.mkdir(home);
  const calls = [];
  const git = async args => {
    calls.push(args);
    if (args[0] === 'clone') {
      await content(root);
      return '';
    }
    if (args.includes('--show-toplevel')) return options.top || root;
    if (args.includes('get-url')) return options.remote || 'https://github.com/microsoft/BCQuality.git';
    if (args.includes('status')) return options.dirty || '';
    if (args.includes('--show-current')) return options.branch === undefined ? 'main' : options.branch;
    if (args.includes('pull') && options.pullError) throw new Error(options.pullError);
    if (args.includes('HEAD')) return 'fixture-commit';
    return '';
  };
  const manager = new BcQualityIntegration({ homeDirectory: home, git });
  return { temporary, home, root, calls, manager };
}

async function content(root) {
  await fs.mkdir(path.join(root, 'skills'), { recursive: true });
  await fs.writeFile(path.join(root, 'plugin.json'), '{"name":"bcquality"}');
  await fs.writeFile(path.join(root, 'skills', 'entry.md'), 'upstream router');
  for (const capability of ['al-code-review', 'al-plan-guidance', 'al-knowledge']) {
    await fs.mkdir(path.join(root, 'skills', capability));
    await fs.writeFile(path.join(root, 'skills', capability, 'SKILL.md'), 'upstream skill');
  }
}

function adapter(home, agent = '.agents', capability = 'al-code-review') {
  return path.join(home, agent, 'skills', `bcdevtoolset-${capability}`, 'SKILL.md');
}

test('initialization clones with argument arrays and registers every public skill for all agents', async t => {
  const { root, home, calls, manager } = await fixture(t);
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'ready');
  assert.equal(status.commit, 'fixture-commit');
  assert.equal(status.adapters.length, 9);
  assert.deepEqual(calls[0], ['clone', '--', 'https://github.com/microsoft/BCQuality.git', root]);
  assert.ok(calls.some(args => args.join(' ').endsWith('pull --ff-only origin main')));
  for (const agent of ['.copilot', '.agents', '.claude']) {
    const text = await fs.readFile(adapter(home, agent), 'utf8');
    assert.match(text, /name: bcdevtoolset-al-code-review/);
    assert.ok(text.includes(JSON.stringify(root)));
    assert.match(text, /skills\/al-code-review\/SKILL.md/);
    assert.match(text, /do not derive it from this adapter/);
    assert.match(text, /registration does not grant filesystem permissions/);
  }
  assert.equal(await fs.readFile(path.join(root, 'skills', 'entry.md'), 'utf8'), 'upstream router');
});

test('each reload updates an existing clean checkout without cloning again', async t => {
  const { root, calls, manager } = await fixture(t);
  await manager.reconcile(root);
  await manager.reconcile(root);
  assert.equal(calls.filter(args => args[0] === 'clone').length, 1);
  assert.equal(calls.filter(args => args.includes('pull')).length, 2);
});

test('offline and non-fast-forward updates preserve usable content and register adapters', async t => {
  for (const pullError of ['Network unreachable', 'Not possible to fast-forward']) {
    const { root, manager } = await fixture(t, { pullError });
    const status = await manager.reconcile(root);
    assert.equal(status.state, 'warning');
    assert.equal(status.adapters.length, 9);
    assert.ok(status.warnings.some(message => message.includes(pullError)));
  }
});

test('local edits and a pinned checkout are never pulled or reset', async t => {
  for (const options of [{ dirty: ' M custom/knowledge.md' }, { branch: '' }, { branch: 'my-local-branch' }]) {
    const { root, calls, manager } = await fixture(t, options);
    assert.equal((await manager.reconcile(root)).state, 'warning');
    assert.ok(!calls.some(args => args.includes('pull')));
    assert.ok(!calls.some(args => args.includes('reset') || args.includes('checkout')));
  }
});

test('unrelated repos and nested project directories are rejected before update or registration', async t => {
  for (const options of [{ remote: 'https://github.com/other/repo.git' }, { top: os.tmpdir() }]) {
    const { root, calls, home, manager } = await fixture(t, options);
    const status = await manager.reconcile(root);
    assert.equal(status.state, 'error');
    assert.ok(!calls.some(args => args.includes('pull')));
    await assert.rejects(fs.stat(adapter(home)), { code: 'ENOENT' });
  }
});

test('a nonempty non-repository directory is not cloned into', async t => {
  const { root, calls, manager } = await fixture(t);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'keep.txt'), 'user content');
  manager.git = async args => { calls.push(args); throw new Error('not a git repository'); };
  assert.equal((await manager.reconcile(root)).state, 'error');
  assert.ok(!calls.some(args => args[0] === 'clone'));
  assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'user content');
});

test('invalid paths fail at the boundary and do not invoke Git', async t => {
  const { manager, calls } = await fixture(t);
  for (const value of ['relative/path', path.parse(os.tmpdir()).root, '/tmp/bad\npath', '/tmp/bad`path']) {
    assert.throws(() => validateClonePath(value));
    assert.equal((await manager.reconcile(value)).state, 'error');
  }
  assert.equal(calls.length, 0);
});

test('clearing the path removes only unchanged managed adapters and retains the checkout', async t => {
  const { root, home, manager } = await fixture(t);
  await manager.reconcile(root);
  const edited = adapter(home, '.claude');
  await fs.appendFile(edited, '\nUser customization');
  const extra = path.join(path.dirname(adapter(home, '.copilot')), 'my-notes.txt');
  await fs.writeFile(extra, 'keep');
  const status = await manager.reconcile('');
  assert.equal(status.state, 'disabled');
  assert.ok(status.warnings.some(message => message.includes('modified')));
  await assert.rejects(fs.stat(adapter(home)), { code: 'ENOENT' });
  assert.match(await fs.readFile(edited, 'utf8'), /User customization/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'keep');
  assert.ok((await fs.stat(path.join(root, 'plugin.json'))).isFile());
  // Cleanup also works after an extension reload when in-memory state is lost.
  const fresh = new BcQualityIntegration({ homeDirectory: home });
  assert.equal((await fresh.reconcile('')).state, 'disabled');
});

test('opt-out after reload cleans adapters and a never-enabled installation creates no files', async t => {
  const { root, home, manager } = await fixture(t);
  await manager.reconcile('');
  assert.deepEqual(await fs.readdir(home), []);
  await manager.reconcile(root);
  const fresh = new BcQualityIntegration({ homeDirectory: home });
  await fresh.reconcile('');
  await assert.rejects(fs.stat(adapter(home)), { code: 'ENOENT' });
});

test('changing paths refreshes managed wrappers while user-owned collisions are preserved', async t => {
  const { root, home, manager } = await fixture(t);
  const collision = adapter(home, '.claude', 'al-knowledge');
  await fs.mkdir(path.dirname(collision), { recursive: true });
  await fs.writeFile(collision, 'my skill');
  await manager.reconcile(root);
  const nextRoot = path.join(path.dirname(root), 'second checkout');
  await content(nextRoot);
  manager.git = async args => args.includes('--show-toplevel') ? nextRoot
    : args.includes('get-url') ? 'git@github.com:microsoft/BCQuality.git'
      : args.includes('--show-current') ? 'main' : '';
  const status = await manager.reconcile(nextRoot);
  assert.equal(status.state, 'warning');
  assert.ok((await fs.readFile(adapter(home), 'utf8')).includes(JSON.stringify(nextRoot)));
  assert.equal(await fs.readFile(collision, 'utf8'), 'my skill');
});

test('absent optional upstream capabilities are not advertised and obsolete adapters are removed', async t => {
  const { root, home, manager } = await fixture(t);
  await manager.reconcile(root);
  await fs.rm(path.join(root, 'skills', 'al-knowledge'), { recursive: true });
  assert.equal((await manager.reconcile(root)).adapters.length, 6);
  await assert.rejects(fs.stat(adapter(home, '.agents', 'al-knowledge')), { code: 'ENOENT' });
});

test('two windows cannot update the checkout or adapters concurrently and release locks on failure', async t => {
  const { root, home, calls, manager } = await fixture(t);
  await manager.reconcile(root);
  const lockFile = path.join(home, '.bcdevtoolset', 'bcquality.lock');
  const release = await acquireLock(lockFile);
  const count = calls.length;
  assert.equal((await manager.reconcile(root)).state, 'busy');
  assert.equal(calls.length, count);
  await release();
  const cloneRelease = await acquireLock(`${root}.bcdevtoolset.lock`);
  assert.equal((await manager.reconcile(root)).state, 'error');
  await cloneRelease();
  assert.equal((await manager.reconcile(root)).state, 'ready');
});

test('stale process locks are reclaimed without evicting live owners', async t => {
  const { home } = await fixture(t);
  const lock = path.join(home, 'fixture.lock');
  const execute = promisify(execFile);
  const { stdout } = await execute(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  await fs.writeFile(lock, JSON.stringify({ pid: Number(stdout) }));
  const unlock = await acquireLock(lock);
  assert.equal(typeof unlock, 'function');
  assert.equal(await acquireLock(lock), undefined);
  await unlock();
});

test('agent directory junctions cannot redirect adapter writes outside the selected home', async t => {
  const { root, home, temporary, manager } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(home, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'warning');
  assert.deepEqual(await fs.readdir(outside), []);
  assert.ok(status.warnings.some(message => message.includes('symlink')));
  const disabled = await manager.reconcile('');
  assert.equal(disabled.state, 'disabled');
  await assert.rejects(fs.stat(adapter(home, '.copilot')), { code: 'ENOENT' });
});

test('setting is machine-scoped, commands are contributed, and development activation never touches personal files', async () => {
  const pkg = require('../package.json');
  const properties = Object.assign({}, ...pkg.contributes.configuration.map(group => group.properties));
  assert.equal(properties['bcDevToolset.bcQualityPath'].scope, 'machine');
  assert.equal(properties['bcDevToolset.bcQualityPath'].default, '');
  const commands = new Map();
  let listener;
  let displayed;
  const disposable = { dispose() {} };
  const vscode = {
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable; } },
    workspace: {
      onDidChangeConfiguration: callback => { listener = callback; return disposable; },
      openTextDocument: async document => document
    },
    window: { showTextDocument: async document => { displayed = document; } }
  };
  const integration = registerBcQualityIntegration(vscode, { subscriptions: [] }, {
    getPath() { assert.fail('Development host read the production clone setting'); },
    isDevelopment: () => true,
    log() {}
  });
  assert.equal(integration.status.state, 'skipped');
  listener({ affectsConfiguration: () => true });
  for (const name of ['bcDevToolset.updateBcQuality', 'bcDevToolset.showBcQualityStatus']) {
    assert.ok(pkg.contributes.commands.some(command => command.command === name));
    assert.ok(pkg.activationEvents.includes(`onCommand:${name}`));
    await commands.get(name)();
  }
  assert.equal(JSON.parse(displayed.content).state, 'skipped');
});

test('production lifecycle starts maintenance, responds to path changes, and exposes the latest status', async () => {
  const calls = [];
  const commands = new Map();
  let configured = 'first checkout';
  let listener;
  let displayed;
  class FakeIntegration {
    constructor() { this.status = {}; }
    async reconcile(value) { calls.push(value); this.status = { path: value }; return this.status; }
  }
  const register = vm.runInNewContext(`(${registerBcQualityIntegration.toString()})`, { BcQualityIntegration: FakeIntegration });
  const disposable = { dispose() {} };
  register({
    commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable; } },
    workspace: {
      onDidChangeConfiguration(callback) { listener = callback; return disposable; },
      openTextDocument: async document => document
    },
    window: { showTextDocument: async document => { displayed = JSON.parse(document.content); } }
  }, { subscriptions: [] }, { getPath: () => configured, log() {}, isDevelopment: () => false });
  assert.deepEqual(calls, ['first checkout']);
  configured = 'second checkout';
  listener({ affectsConfiguration: () => false });
  assert.equal(calls.length, 1);
  listener({ affectsConfiguration: name => name === 'bcDevToolset.bcQualityPath' });
  assert.deepEqual(calls, ['first checkout', 'second checkout']);
  await commands.get('bcDevToolset.updateBcQuality')();
  assert.equal(displayed.path, 'second checkout');
  configured = '';
  listener({ affectsConfiguration: () => true });
  assert.equal(calls.at(-1), '');
});
