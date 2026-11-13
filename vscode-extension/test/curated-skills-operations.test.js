'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');
const pkg = require('../package.json');
const operations = require('../../operations/operations.json');
const { registerCuratedSkillsIntegration } = require('../curated-skills-vscode');
const extensionRoot = authorizeRoot(path.resolve(__dirname, '..'), 'Repository extension root');
const sourcePath = resolveWithinRoot(extensionRoot, 'extension.js');
const source = fs.readFileSync(sourcePath, 'utf8'); // nosemgrep -- fixed source is contained by the authorized repository extension root
const executeSource = source.match(/async function executeOperation\(operation, toolsetPath\) \{[^]*?\n}/)[0];

test('curated source settings are opt-in machine settings and activation reads only User values', () => {
  const properties = Object.assign({}, ...pkg.contributes.configuration.map(group => group.properties));
  for (const key of ['curatedSkillsRepositoryUrl', 'curatedSkillsPath']) {
    assert.equal(properties[`bcDevToolset.${key}`].scope, 'machine');
    assert.equal(properties[`bcDevToolset.${key}`].default, '');
    assert.ok(source.includes(`inspect('${key}')?.globalValue`));
  }
});

for (const [id, title] of [['updateCuratedSkills', 'Update Curated Skills'], ['showCuratedSkillsStatus', 'Show Curated Skills Status']]) {
  test(`${title} is exposed consistently and dispatches the registered command`, async () => {
    const operation = operations.find(entry => entry.id === id);
    assert.ok(operation);
    assert.equal(operation.title, title);
    assert.equal(operation.command, id);
    assert.equal(operation.category, 'Curated Skills');
    assert.ok(pkg.contributes.commands.some(entry => entry.command === `bcDevToolset.${id}`));
    assert.ok(pkg.activationEvents.includes(`onCommand:bcDevToolset.${id}`));
    const calls = [];
    const execute = vm.runInNewContext(`(${executeSource})`, {
      vscode: { commands: { executeCommand: async command => { calls.push(command); return true; } } }
    });
    assert.equal(await execute(operation), true);
    assert.deepEqual(calls, [`bcDevToolset.${id}`]);
  });

  test(`${title} preserves failed command status and does not retry`, async () => {
    let calls = 0;
    const execute = vm.runInNewContext(`(${executeSource})`, {
      vscode: { commands: { executeCommand: async () => { calls++; return false; } } }
    });
    assert.equal(await execute(operations.find(entry => entry.id === id)), false);
    assert.equal(calls, 1);
  });

  test(`${title} reports thrown failures without backend text`, async () => {
    const messages = [];
    let calls = 0;
    const execute = vm.runInNewContext(`(${executeSource})`, {
      vscode: {
        commands: { executeCommand: async () => { calls++; throw new Error('sensitive backend payload'); } },
        window: { showErrorMessage: async message => { messages.push(message); } }
      }
    });
    assert.equal(await execute(operations.find(entry => entry.id === id)), false);
    assert.equal(calls, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Show Curated Skills Status/);
    assert.match(messages[0], id === 'updateCuratedSkills' ? /partially completed|unknown/i : /No maintenance was started/i);
    assert.doesNotMatch(messages[0], /sensitive backend payload|\n\s+at /);
  });
}

function vscodeDouble() {
  const commands = new Map();
  let listener;
  let displayed;
  const errors = [];
  const disposable = { dispose() {} };
  const vscode = {
    commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable; } },
    workspace: {
      onDidChangeConfiguration(callback) { listener = callback; return disposable; },
      openTextDocument: async document => document
    },
    window: {
      showTextDocument: async document => { displayed = JSON.parse(document.content); },
      showErrorMessage: async message => { errors.push(message); }
    }
  };
  return { vscode, commands, change: event => listener(event), displayed: () => displayed, errors };
}

test('development activation and commands never read personal configuration or maintain files', async () => {
  const fixture = vscodeDouble();
  const integration = registerCuratedSkillsIntegration(fixture.vscode, { subscriptions: [] }, {
    getConfiguration() { assert.fail('Development host read production settings'); },
    isDevelopment: () => true,
    log() {}
  });
  assert.equal(integration.status.state, 'skipped');
  fixture.change({ affectsConfiguration: () => true });
  await fixture.commands.get('bcDevToolset.updateCuratedSkills')();
  await fixture.commands.get('bcDevToolset.showCuratedSkillsStatus')();
  assert.equal(fixture.displayed().state, 'skipped');
});

test('production lifecycle reconciles current configuration on activation and either setting change', async () => {
  const calls = [];
  let configuration = { repositoryUrl: '', path: '' };
  class FakeIntegration {
    constructor() { this.status = { state: 'disabled', adapters: [] }; }
    async reconcile(value) {
      calls.push(value);
      this.status = { state: value.repositoryUrl ? 'ready' : 'disabled', adapters: [] };
      return this.status;
    }
  }
  const register = vm.runInNewContext(`(${registerCuratedSkillsIntegration.toString()})`, { CuratedSkillsIntegration: FakeIntegration });
  const fixture = vscodeDouble();
  register(fixture.vscode, { subscriptions: [] }, {
    getConfiguration: () => configuration,
    log() {},
    isDevelopment: () => false
  });
  assert.equal(calls.length, 1);
  fixture.change({ affectsConfiguration: () => false });
  assert.equal(calls.length, 1);
  for (const key of ['curatedSkillsRepositoryUrl', 'curatedSkillsPath']) {
    configuration = { ...configuration, [key === 'curatedSkillsPath' ? 'path' : 'repositoryUrl']: key };
    fixture.change({ affectsConfiguration: name => name === `bcDevToolset.${key}` });
    assert.equal(calls.at(-1), configuration);
  }
  assert.equal(calls.length, 3);
  assert.equal(await fixture.commands.get('bcDevToolset.updateCuratedSkills')(), true);
  assert.equal(calls.length, 4);
  assert.equal(fixture.displayed().state, 'ready');
});

test('maintenance error remains a failed command even when the status document opens', async () => {
  class FakeIntegration {
    constructor() { this.status = { state: 'error', error: 'Clone failed. Verify configuration.', adapters: [] }; }
    async reconcile() { return this.status; }
  }
  const register = vm.runInNewContext(`(${registerCuratedSkillsIntegration.toString()})`, { CuratedSkillsIntegration: FakeIntegration });
  const fixture = vscodeDouble();
  register(fixture.vscode, { subscriptions: [] }, { getConfiguration: () => ({}), isDevelopment: () => false, log() {} });
  assert.equal(await fixture.commands.get('bcDevToolset.updateCuratedSkills')(), false);
  assert.equal(fixture.displayed().state, 'error');
});

test('failed remote update returns false with cached adapters while intentional update skips succeed', async () => {
  for (const updateFailed of [true, false]) {
    const safeFailure = 'Curated skills: fast-forward update failed (code 128). Inspect the checkout before retrying.';
    class FakeIntegration {
      constructor() { this.status = { state: 'warning', updateFailed, adapters: [{ name: 'cached' }], warnings: updateFailed ? [safeFailure] : ['Local changes preserved; update skipped.'] }; }
      async reconcile() { return this.status; }
    }
    const register = vm.runInNewContext(`(${registerCuratedSkillsIntegration.toString()})`, { CuratedSkillsIntegration: FakeIntegration });
    const fixture = vscodeDouble();
    register(fixture.vscode, { subscriptions: [] }, { getConfiguration: () => ({}), isDevelopment: () => false, log() {} });
    assert.equal(await fixture.commands.get('bcDevToolset.updateCuratedSkills')(), !updateFailed);
    assert.equal(fixture.displayed().adapters.length, 1);
    assert.deepEqual(fixture.errors, updateFailed ? [safeFailure] : []);
  }
});

test('status-document failure returns false without rerunning maintenance or displaying raw exceptions', async () => {
  let reconciliations = 0;
  class FakeIntegration {
    constructor() { this.status = { state: 'disabled', adapters: [] }; }
    async reconcile() { reconciliations++; return this.status; }
  }
  const register = vm.runInNewContext(`(${registerCuratedSkillsIntegration.toString()})`, { CuratedSkillsIntegration: FakeIntegration });
  const fixture = vscodeDouble();
  register(fixture.vscode, { subscriptions: [] }, { getConfiguration: () => ({}), isDevelopment: () => false, log() {} });
  fixture.vscode.workspace.openTextDocument = async () => { throw new Error('sensitive document backend payload'); };
  const before = reconciliations;
  assert.equal(await fixture.commands.get('bcDevToolset.showCuratedSkillsStatus')(), false);
  assert.equal(reconciliations, before);
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0], /No maintenance was started/);
  assert.match(fixture.errors[0], /Reload|retry/i);
  assert.doesNotMatch(fixture.errors[0], /sensitive document backend payload/);
});
