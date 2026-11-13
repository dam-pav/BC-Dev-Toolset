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
  test(`${title} is available in the Curated Skills category and dispatches its registered command`, async () => {
    const operation = operations.find(entry => entry.id === id);
    assert.deepEqual(operation, { id, title, command: id, category: 'Curated Skills' });
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

test('all skill operations share Curated Skills without a separate BCQuality category', () => {
  assert.deepEqual(operations.filter(entry => entry.category === 'Curated Skills').map(entry => entry.id).sort(), [
    'checkCuratedSkillsAccess', 'configureCuratedSkillsAccessToken', 'removeCuratedSkillsAccessToken',
    'showBcQualityStatus', 'showCuratedSkillsStatus', 'updateBcQuality', 'updateCuratedSkills'
  ]);
  assert.ok(!operations.some(entry => entry.category === 'BCQuality'));
});

test('operation references document all skill commands under the combined category', () => {
  const repositoryRoot = authorizeRoot(path.resolve(extensionRoot, '..'), 'Repository documentation root');
  const repositoryReadme = fs.readFileSync(resolveWithinRoot(repositoryRoot, 'README.md'), 'utf8'); // nosemgrep -- fixed filename confined to the authorized repository documentation root
  const extensionReadme = fs.readFileSync(resolveWithinRoot(extensionRoot, 'README.md'), 'utf8'); // nosemgrep -- fixed filename confined to the authorized extension root
  const operationReference = extensionReadme.split('\n## Operations')[1].split('\n## Settings')[0];
  assert.equal(operationReference.split(/\n### Curated Skills\r?\n/).length, 2);
  assert.doesNotMatch(operationReference, /\n### BCQuality\r?\n/);
  const combinedCategory = operationReference.split(/\n### Curated Skills\r?\n/)[1].split('\n### ')[0];
  for (const title of ['Update BCQuality', 'Show BCQuality Status', 'Update Curated Skills', 'Show Curated Skills Status',
    'Configure Curated Skills Access Token', 'Remove Curated Skills Access Token', 'Check Curated Skills Access']) {
    assert.ok(combinedCategory.includes('| `' + title + '` |'), `${title} must be documented in Curated Skills`);
  }
  assert.match(repositoryReadme, /choose \*\*Curated Skills\*\* for \*\*Update BCQuality\*\* and \*\*Show BCQuality Status\*\*/);
  assert.doesNotMatch(extensionReadme, /under \*\*BCQuality\*\* in \*\*Show Operations List\*\*/);
});
