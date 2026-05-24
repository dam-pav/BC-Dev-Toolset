const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

let extensionContext;
const repositoryUrl = 'https://github.com/dam-pav/BC-Dev-Toolset.git';

const directOperationIds = [
  'invokeTests',
  'invokePageScriptTests',
  'showBcContainerHelperVersions',
  'initPrerequisites',
  'updatePowerShell',
  'updateBcContainerHelper',
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

function activate(context) {
  extensionContext = context;

  context.subscriptions.push(
    vscode.commands.registerCommand('bcDevToolset.installOrUpdateToolset', installOrUpdateToolset),
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
}

function deactivate() {}

function getConfiguration() {
  return vscode.workspace.getConfiguration('bcDevToolset');
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
  if (!extensionContext || extensionContext.extensionMode !== vscode.ExtensionMode.Development) {
    return '';
  }

  const candidatePath = path.resolve(extensionContext.extensionPath, '..');
  return isDevelopmentToolsetPath(candidatePath) ? candidatePath : '';
}

function isDevelopmentToolsetPath(candidatePath) {
  return fs.existsSync(getOperationMetadataPath(candidatePath)) &&
    fs.existsSync(getOperationBridgePath(candidatePath)) &&
    fs.existsSync(path.join(candidatePath, 'vscode-extension', 'package.json'));
}

function getRepositoryBranch() {
  return getConfiguration().get('repositoryRef') === 'latest' ? 'main' : 'stable';
}

function getOperationMetadataPath(toolsetPath) {
  return path.join(toolsetPath, 'operations', 'operations.json');
}

function getOperationBridgePath(toolsetPath) {
  return path.join(toolsetPath, 'Invoke-BcDevToolsetOperation.ps1');
}

function getMissingRuntimeFiles(toolsetPath) {
  const missingFiles = [];
  if (!fs.existsSync(getOperationMetadataPath(toolsetPath))) {
    missingFiles.push('operations/operations.json');
  }
  if (!fs.existsSync(getOperationBridgePath(toolsetPath))) {
    missingFiles.push('Invoke-BcDevToolsetOperation.ps1');
  }

  return missingFiles;
}

async function resolveToolsetRuntimePath() {
  const configuredToolsetPath = getToolsetPath();
  const missingFiles = getMissingRuntimeFiles(configuredToolsetPath);
  if (missingFiles.length === 0) {
    return configuredToolsetPath;
  }

  const selection = await vscode.window.showErrorMessage(
    fs.existsSync(configuredToolsetPath)
      ? `BC Dev Toolset at ${configuredToolsetPath} is missing required VS Code runtime files: ${missingFiles.join(', ')}.`
      : `BC Dev Toolset is not installed at ${configuredToolsetPath}.`,
    'Install/Update Toolset'
  );
  if (selection === 'Install/Update Toolset') {
    await installOrUpdateToolset();
  }

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
    shortcuts: 'None',
    hostHelperFolder: 'C:\\ProgramData\\BcContainerHelper',
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
    password: 'P@ssw0rd'
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

function createTerminal() {
  const terminal = vscode.window.createTerminal('BC Dev Toolset');
  terminal.show();
  return terminal;
}

function getRuntimeSparseCheckoutPatterns() {
  return [
    '/Invoke-BcDevToolsetOperation.ps1',
    '/common/',
    '/operations/',
    '/visualization/'
  ];
}

async function installOrUpdateToolset() {
  const toolsetPath = getToolsetPath();
  const repositoryBranch = getRepositoryBranch();
  const parentPath = path.dirname(toolsetPath);
  const sparseCheckoutPatterns = getRuntimeSparseCheckoutPatterns()
    .map(quotePowerShellArgument)
    .join(' ');

  if (isDevelopmentToolsetPath(toolsetPath)) {
    await vscode.window.showInformationMessage(`BC Dev Toolset is using the local development clone at ${toolsetPath}. Install/update is managed through that clone.`);
    return;
  }

  const terminal = createTerminal();

  if (fs.existsSync(path.join(toolsetPath, '.git'))) {
    terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} fetch origin ${quotePowerShellArgument(repositoryBranch)}`);
    terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} checkout ${quotePowerShellArgument(repositoryBranch)}`);
    terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} sparse-checkout init --no-cone`);
    terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} sparse-checkout set ${sparseCheckoutPatterns}`);
    terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} pull --ff-only origin ${quotePowerShellArgument(repositoryBranch)}`);
    return;
  }

  terminal.sendText(`New-Item -ItemType Directory -Force -Path ${quotePowerShellArgument(parentPath)} | Out-Null`);
  terminal.sendText(`git clone --filter=blob:none --no-checkout --branch ${quotePowerShellArgument(repositoryBranch)} ${quotePowerShellArgument(repositoryUrl)} ${quotePowerShellArgument(toolsetPath)}`);
  terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} sparse-checkout init --no-cone`);
  terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} sparse-checkout set ${sparseCheckoutPatterns}`);
  terminal.sendText(`git -C ${quotePowerShellArgument(toolsetPath)} checkout ${quotePowerShellArgument(repositoryBranch)}`);
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
  const picked = await vscode.window.showQuickPick(
    operations.map((operation) => ({
      label: operation.title,
      description: operation.category,
      detail: operation.id,
      operation
    })),
    { placeHolder: 'Select a BC Dev Toolset operation' }
  );

  if (!picked) {
    return;
  }

  await executeOperation(picked.operation, toolsetPath);
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
    `${powershellExecutable} -NoLogo -ExecutionPolicy Bypass -File ${quotePowerShellArgument(bridgePath)}` +
    ` -Operation ${quotePowerShellArgument(operation.id)}` +
    ` -WorkspacePath ${quotePowerShellArgument(workspacePath)}` +
    workspaceFileArguments +
    localSettingsArguments;

  const terminal = createTerminal();
  terminal.sendText(command);
}

module.exports = {
  activate,
  deactivate
};
