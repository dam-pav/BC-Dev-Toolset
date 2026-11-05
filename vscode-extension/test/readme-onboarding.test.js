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
