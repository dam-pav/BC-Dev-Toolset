'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { afterEach, test } = require('node:test');
const identity = require('../mcp-bridge-identity');

const temporaryDirectories = [];
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-identity-test-'));
  temporaryDirectories.push(value);
  return value;
}

function state(instanceId, workspacePath, updatedAt) {
  return identity.createState({
    instanceId, url: `http://127.0.0.1:${instanceId.endsWith('1') ? 41001 : 41002}`,
    token: 'a'.repeat(64), extensionHostPid: process.pid,
    workspace: { workspacePath, workspaceFilePath: path.join(workspacePath, `${path.basename(workspacePath)}.code-workspace`), workspaceFolders: [{ path: workspacePath }] },
    updatedAt
  });
}

test('DRI then OTP startup binds each working directory independently', () => {
  const root = directory(), dri = path.join(root, 'DRI'), otp = path.join(root, 'OTP');
  fs.mkdirSync(dri); fs.mkdirSync(otp);
  const states = path.join(root, 'states');
  identity.writeOwnedState(states, state('11111111-1111-4111-8111-111111111111', dri, '2026-01-01T00:00:00Z'));
  identity.writeOwnedState(states, state('22222222-2222-4222-8222-222222222222', otp, '2026-01-01T00:00:01Z'));
  assert.match(identity.discoverState(states, dri).instanceId, /^1111/);
  assert.match(identity.discoverState(states, otp).instanceId, /^2222/);
});

test('OTP then DRI startup order does not change workspace selection', () => {
  const root = directory(), dri = path.join(root, 'DRI'), otp = path.join(root, 'OTP');
  fs.mkdirSync(dri); fs.mkdirSync(otp);
  const states = path.join(root, 'states');
  identity.writeOwnedState(states, state('22222222-2222-4222-8222-222222222222', otp, '2026-01-01T00:00:00Z'));
  identity.writeOwnedState(states, state('11111111-1111-4111-8111-111111111111', dri, '2026-01-01T00:00:01Z'));
  assert.match(identity.discoverState(states, otp).instanceId, /^2222/);
  assert.match(identity.discoverState(states, dri).instanceId, /^1111/);
});

test('simultaneous activation and reload choose the newest instance only within the same workspace', () => {
  const root = directory(), dri = path.join(root, 'DRI'); fs.mkdirSync(dri);
  const states = path.join(root, 'states');
  identity.writeOwnedState(states, state('11111111-1111-4111-8111-111111111111', dri, '2026-01-01T00:00:00Z'));
  identity.writeOwnedState(states, state('33333333-3333-4333-8333-333333333333', dri, '2026-01-01T00:00:01Z'));
  assert.match(identity.discoverState(states, dri).instanceId, /^3333/);
  fs.rmSync(path.join(states, '33333333-3333-4333-8333-333333333333.json'));
  assert.match(identity.discoverState(states, dri).instanceId, /^1111/);
});

test('closing one window removes only its owned state', () => {
  const root = directory(), states = path.join(root, 'states');
  const one = state('11111111-1111-4111-8111-111111111111', root, '2026-01-01T00:00:00Z');
  const two = state('22222222-2222-4222-8222-222222222222', root, '2026-01-01T00:00:01Z');
  identity.writeOwnedState(states, one); identity.writeOwnedState(states, two);
  identity.cleanupStates(states, { ownedInstanceId: one.instanceId });
  assert.equal(fs.existsSync(path.join(states, `${one.instanceId}.json`)), false);
  assert.equal(fs.existsSync(path.join(states, `${two.instanceId}.json`)), true);
});

test('stale and legacy state files are cleaned without deleting live instances', () => {
  const root = directory(), states = path.join(root, 'states'); fs.mkdirSync(states);
  const live = state('11111111-1111-4111-8111-111111111111', root, new Date().toISOString());
  identity.writeOwnedState(states, live);
  fs.writeFileSync(path.join(states, identity.legacyStateFileName), '{}');
  fs.writeFileSync(path.join(states, 'broken.json'), '{');
  identity.cleanupStates(states);
  assert.deepEqual(fs.readdirSync(states), [`${live.instanceId}.json`]);
});

test('workspace, operation, prompt, and status bindings reject deliberate cross-window routing', () => {
  const root = directory(), dri = path.join(root, 'DRI'), otp = path.join(root, 'OTP');
  const expected = { instanceId: '11111111-1111-4111-8111-111111111111', extensionHostPid: process.pid };
  assert.equal(identity.validateBinding(expected, { ...expected, protocolVersion: identity.protocolVersion }), true);
  assert.equal(identity.validateBinding(expected, { protocolVersion: identity.protocolVersion, instanceId: '22222222-2222-4222-8222-222222222222', extensionHostPid: process.pid }), false);
  assert.equal(identity.workspaceOwnsPath({ workspacePath: dri, workspaceFolders: [{ path: dri }] }, path.join(dri, 'App')), true);
  assert.equal(identity.workspaceOwnsPath({ workspacePath: dri, workspaceFolders: [{ path: dri }] }, path.join(otp, 'App')), false);
});
