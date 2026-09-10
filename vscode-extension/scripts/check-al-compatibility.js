'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { discoverAlTool } = require('../al-tool-discovery');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const extensionRoot = authorizeRoot(process.argv[2], 'AL extension installation argument');
const tool = discoverAlTool(extensionRoot);
const manifest = JSON.parse(fs.readFileSync(resolveWithinRoot(extensionRoot, 'package.json'), 'utf8')); // nosemgrep -- fixed manifest within explicitly authorized installation
console.log(`Testing AL extension ${manifest.version}: ${tool}`);
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-al-compatibility-'));
try {
  fs.writeFileSync(resolveWithinRoot(fixtureRoot, 'app.json'), JSON.stringify({ // nosemgrep -- fixed fixture file within newly created test root
    id: '6346c515-8cce-419b-9961-f08bd1617541', name: 'CompatibilityFixture',
    publisher: 'Toolset', version: '1.0.0.0', runtime: '14.0',
    idRanges: [{ from: 50100, to: 50100 }]
  }));
  fs.writeFileSync(resolveWithinRoot(fixtureRoot, 'Probe.al'), 'codeunit 50100 Probe { procedure Check(): Integer begin exit(42); end; }'); // nosemgrep -- fixed fixture file within newly created test root
  const repositoryRoot = path.resolve(__dirname, '../..');
  const operation = resolveWithinRoot(repositoryRoot, 'operations', 'BuildAllApps.ps1');
  const output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', operation, '-SkipOperationUI'], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, BCDEVTOOLSET_ALTOOL_PATH: tool, BCDEVTOOLSET_WORKSPACE_PATH: fixtureRoot, BCDEVTOOLSET_WORKSPACE_FILE: '' }
  });
  console.log(output);
  if (!fs.existsSync(resolveWithinRoot(fixtureRoot, 'Toolset_CompatibilityFixture_1.0.0.0.app'))) { // nosemgrep -- fixed output beneath test root
    throw new Error('Build operation did not create the expected package');
  }
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true }); // nosemgrep -- root created exclusively by mkdtemp for this smoke test
}
