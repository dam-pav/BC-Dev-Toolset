'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

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
