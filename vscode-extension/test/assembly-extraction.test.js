const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-containment-'));
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-per-app-assemblies-'));
  const onPremFolders = ['first', path.join('group', 'second')];
  for (const folder of onPremFolders) {
    fs.mkdirSync(path.join(workspace, folder), { recursive: true });
    fs.writeFileSync(path.join(workspace, folder, 'app.json'), JSON.stringify({ target: 'OnPrem' }));
  }
  fs.mkdirSync(path.join(workspace, 'cloud'));
  fs.writeFileSync(path.join(workspace, 'cloud', 'app.json'), JSON.stringify({ target: 'Cloud' }));
  fs.mkdirSync(path.join(workspace, 'first', '.netpackages'));
  fs.writeFileSync(path.join(workspace, 'first', '.netpackages', 'custom.dll'), 'unmanaged');
  fs.writeFileSync(path.join(workspace, 'first', '.gitignore'), 'existing-entry/\n');
  const workspaceFile = path.join(workspace, 'sample.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [], settings: { 'editor.tabSize': 2 } }));
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
    const appPath = path.join(workspace, folder);
    const packagesPath = path.join(appPath, '.netpackages');
    const expectedFiles = folder === 'first'
      ? ['.bcdevtoolset-assemblies.json', 'DotNet.dll', 'Service.dll', 'Shared.dll', 'custom.dll']
      : ['.bcdevtoolset-assemblies.json', 'DotNet.dll', 'Service.dll', 'Shared.dll'];
    assert.deepEqual(fs.readdirSync(packagesPath).sort(), expectedFiles);
    assert.equal(fs.readFileSync(path.join(packagesPath, 'Shared.dll'), 'utf8'), 'dotnet');
    assert.equal(fs.existsSync(path.join(appPath, '.vscode', 'settings.json')), false);
  }
  assert.equal(fs.readFileSync(path.join(workspace, 'first', '.gitignore'), 'utf8'), 'existing-entry/\n');
  assert.equal(fs.existsSync(path.join(workspace, 'group', 'second', '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'cloud', '.netpackages')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.netpackages')), false);
  const updatedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  assert.equal(updatedWorkspace.settings['editor.tabSize'], 2);
  assert.deepEqual(updatedWorkspace.settings['al.assemblyProbingPaths'], ['./.netpackages']);

  updatedWorkspace.settings['al.assemblyProbingPaths'] = ['./custom-assemblies', './.NetPackages'];
  fs.writeFileSync(workspaceFile, JSON.stringify(updatedWorkspace));
  runPowerShell(script, workspace);
  assert.deepEqual(JSON.parse(fs.readFileSync(workspaceFile, 'utf8')).settings['al.assemblyProbingPaths'], ['./custom-assemblies', './.NetPackages', './.netpackages']);
  runPowerShell(script, workspace);
  assert.deepEqual(JSON.parse(fs.readFileSync(workspaceFile, 'utf8')).settings['al.assemblyProbingPaths'], ['./custom-assemblies', './.NetPackages', './.netpackages']);
});

test('managed assembly refresh removes stale DLLs and preserves unrelated DLLs', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-managed-assemblies-'));
  const packagesPath = path.join(workspace, '.netpackages');
  const firstStage = path.join(workspace, 'first');
  const secondStage = path.join(workspace, 'second');
  for (const folder of [packagesPath, firstStage, secondStage]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(packagesPath, 'custom.dll'), 'unmanaged');
  fs.writeFileSync(path.join(firstStage, 'Old.dll'), 'old');
  fs.writeFileSync(path.join(secondStage, 'New.dll'), 'new');
  runPowerShell(`
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    Sync-AppNetPackages -sourcePath (Join-Path $env:TEST_WORKSPACE 'first') -destinationPath (Join-Path $env:TEST_WORKSPACE '.netpackages')
    Sync-AppNetPackages -sourcePath (Join-Path $env:TEST_WORKSPACE 'second') -destinationPath (Join-Path $env:TEST_WORKSPACE '.netpackages')
  `, workspace);
  assert.deepEqual(fs.readdirSync(packagesPath).sort(), ['.bcdevtoolset-assemblies.json', 'New.dll', 'custom.dll']);
});

test('extraction refuses to overwrite an unrelated DLL with the same name', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-assembly-collision-'));
  const packagesPath = path.join(workspace, '.netpackages');
  const sourcePath = path.join(workspace, 'source');
  fs.mkdirSync(packagesPath);
  fs.mkdirSync(sourcePath);
  fs.writeFileSync(path.join(packagesPath, 'Shared.dll'), 'developer');
  fs.writeFileSync(path.join(sourcePath, 'Shared.dll'), 'container');
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
  assert.equal(fs.readFileSync(path.join(packagesPath, 'Shared.dll'), 'utf8'), 'developer');
});
