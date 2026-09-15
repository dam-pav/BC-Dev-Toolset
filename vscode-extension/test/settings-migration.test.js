'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { planSettingsMigration, migrateSettingsOnStartup } = require('../settings-migration');

function renamed(text, workspace = false) {
  const plan = planSettingsMigration(text, workspace);
  return { plan, text: plan.edits.sort((a, b) => b.start - a.start)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text) };
}

test('renames both historical casings and preserves all contents and JSONC formatting', () => {
  const source = '\ufeff{\r\n // keep comment\r\n "dam-pav.bcdevtoolset": {"unknown": [null,false,0,{"dam-pav.bcDevToolset":"keep"}],},\r\n "dam-pav.bcDevToolset.custom": false,\r\n "unrelated": "dam-pav.bcdevtoolset"\r\n}';
  const result = renamed(source);
  assert.equal(result.plan.edits.length, 2);
  assert.equal(result.text, source.replace('"dam-pav.bcdevtoolset":', '"bcDevToolset":')
    .replace('"dam-pav.bcDevToolset.custom":', '"bcDevToolset.custom":'));
  assert.equal(renamed(result.text).plan.edits.length, 0);
});

test('workspace migration touches settings and language overrides only', () => {
  const source = '{"folders":[{"dam-pav.bcdevtoolset":"untouched"}],"settings":{"[al]":{"dam-pav.bcDevToolset.unknown":{"x":1}}},"dam-pav.bcdevtoolset":"untouched"}';
  const result = renamed(source, true);
  assert.equal(result.plan.edits.length, 1);
  assert.equal(result.text, source.replace('"dam-pav.bcDevToolset.unknown"', '"bcDevToolset.unknown"'));
});

test('existing destination values and duplicate aliases are never overwritten', () => {
  const result = renamed('{"bcDevToolset.x":false,"dam-pav.bcdevtoolset.x":true,"dam-pav.bcdevtoolset.y":1,"dam-pav.bcDevToolset.y":2}');
  assert.deepEqual(result.plan.conflicts, ['dam-pav.bcdevtoolset.x', 'dam-pav.bcDevToolset.y']);
  assert.equal(result.plan.edits.length, 1);
  assert.equal(JSON.parse(result.text)['bcDevToolset.x'], false);
  assert.equal(JSON.parse(result.text)['dam-pav.bcDevToolset.y'], 2);
});

test('invalid JSONC never produces partial edits', () => {
  for (const text of ['{"dam-pav.bcdevtoolset":', '{"dam-pav.bcdevtoolset":true}oops', '{"dam-pav.bcdevtoolset":undefined}', '{"dam-pav.bcdevtoolset":"bad\\q"}']) {
    assert.throws(() => planSettingsMigration(text));
  }
});

test('empty files need no migration and escaped legacy names are still recognized', () => {
  assert.deepEqual(planSettingsMigration(' // User settings\n'), { edits: [], conflicts: [] });
  assert.equal(renamed('{"dam\\u002dpav.bcDevToolset.x":false}').text, '{"bcDevToolset.x":false}');
});

function harness(initialFiles, dirty = new Set()) {
  const files = new Map(Object.entries(initialFiles)), documents = new Map();
  const notifications = [], warnings = [];
  const uri = value => ({ path: value, scheme: 'file', toString: () => value });
  class WorkspaceEdit {
    edits = [];
    replace(uri, range, text) { this.edits.push({ uri, range, text }); }
  }
  const vscode = {
    Uri: { joinPath: (root, ...parts) => uri(path.posix.join(root.path, ...parts)) },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit,
    workspace: {
      workspaceFile: uri('/project/project.code-workspace'),
      workspaceFolders: [{ uri: uri('/project/app') }],
      fs: { stat: async target => { if (!files.has(target.path)) throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); } },
      openTextDocument: async target => {
        const document = {
          text: files.get(target.path), isDirty: dirty.has(target.path),
          getText() { return this.text; }, positionAt(offset) { return offset; },
          async save() { files.set(target.path, this.text); return true; }
        };
        documents.set(target.path, document);
        return document;
      },
      applyEdit: async edit => {
        for (const change of edit.edits.sort((a, b) => b.range.start - a.range.start)) {
          const document = documents.get(change.uri.path);
          document.text = document.text.slice(0, change.range.start) + change.text + document.text.slice(change.range.end);
        }
        return true;
      }
    },
    window: {
      showInformationMessage: async (...args) => notifications.push(args),
      showWarningMessage: async (...args) => warnings.push(args)
    }
  };
  return { files, notifications, warnings,
    run: () => migrateSettingsOnStartup(vscode, { globalStorageUri: uri('/user/globalStorage/extension') }, () => {}) };
}

test('startup migrates user, workspace and folder files, then notifies without asking', async () => {
  const setup = harness({
    '/user/settings.json': '{"dam-pav.bcDevToolset.custom":{"a":[1,2]}}',
    '/project/project.code-workspace': '{"settings":{"dam-pav.bcdevtoolset":{"configurations":[{"name":"test"}]}}}',
    '/project/app/.vscode/settings.json': '{"dam-pav.bcdevtoolset.custom":false}'
  });
  assert.deepEqual(await setup.run(), { renamed: 3, conflicts: 0, failed: 0 });
  assert.equal(setup.notifications.length, 1);
  assert.equal(setup.notifications[0].length, 1); // no buttons or modal confirmation
  for (const text of setup.files.values()) assert.ok(!text.includes('dam-pav.'));
  assert.deepEqual(await setup.run(), { renamed: 0, conflicts: 0, failed: 0 });
  assert.equal(setup.notifications.length, 1);
});

test('startup leaves dirty files and collisions intact and does not create absent files', async () => {
  const original = '{"dam-pav.bcdevtoolset.x":true}';
  const setup = harness({
    '/user/settings.json': original,
    '/project/app/.vscode/settings.json': '{"dam-pav.bcdevtoolset.x":true,"bcDevToolset.x":false}'
  }, new Set(['/user/settings.json']));
  assert.deepEqual(await setup.run(), { renamed: 0, conflicts: 1, failed: 1 });
  assert.equal(setup.files.get('/user/settings.json'), original);
  assert.equal(setup.files.size, 2);
  assert.equal(setup.warnings.length, 1);
});
