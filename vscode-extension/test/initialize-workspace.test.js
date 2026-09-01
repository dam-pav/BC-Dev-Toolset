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

function runInitializeWorkspace(workspacePath, workspaceFile = '', localSettingsPath = '') {
  return childProcess.spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', initializeWorkspaceScript],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        BCDEVTOOLSET_WORKSPACE_PATH: workspacePath,
        BCDEVTOOLSET_WORKSPACE_FILE: workspaceFile,
        BCDEVTOOLSET_LOCAL_SETTINGS_PATH: localSettingsPath
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
  assert.deepEqual(initializedWorkspace.folders, [
    { name: 'sample', path: '.' },
    { path: 'src/app' }
  ]);
  assert.deepEqual(initializedWorkspace.settings['files.exclude'], { 'src/app': true });
  assert.ok(initializedWorkspace.settings['dam-pav.bcdevtoolset']);
  assert.equal(initializedWorkspace.settings['dam-pav.bcdevtoolset'].selectArtifact, 'Latest');
  assert.equal(initializedWorkspace.settings['al.symbolsCountryRegion'], 'w1');
  assert.equal('country' in initializedWorkspace.settings['dam-pav.bcdevtoolset'], false);
  assert.equal(fs.existsSync(settingsPath), true); // nosemgrep -- path is contained by the test-owned workspace root
  const localSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(localSettings.executeTestsInContainerName, 'sample-Test');
  assert.deepEqual(localSettings.configurations.map(({ name }) => name), ['Local', 'Local-Test']);
  assert.deepEqual(localSettings.configurations.map(({ targetType }) => targetType), ['Dev', 'Test']);
  assert.deepEqual(localSettings.configurations.map(({ container }) => container), ['sample', 'sample-Test']);
  assert.deepEqual(localSettings.configurations.map(({ includeTestToolkit }) => includeTestToolkit), ['false', 'true']);
});

test('workspace initialization coordinates repository, app folders, and file exclusions', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-coordinated-workspace-')),
    'Test workspace'
  );
  const payrollPath = resolveWithinRoot(workspacePath, 'apps', 'Payroll');
  const testsPath = resolveWithinRoot(workspacePath, 'tests', 'Payroll.Tests');
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  fs.mkdirSync(payrollPath, { recursive: true }); // nosemgrep -- path is contained by the test-owned workspace root
  fs.mkdirSync(testsPath, { recursive: true }); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(resolveWithinRoot(payrollPath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(resolveWithinRoot(testsPath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, JSON.stringify({ // nosemgrep -- path is contained by the test-owned workspace root
    folders: [
      { name: 'Repository', path: '.' },
      { name: 'Payroll app', path: 'apps/Payroll' },
      { path: 'docs' }
    ],
    settings: { 'files.exclude': { generated: true } }
  }));

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  const initializedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  assert.deepEqual(initializedWorkspace.folders, [
    { name: 'sample', path: '.' },
    { name: 'Payroll app', path: 'apps/Payroll' },
    { path: 'tests/Payroll.Tests' },
    { path: 'docs' }
  ]);
  assert.deepEqual(initializedWorkspace.settings['files.exclude'], {
    generated: true,
    'apps/Payroll': true,
    'tests/Payroll.Tests': true
  });

  const rerunResult = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(rerunResult.status, 0, rerunResult.stderr);
  const rerunWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  assert.deepEqual(rerunWorkspace.folders, initializedWorkspace.folders);
  assert.deepEqual(rerunWorkspace.settings['files.exclude'], initializedWorkspace.settings['files.exclude']);
});

test('workspace initialization writes local settings beside the active workspace file', () => {
  const workspaceBasePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-workspace-base-')),
    'Test workspace'
  );
  const appPath = resolveWithinRoot(workspaceBasePath, 'Project', 'App');
  const workspaceFile = resolveWithinRoot(workspaceBasePath, 'sample.code-workspace');
  const settingsPath = resolveWithinRoot(workspaceBasePath, '.bcdevtoolset', 'settings.json');
  const misplacedSettingsPath = resolveWithinRoot(appPath, '.bcdevtoolset', 'settings.json');
  fs.mkdirSync(appPath, { recursive: true }); // nosemgrep -- appPath is contained by the test-owned workspace root
  fs.writeFileSync(resolveWithinRoot(appPath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "Project/App" }] }\n'); // nosemgrep -- workspaceFile is contained by the test-owned workspace root

  const result = runInitializeWorkspace(appPath, workspaceFile, settingsPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(settingsPath), true); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(fs.existsSync(misplacedSettingsPath), false); // nosemgrep -- misplacedSettingsPath is contained by the test-owned workspace root
});

test('workspace initialization adds missing test defaults without changing existing local settings', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-existing-workspace-')),
    'Test workspace'
  );
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  const settingsDirectory = resolveWithinRoot(workspacePath, '.bcdevtoolset');
  const settingsPath = resolveWithinRoot(workspacePath, '.bcdevtoolset', 'settings.json');
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "." }] }\n'); // nosemgrep -- workspaceFile is contained by the test-owned workspace root
  fs.mkdirSync(settingsDirectory); // nosemgrep -- settingsDirectory is contained by the test-owned workspace root
  fs.writeFileSync(settingsPath, JSON.stringify({ // nosemgrep -- settingsPath is contained by the test-owned workspace root
    licenseFile: 'custom-license.flf',
    executeTestsInContainerName: '',
    configurations: [{
      name: 'Local', serverType: 'Container', targetType: 'Dev', container: 'custom-dev', customValue: 'preserve-me'
    }]
  }, null, 2));

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Added Local-Test configuration for 'sample-Test'/);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(settings.licenseFile, 'custom-license.flf');
  assert.equal(settings.configurations[0].customValue, 'preserve-me');
  assert.equal(settings.configurations[1].name, 'Local-Test');
  assert.equal(settings.configurations[1].container, 'sample-Test');
  assert.equal(settings.executeTestsInContainerName, 'sample-Test');

  settings.configurations = [settings.configurations[0]];
  settings.executeTestsInContainerName = 'preselected-test';
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  const rerunResult = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(rerunResult.status, 0, rerunResult.stderr);
  const rerunSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(rerunSettings.executeTestsInContainerName, 'preselected-test');
  assert.equal(rerunSettings.configurations[1].name, 'Local-Test');
});

test('workspace initialization adds missing Local while preserving an existing Local-Test and explicit test target', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-existing-test-workspace-')),
    'Test workspace'
  );
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  const settingsDirectory = resolveWithinRoot(workspacePath, '.bcdevtoolset');
  const settingsPath = resolveWithinRoot(workspacePath, '.bcdevtoolset', 'settings.json');
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "." }] }\n'); // nosemgrep -- workspaceFile is contained by the test-owned workspace root
  fs.mkdirSync(settingsDirectory); // nosemgrep -- settingsDirectory is contained by the test-owned workspace root
  const originalSettings = JSON.stringify({
    executeTestsInContainerName: 'custom-test',
    configurations: [{
      name: 'Local-Test', serverType: 'Container', targetType: 'Production', container: 'custom-test', customValue: true
    }]
  }, null, 2);
  fs.writeFileSync(settingsPath, originalSettings); // nosemgrep -- settingsPath is contained by the test-owned workspace root

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Added Local configuration for 'sample'/);
  assert.match(result.stdout, /already contain Local-Test; existing values were preserved/);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(settings.executeTestsInContainerName, 'custom-test');
  assert.equal(settings.configurations[0].customValue, true);
  assert.equal(settings.configurations[0].container, 'custom-test');
  assert.equal(settings.configurations[1].name, 'Local');
  assert.equal(settings.configurations[1].container, 'sample');
});

test('workspace initialization reports default container conflicts without changing local settings', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-conflicting-test-workspace-')),
    'Test workspace'
  );
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  const settingsDirectory = resolveWithinRoot(workspacePath, '.bcdevtoolset');
  const settingsPath = resolveWithinRoot(workspacePath, '.bcdevtoolset', 'settings.json');
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "." }] }\n'); // nosemgrep -- workspaceFile is contained by the test-owned workspace root
  fs.mkdirSync(settingsDirectory); // nosemgrep -- settingsDirectory is contained by the test-owned workspace root
  const originalSettings = JSON.stringify({
    executeTestsInContainerName: '',
    configurations: [
      { name: 'Existing-Dev', serverType: 'Container', container: 'sample' },
      { name: 'Existing-Test', serverType: 'Container', container: 'sample-Test' }
    ]
  }, null, 2);
  fs.writeFileSync(settingsPath, originalSettings); // nosemgrep -- settingsPath is contained by the test-owned workspace root

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Local was not added because container 'sample' is already used/);
  assert.match(result.stdout, /Local-Test was not added because container 'sample-Test' is already used/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings); // nosemgrep -- settingsPath is contained by the test-owned workspace root
});

test('workspace initialization migrates the obsolete country setting to the AL region setting', () => {
  const workspacePath = authorizeRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-country-migration-')),
    'Test workspace'
  );
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, JSON.stringify({ // nosemgrep -- workspaceFile is resolved within the authorized test-owned workspace root
    folders: [{ path: '.' }],
    settings: { 'dam-pav.bcdevtoolset': { country: 'de', selectArtifact: 'Closest' } }
  }));

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  const initializedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  assert.equal(initializedWorkspace.settings['al.symbolsCountryRegion'], 'de');
  assert.equal('country' in initializedWorkspace.settings['dam-pav.bcdevtoolset'], false);
});
