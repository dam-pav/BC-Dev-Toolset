'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');
const pkg = require('../package.json');
const operations = require('../../operations/operations.json');
const extensionRoot = authorizeRoot(path.resolve(__dirname, '..'), 'Repository extension root');
const extensionSourcePath = resolveWithinRoot(extensionRoot, 'extension.js');
const source = fs.readFileSync(extensionSourcePath, 'utf8'); // nosemgrep -- fixed source path validated within the authorized repository extension root
const executeSource = source.match(/async function executeOperation\(operation, toolsetPath\) \{[^]*?\n}/)[0];

for (const [id, title] of [['updateBcQuality', 'Update BCQuality'], ['showBcQualityStatus', 'Show BCQuality Status']]) {
  test(`${title} is available in the BCQuality category and dispatches its registered command`, async () => {
    const operation = operations.find(entry => entry.id === id);
    assert.deepEqual(operation, { id, title, command: id, category: 'BCQuality' });
    assert.ok(pkg.contributes.commands.some(entry => entry.command === `bcDevToolset.${id}`));
    assert.ok(pkg.activationEvents.includes(`onCommand:bcDevToolset.${id}`));
    const calls = [];
    const execute = vm.runInNewContext(`(${executeSource})`, {
      vscode: { commands: { executeCommand: async command => { calls.push(command); } } }
    });
    assert.equal(await execute(operation), true);
    assert.deepEqual(calls, [`bcDevToolset.${id}`]);
  });

  test(`${title} reports command failures safely without continuing or retrying`, async () => {
    const messages = [];
    let attempts = 0;
    const execute = vm.runInNewContext(`(${executeSource})`, {
      vscode: {
        commands: { executeCommand: async () => { attempts++; throw new Error('sensitive backend payload'); } },
        window: { showErrorMessage: async message => { messages.push(message); } }
      }
    });
    assert.equal(await execute(operations.find(entry => entry.id === id)), false);
    assert.equal(attempts, 1);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes(title));
    assert.match(messages[0], /Show BCQuality Status/);
    assert.match(messages[0], id === 'updateBcQuality' ? /partially completed/ : /No maintenance was started/);
    assert.doesNotMatch(messages[0], /sensitive backend payload|Error:|\n\s+at /);
  });
}
