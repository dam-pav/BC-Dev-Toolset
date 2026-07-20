const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-empty-workspace-'));
  fs.writeFileSync(path.join(workspacePath, 'README.md'), 'Not an AL project.\n');

  const result = runInitializeWorkspace(workspacePath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialization skipped because the workspace contains no Business Central apps/i);
  assert.deepEqual(fs.readdirSync(workspacePath), ['README.md']);
});

test('workspace initialization leaves a non-BC workspace file unchanged', () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-non-bc-workspace-'));
  const workspaceFile = path.join(workspacePath, 'sample.code-workspace');
  const originalContent = '{\n  "folders": [{ "path": "." }],\n  "settings": { "editor.tabSize": 2 }\n}\n';
  fs.writeFileSync(workspaceFile, originalContent);

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialization skipped because the workspace contains no Business Central apps/i);
  assert.equal(fs.readFileSync(workspaceFile, 'utf8'), originalContent);
  assert.equal(fs.existsSync(path.join(workspacePath, '.bcdevtoolset')), false);
  assert.equal(fs.existsSync(path.join(workspacePath, '.gitignore')), false);
});

test('workspace initialization recognizes BC apps nested in a workspace folder', () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-bc-workspace-'));
  const appPath = path.join(workspacePath, 'src', 'app');
  const workspaceFile = path.join(workspacePath, 'sample.code-workspace');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'app.json'), '{}\n');
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "." }] }\n');

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workspace configuration is ready/i);
  const initializedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  assert.ok(initializedWorkspace.settings['dam-pav.bcdevtoolset']);
  assert.equal(fs.existsSync(path.join(workspacePath, '.bcdevtoolset', 'settings.json')), true);
});
