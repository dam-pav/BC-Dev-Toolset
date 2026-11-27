'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BcQualityFiles } = require('../bcquality-files');
const { assertWithinRoot, authorizeRoot, resolveWithinRoot } = require('../path-security');
const {
  assertKnownTestCodeunits,
  getTestCodeunitCatalog,
  normalizeTestCodeunitIds,
  pickTestCodeunits
} = require('../test-codeunit-selection');

const selectionFilename = 'test-codeunit-selection.json';

async function temporaryDirectory(t) {
  const tempRoot = authorizeRoot(os.tmpdir(), 'Temporary fixture parent');
  const prefix = resolveWithinRoot(tempRoot, 'bcdevtoolset-test-codeunit-selection-');
  const root = assertWithinRoot(tempRoot, await fs.mkdtemp(prefix)); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- fixed prefix is confined to the authorized OS temporary parent
  const files = new BcQualityFiles(root);
  t.after(() => files.rm(root, { recursive: true, force: true }));
  return { root, files };
}

async function createApp(files, root, id, name, source) {
  await files.mkdir(root, { recursive: true });
  await files.writeFile(path.join(root, 'app.json'), JSON.stringify({ id, name, application: '27.0.0.0' }));
  await files.writeFile(path.join(root, 'Codeunits.al'), source);
}

function createVscode(folders, choose, messages = []) {
  return {
    workspace: {
      workspaceFolders: folders.map(fsPath => ({ uri: { scheme: 'file', fsPath } }))
    },
    window: {
      showQuickPick: choose,
      showWarningMessage: async message => { messages.push(message); }
    },
    QuickPickItemKind: { Separator: -1 }
  };
}

test('discovers test codeunits from AL declarations and groups by workspace app', async t => {
  const { root, files } = await temporaryDirectory(t);
  const nested = path.join(root, 'nested-app');
  const unopenedApp = path.join(root, 'unopened-app');
  const other = path.join(root, 'ordinary-folder');
  await createApp(files, root, 'id-b', 'Business app', `
    // codeunit 61 "Comment" { Subtype = Test; }
    namespace Fixture.Root;
    using Fixture.Support;
    codeunit 7 /* a comment between tokens */ "Grouped ""Test""" { sUbTyPe = tEsT; }
    codeunit 4 OtherTest { SubType = Test; }
    codeunit 6 Ordinary {
      // Subtype = Test;
      /* Subtype = Test; */
      var Example: Label 'Subtype = Test; codeunit 8 Fake { Subtype = Test; }';
    }
  `);
  await createApp(files, nested, 'id-a', 'Another app', 'codeunit 9 NestedTest { Subtype = Test; }');
  await createApp(files, unopenedApp, 'id-c', 'Unopened app', 'codeunit 10 UnopenedTest { Subtype = Test; }');
  await files.mkdir(other);
  await files.mkdir(path.join(root, '.alpackages'));
  await files.writeFile(path.join(root, '.alpackages', 'Ignore.al'), 'codeunit 100 Ignored { Subtype = Test; }');

  const vscode = createVscode([root, nested, nested, other]);
  assert.deepEqual(await getTestCodeunitCatalog(vscode), [
    { appId: 'id-a', appName: 'Another app', codeunits: [{ id: 9, name: 'NestedTest' }] },
    {
      appId: 'id-b', appName: 'Business app',
      codeunits: [{ id: 4, name: 'OtherTest' }, { id: 7, name: 'Grouped "Test"' }]
    }
  ]);
});

test('rejects invalid requested IDs and lists every unknown ID before launch', () => {
  const maximumId = 2 ** 31 - 1;
  for (const value of [null, 1, [], ['1'], [0], [-1], [1.5], [maximumId + 1], [true], Array(2)]) {
    assert.throws(() => normalizeTestCodeunitIds(value), /at least one integer ID.*workspace catalog/);
  }
  assert.equal(normalizeTestCodeunitIds(undefined), undefined);
  assert.deepEqual(normalizeTestCodeunitIds([7, 2, 7, maximumId]), [2, 7, maximumId]);
  const catalog = [{ appId: 'id', appName: 'Fixture', codeunits: [{ id: 2, name: 'Test codeunit' }] }];
  assert.doesNotThrow(() => assertKnownTestCodeunits([2], catalog));
  assert.throws(() => assertKnownTestCodeunits([2, 3, 7], catalog), /\(3, 7\).*Refresh/);
});

test('labels conditional source declarations and conditional test subtypes as provisional', async t => {
  const { root, files } = await temporaryDirectory(t);
  await createApp(files, root, 'id', 'Fixture', `
    #if CONTOSO
        codeunit 7 FirstTest { Subtype = Test; }
    #endif
    codeunit 8 SecondTest {
        #if TESTING
            Subtype = Test;
        #endif
    }
    codeunit 9 ThirdTest { Subtype = Test; }
  `);
  const vscode = createVscode([root], async items => {
    assert.match(items.find(item => item.id === 7).detail, /Conditional in source/);
    assert.match(items.find(item => item.id === 8).detail, /Conditional in source/);
    assert.equal(items.find(item => item.id === 9).detail, undefined);
    return undefined;
  });
  const [app] = await getTestCodeunitCatalog(vscode);
  assert.deepEqual(app.codeunits.map(({ id, conditional }) => [id, conditional]), [[7, true], [8, true], [9, undefined]]);
  await pickTestCodeunits(vscode, root);
});

test('saves a grouped selection beside custom settings and reuses it on cancellation', async t => {
  const { root, files } = await temporaryDirectory(t);
  const appA = path.join(root, 'app-a');
  const appB = path.join(root, 'app-b');
  const settingsPath = path.join(root, 'user-settings', 'custom.json');
  const selectionPath = path.join(path.dirname(settingsPath), selectionFilename);
  await createApp(files, appA, 'id-a', 'A', 'codeunit 7 FirstTest { Subtype = Test; }');
  await createApp(files, appB, 'id-b', 'B', 'codeunit 3 SecondTest { Subtype = Test; }');
  const vscode = createVscode([appA, appB], async (items, options) => {
    assert.deepEqual(items.map(({ label, kind, picked }) => [label, kind, picked]), [
      ['A', -1, undefined], ['FirstTest', undefined, false],
      ['B', -1, undefined], ['SecondTest', undefined, false]
    ]);
    assert.equal(options.canPickMany, true);
    assert.equal(options.matchOnDescription, true);
    return [items[1], items[3]];
  });
  assert.deepEqual(await pickTestCodeunits(vscode, root, path.relative(root, settingsPath)), [3, 7]);
  const originalSelection = await files.readFile(selectionPath, 'utf8');
  assert.deepEqual(JSON.parse(originalSelection), { codeunitIds: [3, 7] });
  assert.deepEqual(await files.readdir(path.dirname(settingsPath)), [selectionFilename]);

  vscode.window.showQuickPick = async items => {
    assert.deepEqual(items.filter(item => item.picked).map(item => item.id), [7, 3]);
    return undefined;
  };
  assert.deepEqual(await pickTestCodeunits(vscode, root, settingsPath), [3, 7]);
  assert.equal(await files.readFile(selectionPath, 'utf8'), originalSelection);

  vscode.window.showQuickPick = async items => [items[1]];
  assert.deepEqual(await pickTestCodeunits(vscode, root, settingsPath), [7]);
  assert.deepEqual(JSON.parse(await files.readFile(selectionPath, 'utf8')), { codeunitIds: [7] });
  assert.deepEqual(await files.readdir(path.dirname(settingsPath)), [selectionFilename]);
});

test('empty submissions and cancellation without prior IDs do not write a selection', async t => {
  const { root, files } = await temporaryDirectory(t);
  await createApp(files, root, 'id', 'Fixture', 'codeunit 7 TestFixture { Subtype = Test; }');
  const messages = [];
  const vscode = createVscode([root], async () => undefined, messages);
  assert.equal(await pickTestCodeunits(vscode, root), undefined);
  vscode.window.showQuickPick = async () => [];
  assert.equal(await pickTestCodeunits(vscode, root), undefined);
  assert.match(messages[0], /Select at least one/);
  await assert.rejects(files.stat(path.join(root, '.bcdevtoolset')), { code: 'ENOENT' });

  await files.mkdir(path.join(root, '.bcdevtoolset'));
  const savedFile = path.join(root, '.bcdevtoolset', selectionFilename);
  const previousSelection = '{"codeunitIds":[7]}\n';
  await files.writeFile(savedFile, previousSelection);
  assert.equal(await pickTestCodeunits(vscode, root), undefined);
  assert.equal(await files.readFile(savedFile, 'utf8'), previousSelection);
});

test('malformed saved data fails before showing the picker and remains unchanged', async t => {
  const { root, files } = await temporaryDirectory(t);
  await createApp(files, root, 'id', 'Fixture', 'codeunit 7 TestFixture { Subtype = Test; }');
  await files.mkdir(path.join(root, '.bcdevtoolset'));
  const savedFile = path.join(root, '.bcdevtoolset', selectionFilename);
  for (const data of ['{ invalid JSON', '{}', '{"codeunitIds":[]}']) {
    const vscode = createVscode([root], async () => assert.fail('picker displayed'));
    await files.writeFile(savedFile, data);
    await assert.rejects(pickTestCodeunits(vscode, root), /Correct the codeunitIds list or remove.*No selection was changed/);
    assert.equal(await files.readFile(savedFile, 'utf8'), data);
  }
});

test('failed save retains the previous selection and cleans up the staged file', async t => {
  const { root, files } = await temporaryDirectory(t);
  await createApp(files, root, 'id', 'Fixture', `
    codeunit 7 FirstTest { Subtype = Test; }
    codeunit 8 SecondTest { Subtype = Test; }
  `);
  const selectionDirectory = path.join(root, '.bcdevtoolset');
  const savedFile = path.join(selectionDirectory, selectionFilename);
  await files.mkdir(selectionDirectory);
  const previousSelection = '{"codeunitIds":[7]}\n';
  await files.writeFile(savedFile, previousSelection);
  const vscode = createVscode([root], async items => [items.find(item => item.id === 8)]);
  const rename = t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' });
  });
  await assert.rejects(pickTestCodeunits(vscode, root), error => {
    assert.match(error.message, /Save AL test selection failed \(EACCES\).*saved selection was not replaced.*Check write access/);
    assert.doesNotMatch(error.message, /private filesystem detail/);
    return true;
  });
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(await files.readFile(savedFile, 'utf8'), previousSelection);
  assert.deepEqual(await files.readdir(selectionDirectory), [selectionFilename]);
});

test('rejects settings outside the workspace and avoids reading linked selection directories', async t => {
  const { root, files } = await temporaryDirectory(t);
  const workspace = resolveWithinRoot(root, 'workspace');
  const outside = resolveWithinRoot(root, 'outside');
  await createApp(files, workspace, 'id', 'Fixture', 'codeunit 7 TestFixture { Subtype = Test; }');
  await files.mkdir(outside);
  const savedFile = path.join(outside, selectionFilename);
  const outsideSelection = '{"codeunitIds":[7]}\n';
  await files.writeFile(savedFile, outsideSelection);
  const vscode = createVscode([workspace], async () => assert.fail('picker displayed'));
  await assert.rejects(
    pickTestCodeunits(vscode, workspace, '../outside/custom.json'),
    /Set bcDevToolset.localSettingsPath to a settings file inside the workspace/
  );

  const linkedDirectory = resolveWithinRoot(root, workspace, 'linked-directory');
  await fs.symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- target and link are fixed descendants of the test-owned fixture root
  await assert.rejects(
    pickTestCodeunits(vscode, workspace, path.join(linkedDirectory, 'new-directory', 'custom.json')),
    /inside an ordinary workspace directory without filesystem links/
  );
  assert.deepEqual(await files.readdir(outside), [selectionFilename]);
  assert.equal(await files.readFile(savedFile, 'utf8'), outsideSelection);
});
