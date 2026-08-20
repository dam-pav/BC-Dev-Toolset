'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const extensionRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const operations = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'operations', 'operations.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(extensionRoot, 'extension.js'), 'utf8');
const runtimeBuildSource = fs.readFileSync(path.join(extensionRoot, 'build', 'prepare-runtime-package.js'), 'utf8');

test('declares and contributes the Show Help operation', () => {
  assert.deepEqual(operations.find(({ id }) => id === 'showHelp'), {
    id: 'showHelp',
    title: 'Show Help',
    command: 'showHelp',
    category: 'Prerequisites'
  });
  assert.ok(packageJson.activationEvents.includes('onCommand:bcDevToolset.operation.showHelp'));
  assert.ok(packageJson.contributes.commands.some(({ command, title }) => (
    command === 'bcDevToolset.operation.showHelp' && title === 'BC Dev Toolset: Show Help'
  )));
});

test('opens the bundled repository README in the rendered Markdown preview', () => {
  assert.match(extensionSource, /const readmePath = resolveWithinRoot\(toolsetPath, 'README\.md'\)/);
  assert.match(extensionSource, /executeCommand\('markdown\.showPreview', vscode\.Uri\.file\(readmePath\)\)/);
  assert.match(extensionSource, /copyRuntimeFile\(bundledRuntimePath, toolsetPath, 'README\.md'\)/);
  assert.match(runtimeBuildSource, /'README\.md'/);
});
