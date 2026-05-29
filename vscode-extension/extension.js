const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');

let extensionContext;
let runtimeSyncPromise;
let outputChannel;
let operationTerminal;
let operationTerminalName;

const directOperationIds = [
  'invokeTests',
  'invokePageScriptTests',
  'showBcContainerHelperVersions',
  'initPrerequisites',
  'updatePowerShell',
  'clearAppArtifacts',
  'newDockerContainer',
  'updateLaunchJson',
  'updateBcLicenseContainer',
  'updateBcContainerServerConfiguration',
  'backupBcContainerDatabases',
  'backupBcServiceDatabases',
  'restoreBcContainerDatabases',
  'publishDependencies2Docker',
  'publishDependencies2Test',
  'publishApps2Docker',
  'publishApps2Production',
  'publishApps2Test',
  'createRuntimePackage',
  'publishRuntimeApps2Docker',
  'publishRuntimeApps2Production',
  'publishRuntimeApps2Test',
  'unpublishDockerApps',
  'unpublishTestApps',
  'prepareObjectIdRangeVisualizationData',
  'showObjectIdRangeVisualizationData'
];

const requiredRuntimeFiles = [
  'Invoke-BcDevToolsetOperation.ps1',
  'operations/operations.json'
];

const runtimeDirectories = [
  'common',
  'operations',
  'visualization'
];

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('BC Dev Toolset');

  context.subscriptions.push(
    outputChannel,
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === operationTerminal) {
        operationTerminal = undefined;
        operationTerminalName = undefined;
      }
    }),
    vscode.commands.registerCommand('bcDevToolset.configureWorkspace', configureWorkspace),
    vscode.commands.registerCommand('bcDevToolset.openLocalSettingsJson', openLocalSettingsJson),
    vscode.commands.registerCommand('bcDevToolset.showObjectIdRangeVisualizationData', showObjectIdRangeVisualizationData),
    vscode.commands.registerCommand('bcDevToolset.runOperation', runOperation)
  );

  for (const operationId of directOperationIds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`bcDevToolset.operation.${operationId}`, () => runOperationById(operationId))
    );
  }

  runtimeSyncPromise = syncRuntimeToolsetAfterExtensionUpdate(context);
}

function deactivate() {}

function getConfiguration() {
  return vscode.workspace.getConfiguration('bcDevToolset');
}

function getShortcutMode() {
  return getConfiguration().get('shortcuts') || 'None';
}

function getHostHelperFolder() {
  return getConfiguration().get('hostHelperFolder') || 'C:\\ProgramData\\BcContainerHelper';
}

function getDefaultToolsetPath() {
  const localAppData = process.env.LOCALAPPDATA || process.env.HOME || process.env.USERPROFILE;
  return path.join(localAppData, 'BC-Dev-Toolset', 'toolset');
}

function getToolsetPath() {
  const configuredPath = getConfiguration().get('toolsetPath');
  if (configuredPath && configuredPath.trim()) {
    return configuredPath;
  }

  return getDevelopmentToolsetPath() || getDefaultToolsetPath();
}

function getDevelopmentToolsetPath() {
  if (!isExtensionDevelopmentMode()) {
    return '';
  }

  const candidatePath = path.resolve(extensionContext.extensionPath, '..');
  return isDevelopmentToolsetPath(candidatePath) ? candidatePath : '';
}

function isExtensionDevelopmentMode() {
  return extensionContext && extensionContext.extensionMode === vscode.ExtensionMode.Development;
}

function isDevelopmentToolsetPath(candidatePath) {
  return fs.existsSync(getOperationMetadataPath(candidatePath)) &&
    fs.existsSync(getOperationBridgePath(candidatePath)) &&
    fs.existsSync(path.join(candidatePath, 'vscode-extension', 'package.json'));
}

function getOperationMetadataPath(toolsetPath) {
  return path.join(toolsetPath, 'operations', 'operations.json');
}

function getOperationBridgePath(toolsetPath) {
  return path.join(toolsetPath, 'Invoke-BcDevToolsetOperation.ps1');
}

function getMissingRuntimeFiles(toolsetPath) {
  return requiredRuntimeFiles.filter((relativePath) => !fs.existsSync(path.join(toolsetPath, relativePath)));
}

function getMissingBundledRuntimeItems(runtimePath) {
  return [
    ...getMissingRuntimeFiles(runtimePath),
    ...runtimeDirectories.filter((relativePath) => !fs.existsSync(path.join(runtimePath, relativePath)))
  ];
}

async function resolveToolsetRuntimePath() {
  await waitForRuntimeSync();

  const configuredToolsetPath = getToolsetPath();
  const missingFiles = getMissingRuntimeFiles(configuredToolsetPath);
  if (missingFiles.length === 0) {
    return configuredToolsetPath;
  }

  await vscode.window.showErrorMessage(
    fs.existsSync(configuredToolsetPath)
      ? `BC Dev Toolset at ${configuredToolsetPath} is missing required runtime files after automatic sync: ${missingFiles.join(', ')}.`
      : `BC Dev Toolset runtime was not installed at ${configuredToolsetPath} by automatic sync.`
  );

  return '';
}

function getWorkspacePath() {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    throw new Error('Open a workspace or folder before running BC Dev Toolset commands.');
  }

  const workspaceFolder = vscode.workspace.workspaceFolders.find((folder) => path.basename(folder.uri.fsPath) !== '.bcdevtoolset');
  return (workspaceFolder || vscode.workspace.workspaceFolders[0]).uri.fsPath;
}

function getWorkspaceBasePath() {
  if (vscode.workspace.workspaceFile) {
    return path.dirname(vscode.workspace.workspaceFile.fsPath);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length > 1) {
    return getCommonParentPath(workspaceFolders.map((folder) => folder.uri.fsPath));
  }

  const workspacePath = getWorkspacePath();
  if (fs.existsSync(path.join(workspacePath, 'app.json'))) {
    return path.dirname(workspacePath);
  }

  return workspacePath;
}

function getCommonParentPath(paths) {
  if (paths.length === 0) {
    return '';
  }

  let commonPath = path.resolve(paths[0]);
  for (const candidate of paths.slice(1)) {
    const resolvedCandidate = path.resolve(candidate);
    while (!isSameOrParentPath(commonPath, resolvedCandidate)) {
      const parentPath = path.dirname(commonPath);
      if (parentPath === commonPath) {
        return commonPath;
      }
      commonPath = parentPath;
    }
  }

  return commonPath;
}

function isSameOrParentPath(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getConfigPath() {
  return path.join(getWorkspaceBasePath(), '.bcdevtoolset');
}

function getVisualizationDataPath() {
  return path.join(getConfigPath(), `${getWorkspaceName()}.visualization.json`);
}

function getWorkspaceName() {
  const workspaceFile = getWorkspaceFileName();
  if (workspaceFile) {
    return path.basename(workspaceFile, '.code-workspace');
  }

  return path.basename(getWorkspacePath());
}

function resolveWorkspaceBasePath(value) {
  if (!value || !value.trim()) {
    return '';
  }

  return path.isAbsolute(value) ? value : path.join(getWorkspaceBasePath(), value);
}

function getWorkspaceFileName() {
  if (vscode.workspace.workspaceFile) {
    return vscode.workspace.workspaceFile.fsPath;
  }

  const workspaceBasePath = getWorkspaceBasePath();
  const workspaceFiles = fs.readdirSync(workspaceBasePath).filter((fileName) => fileName.endsWith('.code-workspace'));
  return workspaceFiles.length === 1 ? path.join(workspaceBasePath, workspaceFiles[0]) : '';
}

function getDefaultWorkspaceSettings() {
  return {
    country: 'w1',
    selectArtifact: 'Closest',
    configurations: [
      {
        name: 'sample',
        serverType: '',
        targetType: '',
        server: '',
        serverInstance: '',
        container: '',
        port: '',
        environmentType: '',
        environmentName: '',
        includeTestToolkit: '',
        tenant: '',
        authentication: '',
        admin: '',
        password: '',
        databaseUser: '',
        databasePassword: '',
        remoteUser: '',
        remotePassword: ''
      }
    ]
  };
}

function getDefaultLocalSettings() {
  return {
    licenseFile: '',
    certificateFile: '',
    packageOutputPath: '',
    dependenciesPath: '',
    recordingsPath: '',
    pageScriptTestResultsPath: '',
    pageScriptTestHeaded: 'false',
    sqlBackupPath: '',
    configurations: [
      getDefaultLocalConfiguration()
    ]
  };
}

function getDefaultLocalConfiguration() {
  const workspaceName = getWorkspaceName();
  return {
    name: 'Local',
    serverType: 'Container',
    targetType: 'Dev',
    container: workspaceName.replace(/ /g, '-'),
    environmentType: 'Sandbox',
    includeTestToolkit: 'false',
    authentication: 'UserPassword',
    admin: 'admin',
    password: 'P@ssw0rd',
    network: '',
    hostIP: '',
    macAddress: '',
    IP: '',
    dns: ''
  };
}

function ensureBcDevToolsetWorkspaceSettings(workspaceFile) {
  if (!workspaceFile || !fs.existsSync(workspaceFile)) {
    return false;
  }

  const workspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  if (!workspace.settings) {
    workspace.settings = {};
  }

  if (workspace.settings['dam-pav.bcdevtoolset']) {
    return false;
  }

  workspace.settings['dam-pav.bcdevtoolset'] = getDefaultWorkspaceSettings();
  fs.writeFileSync(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  return true;
}

function ensureDefaultLocalConfiguration(localPath) {
  if (!fs.existsSync(localPath)) {
    return;
  }

  const localSettings = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const configurations = Array.isArray(localSettings.configurations) ? localSettings.configurations : [];
  const hasUsableConfiguration = configurations.some((configuration) => configuration.name && configuration.name !== 'sample');
  if (hasUsableConfiguration) {
    return;
  }

  localSettings.configurations = [
    getDefaultLocalConfiguration(),
    ...configurations.filter((configuration) => configuration.name === 'sample')
  ];
  fs.writeFileSync(localPath, `${JSON.stringify(localSettings, null, 2)}\n`, 'utf8');
}

function quotePowerShellArgument(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getPowerShellTerminalName(powershellExecutable) {
  return `BC Dev Toolset: ${path.basename(powershellExecutable)}`;
}

function isPathLike(value) {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function resolveExecutablePath(executable) {
  if (!executable || !executable.trim()) {
    return executable;
  }

  if (isPathLike(executable)) {
    return executable;
  }

  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const args = [executable];
    const result = childProcess.execFileSync(command, args, { encoding: 'utf8' });
    return result.split(/\r?\n/).find((line) => line.trim()) || executable;
  } catch (error) {
    return executable;
  }
}

function getOperationTerminal(powershellExecutable) {
  const terminalName = getPowerShellTerminalName(powershellExecutable);
  if (!operationTerminal || operationTerminalName !== terminalName) {
    operationTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
    operationTerminalName = operationTerminal ? terminalName : undefined;
  }

  if (!operationTerminal) {
    const shellPath = resolveExecutablePath(powershellExecutable);
    operationTerminal = vscode.window.createTerminal({
      name: terminalName,
      shellPath,
      shellArgs: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass']
    });
    operationTerminalName = terminalName;
  }

  operationTerminal.show();
  return operationTerminal;
}

function getRuntimeSyncStateKey(context) {
  const extensionVersion = context.extension.packageJSON.version || 'unknown';
  return `${extensionVersion}|${getToolsetPath()}`;
}

async function syncRuntimeToolsetAfterExtensionUpdate(context) {
  if (isExtensionDevelopmentMode()) {
    return;
  }

  const syncStateKey = getRuntimeSyncStateKey(context);
  if (context.globalState.get('runtimeToolsetSyncedForExtension') === syncStateKey && getMissingRuntimeFiles(getToolsetPath()).length === 0) {
    return;
  }

  try {
    await syncRuntimeToolsetQuietly();
    await context.globalState.update('runtimeToolsetSyncedForExtension', syncStateKey);
  } catch (error) {
    writeOutput(`Automatic runtime toolset update failed: ${error.message}`);
    vscode.window.showWarningMessage('BC Dev Toolset runtime update failed. Operations may be unavailable until automatic sync succeeds.');
  }
}

async function waitForRuntimeSync() {
  if (!runtimeSyncPromise) {
    return;
  }

  await runtimeSyncPromise;
}

async function syncRuntimeToolsetQuietly() {
  const toolsetPath = getToolsetPath();
  const bundledRuntimePath = getBundledRuntimePath();

  const missingBundledRuntimeItems = getMissingBundledRuntimeItems(bundledRuntimePath);
  if (missingBundledRuntimeItems.length > 0) {
    throw new Error(`Bundled runtime folder is incomplete: ${missingBundledRuntimeItems.join(', ')}.`);
  }

  writeOutput(`Synchronizing BC Dev Toolset runtime at ${toolsetPath} from bundled extension assets.`);

  fs.mkdirSync(toolsetPath, { recursive: true });
  copyRuntimeFile(bundledRuntimePath, toolsetPath, 'Invoke-BcDevToolsetOperation.ps1');
  for (const runtimeDirectory of runtimeDirectories) {
    copyRuntimeDirectory(bundledRuntimePath, toolsetPath, runtimeDirectory);
  }

  const missingRuntimeFiles = getMissingRuntimeFiles(toolsetPath);
  if (missingRuntimeFiles.length > 0) {
    throw new Error(`Runtime sync did not install required files: ${missingRuntimeFiles.join(', ')}.`);
  }
}

function getBundledRuntimePath() {
  return path.join(extensionContext.extensionPath, 'runtime');
}

function copyRuntimeFile(sourceRoot, targetRoot, relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function copyRuntimeDirectory(sourceRoot, targetRoot, relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  const temporaryTargetPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

  fs.rmSync(temporaryTargetPath, { recursive: true, force: true });
  copyDirectoryRecursive(sourcePath, temporaryTargetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.renameSync(temporaryTargetPath, targetPath);
}

function copyDirectoryRecursive(sourcePath, targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });

  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourceEntryPath, targetEntryPath);
      continue;
    }

    fs.copyFileSync(sourceEntryPath, targetEntryPath);
  }
}

function writeOutput(message) {
  if (!outputChannel) {
    return;
  }

  outputChannel.appendLine(message);
}

async function configureWorkspace() {
  const configPath = getConfigPath();
  const localPath = path.join(configPath, 'settings.json');
  const workspaceFile = getWorkspaceFileName();

  fs.mkdirSync(configPath, { recursive: true });

  writeJsonIfMissing(localPath, getDefaultLocalSettings());
  ensureDefaultLocalConfiguration(localPath);

  ensureBcDevToolsetWorkspaceSettings(workspaceFile);
  await vscode.window.showInformationMessage('BC Dev Toolset workspace configuration is ready.');
  await vscode.window.showTextDocument(vscode.Uri.file(localPath));
}

async function openLocalSettingsJson() {
  const configPath = getConfigPath();
  const localPath = path.join(configPath, 'settings.json');

  fs.mkdirSync(configPath, { recursive: true });
  writeJsonIfMissing(localPath, getDefaultLocalSettings());
  ensureDefaultLocalConfiguration(localPath);

  await vscode.window.showTextDocument(vscode.Uri.file(localPath));
}

async function showObjectIdRangeVisualizationData() {
  const toolsetPath = await resolveToolsetRuntimePath();
  if (!toolsetPath) {
    return;
  }

  const htmlPath = path.join(toolsetPath, 'visualization', 'WorkspaceAnalysis.html');
  const dataPath = getVisualizationDataPath();

  if (!fs.existsSync(htmlPath)) {
    await vscode.window.showErrorMessage(`WorkspaceAnalysis.html was not found at ${htmlPath}.`);
    return;
  }

  if (!fs.existsSync(dataPath)) {
    const selection = await vscode.window.showWarningMessage(
      `Visualization data was not found at ${dataPath}.`,
      'Prepare Data'
    );
    if (selection === 'Prepare Data') {
      await runOperationById('prepareObjectIdRangeVisualizationData');
    }
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'bcDevToolsetWorkspaceAnalysis',
    'BC Dev Toolset Workspace Analysis',
    vscode.ViewColumn.One,
    {
      enableScripts: true
    }
  );

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const injectedDataScript = `<script>window.bcDevToolsetData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
  const html = fs.readFileSync(htmlPath, 'utf8').replace('</head>', `${injectedDataScript}\n</head>`);
  panel.webview.html = html;
}

function writeJsonIfMissing(filePath, value) {
  if (fs.existsSync(filePath)) {
    return;
  }

  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runOperation() {
  const toolsetPath = await resolveToolsetRuntimePath();
  if (!toolsetPath) {
    return;
  }

  const operations = getOperations(toolsetPath);
  const categories = Array.from(new Set(operations.map((operation) => operation.category)));
  const pickedCategory = await vscode.window.showQuickPick(
    categories.map((category) => ({
      label: category,
      description: `${operations.filter((operation) => operation.category === category).length} operations`
    })),
    { placeHolder: 'Select a BC Dev Toolset operation category' }
  );

  if (!pickedCategory) {
    return;
  }

  const filteredOperations = operations.filter((operation) => operation.category === pickedCategory.label);
  const pickedOperation = await vscode.window.showQuickPick(
    filteredOperations.map((operation) => ({
      label: operation.title,
      detail: operation.id,
      operation
    })),
    { placeHolder: `Select a ${pickedCategory.label} operation` }
  );

  if (!pickedOperation) {
    return;
  }

  await executeOperation(pickedOperation.operation, toolsetPath);
}

async function runOperationById(operationId) {
  const toolsetPath = await resolveToolsetRuntimePath();
  if (!toolsetPath) {
    return;
  }

  const operation = getOperations(toolsetPath).find((candidate) => candidate.id === operationId);
  if (!operation) {
    await vscode.window.showErrorMessage(`BC Dev Toolset operation '${operationId}' was not found.`);
    return;
  }

  await executeOperation(operation, toolsetPath);
}

function getOperations(toolsetPath) {
  return JSON.parse(fs.readFileSync(getOperationMetadataPath(toolsetPath), 'utf8'));
}

async function executeOperation(operation, toolsetPath) {
  if (operation.command === 'openLocalSettingsJson') {
    await openLocalSettingsJson();
    return;
  }

  if (operation.command === 'showObjectIdRangeVisualizationData') {
    await showObjectIdRangeVisualizationData();
    return;
  }

  if (!operation.script) {
    await vscode.window.showErrorMessage(`BC Dev Toolset operation '${operation.id}' cannot be run by this extension.`);
    return;
  }

  const workspacePath = getWorkspacePath();
  const bridgePath = getOperationBridgePath(toolsetPath);
  const powershellExecutable = operation.powerShellExecutable || getConfiguration().get('powershellExecutable') || 'pwsh';
  const workspaceFile = getWorkspaceFileName();
  const configPath = getConfigPath();
  const localSettingsPath = resolveWorkspaceBasePath(getConfiguration().get('localSettingsPath')) || path.join(configPath, 'settings.json');
  const localSettingsArguments = ` -LocalSettingsPath ${quotePowerShellArgument(localSettingsPath)}`;
  const workspaceFileArguments = workspaceFile
    ? ` -WorkspaceFile ${quotePowerShellArgument(workspaceFile)}`
    : '';

  const command =
    `$env:BCDEVTOOLSET_SHORTCUTS = ${quotePowerShellArgument(getShortcutMode())}; ` +
    `$env:BCDEVTOOLSET_HOST_HELPER_FOLDER = ${quotePowerShellArgument(getHostHelperFolder())}; ` +
    `& ${quotePowerShellArgument(bridgePath)}` +
    ` -Operation ${quotePowerShellArgument(operation.id)}` +
    ` -WorkspacePath ${quotePowerShellArgument(workspacePath)}` +
    workspaceFileArguments +
    localSettingsArguments;

  const terminal = getOperationTerminal(powershellExecutable);
  terminal.sendText(command);
}

module.exports = {
  activate,
  deactivate
};
