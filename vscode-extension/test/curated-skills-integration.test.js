'use strict';

const assert = require('node:assert/strict');
const nativeFs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { BcQualityFiles } = require('../bcquality-files');
const { acquireLock } = require('../bcquality-integration');
const { authorizeRoot, assertWithinRoot, resolveWithinRoot } = require('../path-security');
const { CuratedSkillsIntegration } = require('../curated-skills-integration');

const repositoryUrl = 'https://github.com/example/curated-skills.git';

async function content(files, root, names = ['review', 'planning']) {
  await files.mkdir(resolveWithinRoot(root, '.git'), { recursive: true });
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

function adapter(home, name = 'review') {
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

test('initialization clones the configured source and registers referenced skills only for Codex', async t => {
  const { manager, config, root, home, calls, files } = await fixture(t);
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'ready');
  assert.equal(status.commit, 'fixture-commit');
  assert.equal(status.adapters.length, 2);
  assert.deepEqual(calls[0], ['clone', '--', repositoryUrl, root]);
  for (const name of ['review', 'planning']) {
    const wrapper = await files.readFile(adapter(home, name), 'utf8');
    assert.match(wrapper, new RegExp(`name: bcdevtoolset-curated-${name}`));
    assert.ok(wrapper.includes(JSON.stringify(root)));
    assert.ok(wrapper.includes(`skills/${name}/SKILL.md`));
    assert.match(wrapper, /permission/i);
  }
  for (const other of ['.copilot', '.claude']) await assert.rejects(files.lstat(resolveWithinRoot(home, other)), { code: 'ENOENT' });
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
    assert.equal(status.adapters.length, 2);
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
  assert.match(await files.readFile(adapter(home), 'utf8'), /skills\/review\/SKILL.md/);
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
  assert.match(await files.readFile(adapter(home), 'utf8'), /skills\/review\/SKILL.md/);
});

test('clearing configuration after reload removes only unchanged owned adapters and preserves checkout and BCQuality', async t => {
  const { manager, config, files, home, root } = await fixture(t);
  const bcQuality = resolveWithinRoot(home, '.agents', 'skills', 'bcdevtoolset-al-code-review', 'SKILL.md');
  await files.mkdir(path.dirname(bcQuality), { recursive: true });
  await files.writeFile(bcQuality, 'BCQuality skill');
  await manager.reconcile(config);
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

test('removed upstream skills clean only matching managed adapters', async t => {
  const { manager, config, files, home, root } = await fixture(t);
  await manager.reconcile(config);
  await files.rm(resolveWithinRoot(root, 'skills', 'planning'), { recursive: true });
  assert.equal((await manager.reconcile(config)).adapters.length, 1);
  await assert.rejects(files.lstat(adapter(home, 'planning')), { code: 'ENOENT' });
  assert.ok((await files.stat(adapter(home))).isFile());
});

test('a user-owned collision is retained and is not advertised as installed', async t => {
  const { manager, config, files, home } = await fixture(t);
  await files.mkdir(path.dirname(adapter(home)), { recursive: true });
  await files.writeFile(adapter(home), 'User owned skill');
  const status = await manager.reconcile(config);
  assert.notEqual(status.state, 'ready');
  assert.equal(await files.readFile(adapter(home), 'utf8'), 'User owned skill');
  assert.ok(!status.adapters.some(entry => entry.name === 'bcdevtoolset-curated-review'));
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

test('upstream skill links cannot read content outside the checkout', async t => {
  const { manager, config, root, temporary, files } = await fixture(t);
  await content(files, root);
  const outside = resolveWithinRoot(temporary, 'external-upstream');
  await files.mkdir(outside);
  await files.writeFile(resolveWithinRoot(outside, 'SKILL.md'), 'secret external content');
  const link = resolveWithinRoot(root, 'skills', 'linked');
  // Both paths belong to the temporary fixture; the link itself is untrusted input.
  await nativeFs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  const status = await manager.reconcile(config);
  assert.equal(status.state, 'error');
  assert.doesNotMatch(JSON.stringify(status), /secret external content/);
  assert.equal(status.adapters.length, 0);
});

test('symlinks at the source skills root or SKILL.md entry fail without registration', async t => {
  for (const segments of [['skills'], ['skills', 'review', 'SKILL.md']]) {
    const { manager, config, root, temporary, files } = await fixture(t);
    await content(files, root);
    const outside = resolveWithinRoot(temporary, 'external-source');
    await files.mkdir(outside);
    await files.writeFile(resolveWithinRoot(outside, 'keep.txt'), 'preserved external content');
    const link = resolveWithinRoot(root, ...segments);
    await files.rm(link, { recursive: true });
    // Fixture-owned junctions model an untrusted source entry without accessing user files.
    await nativeFs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    const status = await manager.reconcile(config);
    assert.equal(status.state, 'error');
    assert.equal(status.adapters.length, 0);
    assert.equal(await files.readFile(resolveWithinRoot(outside, 'keep.txt'), 'utf8'), 'preserved external content');
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
  assert.ok(!status.adapters.some(entry => entry.name === 'bcdevtoolset-curated-review'));
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

test('quoted and multiline upstream descriptions produce safe single YAML string values', async t => {
  const cases = [
    ['"Review: \\"quoted\\" examples # safely."', 'Review: "quoted" examples # safely.'],
    ["'Review: it''s useful # guidance.'", "Review: it's useful # guidance."],
    ['>\n  Review: first line\n  and second line.', 'Review: first line and second line.']
  ];
  for (const [description, expected] of cases) {
    const { manager, config, root, home, files } = await fixture(t);
    await content(files, root);
    await files.writeFile(resolveWithinRoot(root, 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: ${description}\n---\n\nInstructions.\n`);
    assert.equal((await manager.reconcile(config)).state, 'ready');
    const generated = await files.readFile(adapter(home), 'utf8');
    const descriptionLine = /^description: (.+)$/m.exec(generated)?.[1];
    assert.equal(JSON.parse(descriptionLine), expected);
  }
});

test('missing or malformed descriptions fail without replacing an existing managed adapter', async t => {
  for (const frontmatter of ['name: review', 'description: "unterminated', 'description: ""']) {
    const { manager, config, root, home, files } = await fixture(t);
    await manager.reconcile(config);
    const before = await files.readFile(adapter(home), 'utf8');
    await files.writeFile(resolveWithinRoot(root, 'skills', 'review', 'SKILL.md'), `---\n${frontmatter}\n---\n\nInstructions.\n`);
    const status = await manager.reconcile(config);
    assert.equal(status.state, 'error');
    assert.match(status.error, /description/i);
    assert.equal(await files.readFile(adapter(home), 'utf8'), before);
  }
});

test('unsafe and excessively long skill directory names fail before personal adapter writes', async t => {
  for (const name of ['UpperCase', 'contains space', 'a'.repeat(45)]) {
    const { manager, config, root, files, home } = await fixture(t);
    await content(files, root, [name]);
    const status = await manager.reconcile(config);
    assert.equal(status.state, 'error');
    assert.match(status.error, /names|characters/i);
    assert.equal(status.adapters.length, 0);
    await assert.rejects(files.lstat(resolveWithinRoot(home, '.agents')), { code: 'ENOENT' });
  }
});
