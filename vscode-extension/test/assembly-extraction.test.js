const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workspaceMgtPath = path.join(repositoryRoot, 'common', 'WorkspaceMgt.ps1');

function runPowerShell(script, workspace) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, TEST_WORKSPACE: workspace }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('assembly paths stay inside their app folder', () => {
  const workspace = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-containment-')), 'Test workspace');
  runPowerShell(`
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    try {
      Resolve-ContainedAssemblyPath -validatedRoot $env:TEST_WORKSPACE -segments @('..', 'Service')
      exit 2
    } catch {
      exit 0
    }
  `, workspace);
});

test('extraction puts DLLs in each OnPrem app .netpackages folder', () => {
  const workspace = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-per-app-assemblies-')), 'Test workspace');
  const onPremFolders = ['first', path.join('group', 'second')];
  for (const folder of onPremFolders) {
    fs.mkdirSync(resolveWithinRoot(workspace, folder), { recursive: true }); // nosemgrep -- contained by test-owned workspace
    fs.writeFileSync(resolveWithinRoot(workspace, folder, 'app.json'), JSON.stringify({ target: 'OnPrem' })); // nosemgrep -- contained by test-owned workspace
  }
  fs.mkdirSync(resolveWithinRoot(workspace, 'cloud')); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(workspace, 'cloud', 'app.json'), JSON.stringify({ target: 'Cloud' })); // nosemgrep -- contained by test-owned workspace
  fs.mkdirSync(resolveWithinRoot(workspace, 'first', '.netpackages')); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(workspace, 'first', '.netpackages', 'custom.dll'), 'unmanaged'); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(workspace, 'first', '.gitignore'), 'existing-entry/\n'); // nosemgrep -- contained by test-owned workspace
  const workspaceFile = resolveWithinRoot(workspace, 'sample.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [], settings: { 'editor.tabSize': 2 } })); // nosemgrep -- contained by test-owned workspace
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $script:bcDevToolsetWorkspaceRootPath = $env:TEST_WORKSPACE
    $env:BCDEVTOOLSET_WORKSPACE_FILE = Join-Path $env:TEST_WORKSPACE 'sample.code-workspace'
    function Test-DockerContainerExists { return $true }
    function Invoke-ScriptInBcContainer {
      return [PSCustomObject]@{ Service = 'C:\\Service'; DotNet = 'C:\\DotNet'; DotNetSource = 'ReferencePack' }
    }
    function Copy-DirectoryFromBcContainer {
      param($containerName, $containerPath, $localPath)
      $null = [System.IO.Directory]::CreateDirectory($localPath)
      if ($containerPath -eq 'C:\\Service') {
        [System.IO.File]::WriteAllText((Join-Path $localPath 'Service.dll'), 'service')
        [System.IO.File]::WriteAllText((Join-Path $localPath 'Shared.dll'), 'service')
      } else {
        [System.IO.File]::WriteAllText((Join-Path $localPath 'DotNet.dll'), 'dotnet')
        [System.IO.File]::WriteAllText((Join-Path $localPath 'Shared.dll'), 'dotnet')
      }
    }
    $workspace = [PSCustomObject]@{ folders = @(
      [PSCustomObject]@{ path = 'first' },
      [PSCustomObject]@{ path = 'group/second' },
      [PSCustomObject]@{ path = 'cloud' }
    ) }
    $configuration = [PSCustomObject]@{ container = 'bc-one' }
    $result = Invoke-ContainerAssemblyExtraction -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -settingsJSON ([PSCustomObject]@{}) -workspaceJSON $workspace -configurations @($configuration)
    if (-not $result) { exit 2 }
  `;
  runPowerShell(script, workspace);

  for (const folder of onPremFolders) {
    const appPath = resolveWithinRoot(workspace, folder);
    const packagesPath = resolveWithinRoot(appPath, '.netpackages');
    const expectedFiles = folder === 'first'
      ? ['.bcdevtoolset-assemblies.json', 'DotNet.dll', 'Service.dll', 'Shared.dll', 'custom.dll']
      : ['.bcdevtoolset-assemblies.json', 'DotNet.dll', 'Service.dll', 'Shared.dll'];
    assert.deepEqual(fs.readdirSync(packagesPath).sort(), expectedFiles); // nosemgrep -- contained by test-owned app
    assert.equal(fs.readFileSync(resolveWithinRoot(packagesPath, 'Shared.dll'), 'utf8'), 'dotnet'); // nosemgrep -- contained by test-owned app
    assert.equal(fs.existsSync(resolveWithinRoot(appPath, '.vscode', 'settings.json')), false); // nosemgrep -- contained by test-owned app
  }
  assert.equal(fs.readFileSync(resolveWithinRoot(workspace, 'first', '.gitignore'), 'utf8'), 'existing-entry/\n'); // nosemgrep -- contained by test-owned workspace
  assert.equal(fs.existsSync(resolveWithinRoot(workspace, 'group', 'second', '.gitignore')), false); // nosemgrep -- contained by test-owned workspace
  assert.equal(fs.existsSync(resolveWithinRoot(workspace, 'cloud', '.netpackages')), false); // nosemgrep -- contained by test-owned workspace
  assert.equal(fs.existsSync(resolveWithinRoot(workspace, '.netpackages')), false); // nosemgrep -- contained by test-owned workspace
  const updatedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); // nosemgrep -- contained by test-owned workspace
  assert.equal(updatedWorkspace.settings['editor.tabSize'], 2);
  assert.deepEqual(updatedWorkspace.settings['al.assemblyProbingPaths'], ['./.netpackages']);

  updatedWorkspace.settings['al.assemblyProbingPaths'] = ['./custom-assemblies', './.NetPackages'];
  fs.writeFileSync(workspaceFile, JSON.stringify(updatedWorkspace)); // nosemgrep -- contained by test-owned workspace
  runPowerShell(script, workspace);
  assert.deepEqual(JSON.parse(fs.readFileSync(workspaceFile, 'utf8')).settings['al.assemblyProbingPaths'], ['./custom-assemblies', './.NetPackages', './.netpackages']); // nosemgrep -- contained by test-owned workspace
  runPowerShell(script, workspace);
  assert.deepEqual(JSON.parse(fs.readFileSync(workspaceFile, 'utf8')).settings['al.assemblyProbingPaths'], ['./custom-assemblies', './.NetPackages', './.netpackages']); // nosemgrep -- contained by test-owned workspace
});

test('managed assembly refresh removes stale DLLs and preserves unrelated DLLs', () => {
  const workspace = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-managed-assemblies-')), 'Test workspace');
  const packagesPath = resolveWithinRoot(workspace, '.netpackages');
  const firstStage = resolveWithinRoot(workspace, 'first');
  const secondStage = resolveWithinRoot(workspace, 'second');
  for (const folder of [packagesPath, firstStage, secondStage]) fs.mkdirSync(folder); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(packagesPath, 'custom.dll'), 'unmanaged'); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(firstStage, 'Old.dll'), 'old'); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(secondStage, 'New.dll'), 'new'); // nosemgrep -- contained by test-owned workspace
  runPowerShell(`
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    Sync-AppNetPackages -sourcePath (Join-Path $env:TEST_WORKSPACE 'first') -destinationPath (Join-Path $env:TEST_WORKSPACE '.netpackages')
    Sync-AppNetPackages -sourcePath (Join-Path $env:TEST_WORKSPACE 'second') -destinationPath (Join-Path $env:TEST_WORKSPACE '.netpackages')
  `, workspace);
  assert.deepEqual(fs.readdirSync(packagesPath).sort(), ['.bcdevtoolset-assemblies.json', 'New.dll', 'custom.dll']); // nosemgrep -- contained by test-owned workspace
});

test('extraction refuses to overwrite an unrelated DLL with the same name', () => {
  const workspace = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-assembly-collision-')), 'Test workspace');
  const packagesPath = resolveWithinRoot(workspace, '.netpackages');
  const sourcePath = resolveWithinRoot(workspace, 'source');
  fs.mkdirSync(packagesPath); // nosemgrep -- contained by test-owned workspace
  fs.mkdirSync(sourcePath); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(packagesPath, 'Shared.dll'), 'developer'); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(sourcePath, 'Shared.dll'), 'container'); // nosemgrep -- contained by test-owned workspace
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    try {
      Sync-AppNetPackages -sourcePath (Join-Path $env:TEST_WORKSPACE 'source') -destinationPath (Join-Path $env:TEST_WORKSPACE '.netpackages')
      exit 2
    } catch {
      Write-Output $_.Exception.Message
    }
  `;
  assert.match(runPowerShell(script, workspace), /not managed/);
  assert.equal(fs.readFileSync(resolveWithinRoot(packagesPath, 'Shared.dll'), 'utf8'), 'developer'); // nosemgrep -- contained by test-owned workspace
});

test('extraction rejects linked manifests and managed DLLs outside the app', (t) => {
  const workspace = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-assembly-links-')), 'Test workspace');
  const packagesPath = resolveWithinRoot(workspace, '.netpackages');
  const sourcePath = resolveWithinRoot(workspace, 'source');
  const outsidePath = resolveWithinRoot(workspace, 'outside.txt');
  const manifestPath = resolveWithinRoot(packagesPath, '.bcdevtoolset-assemblies.json');
  const linkedDllPath = resolveWithinRoot(packagesPath, 'Linked.dll');
  fs.mkdirSync(packagesPath); // nosemgrep -- contained by test-owned workspace
  fs.mkdirSync(sourcePath); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(outsidePath, 'outside'); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(resolveWithinRoot(sourcePath, 'Linked.dll'), 'container'); // nosemgrep -- contained by test-owned workspace
  try {
    fs.symlinkSync(outsidePath, manifestPath, 'file'); // nosemgrep -- both paths are in the test-owned workspace
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('File symlinks are unavailable');
    throw error;
  }
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    try {
      Sync-AppNetPackages -sourcePath (Join-Path $env:TEST_WORKSPACE 'source') -destinationPath (Join-Path $env:TEST_WORKSPACE '.netpackages')
      exit 2
    } catch { Write-Output $_.Exception.Message }
  `;
  assert.match(runPowerShell(script, workspace), /symbolic link or reparse point/);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside'); // nosemgrep -- contained by test-owned workspace
  fs.unlinkSync(manifestPath); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(manifestPath, '["Linked.dll"]'); // nosemgrep -- contained by test-owned workspace
  fs.symlinkSync(outsidePath, linkedDllPath, 'file'); // nosemgrep -- both paths are in the test-owned workspace
  assert.match(runPowerShell(script, workspace), /symbolic link or reparse point/);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside'); // nosemgrep -- contained by test-owned workspace
});

test('folder-only extraction configures VS Code probing paths without changing gitignore', () => {
  const workspace = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-folder-assemblies-')), 'Test workspace');
  fs.writeFileSync(resolveWithinRoot(workspace, 'app.json'), JSON.stringify({ target: 'OnPrem' })); // nosemgrep -- contained by test-owned workspace
  const vscodePath = resolveWithinRoot(workspace, '.vscode');
  const settingsPath = resolveWithinRoot(vscodePath, 'settings.json');
  fs.mkdirSync(vscodePath); // nosemgrep -- contained by test-owned workspace
  fs.writeFileSync(settingsPath, JSON.stringify({ 'editor.tabSize': 2, 'al.assemblyProbingPaths': ['./custom'] })); // nosemgrep -- contained by test-owned workspace
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $script:bcDevToolsetWorkspaceRootPath = $env:TEST_WORKSPACE
    $env:BCDEVTOOLSET_WORKSPACE_FILE = ''
    function Test-DockerContainerExists { return $true }
    function Invoke-ScriptInBcContainer {
      return [PSCustomObject]@{ Service = 'C:\\Service'; DotNet = ''; DotNetSource = 'Missing' }
    }
    function Copy-DirectoryFromBcContainer {
      param($containerName, $containerPath, $localPath)
      $null = [System.IO.Directory]::CreateDirectory($localPath)
      [System.IO.File]::WriteAllText((Join-Path $localPath 'Service.dll'), 'service')
    }
    $workspace = [PSCustomObject]@{ folders = @([PSCustomObject]@{ path = '.' }) }
    $configuration = [PSCustomObject]@{ container = 'bc-one' }
    $result = Invoke-ContainerAssemblyExtraction -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -settingsJSON ([PSCustomObject]@{}) -workspaceJSON $workspace -configurations @($configuration)
    if (-not $result) { exit 2 }
  `;
  runPowerShell(script, workspace);
  runPowerShell(script, workspace);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))['al.assemblyProbingPaths'], ['./custom', './.netpackages']); // nosemgrep -- contained by test-owned workspace
  assert.equal(fs.existsSync(resolveWithinRoot(workspace, '.gitignore')), false); // nosemgrep -- contained by test-owned workspace
});
