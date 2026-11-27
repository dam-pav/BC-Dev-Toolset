const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workspaceMgtPath = path.join(repositoryRoot, 'common', 'WorkspaceMgt.ps1');

test('extension local settings and schema defaults separate manual Dev and automated Test containers', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8'); // nosemgrep -- fixed segments resolve beneath the trusted repository root
  const defaultFunctions = source.match(/^function getDefaultLocal\w+\([^]*?\n}/gm);
  assert.ok(defaultFunctions);
  const context = vm.createContext({ getWorkspaceName: () => 'Sample Project' });
  const settings = JSON.parse(vm.runInContext(`${defaultFunctions.join('\n')}\nJSON.stringify(getDefaultLocalSettings())`, context));
  assert.deepEqual(settings.configurations.map(({ name, serverType, targetType, includeTestToolkit, container }) =>
    ({ name, serverType, targetType, includeTestToolkit, container })), [
    { name: 'Local', serverType: 'Container', targetType: 'Dev', includeTestToolkit: 'false', container: 'Sample-Project' },
    { name: 'Local Test', serverType: 'Container', targetType: 'Test', includeTestToolkit: 'true', container: 'Sample-Project-test' }
  ]);
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'schemas', 'bcdevtoolset-settings.schema.json'), 'utf8')); // nosemgrep -- fixed segments resolve beneath the trusted repository root
  assert.deepEqual(schema.properties.configurations.default.map(({ name, targetType, includeTestToolkit }) =>
    ({ name, targetType, includeTestToolkit })), [
    { name: 'Local', targetType: 'Dev', includeTestToolkit: 'false' },
    { name: 'Local Test', targetType: 'Test', includeTestToolkit: 'true' }
  ]);
  assert.equal(settings.configurations[1].autoRestoreBackup, false);
  assert.notEqual(settings.configurations[0].autoRestoreBackup, false);
  assert.equal(schema.properties.configurations.default[1].autoRestoreBackup, false);
  assert.equal(schema.properties.configurations.default[0].autoRestoreBackup, true);
});

test('extension fallback adds missing defaults, preserves custom values and reports case-insensitive container conflicts', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8'); // nosemgrep -- fixed segments resolve beneath the trusted repository root
  const defaultFunctions = source.match(/^function getDefaultLocal\w+\([^]*?\n}/gm);
  const ensureFunction = source.match(/^function ensureDefaultLocalConfiguration\([^]*?\n}/m)?.[0];
  assert.ok(defaultFunctions);
  assert.ok(ensureFunction);
  for (const initial of [
    {},
    { configurations: [] },
    { configurations: [{ name: 'Local', container: 'legacy', includeTestToolkit: 'true', customField: 'keep' }] },
    { configurations: [{ name: 'local test', container: 'custom', includeTestToolkit: 'false', autoRestoreBackup: true, autoRestoreBeforeTest: false, customField: 7 }] },
    { configurations: [{ name: 'Local Test', container: 'custom', autoRestoreBackup: false, autoRestoreBeforeTest: true }] },
    { configurations: [{ name: 'Local Test', container: 'custom' }] },
    { configurations: [{ name: 'QA', serverType: 'Container', container: 'SAMPLE-TEST' }] }
  ]) {
    const configPath = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-fallback-')), 'Test configuration');
    const settingsPath = resolveWithinRoot(configPath, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ licenseFile: 'existing.flf', ...initial })); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
    const messages = [];
    const context = vm.createContext({ fs, resolveWithinRoot, getWorkspaceName: () => 'sample', writeOutput: (message) => messages.push(message), configPath });
    vm.runInContext(`${defaultFunctions.join('\n')}\n${ensureFunction}\nensureDefaultLocalConfiguration(configPath)`, context);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
    assert.equal(settings.licenseFile, 'existing.flf');
    const original = initial.configurations || [];
    assert.deepEqual(settings.configurations.slice(0, original.length), original);
    const generatedTest = settings.configurations.find(({ name }) => name === 'Local Test' &&
      !original.some((configuration) => configuration.name.toLowerCase() === 'local test'));
    if (generatedTest) assert.equal(generatedTest.autoRestoreBackup, false);
    assert.equal(settings.configurations.filter(({ name }) => name.toLowerCase() === 'local').length, 1);
    if (original.some(({ name }) => name === 'QA')) {
      assert.deepEqual(settings.configurations.map(({ name }) => name), ['QA', 'Local']);
      assert.match(messages.join('\n'), /Local Test was not added.*sample-test.*QA/);
      assert.match(messages.join('\n'), /rename.*rerun Initialize Workspace/i);
    } else {
      assert.equal(settings.configurations.length, 2);
      assert.equal(settings.configurations.filter(({ name }) => name.toLowerCase() === 'local test').length, 1);
    }
    const firstContent = fs.readFileSync(settingsPath, 'utf8'); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
    vm.runInContext('ensureDefaultLocalConfiguration(configPath)', context);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), firstContent); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
  }
});

test('extension local settings reconciles shared names and containers before creating missing defaults', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8'); // nosemgrep -- fixed segments resolve beneath the trusted repository root
  const defaultFunctions = source.match(/^function getDefaultLocal\w+\([^]*?\n}/gm);
  const ensureFunction = source.match(/^function ensureDefaultLocalConfiguration\([^]*?\n}/m)?.[0];
  assert.ok(defaultFunctions);
  assert.ok(ensureFunction);
  for (const scenario of [
    { local: [{ name: 'Local', container: 'custom-dev', customField: 'keep' }], shared: [{ name: 'QA', serverType: 'container', container: 'SAMPLE-TEST' }], expected: ['Local'], conflict: 'QA' },
    { local: [], shared: [{ name: 'LOCAL TEST', container: 'custom-test', customField: 'keep shared' }], expected: ['Local'] },
    { shared: [{ name: 'LOCAL TEST', container: 'custom-test' }], expected: ['Local'] },
    { shared: [{ name: 'QA', serverType: 'Container', container: 'SAMPLE-TEST' }], expected: ['Local'], conflict: 'QA' },
    { shared: [{ name: 'Debug', serverType: 'Container', container: 'SAMPLE' }], expected: ['Local Test'], conflict: 'Debug' },
    { shared: [{ name: 'local', container: 'custom-dev' }, { name: 'LOCAL TEST', container: 'custom-test' }], expected: [] }
  ]) {
    const configPath = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-shared-fallback-')), 'Test configuration');
    const settingsPath = resolveWithinRoot(configPath, 'settings.json');
    if (scenario.local) {
      fs.writeFileSync(settingsPath, JSON.stringify({ licenseFile: 'keep.flf', configurations: scenario.local })); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
    }
    const sharedBefore = structuredClone(scenario.shared);
    const messages = [];
    const context = vm.createContext({ fs, resolveWithinRoot, getWorkspaceName: () => 'sample', writeOutput: (message) => messages.push(message), configPath, sharedConfigurations: scenario.shared });
    vm.runInContext(`${defaultFunctions.join('\n')}\n${ensureFunction}\nensureDefaultLocalConfiguration(configPath, sharedConfigurations)`, context);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
    assert.deepEqual(settings.configurations.map(({ name }) => name), scenario.expected);
    assert.deepEqual(scenario.shared, sharedBefore);
    if (scenario.local) {
      assert.deepEqual(settings.configurations.slice(0, scenario.local.length), scenario.local);
      assert.equal(settings.licenseFile, 'keep.flf');
    }
    if (scenario.conflict) {
      assert.ok(messages.some((message) => {
        const skippedIndex = message.indexOf('was not added');
        return skippedIndex >= 0 && message.indexOf(scenario.conflict, skippedIndex + 'was not added'.length) >= 0;
      }), `Expected a skipped-default diagnostic naming ${scenario.conflict}`);
      assert.match(messages.join('\n'), /(?:shared|workspace).*settings|settings.*(?:shared|workspace)/i);
      assert.match(messages.join('\n'), /rename.*rerun Initialize Workspace/i);
    }
    const firstContent = fs.readFileSync(settingsPath, 'utf8'); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
    vm.runInContext('ensureDefaultLocalConfiguration(configPath, sharedConfigurations)', context);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), firstContent); // nosemgrep -- fixed settings path is contained by the authorized test-owned configuration root
  }
});

test('Open Local Settings and PowerShell initialization pass shared configuration context into reconciliation', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8'); // nosemgrep -- fixed segments resolve beneath the trusted repository root
  const openLocalSettings = source.match(/(?:async )?function openLocalSettingsJson\([^]*?\n}/)?.[0];
  assert.ok(openLocalSettings);
  assert.match(openLocalSettings, /ensureDefaultLocalConfiguration\(configPath,\s*getConfiguration\(\)\.get\('configurations'\)/);
  assert.doesNotMatch(openLocalSettings, /writeJsonIfMissing\([^;]*getDefaultLocalSettings/);
  const workspaceMgt = fs.readFileSync(workspaceMgtPath, 'utf8'); // nosemgrep -- fixed segments resolve beneath the trusted repository root
  const initializeContext = workspaceMgt.match(/function Initialize-Context[^]*?\n}/)?.[0];
  assert.ok(initializeContext);
  assert.match(initializeContext, /Build-Settings[^\n]*-SharedConfigurations/);
});

function runPowerShell(script, environment = {}) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('creation and pre-test restore flags each default to true and ignore the other flag', () => {
  const output = runPowerShell(`
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $results = @()
    foreach ($beforeTest in @('omitted', $true, $false)) {
      foreach ($onCreate in @('omitted', $true, $false)) {
        $configuration = [pscustomobject]@{}
        if ($beforeTest -is [bool]) { $configuration | Add-Member autoRestoreBeforeTest $beforeTest }
        if ($onCreate -is [bool]) { $configuration | Add-Member autoRestoreBackup $onCreate }
        $results += [pscustomobject]@{
          beforeTest = Test-AutoRestoreBeforeTest -configuration $configuration
          onCreate = Test-AutoRestoreBackup -configuration $configuration
        }
      }
    }
    ConvertTo-Json -InputObject $results -Compress
  `);
  assert.deepEqual(JSON.parse(output), [
    { beforeTest: true, onCreate: true }, { beforeTest: true, onCreate: true }, { beforeTest: true, onCreate: false },
    { beforeTest: true, onCreate: true }, { beforeTest: true, onCreate: true }, { beforeTest: true, onCreate: false },
    { beforeTest: false, onCreate: true }, { beforeTest: false, onCreate: true }, { beforeTest: false, onCreate: false }
  ]);
});

test('container creation callers pass workspace context required for OnPrem app detection', () => {
  for (const relativePath of ['operations/NewDockerContainer.ps1', 'common/TestMgt.ps1']) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
    assert.match(source, /New-DockerContainer[\s\S]*?-workspaceJSON \$workspaceJSON/);
  }
});

test('container artifact version comes from configuration platform or workspace baseline', () => {
  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  assert.match(source, /Get-ContainerArtifactApplicationVersion\s+`?\s*-Configuration \$configuration\s+`?\s*-WorkspaceAppJSON \$appJSON/);
});

test('launch.json updates honor explicit values and target-based defaults', () => {
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $cases = @(
      [PSCustomObject]@{ serverType = 'Container'; targetType = 'Dev' },
      [PSCustomObject]@{ serverType = 'Cloud'; targetType = 'Test' },
      [PSCustomObject]@{ serverType = 'OnPrem'; targetType = 'Production' },
      [PSCustomObject]@{ serverType = 'Cloud'; targetType = 'Dev'; autoUpdateLaunchJson = $false },
      [PSCustomObject]@{ serverType = 'OnPrem'; targetType = 'Test'; autoUpdateLaunchJson = $true }
    )
    $actual = @($cases | ForEach-Object { Test-AutoUpdateLaunchJson -configuration $_ })
    $expected = @($true, $false, $false, $false, $true)
    if ((Compare-Object $expected $actual -SyncWindow 0).Count -ne 0) { exit 2 }
    $testConfiguration = [PSCustomObject]@{ targetType = 'Test' }
    if (-not (Test-AutoUpdateLaunchJson -configuration $testConfiguration -appTargetType 'Test')) { exit 3 }
  `;

  runPowerShell(script);

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const launchWriter = source.match(/function Write-LaunchJSON[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(launchWriter, /Test-AutoUpdateLaunchJson -configuration \$_/);
});

test('launch.json target follows whether app dependencies identify it as a test app', () => {
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $regularApp = [PSCustomObject]@{ dependencies = @(
      [PSCustomObject]@{ id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; name = 'Test Reporting Add-in' }
    ) }
    if (Test-AppHasTestDependencies -appJSON $regularApp) { exit 2 }
    $toolkitIds = @(
      '5d86850b-0d76-4eca-bd7b-951ad998e997',
      'dd0be2ea-f733-4d65-bb34-a28f4624fb14',
      'e7320ebb-08b3-4406-b1ec-b4927d3e280b',
      '40860557-a18d-42ad-aecb-22b7dd80dc80',
      '5f892a06-a83a-4efb-95eb-9ab4dfb858bc'
    )
    foreach ($toolkitId in $toolkitIds) {
      $testApp = [PSCustomObject]@{ dependencies = @([PSCustomObject]@{ id = $toolkitId }) }
      if (-not (Test-AppHasTestDependencies -appJSON $testApp)) { exit 3 }
    }
  `;

  runPowerShell(script);
});

test('BC Data companion and designated test app receive Dev and Test container launches', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdata-launch-'));
  try {
    for (const appName of ['BCData', 'BCData.Tests']) {
      const appFolder = path.join(fixtureRoot, appName);
      fs.mkdirSync(appFolder);
      fs.copyFileSync(
        path.join(repositoryRoot, 'al', appName, 'app.json'),
        path.join(appFolder, 'app.json')
      );
    }
    const script = `
      . '${workspaceMgtPath.replaceAll("'", "''")}'
      $script:bcDevToolsetWorkspaceRootPath = $env:TEST_WORKSPACE
      $settings = [pscustomobject]@{ configurations = @(
        [pscustomobject]@{ name = 'BC23'; serverType = 'Container'; targetType = 'Dev'; container = 'bc23'; authentication = 'UserPassword' },
        [pscustomobject]@{ name = 'BC23'; serverType = 'Container'; targetType = 'Test'; container = 'bc23'; authentication = 'UserPassword' }
      ) }
      $workspace = [pscustomobject]@{ folders = @(
        [pscustomobject]@{ path = 'BCData' },
        [pscustomobject]@{ path = 'BCData.Tests' }
      ) }
      foreach ($app in $workspace.folders.path) {
        Write-LaunchJSON -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -appPath $app -settingsJSON $settings -workspaceJSON $workspace -replaceJSON $true
      }
    `;
    runPowerShell(script, { TEST_WORKSPACE: fixtureRoot });
    for (const [appName, target] of [['BCData', 'Dev'], ['BCData.Tests', 'Test']]) {
      const launch = JSON.parse(fs.readFileSync(path.join(fixtureRoot, appName, '.vscode', 'launch.json'), 'utf8'));
      assert.equal(launch.configurations.length, 1);
      assert.equal(launch.configurations[0].name, `BC23 ${target} Container`);
      assert.equal(launch.configurations[0].server, 'http://bc23');
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true }); // nosemgrep -- fixtureRoot is a newly created test-owned temporary directory
  }
});

test('app.json target determines container launch and artifact type', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-app-target-'));
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $script:bcDevToolsetWorkspaceRootPath = $env:TEST_WORKSPACE
    foreach ($case in @(
      [PSCustomObject]@{ folder = 'onprem'; target = 'OnPrem'; expected = 'OnPrem'; legacy = 'Sandbox' },
      [PSCustomObject]@{ folder = 'cloud'; target = 'Cloud'; expected = 'Sandbox'; legacy = 'OnPrem' },
      [PSCustomObject]@{ folder = 'default'; target = ''; expected = 'Sandbox'; legacy = 'OnPrem' }
    )) {
      $appPath = Join-Path $env:TEST_WORKSPACE $case.folder
      $null = [System.IO.Directory]::CreateDirectory($appPath)
      $manifest = [PSCustomObject]@{ application = '24.0.0.0' }
      if ($case.target) { $manifest | Add-Member -MemberType NoteProperty -Name target -Value $case.target }
      $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appPath 'app.json')
      if ((Get-AppArtifactType -appJSON $manifest) -ne $case.expected) { exit 2 }
      $settings = [PSCustomObject]@{ configurations = @([PSCustomObject]@{
        name = 'Local'; serverType = 'Container'; targetType = 'Dev'; container = 'bc-test'
        authentication = 'UserPassword'; environmentType = $case.legacy
      }) }
      Write-LaunchJSON -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -appPath $case.folder -settingsJSON $settings -replaceJSON:$true
      $launch = Get-Content -LiteralPath (Join-Path $appPath '.vscode/launch.json') -Raw | ConvertFrom-Json
      if ($launch.configurations[0].environmentType -ne $case.expected) { exit 3 }
    }
    $workspace = [PSCustomObject]@{ folders = @(
      [PSCustomObject]@{ path = 'onprem' }, [PSCustomObject]@{ path = 'cloud' }
    ) }
    $app = [PSCustomObject]@{}
    if (-not (Test-WorkspaceApplicationVersions -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -workspaceJSON $workspace -appJSON ([ref]$app))) { exit 4 }
    if ((Get-WorkspaceArtifactType -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -workspaceJSON $workspace -appJSON $app) -ne 'OnPrem') { exit 5 }
    $mixedSettings = [PSCustomObject]@{ configurations = @([PSCustomObject]@{
      name = 'Local'; serverType = 'Container'; targetType = 'Dev'; container = 'bc-test'; authentication = 'UserPassword'
    }) }
    Write-LaunchJSON -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -appPath 'cloud' -settingsJSON $mixedSettings -workspaceJSON $workspace -replaceJSON:$true
    $mixedLaunch = Get-Content -LiteralPath (Join-Path $env:TEST_WORKSPACE 'cloud/.vscode/launch.json') -Raw | ConvertFrom-Json
    if ($mixedLaunch.configurations[0].environmentType -ne 'OnPrem') { exit 6 }
    $cloudSettings = [PSCustomObject]@{ configurations = @([PSCustomObject]@{
      name = 'SaaS'; serverType = 'Cloud'; targetType = 'Dev'; environmentName = 'Sandbox'; tenant = 'test'
    }) }
    Write-LaunchJSON -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -appPath 'onprem' -settingsJSON $cloudSettings -workspaceJSON $workspace -replaceJSON:$true
    $onPremLaunch = Get-Content -LiteralPath (Join-Path $env:TEST_WORKSPACE 'onprem/.vscode/launch.json') -Raw | ConvertFrom-Json
    if (@($onPremLaunch.configurations).Count -ne 0) { exit 8 }
    $cloudWorkspace = [PSCustomObject]@{ folders = @([PSCustomObject]@{ path = 'cloud' }) }
    function Select-DockerContainerConfigurations { return [PSCustomObject]@{ container = 'bc-test'; autoExtractAssemblies = $true } }
    try {
      New-DockerContainer -testMode $true -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -appJSON ([PSCustomObject]@{ target = 'Cloud'; application = '24.0.0.0' }) -settingsJSON ([PSCustomObject]@{}) -workspaceJSON $cloudWorkspace -selectArtifact 'Latest' -pullFullArtifact $false
      exit 7
    } catch {
      if ($_.Exception.Message -notmatch 'autoExtractAssemblies requires at least one workspace app.json target OnPrem') { throw }
    }
    exit 0
  `;
  runPowerShell(script, { TEST_WORKSPACE: workspace });

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const containerCreation = source.match(/function New-DockerContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(containerCreation, /type = \$appArtifactType/);
  assert.match(containerCreation, /\$appArtifactType -eq "OnPrem"[\s\S]*?runSandboxAsOnPrem/);
  assert.doesNotMatch(containerCreation, /\$configuration\.environmentType/);
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
    description: 'Whether Service and .NET assemblies are extracted automatically after this container is built. Requires at least one workspace app.json target OnPrem. Manual extraction ignores this setting.'
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

test('automatic backup restore requires a boolean Container configuration flag while manual restore ignores it', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'schemas', 'bcdevtoolset-settings.schema.json'), 'utf8'));
  const containerRule = schema.definitions.configuration.allOf.find((rule) => rule.if?.properties?.serverType?.const === 'Container');
  assert.deepEqual(containerRule.then.properties.autoRestoreBackup, {
    type: 'boolean',
    default: true,
    description: 'Whether Create Docker container automatically restores a compatible SQL backup set from sqlBackupPath. Defaults to true when omitted. Test and manual restore operations ignore this setting.'
  });

  const nonContainerRule = schema.definitions.configuration.allOf.find((rule) =>
    rule.if?.not?.properties?.serverType?.const === 'Container' && rule.then?.properties?.autoRestoreBackup);
  assert.ok(nonContainerRule);

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const containerCreationFunction = source.match(/function New-DockerContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(source, /function Test-AutoRestoreBackup[\s\S]*?return \$configuration\.autoRestoreBackup -eq \$true[\s\S]*?return \$true/);
  assert.match(containerCreationFunction, /\$honorAutoRestoreBackup -and \(Test-AutoRestoreBackup -configuration \$configuration\)[\s\S]*?Get-SqlBackupRootPath[\s\S]*?\$Parameters\.bakFolder/);
  assert.match(containerCreationFunction, /New-BcContainer @Parameters[\s\S]*?\$Parameters\.ContainsKey\('bakFolder'\)[\s\S]*?Invoke-BcContainerSystemApplicationUpgradeAfterRestore/);
  const createContainerOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'NewDockerContainer.ps1'), 'utf8');
  assert.match(createContainerOperation, /New-DockerContainer[\s\S]*?-honorAutoRestoreBackup \$true/);
  const testManagement = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'common', 'TestMgt.ps1'), 'utf8');
  assert.match(testManagement, /New-DockerContainer[\s\S]*?-honorAutoRestoreBackup \$false/);
  assert.match(testManagement, /if \(-not \(Test-AutoRestoreBeforeTest -configuration \$configuration\)\)[\s\S]*?Skipping automatic SQL backup restore because autoRestoreBeforeTest is false/);
  const manualOperation = fs.readFileSync(path.join(repositoryRoot, 'operations', 'RestoreBcContainerDatabases.ps1'), 'utf8');
  assert.doesNotMatch(manualOperation, /autoRestoreBackup|autoRestoreBeforeTest/);
});

test('every newly created test container with a SQL backup path exports its initial backup', () => {
  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const backupManagement = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'common', 'BackupMgt.ps1'), 'utf8');
  const containerCreationFunction = source.match(/function New-DockerContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(
    containerCreationFunction,
    /New-BcContainer @Parameters[\s\S]*?Test-ShouldExportInitialTestContainerBackup[\s\S]*?Export-InitialTestContainerSqlBackupSet/
  );
  assert.match(backupManagement, /function Export-InitialTestContainerSqlBackupSet[\s\S]*?Backup-BcContainerDatabases/);

  const testManagement = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'common', 'TestMgt.ps1'), 'utf8');
  assert.doesNotMatch(testManagement, /Export-TestContainerBackupSet/);
  assert.match(
    testManagement,
    /New-DockerContainer[\s\S]*?-deferInitialBackupExport \$true[\s\S]*?Update-ContainerServerConfiguration[\s\S]*?Export-InitialTestContainerSqlBackupSet/
  );

  const output = runPowerShell(`
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $devTestContainer = [PSCustomObject]@{ targetType = 'Dev'; includeTestToolkit = 'true'; sqlBackupPath = 'backups' }
    $manualTestContainer = [PSCustomObject]@{ targetType = 'Test'; includeTestToolkit = 'true'; sqlBackupPath = 'backups' }
    $testWithoutToolkit = [PSCustomObject]@{ targetType = 'Test'; includeTestToolkit = 'false'; sqlBackupPath = 'backups' }
    [PSCustomObject]@{
      testOperation = Test-ShouldExportInitialTestContainerBackup -configuration $devTestContainer -creationTriggeredByTestOperation $true
      manualTest = Test-ShouldExportInitialTestContainerBackup -configuration $manualTestContainer
      manualDev = Test-ShouldExportInitialTestContainerBackup -configuration $devTestContainer
      missingToolkit = Test-ShouldExportInitialTestContainerBackup -configuration $testWithoutToolkit -creationTriggeredByTestOperation $true
    } | ConvertTo-Json -Compress
  `);
  const result = JSON.parse(output.split(/\r?\n/).at(-1));
  assert.deepEqual(result, {
    testOperation: true,
    manualTest: true,
    manualDev: false,
    missingToolkit: false
  });
});

test('container memory limits are validated and passed to New-BcContainer', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'schemas', 'bcdevtoolset-settings.schema.json'), 'utf8'));
  const containerRule = schema.definitions.configuration.allOf.find((rule) =>
    rule.if?.properties?.serverType?.const === 'Container');
  const nonContainerRule = schema.definitions.configuration.allOf.find((rule) =>
    rule.if?.not?.properties?.serverType?.const === 'Container' && rule.then?.properties?.memoryLimit);

  assert.ok(containerRule);
  assert.ok(nonContainerRule);
  assert.match('16G', new RegExp(containerRule.then.properties.memoryLimit.pattern));
  assert.match('16384M', new RegExp(containerRule.then.properties.memoryLimit.pattern));
  assert.doesNotMatch('16', new RegExp(containerRule.then.properties.memoryLimit.pattern));
  assert.match('2G', new RegExp(containerRule.then.properties.sqlMemoryLimit.pattern));
  assert.match('25%', new RegExp(containerRule.then.properties.sqlMemoryLimit.pattern));
  assert.doesNotMatch('101%', new RegExp(containerRule.then.properties.sqlMemoryLimit.pattern));
  assert.deepEqual(nonContainerRule.then.properties.memoryLimit.not, {});
  assert.deepEqual(nonContainerRule.then.properties.sqlMemoryLimit.not, {});

  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'package.json'), 'utf8'));
  const embeddedConfiguration = packageJson.contributes.configuration.find((group) => group.id === 'bcDevToolset').properties['bcDevToolset']
    .properties.configurations.items;
  const embeddedContainerRule = embeddedConfiguration.allOf.find((rule) =>
    rule.if?.properties?.serverType?.const === 'Container');
  assert.deepEqual(embeddedContainerRule.then.properties.memoryLimit, containerRule.then.properties.memoryLimit);
  assert.deepEqual(embeddedContainerRule.then.properties.sqlMemoryLimit, containerRule.then.properties.sqlMemoryLimit);

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const containerCreationFunction = source.match(/function New-DockerContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(containerCreationFunction, /'memoryLimit', 'sqlMemoryLimit'/);
  assert.match(containerCreationFunction, /\$Parameters\[\$parameterName\] = \[string\]\$configuration\.\$parameterName/);
});

test('container creation supports an optional explicit multitenant mode', () => {
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $implicit = Test-ConfigurationMultitenant -configuration ([PSCustomObject]@{ serverType = 'Container' })
    if ($null -ne $implicit) { exit 2 }
    if (-not (Test-ConfigurationMultitenant -configuration ([PSCustomObject]@{ serverType = 'Container'; multitenant = $true }))) { exit 3 }
    if (Test-ConfigurationMultitenant -configuration ([PSCustomObject]@{ serverType = 'Container'; multitenant = $false })) { exit 4 }
  `;
  runPowerShell(script);

  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'schemas', 'bcdevtoolset-settings.schema.json'), 'utf8'));
  const containerRule = schema.definitions.configuration.allOf.find((rule) => rule.if?.properties?.serverType?.const === 'Container');
  assert.deepEqual(containerRule.then.properties.multitenant, {
    type: 'boolean',
    description: 'Explicit multitenant mode passed to New-BcContainer. When omitted, Create Docker container infers the mode from a compatible backup set; if the backup does not determine the mode, the parameter is omitted and BcContainerHelper decides. Creation aborts when an explicit value conflicts with the backup type.'
  });

  const nonContainerRule = schema.definitions.configuration.allOf.find((rule) =>
    rule.if?.not?.properties?.serverType?.const === 'Container' && rule.then?.properties?.multitenant);
  assert.ok(nonContainerRule);

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const containerCreationFunction = source.match(/function New-DockerContainer[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(containerCreationFunction, /\$resolvedMultitenantMode = Resolve-ContainerMultitenantMode -configuration \$configuration[\s\S]*?\$Parameters\.multitenant = \$resolvedMultitenantMode/);
  assert.doesNotMatch(containerCreationFunction, /multitenant = \(Test-ConfigurationMultitenant/);
  assert.match(containerCreationFunction, /\$resolvedMultitenantMode = Resolve-ContainerMultitenantMode[\s\S]*?-backupEntries \$backupEntries[\s\S]*?\$Parameters\.multitenant = \$resolvedMultitenantMode/);
  const settingsBuilder = source.match(/function Build-Settings[\s\S]*?\n}/)?.[0] ?? '';
  assert.doesNotMatch(settingsBuilder, /-Name multitenant/);

  const extensionSource = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8');
  const defaultLocalConfiguration = extensionSource.match(/function getDefaultLocalConfiguration\([^)]*\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(defaultLocalConfiguration);
  assert.doesNotMatch(defaultLocalConfiguration, /multitenant:/);
  assert.equal(Object.hasOwn(schema.properties.configurations.default[0], 'multitenant'), false);
});

test('explicit multitenant mode wins and conflicting backup types abort creation', () => {
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $appBackup = @([PSCustomObject]@{ DatabaseRole = 'app' })
    $databaseBackup = @([PSCustomObject]@{ DatabaseRole = 'database' })
    $implicit = [PSCustomObject]@{ name = 'Local'; container = 'test' }
    $undecided = Resolve-ContainerMultitenantMode -configuration $implicit -backupEntries @()
    if ($null -ne $undecided) { exit 2 }
    if (-not (Resolve-ContainerMultitenantMode -configuration $implicit -backupEntries $appBackup)) { exit 2 }
    if (Resolve-ContainerMultitenantMode -configuration $implicit -backupEntries $databaseBackup) { exit 3 }

    $explicitMulti = [PSCustomObject]@{ name = 'Local'; container = 'test'; multitenant = $true }
    $explicitSingle = [PSCustomObject]@{ name = 'Local'; container = 'test'; multitenant = $false }
    if (-not (Resolve-ContainerMultitenantMode -configuration $explicitMulti -backupEntries @())) { exit 4 }
    if (Resolve-ContainerMultitenantMode -configuration $explicitSingle -backupEntries @()) { exit 5 }

    $explicitMultiConflict = ''
    try { Resolve-ContainerMultitenantMode -configuration $explicitMulti -backupEntries $databaseBackup | Out-Null }
    catch { $explicitMultiConflict = $_.Exception.Message }
    if ($explicitMultiConflict -notmatch 'explicitly sets multitenant to true') { exit 6 }

    $explicitSingleConflict = ''
    try { Resolve-ContainerMultitenantMode -configuration $explicitSingle -backupEntries $appBackup | Out-Null }
    catch { $explicitSingleConflict = $_.Exception.Message }
    if ($explicitSingleConflict -notmatch 'explicitly sets multitenant to false') { exit 7 }

    $mixedBackupConflict = ''
    try { Resolve-ContainerMultitenantMode -configuration $implicit -backupEntries @($appBackup + $databaseBackup) | Out-Null }
    catch { $mixedBackupConflict = $_.Exception.Message }
    if ($mixedBackupConflict -notmatch 'both multitenant application') { exit 8 }
  `;
  runPowerShell(script);
});

test('Add Test Toolkit operation selects one configured container and aborts invalid selections', () => {
  const operations = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'operations', 'operations.json'), 'utf8'));
  const operation = operations.find(({ id }) => id === 'addTestToolkitToBcContainer');
  assert.equal(operation.title, 'Add Test Toolkit to existing container');
  assert.equal(operation.category, 'Container');
  assert.equal(operation.script, 'operations/AddTestToolkitToBcContainer.ps1');
  assert.equal(operation.promptInputs[0].inputName, 'containerSelection');

  const output = runPowerShell(`
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $script:selection = '2'
    $script:importedContainers = @()
    function Request-BcDevToolsetMcpPrompt { return $script:selection }
    function Import-TestToolkitToBcContainer { param([string] $containerName); $script:importedContainers += $containerName }
    $settings = [PSCustomObject]@{
      configurations = @(
        [PSCustomObject]@{ serverType = 'Cloud'; container = 'ignored' },
        [PSCustomObject]@{ serverType = 'Container'; container = 'first' },
        [PSCustomObject]@{ serverType = 'Container'; container = 'second' }
      )
    }
    $valid = Add-TestToolkitToConfiguredContainer -settingsJSON $settings
    $script:selection = ''
    $empty = Add-TestToolkitToConfiguredContainer -settingsJSON $settings
    $script:selection = '3'
    $invalid = Add-TestToolkitToConfiguredContainer -settingsJSON $settings
    [PSCustomObject]@{
      valid = $valid
      empty = $empty
      invalid = $invalid
      importedContainers = $script:importedContainers
    } | ConvertTo-Json -Compress
  `);
  const result = JSON.parse(output.split(/\r?\n/).at(-1));

  assert.equal(result.valid, true);
  assert.equal(result.empty, false);
  assert.equal(result.invalid, false);
  assert.deepEqual(result.importedContainers, ['second']);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'package.json'), 'utf8'));
  assert.ok(packageJson.activationEvents.includes('onCommand:bcDevToolset.operation.addTestToolkitToBcContainer'));
  assert.ok(packageJson.contributes.commands.some(({ command }) =>
    command === 'bcDevToolset.operation.addTestToolkitToBcContainer'));
});

test('named-container selection is removed and launch files preserve configured target roles', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'schemas', 'bcdevtoolset-settings.schema.json'), 'utf8'));
  assert.equal(Object.hasOwn(schema.properties, 'executeTestsInContainerName'), false);

  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  assert.doesNotMatch(source, /workspaceToolsetSettings\.executeTestsInContainerName/);
  assert.match(source, /\$_.targetType -eq \$appTargetType -and/);
  assert.match(source, /\$launchTargetType = \$remote\.targetType/);
});

test('launch generation keeps Dev and Test app targets on their configured container roles', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdevtoolset-role-specific-launch-'));
  const script = `
    . '${workspaceMgtPath.replaceAll("'", "''")}'
    $script:bcDevToolsetWorkspaceRootPath = $env:TEST_WORKSPACE
    $settings = [PSCustomObject]@{ configurations = @(
      [PSCustomObject]@{ name='BC23'; serverType='Container'; targetType='Dev'; container='bc23'; platform='23.0'; includeTestToolkit='true' },
      [PSCustomObject]@{ name='BC27.1'; serverType='Container'; targetType='Test'; container='bc271'; platform='27.1'; includeTestToolkit='true' }
    ) }
    foreach ($role in @('Dev', 'Test')) {
      $appPath = Join-Path $env:TEST_WORKSPACE $role
      $null = [System.IO.Directory]::CreateDirectory($appPath)
      $dependencies = @()
      if ($role -eq 'Test') { $dependencies = @([PSCustomObject]@{ id='5d86850b-0d76-4eca-bd7b-951ad998e997' }) }
      [PSCustomObject]@{ application='23.0.0.0'; dependencies=$dependencies } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $appPath 'app.json')
      Write-LaunchJSON -scriptPath '${repositoryRoot.replaceAll("'", "''")}' -appPath $role -settingsJSON $settings -replaceJSON:$true
      $launch = Get-Content -LiteralPath (Join-Path $appPath '.vscode/launch.json') -Raw | ConvertFrom-Json
      $expected = if ($role -eq 'Test') { 'BC27.1 Test Container' } else { 'BC23 Dev Container' }
      if ($launch.configurations.Count -ne 1 -or $launch.configurations[0].name -ne $expected) { exit 2 }
    }
  `;
  runPowerShell(script, { TEST_WORKSPACE: workspace });
});

test('automated test target selection requires Test-role Container configurations', () => {
  const targetManagement = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'common', 'TestTargets.ps1'), 'utf8');
  const configurationSelector = targetManagement.match(/function Get-TestContainerConfigurations[\s\S]*?\n}/)?.[0] ?? '';

  assert.match(configurationSelector, /\$_.serverType -eq 'Container'/);
  assert.match(configurationSelector, /\$_.targetType -eq 'Test'/);
  assert.match(configurationSelector, /\$_.includeTestToolkit -eq 'true'/);
  assert.doesNotMatch(targetManagement, /Dev container configurations|Dev Container configurations/);
});

test('AL test builds every workspace app before preparing the test container', () => {
  const testManagement = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'common', 'TestMgt.ps1'), 'utf8');
  const initializeContainer = testManagement.match(/function Initialize-TestExecutionContainer[\s\S]*?\n}/)?.[0] ?? '';
  const invokeTestsOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'Invoke-Tests.ps1'), 'utf8');
  const pageScriptOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'Invoke-PageScriptTests.ps1'), 'utf8');
  const buildOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'BuildAllApps.ps1'), 'utf8');

  assert.match(invokeTestsOperation, /BuildAllApps\.ps1'\) -SkipOperationUI[\s\S]*?Initialize-TestExecutionContainer/);
  assert.match(invokeTestsOperation, /Request-TestExecutionContainerSelection[\s\S]*?BuildAllApps\.ps1/);
  assert.match(pageScriptOperation, /Request-TestExecutionContainerSelection[\s\S]*?BuildAllApps\.ps1'\) -SkipOperationUI[\s\S]*?Initialize-TestExecutionContainer/);
  assert.doesNotMatch(invokeTestsOperation, /-BuildAppsBeforeDeployment/);
  assert.match(initializeContainer, /New-TestExecutionContainerIfMissing/);
  assert.match(buildOperation, /\[switch\] \$SkipOperationUI/);
  assert.match(buildOperation, /\$compilerOutput = @\(& \$alToolPath compile @compilerArguments 2>&1\)[\s\S]*?Write-Host \(\[string\]\$compilerOutputLine\)/);
});

test('AL compilation uses the required AL extension bundled tool instead of global al discovery', () => {
  const packageJson = JSON.parse(fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'vscode-extension', 'package.json'), 'utf8'));
  const extensionSource = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8');
  const operationBridge = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'Invoke-BcDevToolsetOperation.ps1'), 'utf8');
  const buildOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'BuildAllApps.ps1'), 'utf8');

  assert.ok(packageJson.extensionDependencies.includes('ms-dynamics-smb.al'));
  assert.match(extensionSource, /vscode\.extensions\.getExtension\('ms-dynamics-smb\.al'\)/);
  assert.match(extensionSource, /discoverAlTool\(alExtension\.extensionPath\)/);
  assert.match(extensionSource, /operationsRequiringAlTool\.has\(operation\.id\)[\s\S]*?-ValidatedAlToolPath/);
  assert.match(operationBridge, /\[string\] \$ValidatedAlToolPath = ''/);
  assert.match(operationBridge, /\$env:BCDEVTOOLSET_ALTOOL_PATH = \[System\.IO\.Path\]::GetFullPath\(\$ValidatedAlToolPath\)/);
  assert.match(buildOperation, /\$env:BCDEVTOOLSET_ALTOOL_PATH/);
  assert.doesNotMatch(buildOperation, /Get-Command|['"]al\.exe['"]|['"]al['"]/);
});

test('AL test runs discover tests by workspace extension id without suite registration', () => {
  const testManagement = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'common', 'TestMgt.ps1'), 'utf8');
  const invokeTestsOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'Invoke-Tests.ps1'), 'utf8');
  const invokeTests = testManagement.match(/function Invoke-Tests[\s\S]*?\n}/)?.[0] ?? '';

  assert.match(invokeTestsOperation, /Invoke-Tests[\s\S]*?-scriptPath \$scriptRoot[\s\S]*?-workspaceJSON \$workspaceJSON/);
  assert.match(invokeTests, /Get-SortedApps -workspaceJSON \$workspaceJSON/);
  assert.match(invokeTests, /Get-BcContainerAppInfo[\s\S]*?-containerName \$configuration\.container[\s\S]*?-installedOnly/);
  assert.match(invokeTests, /extensionId = \[string\]\$workspaceApp\.AppId/);
  assert.match(invokeTests, /Run-TestsInBcContainer[\s\S]*?@params/);
  assert.match(invokeTests, /JUnitResultFileName = \$resultPath/);
  assert.match(invokeTests, /returnTrueIfAllPassed = \$true/);
  assert.match(invokeTests, /detailed = \$true/);
  assert.doesNotMatch(invokeTests, /\.testSuite|params\.testSuite/);
});

test('test operations target the selected environment without a targetType group filter', () => {
  const testManagement = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'common', 'TestMgt.ps1'), 'utf8');
  const invokeTestsOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'Invoke-Tests.ps1'), 'utf8');
  const pageScriptOperation = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'Invoke-PageScriptTests.ps1'), 'utf8');
  const initializeContainer = testManagement.match(/function Initialize-TestExecutionContainer[\s\S]*?\n}/)?.[0] ?? '';

  assert.doesNotMatch(initializeContainer, /-targetType\s+"Dev"/);
  assert.doesNotMatch(invokeTestsOperation, /-targetType\s+"Dev"/);
  assert.doesNotMatch(pageScriptOperation, /-targetType\s+"Dev"/);
});

test('new local configurations omit optional Docker networking and memory settings', () => {
  const source = fs.readFileSync(workspaceMgtPath, 'utf8');
  const settingsBuilder = source.match(/function Build-Settings[\s\S]*?\n}/)?.[0] ?? '';
  assert.doesNotMatch(settingsBuilder, /-Name (?:network|hostIP|updateHosts|memoryLimit|sqlMemoryLimit)\b/);

  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'vscode-extension', 'schemas', 'bcdevtoolset-settings.schema.json'), 'utf8'));
  const defaultConfiguration = schema.properties.configurations.default[0];
  assert.equal(Object.hasOwn(defaultConfiguration, 'network'), false);
  assert.equal(Object.hasOwn(defaultConfiguration, 'hostIP'), false);
  assert.equal(Object.hasOwn(defaultConfiguration, 'updateHosts'), false);
  assert.equal(Object.hasOwn(defaultConfiguration, 'memoryLimit'), false);
  assert.equal(Object.hasOwn(defaultConfiguration, 'sqlMemoryLimit'), false);

  const containerRule = schema.definitions.configuration.allOf.find((rule) =>
    rule.if?.properties?.serverType?.const === 'Container');
  assert.ok(containerRule);
  for (const propertyName of ['network', 'hostIP', 'updateHosts']) {
    assert.ok(containerRule.then.properties[propertyName]);
    assert.equal(JSON.stringify(schema).split(`"${propertyName}"`).length - 1, 1);
  }
  for (const propertyName of ['memoryLimit', 'sqlMemoryLimit']) {
    assert.ok(containerRule.then.properties[propertyName]);
    assert.equal(JSON.stringify(schema).split(`"${propertyName}"`).length - 1, 2);
  }
});

test('custom settings completion augments macAddress values without duplicating schema properties', () => {
  const extensionSource = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8');
  const completionProvider = extensionSource.match(/function provideSettingsCompletionItems[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(completionProvider, /CompletionItemKind\.Value/);
  assert.doesNotMatch(completionProvider, /CompletionItemKind\.Property|configurationFields/);
});

test('extension development mode uses repository source before a configured installed toolset', () => {
  const extensionSource = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8');
  const getToolsetPath = extensionSource.match(/function getToolsetPath\(\)[\s\S]*?\n}/)?.[0] ?? '';

  assert.match(getToolsetPath, /const developmentToolsetPath = getDevelopmentToolsetPath\(\)/);
  assert.ok(getToolsetPath.indexOf('if (developmentToolsetPath)') < getToolsetPath.indexOf("getConfiguration().get('toolsetPath')"));
  assert.match(getToolsetPath, /return authorizeRoot\(developmentToolsetPath, 'BC Dev Toolset development path'\)/);
});

test('runtime synchronization state includes an explicit content revision', () => {
  const extensionSource = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8');

  const revision = Number(extensionSource.match(/const runtimeToolsetRevision = (\d+);/)?.[1]);
  assert.equal(revision, 79, 'Bundled runtime changes must increment the synchronization revision');
  assert.match(extensionSource, /`\$\{extensionVersion\}\.\$\{runtimeToolsetRevision\}\|\$\{getToolsetPath\(\)\}`/);
});

test('the runtime revision resynchronizes an already installed extension version once', async () => {
  const extensionSource = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'vscode-extension', 'extension.js'), 'utf8');
  const revisionDeclaration = extensionSource.match(/^const runtimeToolsetRevision = \d+;/m)?.[0];
  const syncKeyFunction = extensionSource.match(/^function getRuntimeSyncStateKey\([^]*?\n}/m)?.[0];
  const synchronizeFunction = extensionSource.match(/^async function syncRuntimeToolsetAfterExtensionUpdate\([^]*?\n}/m)?.[0];
  assert.ok(revisionDeclaration && syncKeyFunction && synchronizeFunction);
  const previousKey = '1.11.18.78|fixture-runtime';
  let storedKey = previousKey;
  let syncCount = 0;
  const updates = [];
  const context = vm.createContext({
    getToolsetPath: () => 'fixture-runtime',
    isExtensionDevelopmentMode: () => false,
    getMissingRuntimeFiles: () => [],
    syncRuntimeToolsetQuietly: async () => { syncCount++; },
    extensionContext: {
      extension: { packageJSON: { version: '1.11.18' } },
      globalState: {
        get: (key) => { assert.equal(key, 'runtimeToolsetSyncedForExtension'); return storedKey; },
        update: async (key, value) => {
          assert.equal(key, 'runtimeToolsetSyncedForExtension');
          updates.push(value);
          storedKey = value;
        }
      }
    }
  });
  vm.runInContext(`${revisionDeclaration}\n${syncKeyFunction}\n${synchronizeFunction}`, context);
  await vm.runInContext('syncRuntimeToolsetAfterExtensionUpdate(extensionContext)', context);
  assert.equal(syncCount, 1, 'Old revision must refresh complete runtime files even when the extension version is unchanged');
  assert.deepEqual(updates, ['1.11.18.79|fixture-runtime']);
  assert.notEqual(storedKey, previousKey);
  await vm.runInContext('syncRuntimeToolsetAfterExtensionUpdate(extensionContext)', context);
  assert.equal(syncCount, 1, 'An already refreshed runtime must not be synchronized again');
  assert.equal(updates.length, 1);
});

test('prerequisites distinguish Windows Server roles from client optional features', () => {
  const prerequisitesSource = fs.readFileSync( // nosemgrep -- fixed segments resolve beneath the authorized repository root
    path.join(repositoryRoot, 'operations', 'initPrerequisites.ps1'), 'utf8');

  assert.match(prerequisitesSource, /ProductType -in @\(2, 3\)/);
  assert.match(prerequisitesSource, /Enable-ServerFeatureNonInteractive -FeatureName \$feature/);
  assert.match(prerequisitesSource, /foreach \(\$feature in @\("Containers", "Hyper-V"\)\)/);
  assert.match(prerequisitesSource, /foreach \(\$feature in @\("Containers", "Microsoft-Hyper-V-All"\)\)/);
});
