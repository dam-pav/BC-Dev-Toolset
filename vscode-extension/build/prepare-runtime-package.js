const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const extensionRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const runtimeRoot = path.join(extensionRoot, 'runtime');

const companion = spawnSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'prepare-bc-data-package.ps1')], { stdio: 'inherit', windowsHide: true });
if (companion.error || companion.status !== 0) throw new Error('BC Data package preparation failed. Build the companion with Toolset before packaging.');

const runtimeItems = [
  'README.md',
  'Invoke-BcDevToolsetOperation.ps1',
  'common',
  'operations',
  'visualization',
  'bc-data'
];

fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.mkdirSync(runtimeRoot, { recursive: true });

for (const item of runtimeItems) {
  const sourcePath = path.join(repositoryRoot, item);
  const targetPath = path.join(runtimeRoot, item);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Runtime package source not found: ${sourcePath}`);
  }

  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
}

console.log(`Prepared bundled runtime at ${runtimeRoot}`);
