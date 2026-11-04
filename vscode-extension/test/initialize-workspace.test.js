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
  assert.ok(initializedWorkspace.settings['bcDevToolset']);
  assert.equal(initializedWorkspace.settings['bcDevToolset'].selectArtifact, 'Latest');
  assert.equal(initializedWorkspace.settings['al.symbolsCountryRegion'], 'w1');
  assert.deepEqual(initializedWorkspace.settings['al.assemblyProbingPaths'], ['./.netpackages']);
  assert.equal('country' in initializedWorkspace.settings['bcDevToolset'], false);
  assert.equal(fs.existsSync(settingsPath), true); // nosemgrep -- path is contained by the test-owned workspace root
  const localSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(Object.hasOwn(localSettings, 'executeTestsInContainerName'), false);
  assert.deepEqual(localSettings.configurations.map(({ name }) => name), ['Local']);
  assert.deepEqual(localSettings.configurations.map(({ container }) => container), ['sample']);
  assert.deepEqual(localSettings.configurations.map(({ includeTestToolkit }) => includeTestToolkit), ['true']);
  assert.equal(localSettings.configurations[0].sqlBackupPath, '.bcdevtoolset/.backups/Local');
  assert.ok(fs.statSync(resolveWithinRoot(workspacePath, '.bcdevtoolset', '.backups', 'Local')).isDirectory()); // nosemgrep -- path is contained by the test-owned workspace root
});

test('workspace initialization defaults missing backup paths by configuration name and preserves existing paths', () => {
  const workspacePath = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-backup-defaults-')), 'Test workspace');
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  const settingsPath = resolveWithinRoot(workspacePath, '.bcdevtoolset', 'settings.json');
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.mkdirSync(resolveWithinRoot(workspacePath, '.bcdevtoolset')); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, JSON.stringify({ // nosemgrep -- path is contained by the test-owned workspace root
    folders: [{ path: '.' }],
    settings: { bcDevToolset: { configurations: [
      { name: 'Shared Dev', serverType: 'Container', container: 'shared-container' },
      { name: 'Shared Custom', serverType: 'Container', sqlBackupPath: '../shared-backups' },
      { name: 'Remote', serverType: 'OnPrem' }
    ] } }
  }));
  fs.writeFileSync(settingsPath, JSON.stringify({ configurations: [ // nosemgrep -- path is contained by the test-owned workspace root
    { name: 'Local', serverType: 'Container', container: 'different-container', sqlBackupPath: '' },
    { name: 'QA tests', serverType: 'Container', container: 'qa-container', sqlBackupPath: null },
    { name: 'Missing', serverType: 'Container', container: 'other-container' },
    { name: 'Whitespace', serverType: 'Container', sqlBackupPath: '  ' },
    { name: 'Custom', serverType: 'Container', sqlBackupPath: 'D:/existing-backups' },
    { name: 'Cloud', serverType: 'Cloud' },
    { name: '../escaped-backup', serverType: 'Container' },
    { name: 'nested/backup', serverType: 'Container' },
    { name: 'NUL', serverType: 'Container' }
  ] }));
  fs.writeFileSync(resolveWithinRoot(workspacePath, '.gitignore'), '# Existing rules\n*.app\n'); // nosemgrep -- path is contained by the test-owned workspace root

  const result = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(result.status, 0, result.stderr);
  const localSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  const initializedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  const shared = initializedWorkspace.settings.bcDevToolset.configurations;
  assert.deepEqual(localSettings.configurations.slice(0, 4).map(({ sqlBackupPath }) => sqlBackupPath),
    ['Local', 'QA tests', 'Missing', 'Whitespace'].map((name) => `.bcdevtoolset/.backups/${name}`));
  assert.equal(localSettings.configurations[4].sqlBackupPath, 'D:/existing-backups');
  assert.equal(Object.hasOwn(localSettings.configurations[5], 'sqlBackupPath'), false);
  assert.deepEqual(localSettings.configurations.slice(6).map(({ sqlBackupPath }) => sqlBackupPath),
    ['.._escaped-backup', 'nested_backup', '_NUL'].map((name) => `.bcdevtoolset/.backups/${name}`));
  assert.equal(shared[0].sqlBackupPath, '.bcdevtoolset/.backups/Shared Dev');
  assert.equal(shared[1].sqlBackupPath, '../shared-backups');
  assert.equal(Object.hasOwn(shared[2], 'sqlBackupPath'), false);
  const backupRoot = resolveWithinRoot(workspacePath, '.bcdevtoolset', '.backups');
  assert.deepEqual(fs.readdirSync(backupRoot).sort(), ['.._escaped-backup', 'Local', 'Missing', 'QA tests', 'Shared Dev', 'Whitespace', '_NUL', 'nested_backup']); // nosemgrep -- path is contained by the test-owned workspace root
  assert.equal(fs.existsSync(resolveWithinRoot(workspacePath, '.bcdevtoolset', 'escaped-backup')), false); // nosemgrep -- path is contained by the test-owned workspace root
  const init = childProcess.spawnSync('git', ['init', workspacePath], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const checkIgnore = childProcess.spawnSync('git', ['-C', workspacePath, 'check-ignore', '--no-index', '.bcdevtoolset/.backups/Local/example.bak'], { encoding: 'utf8' });
  assert.equal(checkIgnore.status, 0, checkIgnore.stderr);
  const gitIgnore = fs.readFileSync(resolveWithinRoot(workspacePath, '.gitignore'), 'utf8'); // nosemgrep -- path is contained by the test-owned workspace root
  assert.match(gitIgnore, /\*\.app/);

  const rerun = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), localSettings); // nosemgrep -- path is contained by the test-owned workspace root
  assert.deepEqual(JSON.parse(fs.readFileSync(workspaceFile, 'utf8')), initializedWorkspace); // nosemgrep -- path is contained by the test-owned workspace root
  assert.equal(fs.readFileSync(resolveWithinRoot(workspacePath, '.gitignore'), 'utf8'), gitIgnore); // nosemgrep -- path is contained by the test-owned workspace root
});

test('workspace initialization normalizes invalid folder characters and Windows special names', () => {
  const workspacePath = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-normalized-backups-')), 'Test workspace');
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  const settingsPath = resolveWithinRoot(workspacePath, '.bcdevtoolset', 'settings.json');
  const cases = [
    ['Local', 'Local'],
    ['QA: <test>"/\\|?*\u0001', 'QA_ _test________'],
    ['Trailing. ', 'Trailing__'],
    ['.', '_'],
    ['..', '__'],
    ['', '_'],
    ['CON.txt', '_CON.txt'],
    ['lpt1', '_lpt1'],
    ['Release QA', 'Release QA']
  ];
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "." }] }\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.mkdirSync(resolveWithinRoot(workspacePath, '.bcdevtoolset')); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(settingsPath, JSON.stringify({ configurations: cases.map(([name]) => ({ name, serverType: 'Container' })) })); // nosemgrep -- path is contained by the test-owned workspace root

  const result = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  assert.deepEqual(settings.configurations.map(({ name }) => name), cases.map(([name]) => name));
  assert.deepEqual(settings.configurations.map(({ sqlBackupPath }) => sqlBackupPath), cases.map(([, folder]) => `.bcdevtoolset/.backups/${folder}`));
  for (const [, folder] of cases) {
    assert.ok(fs.statSync(resolveWithinRoot(workspacePath, '.bcdevtoolset', '.backups', folder)).isDirectory()); // nosemgrep -- path is contained by the test-owned workspace root
  }
  const rerun = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), settings); // nosemgrep -- path is contained by the test-owned workspace root
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
    settings: { 'files.exclude': { generated: true }, 'al.assemblyProbingPaths': ['./custom-assemblies'] }
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
  assert.deepEqual(initializedWorkspace.settings['al.assemblyProbingPaths'], ['./custom-assemblies', './.netpackages']);

  const rerunResult = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(rerunResult.status, 0, rerunResult.stderr);
  const rerunWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  assert.deepEqual(rerunWorkspace.folders, initializedWorkspace.folders);
  assert.deepEqual(rerunWorkspace.settings['files.exclude'], initializedWorkspace.settings['files.exclude']);
  assert.deepEqual(rerunWorkspace.settings['al.assemblyProbingPaths'], ['./custom-assemblies', './.netpackages']);
});

test('workspace initialization rejects backup directory links that could write outside the workspace', () => {
  const workspacePath = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-backup-link-')), 'Test workspace');
  const outsidePath = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-outside-backups-')), 'External test directory');
  const workspaceFile = resolveWithinRoot(workspacePath, 'sample.code-workspace');
  fs.writeFileSync(resolveWithinRoot(workspacePath, 'app.json'), '{}\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.writeFileSync(workspaceFile, '{ "folders": [{ "path": "." }] }\n'); // nosemgrep -- path is contained by the test-owned workspace root
  fs.mkdirSync(resolveWithinRoot(workspacePath, '.bcdevtoolset')); // nosemgrep -- path is contained by the test-owned workspace root
  fs.symlinkSync(outsidePath, resolveWithinRoot(workspacePath, '.bcdevtoolset', '.backups'), process.platform === 'win32' ? 'junction' : 'dir'); // nosemgrep -- both paths are authorized test-owned roots

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be a link/);
  assert.deepEqual(fs.readdirSync(outsidePath), []); // nosemgrep -- outsidePath is an authorized test-owned root
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
  assert.ok(fs.statSync(resolveWithinRoot(workspaceBasePath, '.bcdevtoolset', '.backups', 'Local')).isDirectory()); // nosemgrep -- path is contained by the test-owned workspace root
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
  assert.doesNotMatch(result.stdout, /Local-Test/);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(settings.licenseFile, 'custom-license.flf');
  assert.equal(settings.configurations[0].customValue, 'preserve-me');
  assert.equal(Object.hasOwn(settings, 'executeTestsInContainerName'), false);

  settings.executeTestsInContainerName = 'preselected-test';
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  const rerunResult = runInitializeWorkspace(workspacePath, workspaceFile);
  assert.equal(rerunResult.status, 0, rerunResult.stderr);
  const rerunSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(Object.hasOwn(rerunSettings, 'executeTestsInContainerName'), false);
  assert.equal(rerunSettings.configurations.length, 1);
});

test('workspace initialization adds missing Local and removes obsolete named test target setting', () => {
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
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(Object.hasOwn(settings, 'executeTestsInContainerName'), false);
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
  const migrated = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- settingsPath is contained by the test-owned workspace root
  assert.equal(Object.hasOwn(migrated, 'executeTestsInContainerName'), false);
  assert.deepEqual(migrated.configurations.map(({ container }) => container), ['sample', 'sample-Test']);
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
    settings: { 'bcDevToolset': { country: 'de', selectArtifact: 'Closest' } }
  }));

  const result = runInitializeWorkspace(workspacePath, workspaceFile);

  assert.equal(result.status, 0, result.stderr);
  const initializedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- path is contained by the test-owned workspace root
  assert.equal(initializedWorkspace.settings['al.symbolsCountryRegion'], 'de');
  assert.equal('country' in initializedWorkspace.settings['bcDevToolset'], false);
});
