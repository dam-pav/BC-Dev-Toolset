'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { discoverAlTool } = require('../al-tool-discovery');
const { resolveWithinRoot } = require('../path-security');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); // nosemgrep -- root created exclusively for this test
  for (const file of files) {
    const target = resolveWithinRoot(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); // nosemgrep -- contained test fixture path
    fs.writeFileSync(target, 'fixture'); // nosemgrep -- contained test fixture path
  }
  return root;
}
const help = () => 'Microsoft AL CLI tools\ncompile <args>';
for (const platform of ['win32', 'linux', 'darwin']) {
  const exe = platform === 'win32' ? 'altool.exe' : 'altool';
  for (const relative of [`bin/${exe}`, `bin/${platform}/${exe}`, `future/tools/v19/${exe}`]) {
    test(`discovers ${relative} on ${platform}`, t => {
      const root = fixture(t, [relative]);
      assert.equal(discoverAlTool(root, { platform, probe: help }), path.join(root, relative));
    });
  }
}
test('rejects multiple runnable fallback candidates', t => {
  const root = fixture(t, ['one/altool.exe', 'two/altool.exe']);
  assert.throws(() => discoverAlTool(root, { platform: 'win32', probe: help }), /Ambiguous/);
});
test('rejects a tool with an incompatible CLI', t => {
  const root = fixture(t, ['bin/altool.exe']);
  assert.throws(() => discoverAlTool(root, { platform: 'win32', probe: () => 'different tool' }), /Unexpected ALTool help/);
});
test('recovers from an unlaunchable candidate using the runnable fallback', t => {
  const root = fixture(t, ['bin/altool.exe', 'moved/altool.exe']);
  assert.equal(discoverAlTool(root, { platform: 'win32', probe: candidate => {
    if (candidate === path.join(root, 'bin', 'altool.exe')) throw new Error('wrong architecture');
    return help();
  } }), path.join(root, 'moved', 'altool.exe'));
});
test('reports missing tools', t => {
  assert.throws(() => discoverAlTool(fixture(t, []), { probe: help }), /No compatible ALTool/);
});
test('does not traverse a junction outside the extension', t => {
  const outside = fixture(t, ['altool.exe']);
  const root = fixture(t, []);
  fs.symlinkSync(outside, resolveWithinRoot(root, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
  let probes = 0;
  assert.throws(() => discoverAlTool(root, { platform: 'win32', probe: () => { probes++; return help(); } }), /No compatible ALTool/);
  assert.equal(probes, 0);
});
