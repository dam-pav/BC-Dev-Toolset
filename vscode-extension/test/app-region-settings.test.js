/* global require, __dirname, process */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workspaceMgtScript = path.join(repositoryRoot, 'common', 'WorkspaceMgt.ps1');

function createWorkspace(appRegion, workspaceRegion = 'w1') {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-app-region-')),
    'Test workspace'
  );
  const vscodePath = resolveWithinRoot(workspacePath, 'App', '.vscode');
  fs.mkdirSync(vscodePath, { recursive: true }); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'App', 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync( // nosemgrep -- destination is resolved within the authorized test-owned workspace root
    resolveWithinRoot(workspacePath, 'App', '.vscode', 'settings.json'),
    `${JSON.stringify({ 'al.symbolsCountryRegion': appRegion, 'editor.tabSize': 2 }, null, 2)}\n`
  );
  const workspace = {
    folders: [{ path: 'App' }],
    settings: { 'al.symbolsCountryRegion': workspaceRegion }
  };
  fs.writeFileSync( // nosemgrep -- destination is resolved within the authorized test-owned workspace root
    resolveWithinRoot(workspacePath, 'sample.code-workspace'),
    `${JSON.stringify(workspace, null, 2)}\n`
  );
  return workspacePath;
}

function reconcileRegions(workspacePath) {
  const command = [
    `. '${workspaceMgtScript.replaceAll("'", "''")}'`,
    `$Script:bcDevToolsetWorkspaceRootPath = '${workspacePath.replaceAll("'", "''")}'`,
    "$workspace = Get-Content -LiteralPath (Join-Path $Script:bcDevToolsetWorkspaceRootPath 'sample.code-workspace') -Raw | ConvertFrom-Json",
    `Remove-RedundantAppRegionSettings -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -workspaceJSON $workspace`
  ].join('; ');
  return childProcess.spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: process.env
  });
}

test('matching app region is removed before container preparation', () => {
  const workspacePath = createWorkspace('w1');
  const result = reconcileRegions(workspacePath);

  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(fs.readFileSync( // nosemgrep -- source is resolved within the authorized test-owned workspace root
    resolveWithinRoot(workspacePath, 'App', '.vscode', 'settings.json'),
    'utf8'
  ));
  assert.equal('al.symbolsCountryRegion' in settings, false);
  assert.equal(settings['editor.tabSize'], 2);
});

test('conflicting app region aborts container preparation without changing settings', () => {
  const workspacePath = createWorkspace('de', 'w1');
  const settingsPath = resolveWithinRoot(workspacePath, 'App', '.vscode', 'settings.json');
  const originalSettings = fs.readFileSync(settingsPath, 'utf8'); // nosemgrep -- path is contained by the test-owned workspace root
  const result = reconcileRegions(workspacePath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match workspace region/i);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings); // nosemgrep -- path is contained by the test-owned workspace root
});
