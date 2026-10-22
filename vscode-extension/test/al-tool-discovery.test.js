'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { discoverAlTool } = require('../al-tool-discovery');
const { resolveWithinRoot } = require('../path-security');
const inputs = require('../../bc-data/build-inputs.json');

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

test('pinned build inputs use a literal module import instead of a constructed filesystem path', () => {
  const filename = resolveWithinRoot(path.resolve(__dirname, '..'), 'test/al-tool-discovery.test.js');
  const source = fs.readFileSync(filename, 'utf8'); // nosemgrep -- fixed test file contained in the repository extension root
  assert.match(source, /const inputs = require\('\.\.\/\.\.\/bc-data\/build-inputs\.json'\);/);
  assert.doesNotMatch(source, /fs\.readFileSync\([^\n]*path\.join\([^\n]*build-inputs/);
});

function loadWithDependencies(relative, dependencies) {
  const filename = resolveWithinRoot(path.resolve(__dirname, '..'), relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { // nosemgrep -- contained fixed test module path
    module, __dirname: path.dirname(filename), process, console,
    require: name => dependencies[name] || localRequire(name)
  }, { filename });
  return module.exports;
}

function coldStartDiscovery(probes) {
  return loadWithDependencies('al-tool-discovery.js', {
    'node:child_process': { execFileSync(candidate, args, options) {
      probes.push({ candidate, args: Array.from(args), timeout: options.timeout });
      // Model the hosted Windows runner's cold start without sleeping or launching ALTool.
      if (options.timeout < 10000) throw Object.assign(new Error('ALTool startup ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return help();
    } }
  }).discoverAlTool;
}

test('cold ALTool startup can use a longer bounded probe without changing the interactive default', t => {
  const root = fixture(t, ['bin/altool.exe']);
  const probes = [];
  const discover = coldStartDiscovery(probes);
  assert.throws(() => discover(root, { platform: 'win32' }), /ETIMEDOUT/);
  assert.equal(probes[0].timeout, 5000);
  assert.equal(discover(root, { platform: 'win32', probeTimeoutMs: 60000 }), path.join(root, 'bin/altool.exe'));
  assert.equal(probes[1].timeout, 60000);
  assert.deepEqual(probes[1].args, ['--help']);
});

test('CI companion discovery tolerates cold startup before attempting compilation', t => {
  const root = fixture(t, ['bin/altool.exe']);
  fs.writeFileSync(resolveWithinRoot(root, 'package.json'), JSON.stringify({ // nosemgrep -- contained test-owned extension fixture
    publisher: 'ms-dynamics-smb', name: 'al', version: inputs.alExtensionVersion
  }));
  const probes = [];
  const discover = coldStartDiscovery(probes);
  const stopped = new Error('Discovery verified; do not compile in this unit test');
  const { buildCompanion } = loadWithDependencies('build/build-bc-data-ci.js', {
    '../al-tool-discovery': { discoverAlTool(extensionRoot, options) {
      const selected = discover(extensionRoot, { ...options, platform: 'win32' });
      assert.equal(selected, path.join(root, 'bin/altool.exe'));
      throw stopped;
    } }
  });
  assert.throws(() => buildCompanion(root), error => error === stopped);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].timeout, 60000);
});

test('rejects invalid or unbounded ALTool probe timeouts before launching', t => {
  const root = fixture(t, ['bin/altool.exe']);
  for (const probeTimeoutMs of [0, -1, Infinity, 1.5, '60000', 60001]) {
    assert.throws(() => discoverAlTool(root, { probeTimeoutMs, probe: () => assert.fail('Invalid timeout launched ALTool') }), /probe timeout/);
  }
});
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
  const validatedLinkPath = resolveWithinRoot(root, 'bin');
  // Both roots are owned mkdtemp fixtures; the link is contained in root and intentionally targets the separate fixture to test escape rejection.
  fs.symlinkSync(outside, validatedLinkPath, process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep -- authorized test target; link containment validated above
  let probes = 0;
  assert.throws(() => discoverAlTool(root, { platform: 'win32', probe: () => { probes++; return help(); } }), /No compatible ALTool/);
  assert.equal(probes, 0);
});
