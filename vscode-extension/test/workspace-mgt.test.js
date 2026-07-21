const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workspaceMgtPath = path.join(repositoryRoot, 'common', 'WorkspaceMgt.ps1');

function runPowerShell(script, environment = {}) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('assembly probing path helpers update local VS Code settings and gitignore safely', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-assemblies-'));
  const probingRoot = path.join(workspace, '.assemblies');
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $workspaceRoot = [System.IO.Path]::GetFullPath($env:TEST_WORKSPACE)
    $validatedRoot = Resolve-AssemblyProbingPathsRoot -workspaceRootPath $workspaceRoot -configuredRoot '.assemblies'
    $service = Resolve-ContainedAssemblyPath -validatedRoot $validatedRoot -segments @('bc-one', 'Service')
    $dotnet = Resolve-ContainedAssemblyPath -validatedRoot $validatedRoot -segments @('bc-one', 'DotNet')
    Update-AssemblyProbingPathsSetting -workspaceRootPath $workspaceRoot -paths @($service, $dotnet)
    Add-GitIgnoreEntry -workspaceRootPath $workspaceRoot -entry '.assemblies/'
  `;

  runPowerShell(script, { TEST_WORKSPACE: workspace });

  const settings = JSON.parse(fs.readFileSync(path.join(workspace, '.vscode', 'settings.json'), 'utf8'));
  assert.deepEqual(settings['al.assemblyProbingPaths'], [
    path.join(probingRoot, 'bc-one', 'Service'),
    path.join(probingRoot, 'bc-one', 'DotNet')
  ]);
  const gitignore = fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(gitignore.includes('.vscode/settings.json'));
  assert.ok(gitignore.includes('.assemblies/'));
});

test('assembly probing paths reject unsafe container path segments', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-containment-'));
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    try {
      Resolve-ContainedAssemblyPath -validatedRoot $env:TEST_WORKSPACE -segments @('..', 'Service')
      exit 2
    } catch {
      exit 0
    }
  `;

  runPowerShell(script, { TEST_WORKSPACE: workspace });
});

test('OnPrem app discovery returns only OnPrem folders in a multi-folder workspace', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-onprem-'));
  fs.mkdirSync(path.join(workspace, 'cloud'));
  fs.mkdirSync(path.join(workspace, 'onprem'));
  fs.writeFileSync(path.join(workspace, 'cloud', 'app.json'), JSON.stringify({ target: 'Cloud' }));
  fs.writeFileSync(path.join(workspace, 'onprem', 'app.json'), JSON.stringify({ target: 'OnPrem' }));
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $script:bcDevToolsetWorkspaceRootPath = [System.IO.Path]::GetFullPath($env:TEST_WORKSPACE)
    $workspace = [PSCustomObject]@{ folders = [PSCustomObject]@{ path = @('cloud', 'onprem') } }
    $paths = @(Get-WorkspaceOnPremAppPaths -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -workspaceJSON $workspace)
    if ($paths.Count -ne 1 -or (Split-Path -Leaf $paths[0]) -ne 'onprem') { exit 2 }
  `;

  runPowerShell(script, { TEST_WORKSPACE: workspace });
});

test('probing settings are written to OnPrem app folders but not Cloud app folders', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-app-settings-'));
  const cloudPath = path.join(workspace, 'cloud');
  const onPremPath = path.join(workspace, 'onprem');
  fs.mkdirSync(cloudPath);
  fs.mkdirSync(onPremPath);
  const servicePath = path.join(workspace, '.assemblies', 'bc-one', 'Service');
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    Update-AssemblyProbingPathsSetting -workspaceRootPath $env:ONPREM_PATH -paths @($env:SERVICE_PATH)
  `;

  runPowerShell(script, { ONPREM_PATH: onPremPath, SERVICE_PATH: servicePath });

  assert.ok(fs.existsSync(path.join(onPremPath, '.vscode', 'settings.json')));
  assert.ok(!fs.existsSync(path.join(cloudPath, '.vscode', 'settings.json')));
});

test('probing settings remove a stale DotNet path when a container has no reference pack', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-stale-dotnet-'));
  const servicePath = path.join(workspace, '.assemblies', 'bc-one', 'Service');
  const dotNetPath = path.join(workspace, '.assemblies', 'bc-one', 'DotNet');
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    Update-AssemblyProbingPathsSetting -workspaceRootPath $env:TEST_WORKSPACE -paths @($env:SERVICE_PATH, $env:DOTNET_PATH)
    Update-AssemblyProbingPathsSetting -workspaceRootPath $env:TEST_WORKSPACE -paths @($env:SERVICE_PATH) -pathsToRemove @($env:DOTNET_PATH)
  `;

  runPowerShell(script, { TEST_WORKSPACE: workspace, SERVICE_PATH: servicePath, DOTNET_PATH: dotNetPath });
  const settings = JSON.parse(fs.readFileSync(path.join(workspace, '.vscode', 'settings.json'), 'utf8'));
  assert.deepEqual(settings['al.assemblyProbingPaths'], [servicePath]);
});

test('container creation callers pass workspace context required for OnPrem app detection', () => {
  for (const relativePath of ['operations/NewDockerContainer.ps1', 'common/TestMgt.ps1']) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
    assert.match(source, /New-DockerContainer[\s\S]*?-workspaceJSON \$workspaceJSON/);
  }
});

test('assembly extraction uses the Hyper-V-compatible BcContainerHelper copy operation', () => {
  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const extractionFunction = source.match(/function Copy-DirectoryFromBcContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(extractionFunction, /Copy-FileFromBcContainer/);
  assert.match(extractionFunction, /FileShare\]::ReadWrite -bor \[System\.IO\.FileShare\]::Delete/);
  assert.doesNotMatch(extractionFunction, /Compress-Archive/);
  assert.match(extractionFunction, /Sync-ExtractedAssemblyDirectory/);
  assert.doesNotMatch(source, /docker cp/);
});

test('container archive paths preserve the first character of every relative path', () => {
  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const extractionFunction = source.match(/function Copy-DirectoryFromBcContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(extractionFunction, /TrimEnd\(\$separator\) \+ \$separator/);
  assert.doesNotMatch(extractionFunction, /TrimEnd\('\\\\'\) \+ '\\\\'/);
});

test('DotNet extraction prefers reference packs and falls back to the shared runtime', () => {
  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  assert.match(source, /dotnet\\packs\\Microsoft\.NETCore\.App\.Ref/);
  assert.match(source, /dotnet\\shared\\Microsoft\.NETCore\.App/);
  assert.match(source, /DotNetSource = if[\s\S]*?'ReferencePack'[\s\S]*?'RuntimeSharedFramework'/);
  assert.match(source, /Falling back to runtime assemblies/);
});

test('assembly extraction is exposed as a Container operation and reused after container creation', () => {
  const operations = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'operations', 'operations.json'), 'utf8'));
  const operation = operations.find(({ id }) => id === 'extractContainerAssemblies');
  assert.deepEqual(operation, {
    id: 'extractContainerAssemblies',
    title: 'Extract assembly probing paths from Docker container',
    script: 'operations/ExtractContainerAssemblies.ps1',
    category: 'Container'
  });

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const containerCreationFunction = source.match(/function New-DockerContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(containerCreationFunction, /New-BcContainer @Parameters[\s\S]*?autoExtractAssemblies[\s\S]*?Invoke-ContainerAssemblyExtraction/);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'package.json'), 'utf8'));
  assert.ok(packageJson.activationEvents.includes('onCommand:bcDevToolset.operation.extractContainerAssemblies'));
  assert.ok(packageJson.contributes.commands.some(({ command }) => command === 'bcDevToolset.operation.extractContainerAssemblies'));
});

test('automatic extraction requires a boolean Container configuration flag while manual extraction ignores it', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'schemas', 'bcdevtoolset-settings.schema.json'), 'utf8'));
  const containerRule = schema.definitions.configuration.allOf.find((rule) => rule.if?.properties?.serverType?.const === 'Container');
  assert.deepEqual(containerRule.then.properties.autoExtractAssemblies, {
    type: 'boolean',
    default: false,
    description: 'Whether Service and .NET assemblies are extracted automatically after this container is built. Manual extraction ignores this setting.'
  });

  const nonContainerRule = schema.definitions.configuration.allOf.find((rule) =>
    rule.if?.not?.properties?.serverType?.const === 'Container' && rule.then?.properties?.autoExtractAssemblies);
  assert.ok(nonContainerRule);

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  assert.match(source, /autoExtractAssemblies'\] -and \$configuration\.autoExtractAssemblies -eq \$true/);
  const manualOperation = fs.readFileSync(path.join(repositoryRoot, 'operations', 'ExtractContainerAssemblies.ps1'), 'utf8');
  assert.doesNotMatch(manualOperation, /autoExtractAssemblies/);
  assert.match(source, /operationName 'assembly extraction'\s*`\s*-allowAll \$false/);
});
