'use strict';
const { DataTransportError } = require('./bc-data-http10');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { authorizeRoot, resolveWithinRoot } = require('./path-security');

class DataCredentialError extends Error {
  constructor(category = 'credential_unavailable') {
    super(category === 'credential_missing'
      ? 'Stored BC credentials are missing. Use Configure stored credentials for this configuration; plaintext settings are ignored.'
      : 'Stored BC credentials could not be read. Check Windows Credential Manager and the configured PowerShell executable; plaintext settings are ignored.');
    this.name = 'DataCredentialError';
    this.category = category;
  }
}

// One private, lazy worker per extension host. No operation runner, shell,
// credential arguments/environment, log files, or persistent credential cache.
function createCredentialProvider({ toolsetRoot, powershellExecutable = 'pwsh', spawnWorker = spawn,
  timeoutMs = 10000, platform = process.platform }) {
  const root = authorizeRoot(toolsetRoot, 'BC Data credential helper root');
  const helper = resolveWithinRoot(root, 'common', 'ReadBcDataCredential.ps1');
  if (typeof powershellExecutable !== 'string' || !powershellExecutable || powershellExecutable.includes('\0') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new DataCredentialError();
  let worker;
  let disposed = false;
  function stop(current) {
    if (!current || current.stopped) return;
    current.stopped = true;
    if (worker === current) worker = undefined;
    for (const pending of current.pending.values()) { clearTimeout(pending.timer); pending.reject(pending.http ? new DataTransportError('connection_failure') : new DataCredentialError()); }
    current.pending.clear();
    current.output = '';
    try { current.child.kill(); } catch { /* Worker already exited; pending calls are rejected above. */ }
  }
  function start() {
    if (disposed || platform !== 'win32') throw new DataCredentialError();
    const child = spawnWorker(powershellExecutable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    const current = { child, pending: new Map(), output: '', stopped: false };
    worker = current;
    child.stderr.resume(); // Never forward backend stderr into logs/MCP.
    child.stderr.on('error', () => stop(current));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (current.stopped) return;
      current.output += chunk;
      let boundary;
      while ((boundary = current.output.indexOf('\n')) >= 0) {
        const line = current.output.slice(0, boundary).replace(/\r$/, '');
        current.output = current.output.slice(boundary + 1);
        if (line.length > (Array.from(current.pending.values()).some(item => item.http) ? 6 * 1024 * 1024 : 16384)) { stop(current); return; }
        let reply;
        try { reply = JSON.parse(line); } catch { stop(current); return; }
        const pending = current.pending.get(reply?.id);
        if (!pending) { stop(current); return; }
        const keys = Object.keys(reply);
        const failed = keys.length === 2 && keys.includes('error') && ['credential_missing', 'credential_unavailable', 'transport_failure'].includes(reply.error);
        const success = !pending.http && keys.length === 3 && keys.includes('username') && keys.includes('password') &&
          typeof reply.username === 'string' && reply.username.length > 0 && reply.username.length <= 513 && !reply.username.includes(':') &&
          typeof reply.password === 'string' && reply.password.length > 0 && reply.password.length <= 1280;
        const http = pending.http && keys.length === 3 && Number.isInteger(reply.status) && reply.status >= 100 && reply.status <= 599 && typeof reply.body === 'string' && reply.body.length <= 6 * 1024 * 1024;
        if (!failed && !success && !http) { stop(current); return; }
        current.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (failed) pending.reject(pending.http ? new DataTransportError('connection_failure') : new DataCredentialError(reply.error));
        else if (http) pending.resolve({ status: reply.status, body: Buffer.from(reply.body, 'base64') });
        else pending.resolve({ username: reply.username, password: reply.password });
      }
      if (current.output.length > (Array.from(current.pending.values()).some(item => item.http) ? 6 * 1024 * 1024 : 16384)) stop(current);
    });
    child.stdin.on('error', () => stop(current));
    child.stdout.on('error', () => stop(current));
    child.on('error', () => stop(current));
    child.on('close', () => stop(current));
    return current;
  }
  function exchange(payload, http = false) {
      let current;
      try { current = worker || start(); } catch { return Promise.reject(http ? new DataTransportError('connection_failure') : new DataCredentialError()); }
      if (current.pending.size >= 16) return Promise.reject(new DataCredentialError());
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => stop(current), http ? 35000 : timeoutMs);
        current.pending.set(id, { resolve, reject, timer, http });
        try { current.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n'); }
        catch { stop(current); }
      });
  }
  return {
    request(request) { return exchange({ http: request }, true); },
    readConfiguration(configuration, projectScope) {
      if (!configuration || configuration.serverType !== 'OnPrem' || typeof projectScope !== 'string' || !/^[0-9a-f-]{36}$/i.test(projectScope)) return Promise.reject(new DataCredentialError());
      return exchange({ configuration, projectScope });
    },
    read(container) {
      if (typeof container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(container)) return Promise.reject(new DataCredentialError());
      return exchange({ container });
    },
    dispose() { disposed = true; stop(worker); }
  };
}
module.exports = { createCredentialProvider, DataCredentialError };
