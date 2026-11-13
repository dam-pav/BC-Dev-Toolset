'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');
const operations = require('../../operations/operations.json');
const pkg = require('../package.json');
const root = authorizeRoot(path.resolve(__dirname, '..'), 'Extension source root');
// Fixed source path confined to the authorized repository extension root.
const source = fs.readFileSync(resolveWithinRoot(root, 'extension.js'), 'utf8'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
const executeSource = source.match(/async function executeOperation\(operation, toolsetPath\) \{[^]*?\n}/)[0];

for (const id of ['configureCuratedSkillsAccessToken', 'removeCuratedSkillsAccessToken', 'checkCuratedSkillsAccess']) {
  test(`${id} is a human command with no script or credential arguments`, () => {
    const operation = operations.find(entry => entry.id === id);
    assert.equal(operation.command, id);
    assert.equal(operation.category, 'Curated Skills');
    assert.deepEqual(Object.keys(operation).sort(), ['category', 'command', 'id', 'title']);
    assert.ok(pkg.contributes.commands.some(entry => entry.command === `bcDevToolset.${id}`));
    assert.ok(pkg.activationEvents.includes(`onCommand:bcDevToolset.${id}`));
  });

  test(`${id} preserves command failure and redacts thrown failures without retry`, async () => {
    for (const throws of [false, true]) {
      let count = 0;
      const messages = [];
      const execute = vm.runInNewContext(`(${executeSource})`, {
        vscode: {
          commands: { async executeCommand(name) {
            count++;
            assert.equal(name, `bcDevToolset.${id}`);
            if (throws) throw new Error('synthetic-secret-backend-payload');
            return false;
          } },
          window: { showErrorMessage: async message => messages.push(message) }
        }
      });
      assert.equal(await execute(operations.find(entry => entry.id === id)), false);
      assert.equal(count, 1);
      if (throws) {
        assert.equal(messages.length, 1);
        assert.match(messages[0], /Check Curated Skills Access/);
        assert.match(messages[0], id === 'checkCuratedSkillsAccess' ? /No checkout, adapter or credential changes/ : /storage outcome is unknown/);
        assert.doesNotMatch(messages[0], /synthetic-secret|backend-payload|\n\s+at /);
      } else assert.deepEqual(messages, []);
    }
  });
}
