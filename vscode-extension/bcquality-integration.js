'use strict';

const { BcQualityFiles } = require('./bcquality-files');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { authorizeRoot, resolveWithinRoot } = require('./path-security');

const repositoryUrl = 'https://github.com/microsoft/BCQuality.git';
const owner = 'bc-dev-toolset/bcquality';
const agentDirectories = { Copilot: '.copilot', Codex: '.agents', Claude: '.claude' };
const capabilities = new Map([
  ['al-code-review', 'Review Business Central AL code using BCQuality for an app, file, or changes.'],
  ['al-plan-guidance', 'Apply BCQuality guidance to an existing Business Central AL development plan before implementation.'],
  ['al-knowledge', 'Consult BCQuality for cited answers to Business Central development and design questions.']
]);
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
    throw new Error('BCQuality path must be an absolute filesystem path without control characters or backticks.');
  }
  const validatedRoot = authorizeRoot(value, 'BCQuality path');
  if (validatedRoot === path.parse(validatedRoot).root) throw new Error('BCQuality path must not be a filesystem root.');
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

function wrapper(root, capability) {
  const name = `bcdevtoolset-${capability}`;
  return `---\nname: ${name}\ndescription: ${capabilities.get(capability)}\n---\n\n` +
    `# BCQuality integration\n\n` +
    `BC Dev Toolset maintains this adapter. BCQuality content root (JSON string):\n\n` +
    `\`\`\`json\n${JSON.stringify(root)}\n\`\`\`\n\n` +
    `Read and follow the upstream public skill at \`skills/${capability}/SKILL.md\` under that root. ` +
    `Set its PLUGIN_ROOT to the explicit BCQuality content root above; do not derive it from this adapter's location. ` +
    `Resolve BCQuality instructions, knowledge, scripts, and index preparation against that root. ` +
    `Bind the user's actual project, file, diff, question, or plan as the input, preserving the original request.\n\n` +
    `Use explicit file paths through available file or terminal tools; workspace search may omit the external content root. ` +
    `If access is denied, report the missing access to that directory. Skill registration does not grant filesystem permissions. ` +
    `Follow upstream preparation, dispatch, and reporting instructions without duplicating their policy.\n`;
}

// The fixed lock file serializes agent registration across windows, including path changes.
// Dead owners are reclaimed; a live owner is never evicted by a timer.
async function acquireLock(files, lockFile) {
  async function create() {
    const handle = await files.open(lockFile, 'wx');
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
    finally { await handle.close(); }
    return async () => { await files.unlink(lockFile); };
  }
  try { return await create(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Serialize recovery so two windows cannot both unlink a dead owner's lock.
  let recovery;
  try { recovery = await files.open(`${lockFile}.recovery`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
  try {
    const stat = await exists(files, lockFile);
    if (!stat) {
      try { return await create(); } catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
    }
    if (stat.isSymbolicLink()) throw new Error('BCQuality lock must not be a symlink.');
    let pid;
    try { pid = JSON.parse(await files.readFile(lockFile, 'utf8')).pid; }
    catch { return undefined; } // Another process may still be writing the lock.
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try { process.kill(pid, 0); return undefined; }
    catch (error) { if (error.code !== 'ESRCH') return undefined; }
    await files.unlink(lockFile);
    try { return await create(); } catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
  } finally {
    await recovery.close();
    await files.unlink(`${lockFile}.recovery`);
  }
}

class BcQualityIntegration {
  constructor({ homeDirectory = os.homedir(), git = runGit, log = () => {} } = {}) {
    this.home = authorizeRoot(homeDirectory, 'Agent home directory');
    this.files = new BcQualityFiles(this.home);
    this.git = git;
    this.log = log;
    this.queue = Promise.resolve();
    this.status = { state: 'disabled', adapters: [] };
  }

  reconcile(value) {
    this.queue = this.queue.then(() => this.update(value));
    return this.queue;
  }

  // Agent files must remain within the explicitly selected home, even through symlinks.
  async homePath(...segments) {
    const target = resolveWithinRoot(this.home, ...segments);
    let current = this.home;
    for (const segment of path.relative(this.home, target).split(path.sep)) {
      current = resolveWithinRoot(current, segment);
      const stat = await exists(this.files, current);
      if (stat?.isSymbolicLink()) throw new Error(`Agent integration path must not be a symlink: ${current}`);
    }
    return target;
  }

  async update(value) {
    let release;
    let releaseClone;
    const previous = this.status;
    this.status = { ...previous, state: 'updating', lastAttempt: new Date().toISOString(), error: undefined, warnings: [] };
    try {
      const root = value ? validateClonePath(value) : undefined;
      if (root !== previous.path) this.status.commit = undefined;
      this.status.path = root;
      if (!root) {
        let hasAdapters = false;
        for (const agentDirectory of Object.values(agentDirectories)) {
          for (const capability of capabilities.keys()) {
            try {
              if (await exists(this.files, await this.homePath(agentDirectory, 'skills', `bcdevtoolset-${capability}`))) hasAdapters = true;
            } catch { hasAdapters = true; } // Let cleanup report unsafe paths while cleaning other agents.
          }
        }
        if (!hasAdapters) {
          this.status = { state: 'disabled', adapters: [] };
          return this.status;
        }
      }
      const stateDirectory = await this.homePath('.bcdevtoolset');
      await this.files.mkdir(stateDirectory, { recursive: true });
      release = await acquireLock(this.files, await this.homePath('.bcdevtoolset', 'bcquality.lock'));
      if (!release) {
        this.status.state = 'busy';
        this.status.error = 'BCQuality maintenance is already running in another VS Code window. Retry Update BCQuality when it completes.';
        return this.status;
      }
      if (!root) {
        this.status.adapters = await this.syncAdapters(undefined, []);
        this.status.state = 'disabled';
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
      if (!releaseClone) throw new Error('This BCQuality checkout is being maintained by another process. Retry Update BCQuality later.');
      const contentFiles = new BcQualityFiles(root);
      await this.prepareCheckout(root, contentFiles);
      const available = [];
      for (const capability of capabilities.keys()) {
        const entry = resolveWithinRoot(root, 'skills', capability, 'SKILL.md');
        if ((await exists(contentFiles, entry))?.isFile()) available.push(capability);
      }
      if (!available.length) throw new Error('The BCQuality checkout contains no supported public skills.');
      this.status.adapters = await this.syncAdapters(root, available);
      this.status.commit = await this.git(['-C', root, 'rev-parse', 'HEAD']);
      this.status.lastSuccess = new Date().toISOString();
      this.status.state = this.status.warnings.length ? 'warning' : 'ready';
    } catch (error) {
      this.status.state = 'error';
      this.status.error = error.message;
    } finally {
      for (const unlock of [releaseClone, release]) {
        if (unlock) {
          try { await unlock(); } catch (error) { this.status.warnings.push(`Could not release BCQuality lock: ${error.message}`); }
        }
      }
      this.log(`BCQuality: ${JSON.stringify(this.status)}`);
    }
    return this.status;
  }

  async prepareCheckout(root, contentFiles) {
    const stat = await exists(contentFiles, root);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('BCQuality path must be a regular directory.');
    if (!stat || !(await contentFiles.readdir(root)).length) {
      await this.git(['clone', '--', repositoryUrl, root]);
    }
    const top = await this.git(['-C', root, 'rev-parse', '--show-toplevel']);
    if (path.relative(root, path.resolve(top)) !== '') throw new Error('BCQuality path must be the checkout root, not a directory inside another repository.');
    const remote = await this.git(['-C', root, 'remote', 'get-url', 'origin']);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)microsoft\/BCQuality(?:\.git)?\/?$/i.test(remote)) {
      throw new Error('BCQuality origin must point to microsoft/BCQuality on GitHub. No update was performed.');
    }
    for (const file of ['plugin.json', 'skills/entry.md']) {
      if (!(await exists(contentFiles, resolveWithinRoot(root, file)))?.isFile()) throw new Error(`BCQuality checkout is missing ${file}.`);
    }
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
    try { await this.git(['-C', root, 'pull', '--ff-only', 'origin', 'main']); }
    catch (error) { this.status.warnings.push(`BCQuality update failed; using the existing checkout. ${error.message}`); }
  }

  async syncAdapters(root, available) {
    const result = [];
    for (const [agent, agentDirectory] of Object.entries(agentDirectories)) {
      for (const capability of capabilities.keys()) {
        const name = `bcdevtoolset-${capability}`;
        try {
          const directory = await this.homePath(agentDirectory, 'skills', name);
          const skillFile = resolveWithinRoot(directory, 'SKILL.md');
          const ownershipFile = resolveWithinRoot(directory, '.bcdevtoolset-owner.json');
          let managed = false;
          if (await exists(this.files, directory)) {
            // Refuse an altered adapter, symlink, or user-created directory without proof of ownership.
            for (const file of [skillFile, ownershipFile]) {
              if ((await exists(this.files, file))?.isSymbolicLink()) throw new Error(`Existing ${name} contains a symlink; left untouched.`);
            }
            try {
              const record = JSON.parse(await this.files.readFile(ownershipFile, 'utf8'));
              managed = record.owner === owner && record.sha256 === digest(await this.files.readFile(skillFile, 'utf8'));
            } catch { /* Unowned content is preserved. */ }
            if (!managed) throw new Error(`Existing ${name} is user-owned or modified; left untouched.`);
          }
          if (!root || !available.includes(capability)) {
            if (managed) {
              await this.files.unlink(skillFile);
              await this.files.unlink(ownershipFile);
              try { await this.files.rmdir(directory); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
            }
            continue;
          }
          const content = wrapper(root, capability);
          await this.files.mkdir(directory, { recursive: true });
          await this.files.writeFile(skillFile, content);
          await this.files.writeFile(ownershipFile, JSON.stringify({ owner, sha256: digest(content) }) + '\n');
          result.push({ agent, name, path: skillFile });
        } catch (error) {
          this.status.warnings.push(`${agent}: ${error.message}`);
        }
      }
    }
    return result;
  }
}

module.exports = { BcQualityIntegration, validateClonePath, acquireLock };
