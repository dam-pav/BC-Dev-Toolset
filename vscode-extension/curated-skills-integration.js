'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { BcQualityFiles } = require('./bcquality-files');
const { acquireLock } = require('./bcquality-integration');
const { authorizeRoot, resolveWithinRoot } = require('./path-security');
const { backendFailureDetails } = require('./skill-source-diagnostics');
const { CuratedSkillsAuthenticationFailure } = require('./curated-skills-auth');
const { validateRepositoryUrl, validateClonePath, CuratedSkillsConfigurationFailure } = require('./curated-skills-repository');

const owner = 'bc-dev-toolset/curated-skills';
const prefix = 'bcdevtoolset-curated-';
const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const execute = promisify(execFile);
const recovery = 'Run Show Curated Skills Status, inspect the checkout and personal adapters, then correct the curatedSkillsRepositoryUrl/curatedSkillsPath User settings or Git access before retrying Update Curated Skills.';

class CuratedSkillsFailure extends Error {}
function fail(message) { throw new CuratedSkillsFailure(message); }

// Only reviewed toolset messages and narrowly validated status codes reach diagnostics.
function diagnostic(error, stage) {
  if (error instanceof CuratedSkillsAuthenticationFailure) return error.message;
  const { statusSuffix, reason: backendReason } = backendFailureDetails(error);
  const reason = error instanceof CuratedSkillsFailure || error instanceof CuratedSkillsConfigurationFailure ? error.message : backendReason;
  return `Curated skills: ${stage} failed${statusSuffix}. ${reason} ${recovery}`;
}

async function runGit(args) {
  const { stdout } = await execute('git', args, {
    windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  return stdout.trim();
}

async function exists(files, validatedPath) {
  try { return await files.lstat(validatedPath); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function digest(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

async function validateEntry(files, root) {
  const skillsRoot = resolveWithinRoot(root, 'skills');
  const skillsStat = await exists(files, skillsRoot);
  if (!skillsStat?.isDirectory() || skillsStat.isSymbolicLink()) fail('The checkout must contain a regular skills directory and skills/entry.md. Restore the source entry point before retrying.');
  const entry = resolveWithinRoot(skillsRoot, 'entry.md');
  const stat = await exists(files, entry);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('The checkout must contain a regular, non-symlink skills/entry.md. Restore the source entry point before retrying.');
  if (!(await files.readFile(entry, 'utf8')).trim()) fail('The source skills/entry.md is empty. Restore its routing instructions before retrying.');
}

function wrapper(root) {
  return `---\nname: ${prefix}source\ndescription: "Discover and apply skills from the configured curated repository for any task, including development, tooling, review, planning and other workflows. Consult its Entry router to consider all applicable skills."\n---\n\n` +
    `# Curated skill source\n\nBC Dev Toolset maintains this adapter. Upstream repository root (JSON string):\n\n` +
    `\`\`\`json\n${JSON.stringify(root)}\n\`\`\`\n\n` +
    `Read and follow \`skills/entry.md\` under that root to discover all applicable skills; do not use a fixed skill list. ` +
    `Preserve the user's actual goal, available inputs and values, constraints and authorization in the task context. ` +
    `Follow Entry's native input contract and preparation instructions, without inventing context or permissions. ` +
    `Execute its returned dispatch under the source's \`skills/do.md\` instructions. Honor task-start, phase-step and governed-by composition when supplied; a phase-step skill executes inside its coordinator's lifecycle. ` +
    `For no-match or failed, return the dispatch record and its explanation without invoking skills or inventing a fallback. ` +
    `Read the exact dispatched files and preserve their prerequisites, approval gates and reporting instructions.\n\n` +
    `Resolve Entry and other repository-relative paths against the explicit repository root above; resolve skill-relative references against the original upstream skill directory, not this adapter directory. ` +
    `If upstream uses PLUGIN_ROOT, set it to that repository root. ` +
    `Use explicit file paths: workspace search may omit the external checkout. If access is denied, report the missing access. ` +
    `Skill registration does not grant filesystem permissions.\n`;
}

class CuratedSkillsIntegration {
  constructor({ homeDirectory = os.homedir(), git = runGit, gitFactory, log = () => {} } = {}) {
    this.home = authorizeRoot(homeDirectory, 'Agent home directory');
    this.files = new BcQualityFiles(this.home);
    this.git = git;
    this.gitFactory = gitFactory;
    this.log = log;
    this.queue = Promise.resolve();
    this.status = { state: 'disabled', adapters: [], sideEffects: 'not-started' };
  }

  reconcile(configuration = {}) {
    const run = () => this.update(configuration);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async homePath(...segments) {
    const target = resolveWithinRoot(this.home, ...segments);
    let current = this.home;
    for (const segment of [undefined, ...path.relative(this.home, target).split(path.sep).filter(Boolean)]) {
      if (segment !== undefined) current = resolveWithinRoot(current, segment);
      if ((await exists(this.files, current))?.isSymbolicLink()) fail('The personal adapter path must not traverse a symlink. Inspect ~/.agents/skills and ~/.bcdevtoolset before retrying.');
    }
    return target;
  }

  async adapterNames() {
    const directory = await this.homePath('.agents', 'skills');
    if (!await exists(this.files, directory)) return [];
    return (await this.files.readdir(directory)).filter(name => name.startsWith(prefix) && safeName.test(name));
  }

  async update(configuration) {
    let releaseHome;
    let releaseClone;
    let stage = 'configuration validation';
    const previous = this.status;
    this.status = { state: 'updating', adapters: [], warnings: [], sideEffects: 'not-started', lastAttempt: new Date().toISOString() };
    try {
      const repositoryValue = configuration?.repositoryUrl ?? '';
      const pathValue = configuration?.path ?? '';
      if ((repositoryValue === '') !== (pathValue === '')) fail('Set both bcDevToolset.curatedSkillsRepositoryUrl and bcDevToolset.curatedSkillsPath, or clear both to disable maintenance.');
      const repository = repositoryValue === '' ? undefined : validateRepositoryUrl(repositoryValue);
      const root = pathValue === '' ? undefined : validateClonePath(pathValue);
      if (root && this.gitFactory) {
        stage = 'repository authentication';
        this.git = await this.gitFactory(repository.url);
      }
      if (root) {
        this.status.path = root;
        this.status.repositoryUrl = repository.url;
        if (previous.path === root && previous.repositoryUrl === repository.url) this.status.commit = previous.commit;
      }
      stage = 'personal adapter inspection';
      if (!root && !(await this.adapterNames()).length) {
        this.status.state = 'disabled';
        return this.status;
      }
      stage = 'maintenance lock acquisition';
      this.status.sideEffects = 'partially-completed';
      await this.files.mkdir(await this.homePath('.bcdevtoolset'), { recursive: true });
      releaseHome = await acquireLock(this.files, await this.homePath('.bcdevtoolset', 'curated-skills.lock'));
      if (!releaseHome) {
        this.status.state = 'busy';
        this.status.error = 'Curated skills maintenance is running in another VS Code window. Retry Update Curated Skills after it finishes.';
        return this.status;
      }
      if (!root) {
        stage = 'managed adapter cleanup';
        await this.syncAdapters(undefined, []);
        this.status.state = this.status.warnings.length ? 'warning' : 'disabled';
        this.status.sideEffects = 'completed';
        return this.status;
      }
      const parent = authorizeRoot(path.dirname(root), 'Curated skills checkout parent');
      const parentFiles = new BcQualityFiles(parent);
      await parentFiles.mkdir(parent, { recursive: true });
      releaseClone = await acquireLock(parentFiles, resolveWithinRoot(parent, `${path.basename(root)}.bcdevtoolset.lock`));
      if (!releaseClone) fail('Another process is maintaining this checkout. Retry Update Curated Skills after it finishes.');
      const contentFiles = new BcQualityFiles(root);
      stage = 'checkout preparation';
      await this.prepareCheckout(root, repository, contentFiles);
      stage = 'source entry validation';
      await validateEntry(contentFiles, root);
      stage = 'checkout revision inspection';
      const commit = await this.git(['-C', root, 'rev-parse', 'HEAD']);
      stage = 'personal adapter registration';
      await this.syncAdapters(root, [{ name: 'source' }]);
      this.status.commit = commit;
      this.status.state = this.status.warnings.length ? 'warning' : 'ready';
      if (!this.status.updateFailed) this.status.lastSuccess = new Date().toISOString();
      if (this.status.sideEffects !== 'unknown') this.status.sideEffects = 'completed';
    } catch (error) {
      this.status.state = 'error';
      this.status.error = diagnostic(error, stage);
    } finally {
      for (const unlock of [releaseClone, releaseHome]) {
        if (!unlock) continue;
        try { await unlock(); }
        catch (error) {
          this.status.state = 'error';
          const cleanupError = diagnostic(error, 'maintenance lock cleanup');
          if (this.status.error) this.status.warnings.push(cleanupError);
          else this.status.error = cleanupError;
          if (this.status.sideEffects !== 'unknown') this.status.sideEffects = 'partially-completed';
          delete this.status.lastSuccess;
        }
      }
      // A caller's logging hook must not reject or poison later reconciliation.
      try { this.log(`Curated skills: ${JSON.stringify(this.status)}`); } catch { /* Status remains available through the status command. */ }
    }
    return this.status;
  }

  async prepareCheckout(root, repository, files) {
    const stat = await exists(files, root);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('The configured checkout path must be a regular directory, not a file or symlink.');
    if (!stat || !(await files.readdir(root)).length) {
      this.status.sideEffects = 'unknown';
      await this.git(['clone', '--', repository.url, root]);
      this.status.sideEffects = 'partially-completed';
    }
    const top = await this.git(['-C', root, 'rev-parse', '--show-toplevel']);
    if (typeof top !== 'string' || !path.isAbsolute(top) || path.relative(root, path.resolve(top)) !== '') fail('The path must be the checkout root, not a directory inside another repository. No update was performed.');
    const remote = await this.git(['-C', root, 'remote', 'get-url', 'origin']);
    if (validateRepositoryUrl(remote).identity !== repository.identity) fail('Checkout origin does not match the configured GitHub repository. No update was performed. Use a matching checkout or choose a separate empty path.');
    const dirty = await this.git(['-C', root, 'status', '--porcelain']);
    if (dirty) {
      this.status.warnings.push('The checkout has local changes; update skipped and existing skills retained. Commit or stash changes before retrying an update.');
      return;
    }
    const branch = await this.git(['-C', root, 'branch', '--show-current']);
    if (branch !== 'main') {
      this.status.warnings.push('The checkout is not on main; update skipped and the pinned revision retained. Switch to main manually when updates are desired.');
      return;
    }
    this.status.sideEffects = 'unknown';
    try {
      await this.git(['-C', root, 'pull', '--ff-only', 'origin', 'main']);
      this.status.sideEffects = 'partially-completed';
    } catch (error) {
      // Do not replay the write. Reinspect before retaining usable offline content.
      this.status.updateFailed = true;
      const updateDiagnostic = diagnostic(error, 'fast-forward update');
      this.status.warnings.push(updateDiagnostic);
      const afterTop = await this.git(['-C', root, 'rev-parse', '--show-toplevel']);
      const afterRemote = await this.git(['-C', root, 'remote', 'get-url', 'origin']);
      if (path.relative(root, path.resolve(afterTop)) !== '' || validateRepositoryUrl(afterRemote).identity !== repository.identity) fail('Checkout identity could not be reconciled after a failed update. Inspect the checkout before retrying.');
      await validateEntry(files, root);
      this.status.warnings.push('Existing usable content was revalidated and retained after the failed update; no retry was performed.');
    }
  }

  async syncAdapters(root, available) {
    const selected = new Map(available.map(skill => [`${prefix}${skill.name}`, skill]));
    const names = new Set([...selected.keys(), ...await this.adapterNames()]);
    for (const name of names) {
      const directory = await this.homePath('.agents', 'skills', name);
      const skillFile = resolveWithinRoot(directory, 'SKILL.md');
      const ownershipFile = resolveWithinRoot(directory, '.bcdevtoolset-owner.json');
      let managed = false;
      if (await exists(this.files, directory)) {
        const stat = await this.files.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('An adapter directory is unsafe. Remove the conflicting link or choose a regular personal skills directory.');
        const recordStat = await exists(this.files, ownershipFile);
        const skillStat = await exists(this.files, skillFile);
        if (recordStat?.isSymbolicLink() || skillStat?.isSymbolicLink()) fail('A personal adapter contains a symlink; it was left untouched. Inspect the personal skills directory before retrying.');
        if (recordStat?.isFile() && skillStat?.isFile()) {
          let record;
          try { record = JSON.parse(await this.files.readFile(ownershipFile, 'utf8')); }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; }
          managed = record?.owner === owner && record?.sha256 === digest(await this.files.readFile(skillFile, 'utf8'));
        }
        if (!managed) {
          this.status.warnings.push(`Personal skill ${name} is user-owned or modified and was left untouched. Resolve the collision manually to enable its managed adapter.`);
          continue;
        }
      }
      const skill = selected.get(name);
      if (!root || !skill) {
        // Do not remove usable legacy registration until its replacement is installed.
        if (root && !this.status.adapters.length) continue;
        if (managed) {
          await this.files.unlink(skillFile);
          await this.files.unlink(ownershipFile);
          try { await this.files.rmdir(directory); }
          catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
        }
        continue;
      }
      const content = wrapper(root, skill);
      await this.files.mkdir(directory, { recursive: true });
      await this.files.writeFile(skillFile, content);
      await this.files.writeFile(ownershipFile, JSON.stringify({ owner, sha256: digest(content) }) + '\n');
      this.status.adapters.push({ agent: 'Codex', name, path: skillFile });
    }
  }
}

module.exports = { CuratedSkillsIntegration, validateRepositoryUrl, validateClonePath, validateEntry, wrapper };
