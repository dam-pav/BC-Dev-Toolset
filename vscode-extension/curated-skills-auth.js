'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { validateRepositoryUrl: repositoryDetails, validateClonePath } = require('./curated-skills-repository');

const executeFile = promisify(execFile);
const recovery = 'For HTTPS, configure or replace the Curated Skills Access Token or check existing Git credentials. For SSH, check the SSH keys and agent. Verify repository read access and network access, then run Check Curated Skills Access before retrying.';

class CuratedSkillsAuthenticationFailure extends Error {
  constructor(stage, { code, sideEffects = 'not-started', reason } = {}) {
    const safeCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);
    const safeCode = Number.isInteger(code) || safeCodes.has(code) ? code : undefined;
    super(`Curated skills: ${stage} failed${safeCode === undefined ? '' : ` (code ${safeCode})`}. ${reason || 'Git could not complete the operation; the remote cause is unknown.'} ${recovery}`);
    this.stage = stage;
    this.code = safeCode;
    this.sideEffects = sideEffects;
    this.reason = reason || 'Git could not complete the operation; the remote cause is unknown.';
  }
}

function repositoryKey(value) {
  return `bcdevtoolset.curatedSkills.token.${repositoryDetails(value).identity}`;
}

function validateAccessToken(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value)) {
    throw new CuratedSkillsAuthenticationFailure('access token validation', {
      reason: 'Paste only a nonempty single-line access token, without spaces or control characters.'
    });
  }
  return value;
}

function cleanEnvironment(source) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_CONFIG') || upper.startsWith('GIT_TRACE') || [
      'GIT_CURL_VERBOSE', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSL_NO_VERIFY',
      'GIT_TEMPLATE_DIR', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ALLOW_PROTOCOL',
      'GIT_PROTOCOL_FROM_USER', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE'
    ].includes(upper)) continue;
    result[key] = value;
  }
  result.GIT_TERMINAL_PROMPT = '0';
  result.GCM_INTERACTIVE = 'Never';
  // Absent variables allow Git's system/global trace2 targets to reactivate tracing.
  result.GIT_TRACE2 = '0';
  result.GIT_TRACE2_EVENT = '0';
  result.GIT_TRACE2_PERF = '0';
  return result;
}

function authenticatedEnvironment(base, canonicalUrl, token) {
  const env = cleanEnvironment(base);
  const settings = [
    ['credential.helper', ''],
    ['credential.https://github.com.helper', ''],
    [`credential.${canonicalUrl}.helper`, ''],
    ['core.askPass', ''],
    ['http.extraHeader', ''],
    [`http.${canonicalUrl}.extraHeader`, ''],
    [`http.${canonicalUrl}.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`],
    ['http.followRedirects', 'false'],
    [`http.${canonicalUrl}.followRedirects`, 'false'],
    ['http.sslVerify', 'true'],
    [`http.${canonicalUrl}.sslVerify`, 'true'],
    ['http.cookieFile', ''],
    ['http.saveCookies', 'false'],
    ['core.hooksPath', '/dev/null'],
    ['init.templateDir', ''],
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
    ['fetch.recurseSubmodules', 'false'],
    ['submodule.recurse', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always']
  ];
  env.GIT_ALLOW_PROTOCOL = 'https';
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function safeReason(error) {
  if (error?.code === 'ENOENT') return 'Git was not found. Install Git and make it available on PATH.';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'Access was denied. Check executable, filesystem and repository permissions.';
  if (error?.code === 'ETIMEDOUT' || error?.killed) return 'The Git operation timed out or was stopped. Inspect the checkout before retrying.';
  return undefined;
}

function createCuratedSkillsAuthentication({ secrets, execute = executeFile } = {}) {
  async function run(args, env, stage, sideEffects) {
    try {
      const { stdout } = await execute('git', args, { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env });
      return String(stdout || '').trim();
    } catch (error) {
      // Never retain backend stderr, command lines, environment, or exception payloads.
      throw new CuratedSkillsAuthenticationFailure(stage, { code: error?.code, sideEffects, reason: safeReason(error) });
    }
  }

  async function getGit(repositoryUrl) {
    const repository = repositoryDetails(repositoryUrl);
    const isHttps = /^https:\/\//i.test(repository.url);
    let token;
    if (isHttps) {
      try {
        if (typeof secrets?.get !== 'function') throw new Error('Secret storage unavailable');
        token = await secrets.get(repositoryKey(repository.url));
      } catch (error) {
        throw new CuratedSkillsAuthenticationFailure('access token retrieval', {
          code: error?.code,
          reason: 'VS Code encrypted secret storage could not be read. Reload the extension host and check secret-storage access; no alternate credentials were tried.'
        });
      }
      if (token !== undefined) token = validateAccessToken(token);
    }
    const base = cleanEnvironment(process.env);
    const canonicalUrl = `https://github.com/${repository.identity}.git`;
    const authentication = token === undefined ? 'git' : 'stored-token';
    async function verifyRuntimeConfiguration(root) {
      const sentinel = randomUUID();
      const env = { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'bcdevtoolset.authenticationProbe', GIT_CONFIG_VALUE_0: sentinel };
      const args = [...(root ? ['-C', root] : []), 'config', '--get', 'bcdevtoolset.authenticationProbe'];
      let observed;
      try { observed = await run(args, env, 'secure Git configuration support', 'not-started'); }
      catch (error) {
        throw new CuratedSkillsAuthenticationFailure('secure Git configuration support', {
          code: error.code,
          reason: `${error instanceof CuratedSkillsAuthenticationFailure ? error.reason : safeReason(error) || 'Git could not verify process-local authentication settings.'} Install Git 2.31 or later and check Git access; no token was sent and no alternate credentials were tried.`
        });
      }
      if (observed !== sentinel) {
        throw new CuratedSkillsAuthenticationFailure('secure Git configuration support', {
          reason: 'Git did not honor process-local authentication settings. Install Git 2.31 or later before using a stored token; no token was sent and no alternate credentials were tried.'
        });
      }
    }
    async function verifyTransport(root) {
      await verifyRuntimeConfiguration(root);
      const args = [...(root ? ['-C', root] : []), 'ls-remote', '--get-url', '--', canonicalUrl];
      const resolved = await run(args, { ...base }, 'repository transport inspection', 'not-started');
      if (resolved !== canonicalUrl) {
        throw new CuratedSkillsAuthenticationFailure('repository transport validation', {
          reason: 'Git URL rewriting changes the configured HTTPS endpoint. Remove that rewrite or configure the intended repository URL; no token was sent.'
        });
      }
    }
    const git = async args => {
      if (token === undefined) return run(args, { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, 'Git repository operation', args.includes('clone') || args.includes('pull') ? 'unknown' : 'not-started');
      const networkEnv = () => authenticatedEnvironment(base, canonicalUrl, token);
      if (args[0] === 'clone') {
        if (args.length !== 4 || args[1] !== '--' || repositoryDetails(args[2]).identity !== repository.identity) {
          throw new CuratedSkillsAuthenticationFailure('clone validation', { reason: 'The clone request does not match the configured repository. No clone was started.' });
        }
        const root = validateClonePath(args[3]);
        await verifyTransport();
        await run(['clone', '--no-checkout', '--', canonicalUrl, root], networkEnv(), 'private repository clone', 'unknown');
        // Checkout may invoke filters; it runs only after the credential-bearing child exits.
        return run(['-C', root, '-c', 'core.hooksPath=/dev/null', 'checkout', '--force'], { ...base }, 'initial checkout', 'unknown');
      }
      if (args.includes('pull')) {
        if (args.length !== 6 || args[0] !== '-C' || args[2] !== 'pull' || args[3] !== '--ff-only' || args[4] !== 'origin' || args[5] !== 'main') {
          throw new CuratedSkillsAuthenticationFailure('update validation', { reason: 'The update request does not match the supported fast-forward workflow. No update was started.' });
        }
        const root = validateClonePath(args[1]);
        await verifyTransport(root);
        await run(['-C', root, 'fetch', '--no-recurse-submodules', '--no-tags', '--', canonicalUrl, 'main'], networkEnv(), 'private repository fetch', 'unknown');
        // Worktree filters and merge hooks never inherit the stored access token.
        return run(['-C', root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', 'FETCH_HEAD'], { ...base }, 'fast-forward merge', 'unknown');
      }
      if (args[0] === 'ls-remote') {
        if (args.length !== 3 || args[1] !== '--' || repositoryDetails(args[2]).identity !== repository.identity) {
          throw new CuratedSkillsAuthenticationFailure('access check validation', { reason: 'The access check does not match the configured repository. No access check was started.' });
        }
        await verifyTransport();
        return run(['ls-remote', '--', canonicalUrl], networkEnv(), 'private repository access check', 'not-started');
      }
      // Local metadata commands receive neither the token nor its encoded header.
      return run(args, { ...base }, 'checkout inspection', 'not-started');
    };
    git.authentication = authentication;
    return git;
  }

  async function checkAccess(repositoryUrl) {
    const git = await getGit(repositoryUrl);
    await git(['ls-remote', '--', repositoryDetails(repositoryUrl).url]);
    return { authentication: git.authentication };
  }
  return { getGit, checkAccess };
}

module.exports = { createCuratedSkillsAuthentication, repositoryKey, validateAccessToken, CuratedSkillsAuthenticationFailure };
