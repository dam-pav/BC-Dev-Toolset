'use strict';

const fs = require('fs');
const path = require('path');
const { authorizeRoot, resolveWithinRoot } = require('./path-security');

const protocolVersion = 2;
const legacyStateFileName = 'vscode-bridge.json';

function normalizePath(value) {
  return value ? path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase() : ''; // nosemgrep -- normalization only; no filesystem access
}

function isSameOrChild(parent, candidate) {
  const normalizedParent = normalizePath(parent);
  const normalizedCandidate = normalizePath(candidate);
  if (!normalizedParent || !normalizedCandidate) return false;
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getWorkspaceRoots(workspace) {
  const values = [
    workspace && workspace.workspacePath,
    workspace && workspace.workspaceBasePath,
    ...((workspace && workspace.workspaceFolders) || []).map((folder) => folder.path)
  ];
  if (workspace && workspace.workspaceFilePath) values.push(path.dirname(workspace.workspaceFilePath));
  return [...new Set(values.map(normalizePath).filter(Boolean))];
}

function workspaceOwnsPath(workspace, candidate) {
  return getWorkspaceRoots(workspace).some((root) => isSameOrChild(root, candidate));
}

function validateBinding(expected, supplied) {
  return Boolean(expected && supplied && supplied.protocolVersion === protocolVersion &&
    supplied.instanceId === expected.instanceId && supplied.extensionHostPid === expected.extensionHostPid);
}

function createState({ instanceId, url, token, extensionHostPid, workspace, updatedAt = new Date().toISOString() }) {
  return { protocolVersion, instanceId, url, token, extensionHostPid, workspace, updatedAt };
}

function validateState(state) {
  if (!state || state.protocolVersion !== protocolVersion) return 'protocol version mismatch';
  if (!/^[0-9a-f-]{20,}$/i.test(String(state.instanceId || ''))) return 'invalid instance ID';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(state.url || ''))) return 'invalid bridge URL';
  if (!state.token || String(state.token).length < 32) return 'invalid bridge token';
  if (!Number.isInteger(state.extensionHostPid) || state.extensionHostPid <= 0) return 'invalid extension-host PID';
  if (!state.workspace || getWorkspaceRoots(state.workspace).length === 0) return 'missing workspace identity';
  return '';
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return false; }
}

function writeOwnedState(stateDirectory, state) {
  const error = validateState(state);
  if (error) throw new Error(`Cannot write MCP bridge state: ${error}.`);
  const authorizedStateDirectory = authorizeRoot(stateDirectory, 'MCP bridge state directory');
  // The caller-authorized root is normalized above; all child paths are containment-checked below.
  fs.mkdirSync(authorizedStateDirectory, { recursive: true }); // nosemgrep
  const statePath = resolveWithinRoot(authorizedStateDirectory, `${state.instanceId}.json`);
  const temporaryPath = resolveWithinRoot(authorizedStateDirectory, `${state.instanceId}.json.${process.pid}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); // nosemgrep -- containment checked
  fs.renameSync(temporaryPath, statePath); // nosemgrep -- both paths share the authorized root
  return statePath;
}

function cleanupStates(stateDirectory, { ownedInstanceId = '' } = {}) {
  const authorizedStateDirectory = authorizeRoot(stateDirectory, 'MCP bridge state directory'); // nosemgrep -- normalized authorization boundary
  if (!fs.existsSync(authorizedStateDirectory)) return []; // nosemgrep -- authorized root
  const removed = [];
  for (const name of fs.readdirSync(authorizedStateDirectory)) { // nosemgrep -- authorized root
    const validatedStatePath = resolveWithinRoot(authorizedStateDirectory, name);
    if (name === legacyStateFileName || name.endsWith('.tmp')) {
      fs.rmSync(validatedStatePath, { force: true }); removed.push(validatedStatePath); continue; // nosemgrep -- containment checked
    }
    if (!name.endsWith('.json')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(validatedStatePath, 'utf8')); // nosemgrep -- containment checked
      const alive = isProcessAlive(state.extensionHostPid);
      const stale = validateState(state) || state.instanceId === ownedInstanceId || !alive;
      if (stale) { fs.rmSync(validatedStatePath, { force: true }); removed.push(validatedStatePath); } // nosemgrep -- containment checked
    } catch (error) { fs.rmSync(validatedStatePath, { force: true }); removed.push(validatedStatePath); } // nosemgrep -- containment checked
  }
  return removed;
}

function discoverState(stateDirectory, workingDirectory) {
  const authorizedStateDirectory = authorizeRoot(stateDirectory, 'MCP bridge state directory'); // nosemgrep -- normalized authorization boundary
  if (!fs.existsSync(authorizedStateDirectory)) throw new Error('No BC Dev Toolset bridge instances are registered.'); // nosemgrep -- authorized root
  const matches = [];
  for (const name of fs.readdirSync(authorizedStateDirectory).filter((item) => item.endsWith('.json') && item !== legacyStateFileName)) { // nosemgrep -- authorized root
    try {
      const statePath = resolveWithinRoot(authorizedStateDirectory, name);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); // nosemgrep -- containment checked
      if (!validateState(state) && isProcessAlive(state.extensionHostPid) && workspaceOwnsPath(state.workspace, workingDirectory)) matches.push(state);
    } catch (error) { /* Invalid state is ignored and cleaned by the extension host. */ }
  }
  if (matches.length === 0) throw new Error(`No live BC Dev Toolset bridge owns MCP working directory '${workingDirectory}'.`);
  matches.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const bestTime = Date.parse(matches[0].updatedAt);
  if (matches.length > 1 && Date.parse(matches[1].updatedAt) === bestTime) throw new Error('Multiple BC Dev Toolset bridges ambiguously own this MCP workspace.');
  return matches[0];
}

module.exports = { protocolVersion, legacyStateFileName, createState, validateState, validateBinding, writeOwnedState, cleanupStates, discoverState, workspaceOwnsPath, getWorkspaceRoots };
