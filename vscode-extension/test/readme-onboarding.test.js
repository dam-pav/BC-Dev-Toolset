'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = authorizeRoot(path.resolve(__dirname, '..', '..'), 'Repository root');
const extensionReadmePath = resolveWithinRoot(repositoryRoot, 'vscode-extension', 'README.md');
const repositoryReadmePath = resolveWithinRoot(repositoryRoot, 'README.md');
const readme = fs.readFileSync(extensionReadmePath, 'utf8'); // nosemgrep -- fixed README path validated within the authorized repository root
const repositoryReadme = fs.readFileSync(repositoryReadmePath, 'utf8'); // nosemgrep -- fixed README path validated within the authorized repository root

test('repository README introduces BC Data in its own chapter before BCQuality', () => {
  const switches = repositoryReadme.split('#### MCP tool switches')[1].split('\n#### ')[0];
  assert.doesNotMatch(switches, /BC Data access provides/);
  assert.match(repositoryReadme, /^## BC Data access\r?\n\r?\nBC Data access provides[^\r\n]+\r?\n\r?\n## BCQuality integration/m);
});

test('repository settings references use two-column tables', () => {
  const setup = repositoryReadme.split('\n## Setup')[1];
  assert.doesNotMatch(setup, /^- `[^`]+`:/m);
  for (const heading of ['### Extension settings', '### Workspace settings', '#### Configurations', '### Local settings']) {
    const section = setup.split(heading)[1].split(/\n#{3,4} /)[0];
    assert.match(section, /\| Setting +\| Description +\|\r?\n\| -{3,} +\| -{3,} +\|/);
    assert.match(section, /^\| `[^`]+` +\| .+ \|$/m);
  }
  assert.match(setup, /\| `bcCredential`, `remoteCredential`, `databaseCredential` \|/);
  for (const row of setup.split(/\r?\n/).filter(line => line.startsWith('|'))) {
    assert.equal(row.split(/(?<!\\)\|/).length, 4, 'settings table rows must have two columns');
  }
});

test('publishing target guidance is a chapter immediately before Setup', () => {
  const chapters = repositoryReadme.split(/^## /m).slice(1);
  const publishingIndex = chapters.findIndex(chapter => chapter.startsWith('Publishing\r\n') || chapter.startsWith('Publishing\n'));
  assert.ok(publishingIndex >= 0);
  assert.ok(chapters[publishingIndex + 1].startsWith('Setup'));
  assert.match(chapters[publishingIndex], /Supply the exact `configurationName`/);
  assert.doesNotMatch(repositoryReadme, /^### Selecting publishing targets/m);
});

test('onboarding keeps settings brief and links to the detailed reference', () => {
  const gettingStarted = readme.split('## Getting started')[1].split('\n## ')[0];
  const settings = readme.split('\n## Settings')[1];

  assert.match(gettingStarted, /\[Settings reference\]\(#settings\)/);
  assert.match(gettingStarted, /- `configurations`:/);
  for (const setting of [
    'dependenciesPath', 'packageOutputPath', 'sqlBackupPath', 'certificateFile',
    'recordingsPath', 'pageScriptTestResultsPath', 'testIsolationDisabledCodeunits'
  ]) {
    assert.ok(!gettingStarted.includes('`' + setting + '`'), `${setting} belongs in the reference`);
    assert.ok(settings.includes('`' + setting + '`'), `${setting} must remain documented`);
  }
});

test('operation and settings references use two-column tables', () => {
  const reference = readme.split('\n## Operations')[1];
  const operations = reference.split('\n## Settings')[0];
  const settings = reference.split('\n## Settings')[1];

  for (const category of operations.split('\n### ').slice(1)) {
    assert.match(category, /\| Operation \| Description \|\r?\n\| --- \| --- \|/);
    assert.match(category, /^\| `[^`]+` \| .+ \|$/m);
  }
  assert.doesNotMatch(reference, /^- `[^`]+`:/m);
  for (const name of ['VS Code extension settings', 'Workspace settings', 'Local settings']) {
    const section = settings.split('### ' + name)[1].split('\n### ')[0];
    assert.match(section, /\| Setting \| Description \|\r?\n\| --- \| --- \|/);
  }
  for (const row of reference.split(/\r?\n/).filter(line => line.startsWith('|'))) {
    assert.equal(row.split(/(?<!\\)\|/).length, 4, 'reference table rows must have two columns');
  }
});
