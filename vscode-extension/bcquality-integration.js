'use strict';

const { BcQualityFiles } = require('./bcquality-files');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { authorizeRoot, resolveWithinRoot } = require('./path-security');
const { backendFailureDetails } = require('./skill-source-diagnostics');

const repositoryUrl = 'https://github.com/microsoft/BCQuality.git';
const owner = 'bc-dev-toolset/bcquality';
const agentDirectories = { Copilot: '.copilot', Codex: '.agents', Claude: '.claude' };
const sourceName = 'bcdevtoolset-bcquality';
const legacyNames = ['bcdevtoolset-al-code-review', 'bcdevtoolset-al-plan-guidance', 'bcdevtoolset-al-knowledge'];
const adapterNames = [sourceName, ...legacyNames];
class BcQualityFailure extends Error {}
function fail(message) { throw new BcQualityFailure(message); }
function diagnostic(error, stage) {
  const { statusSuffix, reason: backendReason } = backendFailureDetails(error);
  const reason = error instanceof BcQualityFailure ? error.message : backendReason;
  return `BCQuality: ${stage} failed${statusSuffix}. ${reason} Run Show BCQuality Status, inspect the checkout and personal adapters, correct the bcQualityPath User setting or Git access, then retry Update BCQuality.`;
}
const execute = promisify(execFile);

async function runGit(args) {
  const { stdout } = await execute('git', args, {
    windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  return stdout.trim();
}

function validateClonePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim()) ||
      Array.from(value).some(character => character.codePointAt(0) < 32 || character === '`')) {
    throw new BcQualityFailure('BCQuality path must be an absolute filesystem path without control characters or backticks.');
  }
  const validatedRoot = authorizeRoot(value, 'BCQuality path');
  if (validatedRoot === path.parse(validatedRoot).root) throw new BcQualityFailure('BCQuality path must not be a filesystem root.');
  return validatedRoot;
}

// Callers supply a validated configurable root or a path confined with resolveWithinRoot.
async function exists(files, validatedPath) {
  try { return await files.lstat(validatedPath); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function digest(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

function wrapper(root) {
  return `---\nname: ${sourceName}\ndescription: Consider BCQuality skills for Business Central and AL development, implementation, design, planning, review, troubleshooting, and knowledge questions. Route the actual task through the complete configured skill collection.\n---\n\n` +
    `# BCQuality skill source\n\nBC Dev Toolset maintains this source adapter. Repository root (JSON string):\n\n` +
    `\`\`\`json\n${JSON.stringify(root)}\n\`\`\`\n\n` +
    `Read and follow \`skills/entry.md\` under that root before selecting skills. ` +
    `Supply Entry's task-context using the user's actual request as goal and inputs-available reflecting only the inputs actually present. Preserve actual paths, constraints and authorization. ` +
    `Pass optional context and layer/disabled-skill settings only when supplied or reliably known; otherwise retain upstream defaults. ` +
    `Follow Entry's Preparation and How the agent uses the dispatch instructions, including knowledge-index preparation, exact dispatched input subsets, execution and reporting. ` +
    `Consider all applicable skills discovered by Entry across the repository; do not limit routing to the former review or plan adapters or maintain a local allowlist. ` +
    `If Entry returns no-match or failed, return that record without invoking substitute skills or claiming success.\n\n` +
    `Set PLUGIN_ROOT to the explicit repository root above; do not derive it from this adapter's location. ` +
    `Resolve source-relative instructions, dispatched skills, knowledge, scripts and index preparation against that root, and skill-relative references against their upstream skill directory. ` +
    `Use explicit file paths: workspace search may omit the external checkout. If access is denied, report the missing access. ` +
    `Skill registration does not grant filesystem permissions or authorize task side effects.\n`;
}

async function validateEntry(files, root) {
  const skills = await exists(files, resolveWithinRoot(root, 'skills'));
  if (!skills?.isDirectory() || skills.isSymbolicLink()) fail('The checkout needs a regular, non-symlink skills directory. Restore it before retrying.');
  const entry = resolveWithinRoot(root, 'skills', 'entry.md');
  const stat = await exists(files, entry);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('The checkout needs a regular, non-symlink skills/entry.md source entry point. Restore it before retrying.');
  if (!(await files.readFile(entry, 'utf8')).trim()) fail('The skills/entry.md source entry point is empty. Restore its routing instructions before retrying.');
}

// The fixed lock file serializes agent registration across windows, including path changes.
// Dead owners are reclaimed; a live owner is never evicted by a timer.
async function acquireLock(files, lockFile) {
  async function create() {
    // Publish complete owner information atomically, including for recovery locks.
    // A crash before publication can only leave an unused uniquely named file.
    const candidate = `${lockFile}.${crypto.randomUUID()}.owner`;
    const handle = await files.open(candidate, 'wx');
    try {
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      finally { await handle.close(); }
      await files.link(candidate, lockFile);
    } finally { await files.unlink(candidate); }
    return async () => { await files.unlink(lockFile); };
  }
  async function abandoned() {
    const stat = await exists(files, lockFile);
    if (!stat) return 'missing';
    if (stat.isSymbolicLink()) throw new BcQualityFailure('BCQuality lock must not be a symlink.');
    let pid;
    try { pid = JSON.parse(await files.readFile(lockFile, 'utf8'))?.pid; }
    catch (error) {
      if (error.code === 'ENOENT') return 'missing';
      // Windows can reject opens while another contender deletes the lock.
      // Fail closed for this attempt: never reclaim an owner we could not read.
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return false;
      if (!(error instanceof SyntaxError)) throw error;
    }
    // Older versions created empty recovery files. Allow time for their writer
    // to finish; new locks always have owner information before they are visible.
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - stat.mtimeMs > 120000;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }
  try { return await create(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!await abandoned()) return undefined;
  // Recovery locks use the same ownership and reclamation protocol. A crash
  // during recovery therefore cannot leave a permanently blocking sentinel.
  const releaseRecovery = await acquireLock(files, `${lockFile}.recovery`);
  if (!releaseRecovery) return undefined;
  try {
    const stale = await abandoned();
    if (!stale) return undefined;
    if (stale === true) {
      try { await files.unlink(lockFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { return await create(); } catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
  } finally {
    await releaseRecovery();
  }
}

class BcQualityIntegration {
  constructor({ homeDirectory = os.homedir(), git = runGit, log = () => {} } = {}) {
    this.home = authorizeRoot(homeDirectory, 'Agent home directory');
    this.files = new BcQualityFiles(this.home);
    this.git = git;
    this.log = log;
    this.queue = Promise.resolve();
    this.status = { state: 'disabled', adapters: [], sideEffects: 'not-started' };
  }

  reconcile(value) {
    const run = () => this.update(value);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  // Agent files must remain within the explicitly selected home, even through symlinks.
  async homePath(...segments) {
    const target = resolveWithinRoot(this.home, ...segments);
    let current = this.home;
    for (const segment of path.relative(this.home, target).split(path.sep)) {
      current = resolveWithinRoot(current, segment);
      const stat = await exists(this.files, current);
      if (stat?.isSymbolicLink()) fail('Agent integration path must not be a symlink; inspect the personal skills directory.');
    }
    return target;
  }

  async update(value) {
    let release;
    let releaseClone;
    let stage = 'configuration validation';
    const previous = this.status;
    this.status = { state: 'updating', adapters: [], sideEffects: 'not-started', lastAttempt: new Date().toISOString(), warnings: [] };
    if (value === previous.path) this.status.commit = previous.commit;
    try {
      const root = value ? validateClonePath(value) : undefined;
      if (root !== previous.path) this.status.commit = undefined;
      this.status.path = root;
      if (!root) {
        let hasAdapters = false;
        for (const agentDirectory of Object.values(agentDirectories)) {
          for (const name of adapterNames) {
            try {
              if (await exists(this.files, await this.homePath(agentDirectory, 'skills', name))) hasAdapters = true;
            } catch { hasAdapters = true; } // Let cleanup report unsafe paths while cleaning other agents.
          }
        }
        if (!hasAdapters) {
          this.status = { state: 'disabled', adapters: [], sideEffects: 'not-started' };
          return this.status;
        }
      }
      stage = 'maintenance lock acquisition';
      this.status.sideEffects = 'partially-completed';
      const stateDirectory = await this.homePath('.bcdevtoolset');
      await this.files.mkdir(stateDirectory, { recursive: true });
      release = await acquireLock(this.files, await this.homePath('.bcdevtoolset', 'bcquality.lock'));
      if (!release) {
        this.status.state = 'busy';
        this.status.error = 'BCQuality maintenance is already running in another VS Code window. Retry Update BCQuality when it completes.';
        return this.status;
      }
      if (!root) {
        stage = 'managed adapter cleanup';
        this.status.adapters = await this.syncAdapters(undefined);
        this.status.state = this.status.warnings.length ? 'warning' : 'disabled';
        this.status.sideEffects = 'completed';
        this.status.commit = undefined;
        return this.status;
      }
      // The user explicitly authorizes this absolute clone root at the setting boundary.
      // A sibling lock also protects the checkout from another profile sharing that root.
      const parent = authorizeRoot(path.dirname(root), 'BCQuality parent directory');
      const parentFiles = new BcQualityFiles(parent);
      await parentFiles.mkdir(parent, { recursive: true });
      const lockFile = resolveWithinRoot(parent, `${path.basename(root)}.bcdevtoolset.lock`);
      releaseClone = await acquireLock(parentFiles, lockFile);
      if (!releaseClone) throw new BcQualityFailure('This BCQuality checkout is being maintained by another process. Retry Update BCQuality later.');
      const contentFiles = new BcQualityFiles(root);
      stage = 'checkout preparation';
      await this.prepareCheckout(root, contentFiles);
      stage = 'source entry validation';
      await validateEntry(contentFiles, root);
      stage = 'checkout revision inspection';
      this.status.commit = await this.git(['-C', root, 'rev-parse', 'HEAD']);
      stage = 'source adapter registration and migration';
      this.status.adapters = await this.syncAdapters(root);
      if (!this.status.updateFailed) this.status.lastSuccess = new Date().toISOString();
      if (this.status.sideEffects !== 'unknown') this.status.sideEffects = 'completed';
      this.status.state = this.status.warnings.length ? 'warning' : 'ready';
    } catch (error) {
      this.status.state = 'error';
      this.status.error = diagnostic(error, stage);
    } finally {
      for (const unlock of [releaseClone, release]) {
        if (unlock) {
          try { await unlock(); } catch (error) {
            this.status.state = 'error';
            const message = diagnostic(error, 'maintenance lock cleanup');
            if (this.status.error) this.status.warnings.push(message); else this.status.error = message;
            delete this.status.lastSuccess;
            if (this.status.sideEffects !== 'unknown') this.status.sideEffects = 'partially-completed';
          }
        }
      }
      try { this.log(`BCQuality: ${JSON.stringify(this.status)}`); } catch { /* Status remains available. */ }
    }
    return this.status;
  }

  async prepareCheckout(root, contentFiles) {
    const stat = await exists(contentFiles, root);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new BcQualityFailure('BCQuality path must be a regular directory.');
    if (!stat || !(await contentFiles.readdir(root)).length) {
      this.status.sideEffects = 'unknown';
      await this.git(['clone', '--', repositoryUrl, root]);
      this.status.sideEffects = 'partially-completed';
    }
    const top = await this.git(['-C', root, 'rev-parse', '--show-toplevel']);
    if (typeof top !== 'string' || !path.isAbsolute(top) || path.relative(root, path.resolve(top)) !== '') throw new BcQualityFailure('BCQuality path must be the checkout root, not a directory inside another repository.');
    const remote = await this.git(['-C', root, 'remote', 'get-url', 'origin']);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)microsoft\/BCQuality(?:\.git)?\/?$/i.test(remote)) {
      throw new BcQualityFailure('BCQuality origin must point to microsoft/BCQuality on GitHub. No update was performed.');
    }
    if (!(await exists(contentFiles, resolveWithinRoot(root, 'plugin.json')))?.isFile()) fail('The checkout is missing plugin.json. Restore the BCQuality checkout.');
    await validateEntry(contentFiles, root);
    const dirty = await this.git(['-C', root, 'status', '--porcelain']);
    if (dirty) {
      this.status.warnings.push('BCQuality has local changes; update skipped. Existing content remains available.');
      return;
    }
    const branch = await this.git(['-C', root, 'branch', '--show-current']);
    if (branch !== 'main') {
      this.status.warnings.push('BCQuality is not on main; update skipped. Existing content remains available.');
      return;
    }
    this.status.sideEffects = 'unknown';
    try {
      await this.git(['-C', root, 'pull', '--ff-only', 'origin', 'main']);
      this.status.sideEffects = 'partially-completed';
    } catch (error) {
      this.status.updateFailed = true;
      this.status.warnings.push(diagnostic(error, 'fast-forward update'));
      const afterTop = await this.git(['-C', root, 'rev-parse', '--show-toplevel']);
      const afterRemote = await this.git(['-C', root, 'remote', 'get-url', 'origin']);
      if (typeof afterTop !== 'string' || !path.isAbsolute(afterTop) || path.relative(root, path.resolve(afterTop)) !== '' ||
          !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)microsoft\/BCQuality(?:\.git)?\/?$/i.test(afterRemote)) fail('Checkout identity could not be reconciled after a failed update. Inspect the checkout before retrying.');
      await validateEntry(contentFiles, root);
      this.status.warnings.push('Existing source entry was revalidated and retained after the failed update; no retry was performed.');
    }
  }

  async syncAdapters(root) {
    const result = [];
    for (const [agent, agentDirectory] of Object.entries(agentDirectories)) {
      // Publish the replacement before removing legacy redirects. A collision or
      // write failure must leave the prior discovery path available.
      let sourceAvailable = false;
      for (const name of adapterNames) {
        if (root && name !== sourceName && !sourceAvailable) continue;
        try {
          const directory = await this.homePath(agentDirectory, 'skills', name);
          const skillFile = resolveWithinRoot(directory, 'SKILL.md');
          const ownershipFile = resolveWithinRoot(directory, '.bcdevtoolset-owner.json');
          let managed = false;
          if (await exists(this.files, directory)) {
            for (const file of [skillFile, ownershipFile]) {
              if ((await exists(this.files, file))?.isSymbolicLink()) fail(`Existing ${name} contains a symlink; left untouched. Inspect the personal skills directory.`);
            }
            let record;
            const recordStat = await exists(this.files, ownershipFile);
            const skillStat = await exists(this.files, skillFile);
            if (recordStat?.isFile() && skillStat?.isFile()) {
              try { record = JSON.parse(await this.files.readFile(ownershipFile, 'utf8')); }
              catch (error) { if (!(error instanceof SyntaxError)) throw error; }
              managed = record?.owner === owner && record?.sha256 === digest(await this.files.readFile(skillFile, 'utf8'));
            }
            if (!managed) fail(`Existing ${name} is user-owned or modified; left untouched. Resolve the collision manually to enable its source adapter.`);
          }
          if (!root || name !== sourceName) {
            if (managed) {
              await this.files.unlink(skillFile);
              await this.files.unlink(ownershipFile);
              try { await this.files.rmdir(directory); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
            }
            continue;
          }
          const content = wrapper(root);
          await this.files.mkdir(directory, { recursive: true });
          await this.files.writeFile(skillFile, content);
          await this.files.writeFile(ownershipFile, JSON.stringify({ owner, sha256: digest(content) }) + '\n');
          sourceAvailable = true;
          result.push({ agent, name, path: skillFile });
          this.status.adapters = [...result];
        } catch (error) {
          if (!(error instanceof BcQualityFailure)) throw error;
          this.status.warnings.push(`${agent}: ${diagnostic(error, 'personal adapter inspection')}`);
        }
      }
    }
    return result;
  }

}

module.exports = { BcQualityIntegration, validateClonePath, acquireLock };
