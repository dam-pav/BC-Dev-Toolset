'use strict';
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { authorizeRoot, resolveWithinRoot } = require('./path-security');

class DataCredentialError extends Error {
  constructor(category = 'credential_unavailable') {
    super(category === 'credential_missing'
      ? 'Stored BC credentials are missing. Use Configure stored credentials for this container; plaintext settings are ignored.'
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
    for (const pending of current.pending.values()) { clearTimeout(pending.timer); pending.reject(new DataCredentialError()); }
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
        if (line.length > 16384) { stop(current); return; }
        let reply;
        try { reply = JSON.parse(line); } catch { stop(current); return; }
        const pending = current.pending.get(reply?.id);
        if (!pending) { stop(current); return; }
        const keys = Object.keys(reply);
        const failed = keys.length === 2 && keys.includes('error') && ['credential_missing', 'credential_unavailable'].includes(reply.error);
        const success = keys.length === 3 && keys.includes('username') && keys.includes('password') &&
          typeof reply.username === 'string' && reply.username.length > 0 && reply.username.length <= 513 && !reply.username.includes(':') &&
          typeof reply.password === 'string' && reply.password.length > 0 && reply.password.length <= 1280;
        if (!failed && !success) { stop(current); return; }
        current.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (failed) pending.reject(new DataCredentialError(reply.error));
        else pending.resolve({ username: reply.username, password: reply.password });
      }
      if (current.output.length > 16384) stop(current);
    });
    child.stdin.on('error', () => stop(current));
    child.stdout.on('error', () => stop(current));
    child.on('error', () => stop(current));
    child.on('close', () => stop(current));
    return current;
  }
  return {
    read(container) {
      if (typeof container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(container)) return Promise.reject(new DataCredentialError());
      let current;
      try { current = worker || start(); } catch { return Promise.reject(new DataCredentialError()); }
      if (current.pending.size >= 16) return Promise.reject(new DataCredentialError());
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => stop(current), timeoutMs);
        current.pending.set(id, { resolve, reject, timer });
        try { current.child.stdin.write(JSON.stringify({ id, container }) + '\n'); }
        catch { stop(current); }
      });
    },
    dispose() { disposed = true; stop(worker); }
  };
}
module.exports = { createCredentialProvider, DataCredentialError };
