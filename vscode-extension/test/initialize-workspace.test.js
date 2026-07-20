/* global require, __dirname, process */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const initializeWorkspaceScript = path.join(repositoryRoot, 'operations', 'InitializeWorkspace.ps1');

function runInitializeWorkspace(workspacePath, workspaceFile = '') {
  return childProcess.spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', initializeWorkspaceScript],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        BCDEVTOOLSET_WORKSPACE_PATH: workspacePath,
        BCDEVTOOLSET_WORKSPACE_FILE: workspaceFile
      }
    }
  );
}

test('workspace initialization creates nothing when a folder contains no BC apps', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-empty-workspace-')),
    'Test workspace'
  );
  const readmePath = resolveWithinRoot(workspacePath, 'README.md');
  fs.writeFileSync(readmePath, 'Not an AL project.\n'); // nosemgrep -- path is contained by the test-owned workspace root

  const result = runInitializeWorkspace(workspacePath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialization skipped because the workspace contains no Business Central apps/i);
  assert.deepEqual(fs.readdirSync(workspacePath), ['README.md']); // nosemgrep -- workspacePath is an authorized test-owned root
});

test('workspace initialization leaves a non-BC workspace file unchanged', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-non-bc-workspace-')),
    'Test workspace'
  );
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  const settingsDirectory = resolveWithinRoot(workspacePath, '.bcdevtoolset');
  const gitIgnorePath = resolveWithinRoot(workspacePath, '.gitignore');
  const originalContent = '{\n  "folders": [{ "path": "." }],\n  "settings": { "editor.tabSize": 2 }\n}\n';
  fs.writeFileSync(workspaceFile, originalContent); // nosemgrep -- path is contained by the test-owned workspace root

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialization skipped because the workspace contains no Business Central apps/i);
  assert.equal(fs.readFileSync(workspaceFile, 'utf8'), originalContent); // nosemgrep -- path is contained by the test-owned workspace root
  assert.equal(fs.existsSync(settingsDirectory), false); // nosemgrep -- path is contained by the test-owned workspace root
  assert.equal(fs.existsSync(gitIgnorePath), false); // nosemgrep -- path is contained by the test-owned workspace root
});

test('workspace initialization recognizes BC apps nested in a workspace folder', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-bc-workspace-')),
    'Test workspace'
  );
  const appPath = resolveWithinRoot(workspacePath, 'src', 'app');
  const appJsonPath = resolveWithinRoot(workspacePath, 'src', 'app', 'app.json');
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  const settingsPath = resolveWithinRoot(workspacePath, '.bcdevtoolset', 'settings.json');
  fs.mkdirSync(appPath, { recursive: true }); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(appJsonPath, '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "." }] }\n'); // nosemgrep -- path is contained by the test-owned workspace root

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workspace configuration is ready/i);
  const initializedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  assert.ok(initializedWorkspace.settings['dam-pav.bcdevtoolset']);
  assert.equal(fs.existsSync(settingsPath), true); // nosemgrep -- path is contained by the test-owned workspace root
});
