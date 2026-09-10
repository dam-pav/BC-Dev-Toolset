const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

test('source collection ignores literals, comments, caches and nested apps', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-object-usage-'));
  try {
    fs.writeFileSync(path.join(workspace, 'objects.al'), `
      // table 1 Fake {}
      /* page 2 Fake {} */
      namespace Example.Test;
      table /* comment */ 50000 "Quoted ""Name""" {
        field(1; Test; Text[50]) {}
        trigger OnInsert() begin Message('page 3 Fake {}'); end;
      }
      PAGE 50000 RealPage {}
      #if FEATURE
      tableextension 50002 Ext extends "Quoted Name" {}
      #else
      tableextension 50004 Ext2 extends "Quoted Name" {}
      #endif
      profile MyProfile { Caption = 'table 4 Fake {}'; }
      permissionset 50005 Permissions {}
    `);
    fs.writeFileSync(path.join(workspace, 'empty.al'), '');
    for (const folder of ['.alpackages', 'nested', 'src']) {
      fs.mkdirSync(path.join(workspace, folder));
      fs.writeFileSync(path.join(workspace, folder, 'object.al'), 'codeunit 50006 Real {}');
    }
    fs.writeFileSync(path.join(workspace, 'nested', 'app.json'), '{}');
    const scriptPath = path.join(root, 'visualization/ObjectIdUsage.ps1').replaceAll("'", "''");
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      `. '${scriptPath}'; @(Get-AppObjectIdUsage -AuthorizedAppRoot $env:TEST_APP_ROOT) | ConvertTo-Json -Depth 5 -Compress`
    ], { encoding: 'utf8', env: { ...process.env, TEST_APP_ROOT: workspace } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const objects = JSON.parse(result.stdout).sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);
    assert.deepEqual(objects, [
      { type: 'codeunit', id: 50006 }, { type: 'page', id: 50000 },
      { type: 'permissionset', id: 50005 }, { type: 'table', id: 50000 },
      { type: 'tableextension', id: 50002 }, { type: 'tableextension', id: 50004 }
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function loadVisualization() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; this.textContent = ''; }
  }
  const elements = { 'usage-tree': new Element('div'), 'usage-matrix': new Element('div') };
  const context = vm.createContext({
    document: { getElementById: id => elements[id], createElement: tag => new Element(tag) },
    window: { location: { search: '' } }, URLSearchParams,
    fetch: () => ({ then: () => ({ then: () => ({ catch() {} }) }) })
  });
  const html = fs.readFileSync(path.join(root, 'visualization/WorkspaceAnalysis.html'), 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { context, elements };
}

test('usage tree splits gaps and matrix totals count distinct IDs within each app/type', () => {
  const { context, elements } = loadVisualization();
  context.renderObjectUsage({ object_usage: [
    { name: '<App>', path: 'a', app_id: 'one', objects: [
      { type: 'table', id: 50003 }, { type: 'table', id: 50000 },
      { type: 'table', id: 50001 }, { type: 'table', id: 50001 }, { type: 'page', id: 50000 }
    ] },
    { name: 'Second', path: 'b', app_id: 'two', objects: [{ type: 'page', id: 50000 }] },
    { name: 'Zero', path: 'c', app_id: 'three', objects: [] }
  ] });
  const flatten = element => [element, ...element.children.flatMap(flatten)];
  assert.deepEqual(flatten(elements['usage-tree']).filter(e => e.tag === 'li').map(e => e.textContent),
    ['50000', '50000–50001', '50003', '50000']);
  const rows = flatten(elements['usage-matrix']).filter(e => e.tag === 'tr').map(e => e.children.map(c => c.textContent));
  assert.deepEqual(rows, [
    ['App', 'page', 'table', 'Total'], ['<App> (a)', 1, 3, 4],
    ['Second (b)', 1, 0, 1], ['Zero (c)', 0, 0, 0], ['Total', 2, 3, 5]
  ]);
  context.renderObjectUsage({});
  assert.match(elements['usage-tree'].textContent, /Prepare/);
  context.renderObjectUsage({ object_usage: [] });
  assert.match(elements['usage-tree'].textContent, /No apps/);
});
