'use strict';

const assert = require('node:assert/strict');
const nativeFs = require('node:fs/promises');
const { BcQualityFiles } = require('../bcquality-files');
const { authorizeRoot, assertWithinRoot, resolveWithinRoot } = require('../path-security');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { BcQualityIntegration, validateClonePath, acquireLock } = require('../bcquality-integration');
const { registerBcQualityIntegration } = require('../bcquality-vscode');

async function fixture(t, options = {}) {
  const tempRoot = authorizeRoot(os.tmpdir(), 'Temporary fixture parent');
  const prefix = resolveWithinRoot(tempRoot, 'bcquality-test-');
  // Fixed prefix is confined to the explicitly authorized OS temporary directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
  const temporary = assertWithinRoot(tempRoot, await nativeFs.mkdtemp(prefix)); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const files = new BcQualityFiles(temporary);
  t.after(() => files.rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home');
  const root = path.join(temporary, 'knowledge with spaces');
  await files.mkdir(home);
  const calls = [];
  const git = async args => {
    calls.push(args);
    if (args[0] === 'clone') {
      await content(root, files);
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
  return { temporary, home, root, calls, manager, files };
}

async function content(root, files) {
  await files.mkdir(path.join(root, 'skills'), { recursive: true });
  await files.writeFile(path.join(root, 'plugin.json'), '{"name":"bcquality"}');
  await files.writeFile(path.join(root, 'skills', 'entry.md'), 'upstream router');
  for (const capability of ['al-code-review', 'al-plan-guidance', 'al-knowledge']) {
    await files.mkdir(path.join(root, 'skills', capability));
    await files.writeFile(path.join(root, 'skills', capability, 'SKILL.md'), 'upstream skill');
  }
}

function adapter(home, agent = '.agents', capability = 'bcquality') {
  return path.join(home, agent, 'skills', `bcdevtoolset-${capability}`, 'SKILL.md');
}

test('initialization registers one complete BCQuality source for each agent', async t => {
  const { root, home, calls, manager, files } = await fixture(t);
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'ready');
  assert.equal(status.commit, 'fixture-commit');
  assert.equal(status.adapters.length, 3);
  assert.deepEqual(calls[0], ['clone', '--', 'https://github.com/microsoft/BCQuality.git', root]);
  assert.ok(calls.some(args => args.join(' ').endsWith('pull --ff-only origin main')));
  for (const agent of ['.copilot', '.agents', '.claude']) {
    const text = await files.readFile(adapter(home, agent), 'utf8');
    assert.match(text, /name: bcdevtoolset-bcquality/);
    assert.ok(text.includes(JSON.stringify(root)));
    assert.match(text, /skills\/entry.md/);
    assert.match(text, /do not derive it from this adapter/);
    assert.match(text, /registration does not grant filesystem permissions/);
  }
  assert.equal(await files.readFile(path.join(root, 'skills', 'entry.md'), 'utf8'), 'upstream router');
});

test('each reload updates an existing clean checkout without cloning again', async t => {
  const { root, calls, manager, files } = await fixture(t);
  await manager.reconcile(root);
  await manager.reconcile(root);
  assert.equal(calls.filter(args => args[0] === 'clone').length, 1);
  assert.equal(calls.filter(args => args.includes('pull')).length, 2);
});

test('offline and non-fast-forward updates preserve usable content and register adapters', async t => {
  for (const pullError of ['Network unreachable', 'Not possible to fast-forward']) {
    const { root, manager, files } = await fixture(t, { pullError });
    const status = await manager.reconcile(root);
    assert.equal(status.state, 'warning');
    assert.equal(status.adapters.length, 3);
    assert.ok(status.warnings.some(message => message.includes('fast-forward update failed')));
    assert.equal(status.updateFailed, true);
    assert.equal(status.lastSuccess, undefined);
    assert.equal(status.sideEffects, 'unknown');
    assert.ok(!status.warnings.some(message => message.includes(pullError)));
  }
});

test('local edits and a pinned checkout are never pulled or reset', async t => {
  for (const options of [{ dirty: ' M custom/knowledge.md' }, { branch: '' }, { branch: 'my-local-branch' }]) {
    const { root, calls, manager, files } = await fixture(t, options);
    assert.equal((await manager.reconcile(root)).state, 'warning');
    assert.ok(!calls.some(args => args.includes('pull')));
    assert.ok(!calls.some(args => args.includes('reset') || args.includes('checkout')));
  }
});

test('unrelated repos and nested project directories are rejected before update or registration', async t => {
  for (const options of [{ remote: 'https://github.com/other/repo.git' }, { top: os.tmpdir() }]) {
    const { root, calls, home, manager, files } = await fixture(t, options);
    const status = await manager.reconcile(root);
    assert.equal(status.state, 'error');
    assert.ok(!calls.some(args => args.includes('pull')));
    await assert.rejects(files.stat(adapter(home)), { code: 'ENOENT' });
  }
});

test('a nonempty non-repository directory is not cloned into', async t => {
  const { root, calls, manager, files } = await fixture(t);
  await files.mkdir(root);
  await files.writeFile(path.join(root, 'keep.txt'), 'user content');
  manager.git = async args => { calls.push(args); throw new Error('not a git repository'); };
  assert.equal((await manager.reconcile(root)).state, 'error');
  assert.ok(!calls.some(args => args[0] === 'clone'));
  assert.equal(await files.readFile(path.join(root, 'keep.txt'), 'utf8'), 'user content');
});

test('invalid paths fail at the boundary and do not invoke Git', async t => {
  const { manager, calls, files } = await fixture(t);
  for (const value of ['relative/path', path.parse(os.tmpdir()).root, '/tmp/bad\npath', '/tmp/bad`path', '/tmp/bad\u0000path', '/tmp/bad\tpath']) {
    assert.throws(() => validateClonePath(value));
    assert.equal((await manager.reconcile(value)).state, 'error');
  }
  assert.equal(calls.length, 0);
});

test('clearing the path removes only unchanged managed adapters and retains the checkout', async t => {
  const { root, home, manager, files } = await fixture(t);
  await manager.reconcile(root);
  const edited = adapter(home, '.claude');
  await files.appendFile(edited, '\nUser customization');
  const extra = path.join(path.dirname(adapter(home, '.copilot')), 'my-notes.txt');
  await files.writeFile(extra, 'keep');
  const status = await manager.reconcile('');
  assert.equal(status.state, 'warning');
  assert.ok(status.warnings.some(message => message.includes('modified')));
  await assert.rejects(files.stat(adapter(home)), { code: 'ENOENT' });
  assert.match(await files.readFile(edited, 'utf8'), /User customization/);
  assert.equal(await files.readFile(extra, 'utf8'), 'keep');
  assert.ok((await files.stat(path.join(root, 'plugin.json'))).isFile());
  // Cleanup also works after an extension reload when in-memory state is lost.
  const fresh = new BcQualityIntegration({ homeDirectory: home });
  assert.equal((await fresh.reconcile('')).state, 'warning');
});

test('opt-out after reload cleans adapters and a never-enabled installation creates no files', async t => {
  const { root, home, manager, files } = await fixture(t);
  await manager.reconcile('');
  assert.deepEqual(await files.readdir(home), []);
  await manager.reconcile(root);
  const fresh = new BcQualityIntegration({ homeDirectory: home });
  await fresh.reconcile('');
  await assert.rejects(files.stat(adapter(home)), { code: 'ENOENT' });
});

test('changing paths refreshes managed wrappers while user-owned collisions are preserved', async t => {
  const { root, home, manager, files } = await fixture(t);
  const collision = adapter(home, '.claude');
  await files.mkdir(path.dirname(collision), { recursive: true });
  await files.writeFile(collision, 'my skill');
  await manager.reconcile(root);
  const nextRoot = path.join(path.dirname(root), 'second checkout');
  await content(nextRoot, files);
  manager.git = async args => args.includes('--show-toplevel') ? nextRoot
    : args.includes('get-url') ? 'git@github.com:microsoft/BCQuality.git'
      : args.includes('--show-current') ? 'main' : '';
  const status = await manager.reconcile(nextRoot);
  assert.equal(status.state, 'warning');
  assert.ok((await files.readFile(adapter(home), 'utf8')).includes(JSON.stringify(nextRoot)));
  assert.equal(await files.readFile(collision, 'utf8'), 'my skill');
});

test('native skill additions and removals never generate per-skill adapters', async t => {
  const { root, home, manager, files } = await fixture(t);
  await manager.reconcile(root);
  const before = await files.readFile(adapter(home), 'utf8');
  await files.rm(path.join(root, 'skills', 'al-knowledge'), { recursive: true });
  for (let number = 0; number < 120; number++) {
    const directory = resolveWithinRoot(root, 'skills', `new-${number}`);
    await files.mkdir(directory);
    await files.writeFile(resolveWithinRoot(directory, 'SKILL.md'), 'new upstream skill');
  }
  assert.equal((await manager.reconcile(root)).adapters.length, 3);
  assert.deepEqual(await files.readdir(resolveWithinRoot(home, '.agents', 'skills')), ['bcdevtoolset-bcquality']);
  assert.equal(await files.readFile(adapter(home), 'utf8'), before);
  assert.match(before, /all applicable skills discovered by Entry/);
  assert.match(before, /no-match or failed/);
  assert.match(before, /exact dispatched input subsets/);
  assert.match(before, /Preparation/);
});

async function legacy(files, home, agent = '.agents', capability = 'al-code-review') {
  const skill = adapter(home, agent, capability);
  const directory = path.dirname(skill);
  const text = `legacy ${capability}`;
  await files.mkdir(directory, { recursive: true });
  await files.writeFile(skill, text);
  await files.writeFile(resolveWithinRoot(directory, '.bcdevtoolset-owner.json'), JSON.stringify({
    owner: 'bc-dev-toolset/bcquality', sha256: crypto.createHash('sha256').update(text).digest('hex')
  }));
  return skill;
}

test('migration removes unchanged legacy redirects after publishing the source and preserves user content', async t => {
  const { root, home, manager, files } = await fixture(t);
  const old = await legacy(files, home);
  const notes = resolveWithinRoot(path.dirname(old), 'notes.txt');
  await files.writeFile(notes, 'keep notes');
  const modified = await legacy(files, home, '.agents', 'al-plan-guidance');
  await files.appendFile(modified, ' customization');
  const unowned = adapter(home, '.agents', 'al-knowledge');
  await files.mkdir(path.dirname(unowned), { recursive: true });
  await files.writeFile(unowned, 'user content');
  const sourceWrite = manager.files.writeFile.bind(manager.files);
  manager.files.writeFile = async (candidate, text) => {
    if (candidate === adapter(home)) assert.equal(await files.readFile(old, 'utf8'), 'legacy al-code-review');
    return sourceWrite(candidate, text);
  };
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'warning');
  assert.equal(status.adapters.length, 3);
  await assert.rejects(files.lstat(old), { code: 'ENOENT' });
  assert.equal(await files.readFile(notes, 'utf8'), 'keep notes');
  assert.match(await files.readFile(modified, 'utf8'), /customization/);
  assert.equal(await files.readFile(unowned, 'utf8'), 'user content');
});

test('source collision preserves legacy discovery and reports remediation', async t => {
  const { root, home, manager, files } = await fixture(t);
  const old = await legacy(files, home);
  const source = adapter(home);
  await files.mkdir(path.dirname(source), { recursive: true });
  await files.writeFile(source, 'user source');
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'warning');
  assert.match(status.warnings.join(' '), /Resolve the collision manually/);
  assert.equal(await files.readFile(old, 'utf8'), 'legacy al-code-review');
  assert.equal(await files.readFile(source, 'utf8'), 'user source');
});

test('source write failures retain legacy redirects, fail safely and release locks', async t => {
  const { root, home, manager, files } = await fixture(t);
  const old = await legacy(files, home, '.copilot');
  manager.files.writeFile = async () => { throw Object.assign(new Error('secret backend payload'), { code: 'EACCES' }); };
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'error');
  assert.match(status.error, /source adapter registration and migration failed.*EACCES/);
  assert.match(status.error, /Access was denied/);
  assert.match(status.error, /Show BCQuality Status/);
  assert.ok(!JSON.stringify(status).includes('secret backend payload'));
  assert.equal(status.lastSuccess, undefined);
  assert.equal(await files.readFile(old, 'utf8'), 'legacy al-code-review');
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'bcquality.lock')), { code: 'ENOENT' });
  await assert.rejects(files.lstat(`${root}.bcdevtoolset.lock`), { code: 'ENOENT' });
});

test('missing, directory and empty source entries fail before migration and release locks', async t => {
  for (const mode of ['missing', 'directory', 'empty']) {
    const { root, home, manager, files, calls } = await fixture(t);
    await content(root, files);
    const entry = resolveWithinRoot(root, 'skills', 'entry.md');
    await files.unlink(entry);
    if (mode === 'directory') await files.mkdir(entry);
    if (mode === 'empty') await files.writeFile(entry, '  \n');
    const old = await legacy(files, home);
    const status = await manager.reconcile(root);
    assert.equal(status.state, 'error');
    assert.match(status.error, /skills\/entry.md/);
    assert.match(status.error, /Restore|restore/);
    assert.equal(status.lastSuccess, undefined);
    assert.ok(!calls.some(args => args.includes('pull')));
    assert.equal(await files.readFile(old, 'utf8'), 'legacy al-code-review');
    await assert.rejects(files.lstat(adapter(home)), { code: 'ENOENT' });
    await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'bcquality.lock')), { code: 'ENOENT' });
  }
});

test('entry read errors preserve safe cause, stop migration and release locks', async t => {
  const { root, home, manager, files } = await fixture(t);
  await content(root, files);
  const old = await legacy(files, home);
  const read = BcQualityFiles.prototype.readFile;
  BcQualityFiles.prototype.readFile = async function(candidate, encoding) {
    if (candidate === resolveWithinRoot(root, 'skills', 'entry.md')) throw Object.assign(new Error('secret payload'), { code: 'EACCES' });
    return read.call(this, candidate, encoding);
  };
  let status;
  try { status = await manager.reconcile(root); }
  finally { BcQualityFiles.prototype.readFile = read; }
  assert.equal(status.state, 'error');
  assert.match(status.error, /EACCES.*Access was denied/);
  assert.match(status.error, /Show BCQuality Status/);
  assert.ok(!status.error.includes('secret payload'));
  assert.equal(await files.readFile(old, 'utf8'), 'legacy al-code-review');
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'bcquality.lock')), { code: 'ENOENT' });
});

test('linked source entry points are rejected without following the target or migrating legacy', async t => {
  const { root, home, temporary, manager, files } = await fixture(t);
  await content(root, files);
  const entry = resolveWithinRoot(root, 'skills', 'entry.md');
  const target = resolveWithinRoot(temporary, 'external-router.md');
  await files.writeFile(target, 'external router');
  await files.unlink(entry);
  // Link and target are confined to this test's owned temporary directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are contained in the fixture above.
  try { await nativeFs.symlink(target, entry, 'file'); } // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  catch (error) { if (error.code === 'EPERM') { t.skip('File symlinks unavailable'); return; } throw error; }
  const old = await legacy(files, home);
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'error');
  assert.match(status.error, /non-symlink skills\/entry.md/);
  assert.equal(await files.readFile(target, 'utf8'), 'external router');
  assert.equal(await files.readFile(old, 'utf8'), 'legacy al-code-review');
  await assert.rejects(files.lstat(adapter(home)), { code: 'ENOENT' });
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'bcquality.lock')), { code: 'ENOENT' });
});

test('linked source skills directory is rejected with actionable diagnostics', async t => {
  const { root, home, temporary, manager, files } = await fixture(t);
  await content(root, files);
  await files.rm(resolveWithinRoot(root, 'skills'), { recursive: true });
  const target = resolveWithinRoot(temporary, 'external-skills');
  await files.mkdir(target);
  await files.writeFile(resolveWithinRoot(target, 'entry.md'), 'external router');
  const link = resolveWithinRoot(root, 'skills');
  // Link and target are confined to this test's owned temporary directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are contained in the fixture above.
  await nativeFs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'error');
  assert.match(status.error, /non-symlink skills directory/);
  assert.match(status.error, /Restore it/);
  await assert.rejects(files.lstat(adapter(home)), { code: 'ENOENT' });
});

test('lock cleanup failure preserves failed status and removes the success timestamp', async t => {
  const { root, home, manager } = await fixture(t);
  const unlink = manager.files.unlink.bind(manager.files);
  manager.files.unlink = async candidate => {
    if (candidate === resolveWithinRoot(home, '.bcdevtoolset', 'bcquality.lock')) throw Object.assign(new Error('secret cleanup payload'), { code: 'EACCES' });
    return unlink(candidate);
  };
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'error');
  assert.match(status.error, /maintenance lock cleanup failed.*EACCES/);
  assert.equal(status.lastSuccess, undefined);
  assert.equal(status.sideEffects, 'partially-completed');
  assert.ok(!JSON.stringify(status).includes('secret cleanup payload'));
});

test('two windows cannot update the checkout or adapters concurrently and release locks on failure', async t => {
  const { root, home, calls, manager, files } = await fixture(t);
  await manager.reconcile(root);
  const lockFile = path.join(home, '.bcdevtoolset', 'bcquality.lock');
  const release = await acquireLock(files, lockFile);
  const count = calls.length;
  assert.equal((await manager.reconcile(root)).state, 'busy');
  assert.equal(calls.length, count);
  await release();
  const cloneRelease = await acquireLock(files, `${root}.bcdevtoolset.lock`);
  assert.equal((await manager.reconcile(root)).state, 'error');
  await cloneRelease();
  assert.equal((await manager.reconcile(root)).state, 'ready');
});

test('stale process locks are reclaimed without evicting live owners', async t => {
  const { home, files } = await fixture(t);
  const lock = path.join(home, 'fixture.lock');
  const execute = promisify(execFile);
  const { stdout } = await execute(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  await files.writeFile(lock, JSON.stringify({ pid: Number(stdout) }));
  const unlock = await acquireLock(files, lock);
  assert.equal(typeof unlock, 'function');
  assert.equal(await acquireLock(files, lock), undefined);
  await unlock();
});

test('abandoned recovery locks are reclaimed with only one concurrent winner', async t => {
  const { home, files } = await fixture(t);
  const lock = path.join(home, 'fixture.lock');
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadOwner = JSON.stringify({ pid: Number(stdout) });
  for (const suffix of ['', '.recovery', '.recovery.recovery']) {
    await files.writeFile(`${lock}${suffix}`, deadOwner);
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(files, lock)));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(JSON.parse(await files.readFile(lock, 'utf8')).pid, process.pid);
  assert.equal(await acquireLock(files, lock), undefined);
  await winners[0]();
  assert.deepEqual(await files.readdir(home), []);
});

test('live recovery owners block reclamation of a dead primary owner', async t => {
  const { home, files } = await fixture(t);
  const lock = path.join(home, 'fixture.lock');
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadOwner = JSON.stringify({ pid: Number(stdout) });
  await files.writeFile(lock, deadOwner);
  const releaseRecovery = await acquireLock(files, `${lock}.recovery`);
  assert.equal(await acquireLock(files, lock), undefined);
  assert.equal(await files.readFile(lock, 'utf8'), deadOwner);
  await releaseRecovery();
  const release = await acquireLock(files, lock);
  assert.equal(typeof release, 'function');
  await release();
});

test('Windows recovery read contention leaves locks untouched and permits a later retry', {
  skip: process.platform !== 'win32'
}, async t => {
  const { home, files } = await fixture(t);
  const lock = path.join(home, 'fixture.lock');
  const recovery = `${lock}.recovery`;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadOwner = JSON.stringify({ pid: Number(stdout) });
  await files.writeFile(lock, deadOwner);
  await files.writeFile(recovery, deadOwner);
  const readFile = files.readFile.bind(files);
  for (const code of ['EPERM', 'EACCES']) {
    files.readFile = async (candidate, encoding) => {
      if (candidate === recovery) throw Object.assign(new Error('Lock is being deleted'), { code });
      return readFile(candidate, encoding);
    };
    assert.equal(await acquireLock(files, lock), undefined);
    assert.equal(await readFile(lock, 'utf8'), deadOwner);
    assert.equal(await readFile(recovery, 'utf8'), deadOwner);
  }
  files.readFile = readFile;
  const release = await acquireLock(files, lock);
  assert.equal(typeof release, 'function');
  await release();
  assert.deepEqual(await files.readdir(home), []);
});

test('legacy empty recovery locks wait for initialization then become reclaimable', async t => {
  const { home, files } = await fixture(t);
  const lock = path.join(home, 'fixture.lock');
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  await files.writeFile(lock, JSON.stringify({ pid: Number(stdout) }));
  const recovery = resolveWithinRoot(home, 'fixture.lock.recovery');
  await files.writeFile(recovery, '');
  assert.equal(await acquireLock(files, lock), undefined);
  const validatedRecovery = await files.checked(recovery);
  const old = new Date(Date.now() - 180000);
  // The recovery file is contained in this test's authorized temporary fixture.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked enforces containment and rejects symlinks above.
  await nativeFs.utimes(validatedRecovery, old, old); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const release = await acquireLock(files, lock);
  assert.equal(typeof release, 'function');
  await release();
  assert.deepEqual(await files.readdir(home), []);
});

test('lock publication exposes complete ownership and cleans up after failures', async t => {
  const { home, files } = await fixture(t);
  const lock = path.join(home, 'fixture.lock');
  const link = files.link.bind(files);
  files.link = async (source, destination) => {
    assert.equal(JSON.parse(await files.readFile(source, 'utf8')).pid, process.pid);
    await assert.rejects(files.lstat(destination), { code: 'ENOENT' });
    throw new Error('publication failed');
  };
  await assert.rejects(acquireLock(files, lock), /publication failed/);
  assert.deepEqual(await files.readdir(home), []);
  files.link = link;
  const release = await acquireLock(files, lock);
  await release();
});

test('agent directory junctions cannot redirect adapter writes outside the selected home', async t => {
  const { root, home, temporary, manager, files } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  await files.mkdir(outside);
  const link = resolveWithinRoot(home, '.agents');
  const target = assertWithinRoot(temporary, outside);
  // Both link and target are inside this test's owned temporary fixture.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
  await nativeFs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'warning');
  assert.deepEqual(await files.readdir(outside), []);
  assert.ok(status.warnings.some(message => message.includes('symlink')));
  const disabled = await manager.reconcile('');
  assert.equal(disabled.state, 'warning');
  await assert.rejects(files.stat(adapter(home, '.copilot')), { code: 'ENOENT' });
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

test('every filesystem operation rejects relative traversal and absolute paths outside its authorization root', async t => {
  const { home, temporary, files: fixtureFiles } = await fixture(t);
  const files = new BcQualityFiles(home);
  const outside = path.join(temporary, 'outside.txt');
  await fixtureFiles.writeFile(outside, 'preserve outside content');
  for (const candidate of [outside, path.join(home, '..', 'outside.txt')]) {
    const attempts = [
      () => files.lstat(candidate), () => files.stat(candidate), () => files.open(candidate, 'wx'),
      () => files.mkdir(candidate), () => files.readdir(candidate), () => files.readFile(candidate, 'utf8'),
      () => files.writeFile(candidate, 'overwrite'), () => files.appendFile(candidate, 'append'),
      () => files.unlink(candidate), () => files.rmdir(candidate), () => files.rm(candidate, { recursive: true }),
      () => files.link(candidate, path.join(home, 'copy.txt')),
      () => files.link(path.join(home, 'copy.txt'), candidate),
      () => acquireLock(files, candidate)
    ];
    for (const attempt of attempts) await assert.rejects(attempt(), /escapes its authorized root/);
  }
  assert.equal(await fixtureFiles.readFile(outside, 'utf8'), 'preserve outside content');
});

test('filesystem reads, writes, cleanup, and lock creation reject nested directory links', async t => {
  const { home, temporary, files: fixtureFiles } = await fixture(t);
  const target = resolveWithinRoot(temporary, 'external-content');
  await fixtureFiles.mkdir(target);
  const marker = resolveWithinRoot(target, 'marker.txt');
  await fixtureFiles.writeFile(marker, 'preserve external content');
  const link = resolveWithinRoot(home, 'linked');
  // The malicious link and target are both confined to this test's owned fixture.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
  await nativeFs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const files = new BcQualityFiles(home);
  const throughLink = resolveWithinRoot(link, 'marker.txt');
  for (const attempt of [() => files.readFile(throughLink), () => files.writeFile(throughLink, 'overwrite'),
    () => files.link(throughLink, path.join(home, 'copy.txt')),
    () => files.link(path.join(home, 'copy.txt'), throughLink),
    () => files.rm(throughLink), () => acquireLock(files, throughLink)]) {
    await assert.rejects(attempt(), /symlink/);
  }
  assert.equal(await fixtureFiles.readFile(marker, 'utf8'), 'preserve external content');
});


test('Update BCQuality returns a failed result for errors, busy locks and failed refreshes', async () => {
  for (const status of [
    { state: 'error', error: 'safe failure', sideEffects: 'not-started' },
    { state: 'busy', error: 'retry later', sideEffects: 'partially-completed' },
    { state: 'warning', updateFailed: true, warnings: ['BCQuality: fast-forward update failed. Retry Update BCQuality.'], sideEffects: 'unknown' }
  ]) {
    const commands = new Map();
    const errors = [];
    class FakeIntegration {
      constructor() { this.status = status; }
      async reconcile() { return this.status; }
    }
    const register = vm.runInNewContext(`(${registerBcQualityIntegration.toString()})`, { BcQualityIntegration: FakeIntegration });
    const disposable = { dispose() {} };
    register({
      commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable; } },
      workspace: { onDidChangeConfiguration() { return disposable; }, openTextDocument: async document => document },
      window: { showTextDocument: async () => {}, showErrorMessage: async message => errors.push(message) }
    }, { subscriptions: [] }, { getPath: () => 'checkout', log() {}, isDevelopment: () => false });
    assert.equal(await commands.get('bcDevToolset.updateBcQuality')(), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /safe failure|retry later|fast-forward update failed/);
  }
});


test('Show BCQuality Status reports display failure safely without starting maintenance', async () => {
  const commands = new Map();
  const errors = [];
  let maintenance = 0;
  class FakeIntegration {
    constructor() { this.status = { state: 'ready' }; }
    async reconcile() { maintenance++; return this.status; }
  }
  const register = vm.runInNewContext(`(${registerBcQualityIntegration.toString()})`, { BcQualityIntegration: FakeIntegration });
  const disposable = { dispose() {} };
  register({
    commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable; } },
    workspace: { onDidChangeConfiguration() { return disposable; }, openTextDocument: async () => { throw new Error('secret display payload'); } },
    window: { showErrorMessage: async message => errors.push(message) }
  }, { subscriptions: [] }, { getPath: () => 'checkout', log() {}, isDevelopment: () => false });
  const initial = maintenance;
  assert.equal(await commands.get('bcDevToolset.showBcQualityStatus')(), false);
  assert.equal(maintenance, initial);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Show BCQuality Status could not open.*No maintenance.*Reload VS Code/);
  assert.ok(!errors[0].includes('secret display payload'));
  assert.equal(await commands.get('bcDevToolset.updateBcQuality')(), false);
});


test('legacy cleanup failure retains installed source, stops deletion and reports partial effects', async t => {
  const { root, home, manager, files } = await fixture(t);
  const old = await legacy(files, home, '.copilot');
  const later = await legacy(files, home, '.copilot', 'al-plan-guidance');
  const unlink = manager.files.unlink.bind(manager.files);
  manager.files.unlink = async candidate => {
    if (candidate === old) throw Object.assign(new Error('secret cleanup backend'), { code: 'EACCES' });
    return unlink(candidate);
  };
  const status = await manager.reconcile(root);
  assert.equal(status.state, 'error');
  assert.match(status.error, /source adapter registration and migration failed.*EACCES/);
  assert.match(status.error, /Access was denied.*Show BCQuality Status/);
  assert.equal(status.lastSuccess, undefined);
  assert.equal(status.sideEffects, 'partially-completed');
  assert.equal(status.adapters.length, 1);
  assert.match(await files.readFile(adapter(home, '.copilot'), 'utf8'), /skills\/entry.md/);
  assert.equal(await files.readFile(old, 'utf8'), 'legacy al-code-review');
  assert.equal(await files.readFile(later, 'utf8'), 'legacy al-plan-guidance');
  assert.ok(!JSON.stringify(status).includes('secret cleanup backend'));
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'bcquality.lock')), { code: 'ENOENT' });
  await assert.rejects(files.lstat(`${root}.bcdevtoolset.lock`), { code: 'ENOENT' });
});
