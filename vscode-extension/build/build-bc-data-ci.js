'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');
const { discoverAlTool } = require('../al-tool-discovery');

function buildCompanion(extensionPath) {
  const repositoryRoot = path.resolve(__dirname, '../..');
  const inputs = JSON.parse(fs.readFileSync(resolveWithinRoot(repositoryRoot, 'bc-data/build-inputs.json'), 'utf8'));
  const extensionRoot = authorizeRoot(extensionPath, 'Isolated Microsoft AL extension installation');
  const extension = JSON.parse(fs.readFileSync(resolveWithinRoot(extensionRoot, 'package.json'), 'utf8'));
  if (extension.publisher !== 'ms-dynamics-smb' || extension.name !== 'al' || extension.version !== inputs.alExtensionVersion) throw new Error('CI requires the pinned Microsoft AL extension.');
  const tool = discoverAlTool(extensionRoot);
  const sourceRoot = resolveWithinRoot(repositoryRoot, 'al/BCData');
  const manifest = JSON.parse(fs.readFileSync(resolveWithinRoot(sourceRoot, 'app.json'), 'utf8'));
  const fileName = `${manifest.publisher}_${manifest.name}_${manifest.version}.app`;
  const output = resolveWithinRoot(sourceRoot, fileName);
  // Fresh CI checkout only: a pre-existing app must never stand in for this build.
  if (fs.readdirSync(sourceRoot).some(name => name.endsWith('.app'))) throw new Error('CI companion output must be absent before compilation.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdata-ci-build-'));
  try {
    const project = resolveWithinRoot(scratch, 'project');
    const cache = resolveWithinRoot(project, '.alpackages');
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(resolveWithinRoot(sourceRoot, 'app.json'), resolveWithinRoot(project, 'app.json'));
    fs.cpSync(resolveWithinRoot(sourceRoot, 'src'), resolveWithinRoot(project, 'src'), { recursive: true, dereference: false });
    for (const symbol of inputs.symbols) {
      const input = resolveWithinRoot(repositoryRoot, '.bcdevtoolset/ci-inputs/symbols', symbol.file);
      if (crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex') !== symbol.sha256) throw new Error('CI baseline package checksum mismatch.');
      fs.copyFileSync(input, resolveWithinRoot(cache, symbol.file));
    }
    // CI has no extension-host bridge. Use the same repository build operation,
    // with an isolated companion-only workspace and no developer settings/cache.
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', resolveWithinRoot(repositoryRoot, 'operations/BuildAllApps.ps1'), '-SkipOperationUI', '-WarningsAsErrors'], {
      stdio: 'inherit', windowsHide: true, timeout: 300000,
      env: { ...process.env, BCDEVTOOLSET_ALTOOL_PATH: tool, BCDEVTOOLSET_WORKSPACE_PATH: project, BCDEVTOOLSET_WORKSPACE_FILE: '' }
    });
    fs.copyFileSync(resolveWithinRoot(project, fileName), output);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true }); // nosemgrep -- exclusively owned mkdtemp root
  }
  console.log(`Built companion ${manifest.version} from this checkout using AL ${inputs.alExtensionVersion}.`);
}
if (require.main === module) buildCompanion(process.argv[2]);
module.exports = { buildCompanion };
