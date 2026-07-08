/* eslint-env node */
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const runtimeRoot = path.join(extensionRoot, 'runtime');

const runtimeItems = [
  'Invoke-BcDevToolsetOperation.ps1',
  'common',
  'operations',
  'visualization'
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
