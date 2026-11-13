'use strict';

const assert = require('node:assert/strict');
const nativeFs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const crypto = require('node:crypto');
const { BcQualityFiles } = require('../bcquality-files');
const { acquireLock } = require('../bcquality-integration');
const { authorizeRoot, assertWithinRoot, resolveWithinRoot } = require('../path-security');
const { CuratedSkillsIntegration } = require('../curated-skills-integration');

const repositoryUrl = 'https://github.com/example/curated-skills.git';

async function content(files, root, names = ['review', 'planning']) {
  await files.mkdir(resolveWithinRoot(root, '.git'), { recursive: true });
  await files.mkdir(resolveWithinRoot(root, 'skills'), { recursive: true });
  await files.writeFile(resolveWithinRoot(root, 'skills', 'entry.md'), 'Native source router');
  for (const name of names) {
    const directory = resolveWithinRoot(root, 'skills', name);
    await files.mkdir(directory, { recursive: true });
    await files.writeFile(resolveWithinRoot(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Help with ${name}.\n---\n\nUpstream instructions.\n`);
  }
}

async function fixture(t, options = {}) {
  const temporaryParent = authorizeRoot(os.tmpdir(), 'Test temporary directory');
  const prefix = resolveWithinRoot(temporaryParent, 'curated-skills-test-');
  // The temporary prefix is contained by the authorized OS temporary parent.
  const temporary = assertWithinRoot(temporaryParent, await nativeFs.mkdtemp(prefix)); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const files = new BcQualityFiles(temporary);
  t.after(() => files.rm(temporary, { recursive: true, force: true }));
  const home = resolveWithinRoot(temporary, 'home');
  const root = resolveWithinRoot(temporary, 'curated skills');
  await files.mkdir(home);
  const calls = [];
  const git = async args => {
    calls.push(args);
    if (args[0] === 'clone') {
      if (options.cloneError) throw options.cloneError;
      await content(files, root, options.names);
      return '';
    }
    if (args.includes('--show-toplevel')) return options.top || root;
    if (args.includes('get-url')) return options.remote || repositoryUrl;
    if (args.includes('status')) return options.dirty || '';
    if (args.includes('--show-current')) return options.branch === undefined ? 'main' : options.branch;
    if (args.includes('symbolic-ref')) return 'origin/main';
    if (args.includes('pull') && options.pullError) throw options.pullError;
    if (args.includes('HEAD')) return 'fixture-commit';
    return '';
  };
  const logs = [];
  const manager = new CuratedSkillsIntegration({ homeDirectory: home, git, log: value => logs.push(value) });
  const config = { repositoryUrl, path: root };
  return { temporary, files, home, root, calls, manager, config, logs };
}

function adapter(home, name = 'source') {
  return resolveWithinRoot(home, '.agents', 'skills', `bcdevtoolset-curated-${name}`, 'SKILL.md');
}

test('an unconfigured source stays disabled without touching Git or creating personal state', async t => {
  const { manager, calls, files, home } = await fixture(t);
  const status = await manager.reconcile({ repositoryUrl: '', path: '' });
  assert.equal(status.state, 'disabled');
  assert.equal(calls.length, 0);
  assert.deepEqual(await files.readdir(home), []);
});

test('incomplete configuration names both settings and starts no Git or filesystem writes', async t => {
  const { manager, config, calls, files, home } = await fixture(t);
  for (const partial of [{ repositoryUrl, path: '' }, { repositoryUrl: '', path: config.path }]) {
    const status = await manager.reconcile(partial);
    assert.equal(status.state, 'error');
    assert.match(status.error, /curatedSkillsRepositoryUrl/);
    assert.match(status.error, /curatedSkillsPath/);
    assert.equal(status.sideEffects, 'not-started');
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await files.readdir(home), []);
});

test('initialization installs one broad Codex source adapter with native dispatch and composition', async t => {
  const { manager, config, root, home, calls, files } = await fixture(t);
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'ready');
  assert.equal(status.commit, 'fixture-commit');
  assert.equal(status.adapters.length, 1);
  assert.deepEqual(calls[0], ['clone', '--', repositoryUrl, root]);
  const text = await files.readFile(adapter(home), 'utf8');
  assert.match(text, /name: bcdevtoolset-curated-source/);
  assert.ok(text.includes(JSON.stringify(root)));
  for (const expected of ['any task', 'skills/entry.md', 'skills/do.md', 'task-start', 'phase-step', 'governed-by', 'no-match', 'failed', 'authorization', 'approval gates', 'original upstream skill directory', 'permissions']) assert.ok(text.includes(expected), expected);
  for (const other of ['.copilot', '.claude']) await assert.rejects(files.lstat(resolveWithinRoot(home, other)), { code: 'ENOENT' });
  await assert.rejects(files.lstat(adapter(home, 'review')), { code: 'ENOENT' });
});

test('reload updates an existing clean checkout without cloning twice', async t => {
  const { manager, config, calls } = await fixture(t);
  await manager.reconcile(config);
  await manager.reconcile(config);
  assert.equal(calls.filter(args => args[0] === 'clone').length, 1);
  assert.equal(calls.filter(args => args.includes('pull')).length, 2);
  for (const args of calls.filter(args => args.includes('pull'))) assert.ok(args.includes('--ff-only'));
});

test('local edits, non-main branches and detached revisions preserve content without pull/reset', async t => {
  for (const options of [{ dirty: ' M skills/review/SKILL.md' }, { branch: 'feature' }, { branch: '' }]) {
    const { manager, config, calls } = await fixture(t, options);
    const status = await manager.reconcile(config);
    assert.equal(status.state, 'warning');
    assert.notEqual(status.updateFailed, true);
    assert.ok(status.lastSuccess);
    assert.equal(status.adapters.length, 1);
    assert.ok(!calls.some(args => args.some(arg => ['pull', 'reset', 'checkout'].includes(arg))));
  }
});

test('wrong origin and nested checkout paths stop before update or personal skill registration', async t => {
  for (const options of [{ remote: 'https://github.com/other/repository.git' }, { top: os.tmpdir() }]) {
    const { manager, config, calls, home, files } = await fixture(t, options);
    const status = await manager.reconcile(config);
    assert.equal(status.state, 'error');
    assert.ok(!calls.some(args => args.includes('pull')));
    await assert.rejects(files.lstat(adapter(home)), { code: 'ENOENT' });
  }
});

test('unsafe repository URLs and clone paths are rejected before Git use', async t => {
  const { manager, config, calls } = await fixture(t);
  for (const repositoryUrl of ['--upload-pack=evil', 'https://token:secret@github.com/example/skills.git', 'file:///tmp/skills', 'https://github.com/example/skills.git\n--evil']) {
    assert.equal((await manager.reconcile({ ...config, repositoryUrl })).state, 'error');
  }
  for (const value of ['relative', path.parse(os.tmpdir()).root, `${config.path}\ninvalid`, `${config.path}\u0000invalid`]) {
    assert.equal((await manager.reconcile({ ...config, path: value })).state, 'error');
  }
  assert.equal(calls.length, 0);
});

test('an absent repository fails safely, does not advertise adapters and permits later explicit retry', async t => {
  const { manager, config, calls, home, files, logs } = await fixture(t);
  const originalGit = manager.git;
  manager.git = async args => {
    calls.push(args);
    throw Object.assign(new Error('secret token and raw backend payload'), { code: 128 });
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.equal(status.sideEffects, 'unknown');
  assert.equal(status.lastSuccess, undefined);
  assert.equal(status.adapters.length, 0);
  assert.match(status.error, /clone|checkout|repository/i);
  assert.match(status.error, /check|verify|inspect|retry|create/i);
  assert.doesNotMatch(JSON.stringify([status, logs]), /secret token|raw backend payload/);
  assert.equal(calls.length, 1);
  await assert.rejects(files.lstat(adapter(home)), { code: 'ENOENT' });
  manager.git = originalGit;
  assert.equal((await manager.reconcile(config)).state, 'ready');
});

test('failed update retains usable content while redacting backend text and reporting a warning', async t => {
  const { manager, config, files, home, logs } = await fixture(t, { pullError: Object.assign(new Error('credential=secret-backend-payload'), { code: 128 }) });
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'warning');
  assert.equal(status.sideEffects, 'unknown');
  assert.equal(status.updateFailed, true);
  assert.equal(status.lastSuccess, undefined);
  assert.ok(status.warnings.length > 0);
  assert.doesNotMatch(JSON.stringify([status, logs]), /secret-backend-payload/);
  assert.match(await files.readFile(adapter(home), 'utf8'), /skills\/entry.md/);
});

test('failed post-update reconciliation retains the original pull status without claiming cached content is usable', async t => {
  const { manager, config, logs } = await fixture(t);
  const originalGit = manager.git;
  let pullFailed = false;
  manager.git = async args => {
    if (args.includes('pull')) {
      pullFailed = true;
      throw Object.assign(new Error('secret pull payload'), { code: 128 });
    }
    if (pullFailed && args.includes('--show-toplevel')) throw Object.assign(new Error('secret reconciliation payload'), { code: 'EACCES' });
    return originalGit(args);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.equal(status.updateFailed, true);
  assert.equal(status.sideEffects, 'unknown');
  assert.equal(status.lastSuccess, undefined);
  assert.match(status.error, /EACCES/);
  assert.ok(status.warnings.some(message => /fast-forward update failed/.test(message) && /128/.test(message)));
  assert.ok(!status.warnings.some(message => /revalidated and retained/.test(message)));
  assert.doesNotMatch(JSON.stringify([status, logs]), /secret pull|secret reconciliation/);
});

test('an existing checkout can receive its first skills through a fast-forward update', async t => {
  const { manager, config, root, home, files, calls } = await fixture(t);
  await files.mkdir(resolveWithinRoot(root, '.git'), { recursive: true });
  const originalGit = manager.git;
  manager.git = async args => {
    if (args.includes('pull')) await content(files, root);
    return originalGit(args);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'ready');
  assert.ok(calls.some(args => args.includes('pull')));
  assert.ok(!calls.some(args => args[0] === 'clone'));
  assert.match(await files.readFile(adapter(home), 'utf8'), /skills\/entry.md/);
});

test('clearing configuration after reload removes only unchanged owned adapters and preserves checkout and BCQuality', async t => {
  const { manager, config, files, home, root } = await fixture(t);
  const bcQuality = resolveWithinRoot(home, '.agents', 'skills', 'bcdevtoolset-al-code-review', 'SKILL.md');
  await files.mkdir(path.dirname(bcQuality), { recursive: true });
  await files.writeFile(bcQuality, 'BCQuality skill');
  await manager.reconcile(config);
  await seedLegacy(files, home, 'planning');
  await files.appendFile(adapter(home, 'planning'), '\nUser customization');
  const fresh = new CuratedSkillsIntegration({ homeDirectory: home, git: async () => assert.fail('Opt-out invoked Git') });
  const status = await fresh.reconcile({ repositoryUrl: '', path: '' });
  assert.equal(status.state, 'warning');
  assert.match(status.warnings.join(' '), /modified|user-owned/i);
  await assert.rejects(files.lstat(adapter(home)), { code: 'ENOENT' });
  assert.match(await files.readFile(adapter(home, 'planning'), 'utf8'), /User customization/);
  assert.equal(await files.readFile(bcQuality, 'utf8'), 'BCQuality skill');
  assert.ok((await files.stat(root)).isDirectory());
});

test('native additions, removals and metadata changes keep a single source adapter without reading native skills', async t => {
  const { manager, config, files, home, root } = await fixture(t);
  await manager.reconcile(config);
  const before = await files.readFile(adapter(home), 'utf8');
  await files.rm(resolveWithinRoot(root, 'skills', 'planning'), { recursive: true });
  for (let index = 0; index < 105; index++) {
    const directory = resolveWithinRoot(root, 'skills', `new-${index}`);
    await files.mkdir(directory);
    await files.writeFile(resolveWithinRoot(directory, 'SKILL.md'), 'Metadata is evaluated by upstream Entry at invocation.');
  }
  const originalRead = BcQualityFiles.prototype.readFile;
  t.after(() => { BcQualityFiles.prototype.readFile = originalRead; });
  BcQualityFiles.prototype.readFile = async function(candidate, encoding) {
    if (candidate.startsWith(root) && candidate.endsWith('SKILL.md')) assert.fail('Registration must not inspect native skills');
    return originalRead.call(this, candidate, encoding);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'ready');
  assert.equal(status.adapters.length, 1);
  assert.equal(await files.readFile(adapter(home), 'utf8'), before);
  assert.deepEqual(await files.readdir(resolveWithinRoot(home, '.agents', 'skills')), ['bcdevtoolset-curated-source']);
});

test('a user-owned collision is retained and is not advertised as installed', async t => {
  const { manager, config, files, home } = await fixture(t);
  await files.mkdir(path.dirname(adapter(home)), { recursive: true });
  await files.writeFile(adapter(home), 'User owned skill');
  const status = await manager.reconcile(config);
  assert.notEqual(status.state, 'ready');
  assert.equal(await files.readFile(adapter(home), 'utf8'), 'User owned skill');
  assert.ok(!status.adapters.some(entry => entry.name === 'bcdevtoolset-curated-source'));
});

test('a checkout lock blocks maintenance without dependent Git calls and is released after failures', async t => {
  const { manager, config, files, root, calls } = await fixture(t);
  const release = await acquireLock(files, `${root}.bcdevtoolset.lock`);
  const status = await manager.reconcile(config);
  assert.ok(['busy', 'error'].includes(status.state));
  assert.equal(calls.length, 0);
  await release();
  assert.equal((await manager.reconcile(config)).state, 'ready');
});

test('a personal skills junction cannot redirect adapter registration outside the selected home', async t => {
  const { manager, config, files, temporary, home } = await fixture(t);
  const outside = resolveWithinRoot(temporary, 'outside');
  const link = resolveWithinRoot(home, '.agents');
  await files.mkdir(outside);
  // Both paths are contained by this fixture; the junction exercises rejected traversal.
  await nativeFs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const status = await manager.reconcile(config);
  assert.notEqual(status.state, 'ready');
  assert.deepEqual(await files.readdir(outside), []);
});

test('failed discovery preserves previously registered skills instead of treating the source as empty', async t => {
  const { manager, config, root, home, files } = await fixture(t);
  await manager.reconcile(config);
  const before = await files.readFile(adapter(home), 'utf8');
  await files.rm(resolveWithinRoot(root, 'skills'), { recursive: true });
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.match(status.error, /skills/i);
  assert.match(status.error, /retry|correct|add/i);
  assert.equal(await files.readFile(adapter(home), 'utf8'), before);
});

test('source skills directory and entry links cannot redirect reads outside the checkout', async t => {
  for (const segments of [['skills'], ['skills', 'entry.md']]) {
    const { manager, config, root, temporary, files } = await fixture(t);
    await content(files, root);
    const outside = resolveWithinRoot(temporary, 'external-source');
    await files.mkdir(outside);
    await files.writeFile(resolveWithinRoot(outside, 'entry.md'), 'secret external content');
    const link = resolveWithinRoot(root, ...segments);
    await files.rm(link, { recursive: true });
    // Both paths belong to this fixture; a directory junction exercises rejected traversal.
    await nativeFs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    const status = await manager.reconcile(config);
    assert.equal(status.state, 'error');
    assert.equal(status.adapters.length, 0);
    assert.doesNotMatch(JSON.stringify(status), /secret external content/);
    await assert.rejects(files.lstat(resolveWithinRoot(manager.home, '.bcdevtoolset', 'curated-skills.lock')), { code: 'ENOENT' });
  }
});

test('adapter write failures preserve failure status, redact payload and release owned locks for retry', async t => {
  const { manager, config, home, files } = await fixture(t);
  const originalWrite = manager.files.writeFile.bind(manager.files);
  manager.files.writeFile = async (candidate, data) => {
    if (candidate === adapter(home)) throw Object.assign(new Error('secret write payload'), { code: 'EACCES' });
    return originalWrite(candidate, data);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.match(status.error, /registration|adapter/i);
  assert.match(status.error, /EACCES/);
  assert.match(status.error, /permission|access/i);
  assert.doesNotMatch(JSON.stringify(status), /secret write payload/);
  assert.equal(status.lastSuccess, undefined);
  assert.ok(!status.adapters.some(entry => entry.name === 'bcdevtoolset-curated-source'));
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'curated-skills.lock')), { code: 'ENOENT' });
});

test('lock cleanup failure preserves the primary failure and reports cleanup separately', async t => {
  const { manager, config, home, logs } = await fixture(t, {
    cloneError: Object.assign(new Error('secret primary backend payload'), { code: 128 })
  });
  const originalUnlink = manager.files.unlink.bind(manager.files);
  const homeLock = resolveWithinRoot(home, '.bcdevtoolset', 'curated-skills.lock');
  manager.files.unlink = async candidate => {
    if (candidate === homeLock) throw Object.assign(new Error('secret cleanup backend payload'), { code: 'EACCES' });
    return originalUnlink(candidate);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.equal(status.sideEffects, 'unknown');
  assert.equal(status.lastSuccess, undefined);
  assert.match(status.error, /checkout preparation/);
  assert.match(status.error, /128/);
  assert.ok(status.warnings.some(message => /lock cleanup/.test(message) && /EACCES/.test(message)));
  assert.doesNotMatch(JSON.stringify([status, logs]), /secret primary|secret cleanup/);
});

test('equivalent HTTPS and SSH origins refer to the same configured repository', async t => {
  for (const remote of ['git@github.com:example/curated-skills.git', 'ssh://git@github.com/example/curated-skills.git', 'https://github.com/EXAMPLE/curated-skills/']) {
    const { manager, config } = await fixture(t, { remote });
    assert.equal((await manager.reconcile(config)).state, 'ready');
  }
});

async function seedLegacy(files, home, name) {
  const target = adapter(home, name);
  const text = `Legacy ${name} redirect`;
  await files.mkdir(path.dirname(target), { recursive: true });
  await files.writeFile(target, text);
  await files.writeFile(resolveWithinRoot(path.dirname(target), '.bcdevtoolset-owner.json'), JSON.stringify({ owner: 'bc-dev-toolset/curated-skills', sha256: crypto.createHash('sha256').update(text).digest('hex') }));
}

test('migration replaces unchanged legacy redirects but preserves edited, unowned and unrelated skills', async t => {
  const { manager, config, home, files } = await fixture(t);
  for (const name of ['review', 'planning', 'edited']) await seedLegacy(files, home, name);
  await files.appendFile(adapter(home, 'edited'), ' user modification');
  const notes = resolveWithinRoot(path.dirname(adapter(home, 'review')), 'notes.md');
  await files.writeFile(notes, 'user notes');
  await files.mkdir(path.dirname(adapter(home, 'personal')), { recursive: true });
  await files.writeFile(adapter(home, 'personal'), 'user-owned');
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'warning');
  assert.equal(status.adapters.length, 1);
  for (const name of ['review', 'planning']) await assert.rejects(files.lstat(adapter(home, name)), { code: 'ENOENT' });
  assert.equal(await files.readFile(notes, 'utf8'), 'user notes');
  assert.match(await files.readFile(adapter(home, 'edited'), 'utf8'), /user modification/);
  assert.equal(await files.readFile(adapter(home, 'personal'), 'utf8'), 'user-owned');
});

test('failed source registration preserves legacy redirects and releases locks', async t => {
  const { manager, config, home, files } = await fixture(t);
  await seedLegacy(files, home, 'review');
  const originalWrite = manager.files.writeFile.bind(manager.files);
  manager.files.writeFile = async (candidate, data) => {
    if (candidate === adapter(home)) throw Object.assign(new Error('sensitive write payload'), { code: 'EACCES' });
    return originalWrite(candidate, data);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.match(status.error, /registration.*EACCES/);
  assert.equal(status.lastSuccess, undefined);
  assert.equal(status.sideEffects, 'partially-completed');
  assert.equal(await files.readFile(adapter(home, 'review'), 'utf8'), 'Legacy review redirect');
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'curated-skills.lock')), { code: 'ENOENT' });
});

test('a source-name collision preserves legacy redirects until manual resolution', async t => {
  const { manager, config, home, files } = await fixture(t);
  await seedLegacy(files, home, 'review');
  await files.mkdir(path.dirname(adapter(home)), { recursive: true });
  await files.writeFile(adapter(home), 'user-owned source');
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'warning');
  assert.equal(status.adapters.length, 0);
  assert.match(status.warnings.join(' '), /Resolve the collision manually/);
  assert.equal(await files.readFile(adapter(home, 'review'), 'utf8'), 'Legacy review redirect');
});

test('missing, empty and non-file Entry fail before migration and preserve registrations', async t => {
  for (const kind of ['missing', 'empty', 'directory']) {
    const { manager, config, root, home, files } = await fixture(t);
    await manager.reconcile(config);
    await seedLegacy(files, home, 'review');
    const before = await files.readFile(adapter(home), 'utf8');
    const entry = resolveWithinRoot(root, 'skills', 'entry.md');
    await files.unlink(entry);
    if (kind === 'empty') await files.writeFile(entry, '  \n');
    if (kind === 'directory') await files.mkdir(entry);
    const status = await manager.reconcile(config);
    assert.equal(status.state, 'error');
    assert.match(status.error, /source entry validation.*entry.md/);
    assert.match(status.error, /Restore|retry/);
    assert.equal(status.lastSuccess, undefined);
    assert.equal(await files.readFile(adapter(home), 'utf8'), before);
    assert.equal(await files.readFile(adapter(home, 'review'), 'utf8'), 'Legacy review redirect');
    await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'curated-skills.lock')), { code: 'ENOENT' });
  }
});

test('Entry read failures redact backend data, stop migration and release locks', async t => {
  const { manager, config, root, home, files } = await fixture(t);
  await content(files, root);
  await seedLegacy(files, home, 'review');
  const originalRead = BcQualityFiles.prototype.readFile;
  t.after(() => { BcQualityFiles.prototype.readFile = originalRead; });
  BcQualityFiles.prototype.readFile = async function(candidate, encoding) {
    if (candidate === resolveWithinRoot(root, 'skills', 'entry.md')) throw Object.assign(new Error('secret entry data'), { code: 'EACCES' });
    return originalRead.call(this, candidate, encoding);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.match(status.error, /source entry validation.*EACCES/);
  assert.match(status.error, /Access was denied/);
  assert.equal(status.lastSuccess, undefined);
  assert.equal(status.adapters.length, 0);
  assert.doesNotMatch(JSON.stringify(status), /secret entry data/);
  assert.equal(await files.readFile(adapter(home, 'review'), 'utf8'), 'Legacy review redirect');
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'curated-skills.lock')), { code: 'ENOENT' });
});


test('legacy cleanup failure after source installation preserves remaining redirects and failed status', async t => {
  const { manager, config, home, root, files, logs } = await fixture(t);
  await seedLegacy(files, home, 'planning');
  await seedLegacy(files, home, 'review');
  const originalUnlink = manager.files.unlink.bind(manager.files);
  const legacyDeletes = [];
  manager.files.unlink = async candidate => {
    if ([adapter(home, 'planning'), adapter(home, 'review')].includes(candidate)) {
      legacyDeletes.push(candidate);
      throw Object.assign(new Error('secret legacy deletion payload'), { code: 'EACCES' });
    }
    return originalUnlink(candidate);
  };
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.equal(status.lastSuccess, undefined);
  assert.equal(status.sideEffects, 'partially-completed');
  assert.match(status.error, /personal adapter registration failed.*EACCES/);
  assert.match(status.error, /Access was denied/);
  assert.match(status.error, /inspect the checkout and personal adapters/);
  assert.match(status.error, /retrying Update Curated Skills/);
  assert.doesNotMatch(JSON.stringify([status, logs]), /secret legacy deletion payload/);
  assert.equal(status.adapters.length, 1);
  assert.match(await files.readFile(adapter(home), 'utf8'), /name: bcdevtoolset-curated-source/);
  assert.equal(legacyDeletes.length, 1, 'cleanup stops after its first failed deletion');
  for (const name of ['planning', 'review']) assert.equal(await files.readFile(adapter(home, name), 'utf8'), `Legacy ${name} redirect`);
  await assert.rejects(files.lstat(resolveWithinRoot(home, '.bcdevtoolset', 'curated-skills.lock')), { code: 'ENOENT' });
  await assert.rejects(files.lstat(`${root}.bcdevtoolset.lock`), { code: 'ENOENT' });
});
