/* eslint-env node */
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const http = require('http');
const os = require('os');
const vscode = require('vscode');
const {
  classifyCodexMcpConfiguration,
  removeCodexMcpConfigContent,
  resolveCodexMcpIntegrationState,
  runCodexMcpIntegrationTransition,
  updateCodexMcpConfigContent
} = require('./codex-mcp-config');

let extensionContext;
let runtimeSyncPromise;
let codexMcpSyncPromise = Promise.resolve();
let codexMcpSettingUpdateInProgress = false;
let outputChannel;
let operationTerminal;
let operationTerminalName;
let mcpBridgeServer;
let mcpBridgeUrl;
let mcpBridgeToken;
let mcpBridgeStatePath;
const mcpPromptSessions = new Map();
const mcpPromptSessionMaxAgeMs = 60 * 60 * 1000;
const mcpPromptSessionMaxCount = 50;
const mcpPromptSessionCleanupIntervalMs = 5 * 60 * 1000;

const directOperationIds = [
  'invokeTests',
  'invokePageScriptTests',
  'showBcContainerHelperVersions',
  'initPrerequisites',
  'updatePowerShell',
  'configureCodexMcp',
  'disableCodexMcp',
  'clearAppArtifacts',
  'newDockerContainer',
  'updateLaunchJson',
  'updateBcLicenseContainer',
  'showActiveLicenses',
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

function joinTrustedPath(basePath, ...segments) {
  if (!basePath || segments.some((segment) => !segment || path.isAbsolute(segment) || segment.split(/[\\/]+/).includes('..'))) {
    throw new Error(`Invalid path segment for base path '${basePath}'.`);
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  // eslint-disable-next-line -- base paths come from VS Code APIs or validated extension settings.
  return path.join(basePath, ...segments);
}

function fileExists(filePath) {
  if (!filePath) {
    return false;
  }

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration files.
  return fs.existsSync(filePath);
}

function readTextFile(filePath) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration files.
  return fs.readFileSync(filePath, 'utf8');
}

function writeTextFile(filePath, content) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration files.
  fs.writeFileSync(filePath, content, 'utf8');
}

function removeFile(filePath) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration files.
  fs.rmSync(filePath, { force: true });
}

function removePath(filePath, options) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration folders.
  fs.rmSync(filePath, options);
}

function unlinkFile(filePath) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration files.
  fs.unlinkSync(filePath);
}

function renameFile(sourcePath, targetPath) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration files.
  fs.renameSync(sourcePath, targetPath);
}

function readDirectory(directoryPath, options) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- extension features operate on selected workspace/configuration folders.
  return fs.readdirSync(directoryPath, options);
}

function copyFile(sourcePath, targetPath) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- runtime sync copies files from bundled extension assets.
  fs.copyFileSync(sourcePath, targetPath);
}

const configurationFields = [
  { name: 'name', validServerTypes: [] },
  { name: 'serverType', validServerTypes: [] },
  { name: 'targetType', validServerTypes: [] },
  { name: 'server', validServerTypes: ['OnPrem'] },
  { name: 'serverInstance', validServerTypes: ['OnPrem'] },
  { name: 'container', validServerTypes: ['Container'] },
  { name: 'port', validServerTypes: ['OnPrem'] },
  { name: 'environmentType', validServerTypes: ['Container', 'Cloud'] },
  { name: 'environmentName', validServerTypes: ['Cloud'] },
  { name: 'includeTestToolkit', validServerTypes: ['Container'] },
  { name: 'tenant', validServerTypes: ['Cloud', 'OnPrem'] },
  { name: 'authentication', validServerTypes: ['Container', 'OnPrem'] },
  { name: 'bcUser', validServerTypes: ['Container'] },
  { name: 'bcPassword', validServerTypes: ['Container'] },
  { name: 'admin', validServerTypes: ['Container'] },
  { name: 'password', validServerTypes: ['Container'] },
  { name: 'network', validServerTypes: ['Container'] },
  { name: 'hostIP', validServerTypes: ['Container'] },
  { name: 'updateHosts', validServerTypes: ['Container'] },
  { name: 'macAddress', validServerTypes: ['Container'], requiredNetwork: 'transparent' },
  { name: 'IP', validServerTypes: ['Container'], requiredNetwork: 'transparent' },
  { name: 'dns', validServerTypes: ['Container'], requiredNetwork: 'transparent' },
  { name: 'databaseUser', validServerTypes: [] },
  { name: 'databasePassword', validServerTypes: [] },
  { name: 'remoteUser', validServerTypes: [] },
  { name: 'remotePassword', validServerTypes: [] },
  { name: 'serverConfiguration', validServerTypes: [] }
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
    vscode.commands.registerCommand('bcDevToolset.initializeWorkspace', initializeWorkspace),
    vscode.commands.registerCommand('bcDevToolset.openLocalSettingsJson', openLocalSettingsJson),
    vscode.commands.registerCommand('bcDevToolset.showObjectIdRangeVisualizationData', showObjectIdRangeVisualizationData),
    vscode.commands.registerCommand('bcDevToolset.showMcpStatus', showMcpStatus),
    vscode.commands.registerCommand('bcDevToolset.configureCodexMcp', configureCodexMcp),
    vscode.commands.registerCommand('bcDevToolset.disableCodexMcp', disableCodexMcp),
    vscode.commands.registerCommand('bcDevToolset.runOperation', runOperation),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!codexMcpSettingUpdateInProgress && event.affectsConfiguration('bcDevToolset.codexMcpIntegration.enabled')) {
        queueCodexMcpReconciliation(context, { notifyWhenChanged: true });
      }
    }),
    startMcpBridgeServer(context),
    startMcpPromptSessionCleanup(),
    registerMcpServerDefinitionProvider(context),
    vscode.languages.registerCompletionItemProvider(
      [
        { language: 'json', scheme: 'file' },
        { language: 'jsonc', scheme: 'file' }
      ],
      {
        provideCompletionItems: provideSettingsCompletionItems
      },
      '"',
      ':',
      ' '
    )
  );

  for (const operationId of directOperationIds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`bcDevToolset.operation.${operationId}`, () => runOperationById(operationId))
    );
  }

  runtimeSyncPromise = syncRuntimeToolsetAfterExtensionUpdate(context);
  queueCodexMcpReconciliation(context, { migrateLegacySetting: true, notifyWhenChanged: true });
}

function deactivate() {}

function startMcpBridgeServer(context) {
  mcpBridgeToken = crypto.randomBytes(32).toString('hex');
  mcpBridgeServer = http.createServer((request, response) => {
    void handleMcpBridgeRequest(request, response);
  });

  mcpBridgeServer.listen(0, '127.0.0.1', () => {
    const address = mcpBridgeServer.address();
    if (address && typeof address === 'object') {
      mcpBridgeUrl = `http://127.0.0.1:${address.port}`;
      writeMcpBridgeState(context);
      writeOutput(`BC Dev Toolset MCP bridge listening at ${mcpBridgeUrl}.`);
    }
  });

  return {
    dispose: () => {
      if (mcpBridgeServer) {
        mcpBridgeServer.close();
        mcpBridgeServer = undefined;
        mcpBridgeUrl = undefined;
        removeMcpBridgeState();
      }
    }
  };
}

function startMcpPromptSessionCleanup() {
  const timer = setInterval(pruneMcpPromptSessions, mcpPromptSessionCleanupIntervalMs);
  return {
    dispose: () => clearInterval(timer)
  };
}

function getMcpBridgeStatePath() {
  return joinTrustedPath(os.tmpdir(), 'bc-dev-toolset-mcp', 'vscode-bridge.json');
}

function writeMcpBridgeState(context) {
  if (!mcpBridgeUrl || !mcpBridgeToken) {
    return;
  }

  mcpBridgeStatePath = getMcpBridgeStatePath(context);
  fs.mkdirSync(path.dirname(mcpBridgeStatePath), { recursive: true });
  writeTextFile(mcpBridgeStatePath, `${JSON.stringify({
    url: mcpBridgeUrl,
    token: mcpBridgeToken,
    pid: process.pid,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
}

function removeMcpBridgeState() {
  if (fileExists(mcpBridgeStatePath)) {
    removeFile(mcpBridgeStatePath);
  }
}

async function handleMcpBridgeRequest(request, response) {
  try {
    if (request.method !== 'POST') {
      writeMcpBridgeResponse(response, 404, { error: 'Not found.' });
      return;
    }

    const authorization = request.headers.authorization || '';
    if (authorization !== `Bearer ${mcpBridgeToken}`) {
      writeMcpBridgeResponse(response, 401, { error: 'Unauthorized.' });
      return;
    }

    const body = await readRequestBody(request);
    if (request.url === '/prompt/request') {
      await handleMcpPromptRequest(body, response);
      return;
    }

    if (request.url === '/prompt/answer') {
      writeMcpBridgeResponse(response, 200, answerMcpPrompt(body));
      return;
    }

    if (request.url === '/operation-status') {
      writeMcpBridgeResponse(response, 200, getMcpOperationStatus(body));
      return;
    }

    if (request.url === '/workspace-context') {
      writeMcpBridgeResponse(response, 200, getMcpWorkspaceContext());
      return;
    }

    if (request.url !== '/run-operation') {
      writeMcpBridgeResponse(response, 404, { error: 'Not found.' });
      return;
    }

    const operationId = String((body && body.operationId) || '').trim();
    if (!operationId) {
      writeMcpBridgeResponse(response, 400, { error: 'operationId is required.' });
      return;
    }

    const timeoutSeconds = Number(body.timeoutSeconds);
    const result = await runOperationByIdForMcp(operationId, {
      workspacePath: body.workspacePath,
      workspaceFile: body.workspaceFile,
      localSettingsPath: body.localSettingsPath,
      timeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : undefined
    });
    writeMcpBridgeResponse(response, 200, result);
  } catch (error) {
    writeMcpBridgeResponse(response, 500, { error: error.message });
  }
}

async function handleMcpPromptRequest(body, response) {
  const sessionId = String((body && body.sessionId) || '').trim();
  const prompt = body && body.prompt;
  if (!sessionId || !prompt || typeof prompt !== 'object') {
    writeMcpBridgeResponse(response, 400, { error: 'sessionId and prompt are required.' });
    return;
  }

  const session = getOrCreateMcpPromptSession(sessionId);
  const promptRequest = {
    ...prompt,
    requestedAt: new Date().toISOString()
  };
  session.status = 'waiting_for_input';
  session.prompt = promptRequest;
  session.answer = undefined;
  session.respondedAt = undefined;
  touchMcpPromptSession(session);
  writeOutput(`BC Dev Toolset MCP operation is waiting for input: ${promptRequest.question || promptRequest.id || '(unknown prompt)'}`);

  await new Promise((resolve) => {
    response.setTimeout(0);
    session.resolvePrompt = (answer) => {
      session.status = 'running';
      session.answer = answer;
      session.respondedAt = new Date().toISOString();
      touchMcpPromptSession(session);
      writeMcpBridgeResponse(response, 200, answer);
      resolve();
    };
    requestCleanupOnResponseClose(response, session);
  });
}

function requestCleanupOnResponseClose(response, session) {
  response.on('close', () => {
    if (!response.writableEnded && session.resolvePrompt) {
      session.resolvePrompt = undefined;
      session.status = 'running';
      touchMcpPromptSession(session);
    }
  });
}

function answerMcpPrompt(body) {
  const sessionId = String((body && body.sessionId) || '').trim();
  const answer = body && body.answer;
  if (!sessionId) {
    return { status: 'failed', error: 'sessionId is required.' };
  }

  const session = mcpPromptSessions.get(sessionId);
  if (!session || session.status !== 'waiting_for_input' || !session.resolvePrompt) {
    return { status: 'failed', sessionId, error: 'No pending prompt was found for this session.' };
  }
  touchMcpPromptSession(session);

  const prompt = session.prompt || {};
  if (prompt.sensitive) {
    return { status: 'failed', sessionId, error: 'Sensitive prompts cannot be answered through MCP.' };
  }

  const normalizedAnswer = normalizeMcpPromptAnswer(answer, prompt);
  session.resolvePrompt({ answer: normalizedAnswer, answeredBy: 'mcp' });
  session.resolvePrompt = undefined;
  return { status: 'answered', sessionId, answer: normalizedAnswer };
}

function normalizeMcpPromptAnswer(answer, prompt = {}) {
  if (typeof answer === 'boolean') {
    return answer ? 'yes' : 'no';
  }

  const value = String(answer || '').trim().toLowerCase();
  if (prompt.type && prompt.type !== 'confirm') {
    if (!value && prompt.default) {
      return String(prompt.default);
    }
    if (!value) {
      throw new Error('answer is required.');
    }
    return String(answer).trim();
  }

  if (['yes', 'y', 'true', '1'].includes(value)) {
    return 'yes';
  }
  if (['no', 'n', 'false', '0'].includes(value)) {
    return 'no';
  }

  throw new Error('answer must be yes or no.');
}

function getMcpOperationStatus(body) {
  pruneMcpPromptSessions();
  const sessionId = String((body && body.sessionId) || '').trim();
  if (!sessionId) {
    return { status: 'failed', error: 'sessionId is required.' };
  }

  const session = mcpPromptSessions.get(sessionId);
  if (!session) {
    return { status: 'unknown', sessionId };
  }
  touchMcpPromptSession(session);

  if (session.capture && session.operationId && session.terminalName) {
    const result = readMcpCaptureResult(
      { id: session.operationId, title: session.operationTitle || session.operationId },
      session.terminalName,
      session.capture
    );
    if (result) {
      session.status = result.status;
      session.completedAt = session.completedAt || new Date().toISOString();
      session.result = result;
      touchMcpPromptSession(session);
    }
  }

  return getMcpPromptSessionSnapshot(session);
}

function getOrCreateMcpPromptSession(sessionId) {
  pruneMcpPromptSessions();
  const existing = mcpPromptSessions.get(sessionId);
  if (existing) {
    touchMcpPromptSession(existing);
    return existing;
  }

  const now = new Date().toISOString();
  const session = {
    sessionId,
    status: 'running',
    prompt: undefined,
    answer: undefined,
    startedAt: now,
    updatedAt: now,
    completedAt: undefined,
    result: undefined,
    resolvePrompt: undefined
  };
  mcpPromptSessions.set(sessionId, session);
  pruneMcpPromptSessions();
  return session;
}

function touchMcpPromptSession(session) {
  session.updatedAt = new Date().toISOString();
}

function pruneMcpPromptSessions() {
  const now = Date.now();
  for (const [sessionId, session] of mcpPromptSessions) {
    const sessionTime = Date.parse(session.updatedAt || session.completedAt || session.startedAt || '');
    if (Number.isFinite(sessionTime) && now - sessionTime > mcpPromptSessionMaxAgeMs) {
      deleteMcpPromptSession(sessionId, session);
    }
  }

  if (mcpPromptSessions.size <= mcpPromptSessionMaxCount) {
    return;
  }

  const removableSessions = [...mcpPromptSessions.entries()]
    .filter(([, session]) => !session.resolvePrompt)
    .sort((left, right) => getMcpPromptSessionSortTime(left[1]) - getMcpPromptSessionSortTime(right[1]));

  while (mcpPromptSessions.size > mcpPromptSessionMaxCount && removableSessions.length > 0) {
    const [sessionId, session] = removableSessions.shift();
    deleteMcpPromptSession(sessionId, session);
  }
}

function getMcpPromptSessionSortTime(session) {
  const value = Date.parse(session.updatedAt || session.completedAt || session.startedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function deleteMcpPromptSession(sessionId, session) {
  mcpPromptSessions.delete(sessionId);
  cleanupMcpCaptureFiles(session && session.capture);
}

function cleanupMcpCaptureFiles(capture) {
  if (!capture) {
    return;
  }

  for (const filePath of [capture.transcriptPath, capture.resultPath]) {
    if (fileExists(filePath)) {
      try {
        removeFile(filePath);
      } catch (error) {
        writeOutput(`Failed to remove MCP capture file ${filePath}: ${error.message}`);
      }
    }
  }
}

function getMcpPromptSessionSnapshot(session) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    operationId: session.operationId,
    operationTitle: session.operationTitle,
    terminalName: session.terminalName,
    prompt: session.prompt,
    answer: session.answer,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    result: session.result
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let content = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      content += chunk;
      if (content.length > 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(content ? JSON.parse(content) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON request body: ${error.message}`));
      }
    });
    request.on('error', reject);
  });
}

function writeMcpBridgeResponse(response, statusCode, body) {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content)
  });
  response.end(content);
}

function waitForMcpBridgeServer() {
  if (mcpBridgeUrl) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (mcpBridgeUrl || Date.now() - startedAt > 5000) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

function registerMcpServerDefinitionProvider(context) {
  if (!vscode.lm || !vscode.lm.registerMcpServerDefinitionProvider || !vscode.McpStdioServerDefinition) {
    writeOutput('VS Code MCP server definition provider API is not available in this VS Code version.');
    return { dispose: () => {} };
  }

  return vscode.lm.registerMcpServerDefinitionProvider('bcDevToolset.operations', {
    provideMcpServerDefinitions: async () => [
      createMcpServerDefinition(context)
    ],
    resolveMcpServerDefinition: async (server) => {
      await waitForRuntimeSync();
      await waitForMcpBridgeServer();
      server.env = {
        ...server.env,
      BCDEVTOOLSET_MCP_BRIDGE_URL: mcpBridgeUrl || '',
      BCDEVTOOLSET_MCP_BRIDGE_TOKEN: mcpBridgeToken || ''
      };
      return server;
    }
  });
}

function createMcpServerDefinition(context) {
  const serverPath = joinTrustedPath(context.extensionPath, 'mcp-server.js');
  const workspacePath = getOptionalWorkspacePath();
  const workspaceFile = getOptionalWorkspaceFileName();
  const localSettingsPath = getOptionalLocalSettingsPath();
  const nodeExecutable = getMcpNodeExecutable();
  const mcpServerVersion = getMcpServerVersion(context, serverPath);

  const serverDefinition = new vscode.McpStdioServerDefinition(
    'BC Dev Toolset Operations',
    nodeExecutable,
    [serverPath],
    {
      BCDEVTOOLSET_MCP_TOOLSET_PATH: getToolsetPath(),
      BCDEVTOOLSET_MCP_WORKSPACE_PATH: workspacePath,
      BCDEVTOOLSET_MCP_WORKSPACE_FILE: workspaceFile,
      BCDEVTOOLSET_MCP_WORKSPACE_CONTEXT: JSON.stringify(getMcpWorkspaceContext()),
      BCDEVTOOLSET_MCP_LOCAL_SETTINGS_PATH: localSettingsPath,
      BCDEVTOOLSET_MCP_POWERSHELL_EXECUTABLE: getConfiguration().get('powershellExecutable') || 'pwsh',
      BCDEVTOOLSET_MCP_EXTENSION_VERSION: mcpServerVersion,
      BCDEVTOOLSET_MCP_BRIDGE_URL: mcpBridgeUrl || '',
      BCDEVTOOLSET_MCP_BRIDGE_TOKEN: mcpBridgeToken || '',
      BCDEVTOOLSET_MCP_BRIDGE_STATE_PATH: mcpBridgeStatePath || getMcpBridgeStatePath(context),
      BCDEVTOOLSET_SHORTCUTS: getShortcutMode(),
      BCDEVTOOLSET_HOST_HELPER_FOLDER: getHostHelperFolder(),
      ELECTRON_RUN_AS_NODE: '1'
    },
    mcpServerVersion
  );
  serverDefinition.cwd = vscode.Uri.file(context.extensionPath);
  return serverDefinition;
}

async function showMcpStatus() {
  const hasMcpApi = Boolean(vscode.lm && vscode.lm.registerMcpServerDefinitionProvider && vscode.McpStdioServerDefinition);
  const serverPath = extensionContext ? joinTrustedPath(extensionContext.extensionPath, 'mcp-server.js') : '';
  const nodeExecutable = getMcpNodeExecutable();
  const integrationSetting = getCodexMcpIntegrationSetting();
  const configPath = getCodexConfigPath();
  const configContent = fileExists(configPath) ? readTextFile(configPath) : '';
  const codexConfiguration = classifyCodexMcpConfiguration(configContent, serverPath);
  const configuredServerExists = fileExists(codexConfiguration.configuredServerPath);
  const message = [
    `Extension path: ${extensionContext ? extensionContext.extensionPath : '(not set)'}`,
    `MCP API available: ${hasMcpApi}`,
    `MCP server file exists: ${fileExists(serverPath)}`,
    `MCP Node executable: ${nodeExecutable}`,
    `MCP terminal bridge: ${mcpBridgeUrl || '(not ready)'}`,
    `MCP bridge state: ${mcpBridgeStatePath || (extensionContext ? getMcpBridgeStatePath(extensionContext) : '(not ready)')}`,
    `Toolset path: ${getToolsetPath()}`,
    `Codex integration setting: ${formatCodexMcpIntegrationSetting(integrationSetting)}`,
    `Codex configuration: ${configPath}`,
    `Codex MCP configuration status: ${codexConfiguration.status}`,
    `Codex configured MCP server: ${codexConfiguration.configuredServerPath || '(not configured)'}`,
    `Codex configured MCP server exists: ${configuredServerExists}`
  ].join('\n');

  writeOutput(message);
  await vscode.window.showInformationMessage(message, { modal: true });
}

async function configureCodexMcp() {
  const result = await queueCodexMcpReconciliation(extensionContext, { force: true, forceEnabled: true });
  if (!result || !result.enabled || result.error) {
    return;
  }

  const message = result.settingError
    ? `Codex MCP configuration is current at ${result.configPath}, but VS Code could not save the automatic maintenance setting. Reload the VS Code window so the migration can retry.`
    : `Codex MCP configuration is enabled and current at ${result.configPath}. Codex global instructions are current at ${result.agentsPath}. Restart Codex to load the BC Dev Toolset MCP server.`;
  writeOutput(message);
  await (result.settingError ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
}

async function disableCodexMcp() {
  const answer = await vscode.window.showWarningMessage(
    'Disable BC Dev Toolset Codex MCP integration and remove its managed Codex configuration and global instructions?',
    { modal: true },
    'Disable'
  );
  if (answer !== 'Disable') {
    return;
  }

  const configPath = getCodexConfigPath();
  const existingContent = fileExists(configPath) ? readTextFile(configPath) : '';
  const expectedServerPath = joinTrustedPath(extensionContext.extensionPath, 'mcp-server.js');
  const configuration = classifyCodexMcpConfiguration(existingContent, expectedServerPath);
  const canRemoveConfiguration = configuration.status === 'current' || configuration.status === 'stale';
  const updatedContent = canRemoveConfiguration ? removeCodexMcpConfigContent(existingContent).trimEnd() : existingContent;
  const normalizedContent = canRemoveConfiguration && updatedContent ? `${updatedContent}\n` : updatedContent;
  const configChanged = writeFileWithBackupIfChanged(configPath, normalizedContent);
  const agentsResult = removeCodexGlobalAgentsInstructions();
  let settingError;
  try {
    await setCodexMcpIntegrationSetting(false);
    await extensionContext.globalState.update('codexMcpIntegrationLegacyMigrationCompleted', true);
  } catch (error) {
    settingError = error;
    writeOutput(`Codex MCP integration was removed, but its disabled setting could not be saved: ${error.message}`);
  }
  const message = settingError
    ? 'BC Dev Toolset Codex MCP integration was removed, but VS Code could not save the disabled setting. Reload the VS Code window and run this command again.'
    : configChanged || agentsResult.changed
      ? 'BC Dev Toolset Codex MCP integration was disabled. Restart Codex to unload the MCP server.'
      : 'BC Dev Toolset Codex MCP integration is disabled.';
  writeOutput(message);
  await (settingError ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
}

function queueCodexMcpReconciliation(context, options = {}) {
  codexMcpSyncPromise = codexMcpSyncPromise
    .catch((error) => writeOutput(`Previous Codex MCP configuration update failed: ${error.message}`))
    .then(() => reconcileCodexMcpConfiguration(context, options));
  return codexMcpSyncPromise;
}

async function reconcileCodexMcpConfiguration(context, options = {}) {
  await waitForRuntimeSync();

  if (isExtensionDevelopmentMode() && !options.force) {
    return { enabled: getCodexMcpIntegrationSetting() === true, changed: false, skipped: 'extension development mode' };
  }

  const explicitSetting = getCodexMcpIntegrationSetting();
  const migrationKey = 'codexMcpIntegrationLegacyMigrationCompleted';
  const migrationCompleted = context.globalState.get(migrationKey) === true;
  const configPath = getCodexConfigPath();
  const content = fileExists(configPath) ? readTextFile(configPath) : '';
  const expectedServerPath = joinTrustedPath(context.extensionPath, 'mcp-server.js');
  const configuration = classifyCodexMcpConfiguration(content, expectedServerPath);
  const integrationState = options.forceEnabled
    ? {
        enabled: true,
        persistSetting: explicitSetting !== true,
        completeMigration: !migrationCompleted
      }
    : resolveCodexMcpIntegrationState({
        explicitValue: explicitSetting,
        migrationCompleted,
        allowLegacyMigration: options.migrateLegacySetting === true,
        configurationStatus: configuration.status
      });

  if (!integrationState.enabled) {
    try {
      const result = await runCodexMcpIntegrationTransition(integrationState, {
        applyConfiguration: () => Promise.resolve({ enabled: false, changed: false }),
        persistSetting: setCodexMcpIntegrationSetting,
        completeMigration: () => context.globalState.update(migrationKey, true)
      });
      if (result.settingError) {
        writeOutput(`Codex MCP disabled setting could not be saved. The migration will retry after VS Code reloads its configuration registry: ${result.settingError.message}`);
      }
      return result;
    } catch (error) {
      writeOutput(`Automatic Codex MCP setting migration failed: ${error.message}`);
      return { enabled: false, changed: false, error };
    }
  }

  try {
    const result = await runCodexMcpIntegrationTransition(integrationState, {
      applyConfiguration: () => applyCodexMcpConfiguration(context),
      persistSetting: setCodexMcpIntegrationSetting,
      completeMigration: () => context.globalState.update(migrationKey, true)
    });
    if (result.settingError) {
      if (options.forceEnabled) {
        await context.globalState.update(migrationKey, false);
      }
      writeOutput(`Codex MCP configuration was repaired, but its automatic maintenance setting could not be saved. The migration will retry after VS Code reloads its configuration registry: ${result.settingError.message}`);
    }
    if (result.changed && options.notifyWhenChanged) {
      const message = result.settingError
        ? 'BC Dev Toolset updated the Codex MCP configuration. Reload the VS Code window so automatic maintenance can finish, then restart Codex.'
        : 'BC Dev Toolset updated the Codex MCP configuration. Restart Codex to load the current extension version.';
      writeOutput(message);
      await vscode.window.showInformationMessage(message);
    }
    return result;
  } catch (error) {
    writeOutput(`Automatic Codex MCP configuration update failed: ${error.message}`);
    await vscode.window.showWarningMessage(`BC Dev Toolset could not update the Codex MCP configuration: ${error.message}`);
    return { enabled: true, changed: false, error };
  }
}

async function applyCodexMcpConfiguration(context) {
  const toolsetPath = await resolveToolsetRuntimePath();
  if (!toolsetPath) {
    throw new Error('BC Dev Toolset runtime could not be resolved.');
  }

  const mcpServerPath = joinTrustedPath(context.extensionPath, 'mcp-server.js');
  if (!fileExists(mcpServerPath)) {
    throw new Error(`BC Dev Toolset MCP server was not found at ${mcpServerPath}.`);
  }

  const configPath = getCodexConfigPath();
  const existingContent = fileExists(configPath) ? readTextFile(configPath) : '';
  const updatedContent = updateCodexMcpConfigContent(existingContent, { mcpServerPath, toolsetPath });
  const configChanged = writeFileWithBackupIfChanged(configPath, updatedContent);
  const agentsResult = ensureCodexGlobalAgentsInstructions();
  return {
    enabled: true,
    changed: configChanged || agentsResult.changed,
    configPath,
    agentsPath: agentsResult.path
  };
}

function getCodexMcpIntegrationSetting() {
  const inspected = getConfiguration().inspect('codexMcpIntegration.enabled');
  return inspected ? inspected.globalValue : undefined;
}

async function setCodexMcpIntegrationSetting(value) {
  codexMcpSettingUpdateInProgress = true;
  try {
    await getConfiguration().update('codexMcpIntegration.enabled', value, vscode.ConfigurationTarget.Global);
  } finally {
    codexMcpSettingUpdateInProgress = false;
  }
}

function formatCodexMcpIntegrationSetting(value) {
  if (value === undefined) {
    return 'undefined (not explicitly configured)';
  }
  return value ? 'enabled' : 'disabled';
}

function getCodexHomePath() {
  if (process.env.CODEX_HOME) {
    return process.env.CODEX_HOME;
  }

  const homePath = process.env.USERPROFILE || process.env.HOME;
  if (!homePath) {
    throw new Error('Could not resolve the user profile folder for Codex config.');
  }

  return joinTrustedPath(homePath, '.codex');
}

function getCodexConfigPath() {
  return joinTrustedPath(getCodexHomePath(), 'config.toml');
}

function getTimestampForFileName() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function writeFileWithBackupIfChanged(filePath, content) {
  const currentContent = fileExists(filePath) ? readTextFile(filePath) : '';
  if (currentContent === content) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (currentContent) {
    writeTextFile(`${filePath}.${getTimestampForFileName()}.bak`, currentContent);
  }

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeTextFile(temporaryPath, content);
    renameFile(temporaryPath, filePath);
  } catch (error) {
    if (fileExists(temporaryPath)) {
      unlinkFile(temporaryPath);
    }
    throw error;
  }

  return true;
}

function ensureCodexGlobalAgentsInstructions() {
  const codexHomePath = getCodexHomePath();
  const agentsPath = getCodexGlobalAgentsPath(codexHomePath);
  const section = getCodexAgentsInstructionSection();
  const currentContent = fileExists(agentsPath) ? readTextFile(agentsPath) : '';
  const updatedContent = upsertGeneratedMarkdownSection(
    currentContent,
    'bc-dev-toolset-codex-mcp',
    section
  );

  return {
    path: agentsPath,
    changed: writeFileWithBackupIfChanged(agentsPath, updatedContent)
  };
}

function removeCodexGlobalAgentsInstructions() {
  const codexHomePath = getCodexHomePath();
  const agentsPath = getCodexGlobalAgentsPath(codexHomePath);
  if (!fileExists(agentsPath)) {
    return { path: agentsPath, changed: false };
  }

  const currentContent = readTextFile(agentsPath);
  const updatedContent = removeGeneratedMarkdownSection(currentContent, 'bc-dev-toolset-codex-mcp');
  return {
    path: agentsPath,
    changed: writeFileWithBackupIfChanged(agentsPath, updatedContent)
  };
}

function getCodexGlobalAgentsPath(codexHomePath) {
  const overridePath = joinTrustedPath(codexHomePath, 'AGENTS.override.md');
  if (fileExists(overridePath) && readTextFile(overridePath).trim()) {
    return overridePath;
  }

  return joinTrustedPath(codexHomePath, 'AGENTS.md');
}

function getCodexAgentsInstructionSection() {
  return [
    '## BC Dev Toolset MCP',
    '',
    'For Business Central Developer\'s Toolset operations, use the Codex MCP server `bc-dev-toolset` and its direct tools named `bc_dev_toolset_*`.',
    '',
    'Do not duplicate supported BC Dev Toolset operations by manually inspecting Docker containers, running BcContainerHelper cmdlets, or invoking PowerShell scripts directly. If a matching `bc_dev_toolset_*` tool exists, call it first.',
    '',
    'Use BC Dev Toolset runtime package operations only when the user explicitly asks for runtime packages. Do not use `bc_dev_toolset_create_runtime_package` as a substitute for ordinary AL compile/build/validation; it creates deployment runtime artifacts and requires runtime-package settings such as `packageOutputPath`.',
    '',
    'For compile/build/validate requests, use a matching compile/build tool when one exists. If no matching `bc_dev_toolset_*` compile/build tool is exposed, normal AL CLI compilation with the discovered workspace settings is appropriate.',
    '',
    'PowerShell and terminal commands are appropriate for work that is not covered by a `bc_dev_toolset_*` MCP tool, for reading local files, and for normal codebase maintenance.',
    '',
    'PowerShell-backed MCP operations require the BC Dev Toolset VS Code extension terminal bridge. If the MCP tool reports that the bridge is unavailable, tell the user to start or reload the VS Code extension host instead of falling back to a manual implementation.',
    ''
  ].join('\n');
}

function upsertGeneratedMarkdownSection(content, sectionId, sectionContent) {
  const startMarker = `<!-- BEGIN ${sectionId} -->`;
  const endMarker = `<!-- END ${sectionId} -->`;
  const generatedSection = `${startMarker}\n${sectionContent.trimEnd()}\n${endMarker}\n`;
  const source = content || '';
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);

  if (startIndex >= 0 && endIndex > startIndex) {
    return `${source.slice(0, startIndex)}${generatedSection}${source.slice(endIndex + endMarker.length).replace(/^\r?\n/, '')}`;
  }

  const separator = source.trim() ? (source.endsWith('\n') ? '\n' : '\n\n') : '';
  return `${source}${separator}${generatedSection}`;
}

function removeGeneratedMarkdownSection(content, sectionId) {
  const startMarker = `<!-- BEGIN ${sectionId} -->`;
  const endMarker = `<!-- END ${sectionId} -->`;
  const source = content || '';
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);
  if (startIndex < 0 || endIndex <= startIndex) {
    return source;
  }

  const before = source.slice(0, startIndex).trimEnd();
  const after = source.slice(endIndex + endMarker.length).trimStart();
  if (!before) {
    return after ? `${after}\n` : '';
  }
  if (!after) {
    return `${before}\n`;
  }
  return `${before}\n\n${after}\n`;
}

function getMcpNodeExecutable() {
  const nodeExecutable = resolveExecutablePath('node');
  if (nodeExecutable && nodeExecutable !== 'node') {
    return nodeExecutable;
  }

  return process.execPath;
}

function getMcpServerVersion(context, serverPath) {
  const extensionVersion = context.extension.packageJSON.version || 'unknown';
  try {
    return `${extensionVersion}.${Math.floor(fs.statSync(serverPath).mtimeMs)}`;
  } catch (error) {
    return extensionVersion;
  }
}

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
  return joinTrustedPath(localAppData, 'BC-Dev-Toolset', 'toolset');
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
  return fileExists(getOperationMetadataPath(candidatePath)) &&
    fileExists(getOperationBridgePath(candidatePath)) &&
    fileExists(joinTrustedPath(candidatePath, 'vscode-extension', 'package.json'));
}

function getOperationMetadataPath(toolsetPath) {
  return joinTrustedPath(toolsetPath, 'operations', 'operations.json');
}

function getOperationBridgePath(toolsetPath) {
  return joinTrustedPath(toolsetPath, 'Invoke-BcDevToolsetOperation.ps1');
}

function getMissingRuntimeFiles(toolsetPath) {
  return requiredRuntimeFiles.filter((relativePath) => !fileExists(joinTrustedPath(toolsetPath, relativePath)));
}

function getMissingBundledRuntimeItems(runtimePath) {
  return [
    ...getMissingRuntimeFiles(runtimePath),
    ...runtimeDirectories.filter((relativePath) => !fileExists(joinTrustedPath(runtimePath, relativePath)))
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
    fileExists(configuredToolsetPath)
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

function getOptionalWorkspacePath() {
  try {
    return getWorkspacePath();
  } catch (error) {
    return '';
  }
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
  const workspaceFiles = getWorkspaceFilesInDirectory(workspacePath);
  if (workspaceFiles.length === 1) {
    return workspacePath;
  }

  if (fileExists(joinTrustedPath(workspacePath, 'app.json'))) {
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
  return joinTrustedPath(getWorkspaceBasePath(), '.bcdevtoolset');
}

function getVisualizationDataPath() {
  return joinTrustedPath(getConfigPath(), `${getWorkspaceName()}.visualization.json`);
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

  return path.isAbsolute(value) ? value : joinTrustedPath(getWorkspaceBasePath(), value);
}

function getWorkspaceFileName() {
  if (vscode.workspace.workspaceFile) {
    return vscode.workspace.workspaceFile.fsPath;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length === 1) {
    const openedFolderWorkspaceFiles = getWorkspaceFilesInDirectory(workspaceFolders[0].uri.fsPath);
    if (openedFolderWorkspaceFiles.length === 1) {
      return openedFolderWorkspaceFiles[0];
    }
  }

  const workspaceBasePath = getWorkspaceBasePath();
  const workspaceFiles = getWorkspaceFilesInDirectory(workspaceBasePath);
  return workspaceFiles.length === 1 ? workspaceFiles[0] : '';
}

function getOptionalWorkspaceFileName() {
  try {
    return getWorkspaceFileName();
  } catch (error) {
    return '';
  }
}

function getOptionalLocalSettingsPath() {
  try {
    const configuredLocalSettingsPath = resolveWorkspaceBasePath(getConfiguration().get('localSettingsPath'));
    return configuredLocalSettingsPath || joinTrustedPath(getConfigPath(), 'settings.json');
  } catch (error) {
    return '';
  }
}

function getMcpWorkspaceContext() {
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath
  }));
  const activeAlProjectPath = getActiveAlProjectPath(workspaceFolders.map((folder) => folder.path));
  const appJsonPath = activeAlProjectPath ? joinTrustedPath(activeAlProjectPath, 'app.json') : '';

  return {
    source: 'vscode',
    workspacePath: getOptionalWorkspacePath(),
    workspaceFilePath: getOptionalWorkspaceFileName(),
    workspaceBasePath: getOptionalValue(getWorkspaceBasePath),
    localSettingsPath: getOptionalLocalSettingsPath(),
    workspaceFolders,
    activeAlProjectPath,
    appJsonPath: fileExists(appJsonPath) ? appJsonPath : '',
    settings: getMcpWorkspaceSettings()
  };
}

function getOptionalValue(callback) {
  try {
    return callback();
  } catch (error) {
    return '';
  }
}

function getActiveAlProjectPath(workspaceFolderPaths) {
  const firstAppFolder = workspaceFolderPaths.find((folderPath) => fileExists(joinTrustedPath(folderPath, 'app.json')));
  return firstAppFolder || '';
}

function getMcpWorkspaceSettings() {
  const alConfiguration = vscode.workspace.getConfiguration('al');
  return {
    'al.assemblyProbingPaths': alConfiguration.get('assemblyProbingPaths') || [],
    'al.enableCodeAnalysis': alConfiguration.get('enableCodeAnalysis'),
    'al.enableCodeActions': alConfiguration.get('enableCodeActions'),
    'al.compilationOptions': alConfiguration.get('compilationOptions') || {}
  };
}

function getWorkspaceFilesInDirectory(directoryPath) {
  if (!fileExists(directoryPath)) {
    return [];
  }

  return readDirectory(directoryPath)
    .filter((fileName) => fileName.endsWith('.code-workspace'))
    .map((fileName) => joinTrustedPath(directoryPath, fileName));
}

function getWorkspaceFileNameForInitializeWorkspace() {
  if (vscode.workspace.workspaceFile) {
    return vscode.workspace.workspaceFile.fsPath;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length !== 1) {
    return getWorkspaceFileName();
  }

  const openedFolderPath = workspaceFolders[0].uri.fsPath;
  const existingWorkspaceFiles = getWorkspaceFilesInDirectory(openedFolderPath);
  if (existingWorkspaceFiles.length === 1) {
    return existingWorkspaceFiles[0];
  }

  if (existingWorkspaceFiles.length > 1) {
    return '';
  }

  const workspaceFile = joinTrustedPath(openedFolderPath, `${path.basename(openedFolderPath)}.code-workspace`);
  const workspace = {
    folders: getAppFolderWorkspacePaths(openedFolderPath).map((folderPath) => ({ path: folderPath }))
  };

  writeTextFile(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`);
  return workspaceFile;
}

function getAppFolderWorkspacePaths(rootPath) {
  if (fileExists(joinTrustedPath(rootPath, 'app.json'))) {
    return ['.'];
  }

  const appFolderPaths = [];
  collectAppFolderWorkspacePaths(rootPath, rootPath, appFolderPaths);
  return appFolderPaths.sort((left, right) => left.localeCompare(right));
}

function collectAppFolderWorkspacePaths(rootPath, currentPath, appFolderPaths) {
  for (const entry of readDirectory(currentPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || shouldSkipWorkspaceFolderDiscovery(entry.name)) {
      continue;
    }

    const entryPath = joinTrustedPath(currentPath, entry.name);
    if (fileExists(joinTrustedPath(entryPath, 'app.json'))) {
      appFolderPaths.push(path.relative(rootPath, entryPath).replace(/\\/g, '/'));
    }

    collectAppFolderWorkspacePaths(rootPath, entryPath, appFolderPaths);
  }
}

function shouldSkipWorkspaceFolderDiscovery(folderName) {
  return folderName === 'node_modules' || folderName === '.git';
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
        bcUser: '',
        bcPassword: '',
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
    dependenciesPaths: [],
    recordingsPath: '',
    pageScriptTestResultsPath: '',
    pageScriptTestHeaded: 'false',
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
    bcUser: 'admin',
    bcPassword: 'P@ssw0rd',
    sqlBackupPath: '',
    network: '',
    hostIP: '',
    updateHosts: true
  };
}

function provideSettingsCompletionItems(document, position) {
  if (!isBcDevToolsetSettingsDocument(document)) {
    return undefined;
  }

  const completionContext = getMacAddressCompletionContext(document, position);
  if (completionContext) {
    if (!isMacAddressAllowedForCurrentConfiguration(document, position)) {
      return undefined;
    }

    const macAddress = generateLocalMacAddress();
    const item = new vscode.CompletionItem(macAddress, vscode.CompletionItemKind.Value);
    item.detail = 'Random locally administered MAC address';
    item.insertText = completionContext.insertQuotes ? `"${macAddress}"` : macAddress;
    item.range = completionContext.range;
    item.sortText = '0000';
    return [item];
  }

  const propertyCompletionContext = getConfigurationPropertyCompletionContext(document, position);
  if (!propertyCompletionContext) {
    return undefined;
  }

  const existingProperties = getExistingJsonObjectProperties(propertyCompletionContext.objectText);
  return configurationFields
    .filter((field) => isConfigurationFieldAllowed(field, propertyCompletionContext.serverType, propertyCompletionContext.network))
    .filter((field) => !existingProperties.has(field.name))
    .map((field, index) => createConfigurationPropertyCompletionItem(field.name, propertyCompletionContext.range, index));
}

function isBcDevToolsetSettingsDocument(document) {
  const normalizedPath = document.uri.fsPath.replace(/\\/g, '/');
  return normalizedPath.endsWith('/.bcdevtoolset/settings.json') || normalizedPath.endsWith('.code-workspace');
}

function getMacAddressCompletionContext(document, position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const quotedValueMatch = linePrefix.match(/"macAddress"\s*:\s*"[^"]*$/);
  if (quotedValueMatch) {
    const valueStart = linePrefix.lastIndexOf('"') + 1;
    return {
      insertQuotes: false,
      range: new vscode.Range(position.line, valueStart, position.line, position.character)
    };
  }

  const emptyValueMatch = linePrefix.match(/"macAddress"\s*:\s*$/);
  if (emptyValueMatch) {
    return {
      insertQuotes: true,
      range: new vscode.Range(position, position)
    };
  }

  return undefined;
}

function getConfigurationPropertyCompletionContext(document, position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const propertyMatch = linePrefix.match(/^(\s*)"?[A-Za-z]*$/);
  const propertyStart = new vscode.Position(position.line, propertyMatch ? propertyMatch[1].length : position.character);
  if (!propertyMatch || !isJsonPropertyPosition(document, propertyStart)) {
    return undefined;
  }

  const objectContext = getEnclosingJsonObjectContext(document, position);
  if (!objectContext || !isInsideConfigurationsArray(document.getText(), objectContext.start)) {
    return undefined;
  }

  return {
    objectText: objectContext.text,
    range: new vscode.Range(propertyStart, position),
    serverType: getJsonStringPropertyValue(objectContext.text, 'serverType'),
    network: getJsonStringPropertyValue(objectContext.text, 'network')
  };
}

function isMacAddressAllowedForCurrentConfiguration(document, position) {
  const objectContext = getEnclosingJsonObjectContext(document, position);
  if (!objectContext || !isInsideConfigurationsArray(document.getText(), objectContext.start)) {
    return false;
  }

  const serverType = getJsonStringPropertyValue(objectContext.text, 'serverType');
  const network = getJsonStringPropertyValue(objectContext.text, 'network');
  return serverType === 'Container' && network === 'transparent';
}

function getJsonStringPropertyValue(objectText, propertyName) {
  return Array.from(objectText.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g))
    .find((match) => match[1] === propertyName)?.[2];
}

function isConfigurationFieldAllowed(field, serverType, network) {
  if (serverType !== undefined && field.validServerTypes.length > 0 && !field.validServerTypes.includes(serverType)) {
    return false;
  }

  return !field.requiredNetwork || network === field.requiredNetwork;
}

function getExistingJsonObjectProperties(objectText) {
  return new Set(Array.from(objectText.matchAll(/"([^"]+)"\s*:/g), (match) => match[1]));
}

function createConfigurationPropertyCompletionItem(fieldName, range, index) {
  const item = new vscode.CompletionItem(fieldName, vscode.CompletionItemKind.Property);
  item.range = range;
  item.sortText = String(index).padStart(4, '0');

  if (fieldName === 'macAddress') {
    item.detail = 'Insert macAddress with a random locally administered MAC address';
    item.insertText = `"macAddress": "${generateLocalMacAddress()}"`;
  } else {
    item.insertText = `"${fieldName}": `;
  }

  return item;
}

function getEnclosingJsonObjectContext(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const objectStart = findEnclosingObjectStart(text, offset);
  if (objectStart < 0) {
    return undefined;
  }

  const objectEnd = findMatchingObjectEnd(text, objectStart);
  if (objectEnd < 0) {
    return {
      start: objectStart,
      text: text.slice(objectStart, offset)
    };
  }

  return {
    start: objectStart,
    text: text.slice(objectStart, objectEnd + 1)
  };
}

function findEnclosingObjectStart(text, offset) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < offset; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      stack.push(index);
    } else if (character === '}') {
      stack.pop();
    }
  }

  return stack.length > 0 ? stack[stack.length - 1] : -1;
}

function isInsideConfigurationsArray(text, offset) {
  const prefix = text.slice(0, offset);
  const configurationsArrayMatches = Array.from(prefix.matchAll(/"configurations"\s*:\s*\[/g));
  const configurationsArrayMatch = configurationsArrayMatches[configurationsArrayMatches.length - 1];
  if (!configurationsArrayMatch) {
    return false;
  }

  const arrayStart = configurationsArrayMatch.index + configurationsArrayMatch[0].lastIndexOf('[');
  return isArrayOpenAtOffset(text, arrayStart, offset);
}

function isArrayOpenAtOffset(text, arrayStart, offset) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart; index < offset; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '[') {
      depth++;
    } else if (character === ']') {
      depth--;
    }
  }

  return depth > 0;
}

function findMatchingObjectEnd(text, objectStart) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = objectStart; index < text.length; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isJsonPropertyPosition(document, propertyStart) {
  const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), propertyStart));
  const previousSignificantCharacter = prefix.trimEnd().slice(-1);
  return previousSignificantCharacter === '{' || previousSignificantCharacter === ',';
}

function generateLocalMacAddress() {
  return ['02', ...Array.from(crypto.randomBytes(5), (byte) => byte.toString(16).padStart(2, '0').toUpperCase())].join(':');
}

function ensureBcDevToolsetWorkspaceSettings(workspaceFile) {
  if (!fileExists(workspaceFile)) {
    return false;
  }

  const workspace = JSON.parse(readTextFile(workspaceFile));
  if (!workspace.settings) {
    workspace.settings = {};
  }

  if (workspace.settings['dam-pav.bcdevtoolset']) {
    return false;
  }

  workspace.settings['dam-pav.bcdevtoolset'] = getDefaultWorkspaceSettings();
  writeTextFile(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`);
  return true;
}

function ensureDefaultLocalConfiguration(localPath) {
  if (!fileExists(localPath)) {
    return;
  }

  const localSettings = JSON.parse(readTextFile(localPath));
  const configurations = Array.isArray(localSettings.configurations) ? localSettings.configurations : [];
  const hasUsableConfiguration = configurations.some((configuration) => configuration.name && configuration.name !== 'sample');
  if (hasUsableConfiguration) {
    return;
  }

  localSettings.configurations = [
    getDefaultLocalConfiguration(),
    ...configurations.filter((configuration) => configuration.name === 'sample')
  ];
  writeTextFile(localPath, `${JSON.stringify(localSettings, null, 2)}\n`);
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
  return joinTrustedPath(extensionContext.extensionPath, 'runtime');
}

function copyRuntimeFile(sourceRoot, targetRoot, relativePath) {
  const sourcePath = joinTrustedPath(sourceRoot, relativePath);
  const targetPath = joinTrustedPath(targetRoot, relativePath);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFile(sourcePath, targetPath);
}

function copyRuntimeDirectory(sourceRoot, targetRoot, relativePath) {
  const sourcePath = joinTrustedPath(sourceRoot, relativePath);
  const targetPath = joinTrustedPath(targetRoot, relativePath);
  const temporaryTargetPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

  removePath(temporaryTargetPath, { recursive: true, force: true });
  copyDirectoryRecursive(sourcePath, temporaryTargetPath);
  removePath(targetPath, { recursive: true, force: true });
  renameFile(temporaryTargetPath, targetPath);
}

function copyDirectoryRecursive(sourcePath, targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });

  for (const entry of readDirectory(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = joinTrustedPath(sourcePath, entry.name);
    const targetEntryPath = joinTrustedPath(targetPath, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourceEntryPath, targetEntryPath);
      continue;
    }

    copyFile(sourceEntryPath, targetEntryPath);
  }
}

function writeOutput(message) {
  if (!outputChannel) {
    return;
  }

  outputChannel.appendLine(message);
}

async function initializeWorkspace() {
  const workspaceFile = getWorkspaceFileNameForInitializeWorkspace();
  const configPath = workspaceFile ? joinTrustedPath(path.dirname(workspaceFile), '.bcdevtoolset') : getConfigPath();
  const localPath = joinTrustedPath(configPath, 'settings.json');

  fs.mkdirSync(configPath, { recursive: true });
  ensureBcDevToolsetGitIgnore(path.dirname(configPath));

  writeJsonIfMissing(localPath, getDefaultLocalSettings());
  ensureDefaultLocalConfiguration(localPath);

  ensureBcDevToolsetWorkspaceSettings(workspaceFile);
  await vscode.window.showInformationMessage('BC Dev Toolset workspace configuration is ready.');
  await vscode.window.showTextDocument(vscode.Uri.file(localPath));
}

async function openLocalSettingsJson() {
  const configPath = getConfigPath();
  const localPath = joinTrustedPath(configPath, 'settings.json');

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

  const htmlPath = joinTrustedPath(toolsetPath, 'visualization', 'WorkspaceAnalysis.html');
  const dataPath = getVisualizationDataPath();

  if (!fileExists(htmlPath)) {
    await vscode.window.showErrorMessage(`WorkspaceAnalysis.html was not found at ${htmlPath}.`);
    return;
  }

  if (!fileExists(dataPath)) {
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

  const data = JSON.parse(readTextFile(dataPath));
  const injectedDataScript = `<script>window.bcDevToolsetData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
  const html = readTextFile(htmlPath).replace('</head>', `${injectedDataScript}\n</head>`);
  panel.webview.html = html;
}

function ensureBcDevToolsetGitIgnore(basePath) {
  const gitIgnorePath = joinTrustedPath(basePath, '.gitignore');
  const ignoredFolder = '.bcdevtoolset/';
  const currentContent = fileExists(gitIgnorePath) ? readTextFile(gitIgnorePath) : '';
  const ignoredEntries = currentContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (ignoredEntries.includes(ignoredFolder) || ignoredEntries.includes('.bcdevtoolset')) {
    return;
  }

  const separator = currentContent && !currentContent.endsWith('\n') ? '\n' : '';
  writeTextFile(gitIgnorePath, `${currentContent}${separator}${ignoredFolder}\n`);
}

function writeJsonIfMissing(filePath, value) {
  if (fileExists(filePath)) {
    return;
  }

  writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

async function runOperationByIdForMcp(operationId, options = {}) {
  const toolsetPath = await resolveToolsetRuntimePath();
  if (!toolsetPath) {
    throw new Error('BC Dev Toolset runtime could not be resolved.');
  }

  const operation = getOperations(toolsetPath).find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw new Error(`BC Dev Toolset operation '${operationId}' was not found.`);
  }

  return executeOperationInTerminalForMcp(operation, toolsetPath, options);
}

function getOperations(toolsetPath) {
  return JSON.parse(readTextFile(getOperationMetadataPath(toolsetPath)));
}

async function executeOperation(operation, toolsetPath) {
  if (operation.command === 'initializeWorkspace') {
    await initializeWorkspace();
    return;
  }

  if (operation.command === 'openLocalSettingsJson') {
    await openLocalSettingsJson();
    return;
  }

  if (operation.command === 'configureCodexMcp') {
    await configureCodexMcp();
    return;
  }

  if (operation.command === 'disableCodexMcp') {
    await disableCodexMcp();
    return;
  }

  if (operation.command === 'showMcpStatus') {
    await showMcpStatus();
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

  const { command, powershellExecutable } = buildOperationTerminalCommand(operation, toolsetPath, { nonInteractive: false });

  const terminal = getOperationTerminal(powershellExecutable);
  terminal.sendText(command);
}

async function executeOperationInTerminalForMcp(operation, toolsetPath, options = {}) {
  if (!operation.script) {
    throw new Error(`BC Dev Toolset operation '${operation.id}' cannot be run by this extension.`);
  }

  const capture = createMcpCapturePaths(operation.id);
  const session = getOrCreateMcpPromptSession(capture.sessionId);
  session.operationId = operation.id;
  session.operationTitle = operation.title;
  touchMcpPromptSession(session);
  const { command, powershellExecutable } = buildOperationTerminalCommand(operation, toolsetPath, {
    nonInteractive: false,
    includeMcpCapture: true,
    transcriptPath: capture.transcriptPath,
    resultPath: capture.resultPath,
    mcpSessionId: capture.sessionId,
    workspacePath: options.workspacePath,
    workspaceFile: options.workspaceFile,
    localSettingsPath: options.localSettingsPath
  });
  const terminal = getOperationTerminal(powershellExecutable);
  const terminalName = getPowerShellTerminalName(powershellExecutable);
  session.terminalName = terminalName;
  session.capture = capture;
  touchMcpPromptSession(session);
  const shellIntegration = await waitForTerminalShellIntegration(terminal, 3000);

  if (!shellIntegration) {
    terminal.sendText(command);
    return waitForMcpCaptureResult(operation, terminalName, capture, options);
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : (Number.isFinite(Number(process.env.BCDEVTOOLSET_MCP_TERMINAL_TIMEOUT_MS))
        ? Number(process.env.BCDEVTOOLSET_MCP_TERMINAL_TIMEOUT_MS)
        : 60 * 60 * 1000);
  const execution = shellIntegration.executeCommand(command);
  const outputParts = [];
  const readPromise = readTerminalExecutionOutput(execution, outputParts);
  const captureResult = await waitForMcpCaptureResult(operation, terminalName, capture, { timeoutMs });
  await waitForTerminalReadToSettle(readPromise, 2000);
  return captureResult;
}

function buildOperationTerminalCommand(operation, toolsetPath, options = {}) {
  const workspacePath = options.workspacePath || getWorkspacePath();
  const bridgePath = getOperationBridgePath(toolsetPath);
  const powershellExecutable = operation.powerShellExecutable || getConfiguration().get('powershellExecutable') || 'pwsh';
  const workspaceFile = options.workspaceFile || getWorkspaceFileName();
  const configPath = getConfigPath();
  const localSettingsPath = options.localSettingsPath || resolveWorkspaceBasePath(getConfiguration().get('localSettingsPath')) || joinTrustedPath(configPath, 'settings.json');
  const localSettingsArguments = ` -LocalSettingsPath ${quotePowerShellArgument(localSettingsPath)}`;
  const workspaceFileArguments = workspaceFile
    ? ` -WorkspaceFile ${quotePowerShellArgument(workspaceFile)}`
    : '';

  const operationCommand =
    `& ${quotePowerShellArgument(bridgePath)}` +
    ` -Operation ${quotePowerShellArgument(operation.id)}` +
    ` -WorkspacePath ${quotePowerShellArgument(workspacePath)}` +
    workspaceFileArguments +
    localSettingsArguments +
    (options.nonInteractive ? ' -NonInteractive' : '');

  const mcpPromptEnvironment = options.mcpSessionId
    ? [
        `$env:BCDEVTOOLSET_MCP_SESSION_ID = ${quotePowerShellArgument(options.mcpSessionId)}`,
        `$env:BCDEVTOOLSET_MCP_PROMPT_URL = ${quotePowerShellArgument(`${mcpBridgeUrl}/prompt/request`)}`,
        `$env:BCDEVTOOLSET_MCP_PROMPT_TOKEN = ${quotePowerShellArgument(mcpBridgeToken)}`
      ].join('; ') + '; '
    : [
        '$env:BCDEVTOOLSET_MCP_SESSION_ID = $null',
        '$env:BCDEVTOOLSET_MCP_PROMPT_URL = $null',
        '$env:BCDEVTOOLSET_MCP_PROMPT_TOKEN = $null'
      ].join('; ') + '; ';

  const command =
    `$env:BCDEVTOOLSET_SHORTCUTS = ${quotePowerShellArgument(getShortcutMode())}; ` +
    `$env:BCDEVTOOLSET_HOST_HELPER_FOLDER = ${quotePowerShellArgument(getHostHelperFolder())}; ` +
    mcpPromptEnvironment +
    (options.includeMcpCapture
      ? buildMcpCapturedPowerShellCommand(operationCommand, options.transcriptPath, options.resultPath)
      : options.includeMcpExitMarker
        ? `try { ${operationCommand}; $bcDevToolsetMcpExitCode = if ($?) { 0 } else { 1 } } catch { Write-Error $_; $bcDevToolsetMcpExitCode = 1 }; Write-Host ${quotePowerShellArgument('__BCDEVTOOLSET_MCP_EXIT_CODE__')} $bcDevToolsetMcpExitCode`
      : operationCommand);

  return { command, powershellExecutable };
}

function buildMcpCapturedPowerShellCommand(operationCommand, transcriptPath, resultPath) {
  const quotedTranscriptPath = quotePowerShellArgument(transcriptPath);
  const quotedResultPath = quotePowerShellArgument(resultPath);
  return [
    `$bcDevToolsetMcpTranscriptPath = ${quotedTranscriptPath}`,
    `$bcDevToolsetMcpResultPath = ${quotedResultPath}`,
    '$bcDevToolsetMcpExitCode = 1',
    '$bcDevToolsetMcpError = $null',
    'try {',
    '  Start-Transcript -Path $bcDevToolsetMcpTranscriptPath -Force | Out-Null',
    `  try { ${operationCommand}; $bcDevToolsetMcpExitCode = if ($?) { 0 } else { 1 } } catch { $bcDevToolsetMcpError = $_.Exception.Message; Write-Error $_; $bcDevToolsetMcpExitCode = 1 }`,
    '} finally {',
    '  try { Stop-Transcript | Out-Null } catch {}',
    '  [pscustomobject]@{ exitCode = $bcDevToolsetMcpExitCode; error = $bcDevToolsetMcpError } | ConvertTo-Json -Compress | Set-Content -LiteralPath $bcDevToolsetMcpResultPath -Encoding UTF8',
    '}'
  ].join('; ');
}

function createMcpCapturePaths(operationId) {
  const directoryPath = joinTrustedPath(os.tmpdir(), 'bc-dev-toolset-mcp');
  fs.mkdirSync(directoryPath, { recursive: true });
  const id = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${operationId}`;
  return {
    sessionId: id,
    transcriptPath: joinTrustedPath(directoryPath, `${id}.transcript.txt`),
    resultPath: joinTrustedPath(directoryPath, `${id}.result.json`)
  };
}

async function waitForMcpCaptureResult(operation, terminalName, capture, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60 * 60 * 1000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = readMcpCaptureResult(operation, terminalName, capture);
    if (result) {
      const session = getOrCreateMcpPromptSession(capture.sessionId);
      session.status = result.status;
      session.completedAt = new Date().toISOString();
      session.result = result;
      touchMcpPromptSession(session);
      return result;
    }

    const session = mcpPromptSessions.get(capture.sessionId);
    if (session && session.status === 'waiting_for_input') {
      return {
        status: 'waiting_for_input',
        operationId: operation.id,
        operationTitle: operation.title,
        terminalName,
        sessionId: capture.sessionId,
        prompt: session.prompt,
        exitCode: null,
        exitCodeSource: 'mcp-prompt',
        timedOut: false,
        outputAvailable: fileExists(capture.transcriptPath),
        output: cleanPowerShellTranscript(readTextFileIfExists(capture.transcriptPath))
      };
    }

    await delay(500);
  }

  const timeoutResult = {
    status: 'timeout',
    operationId: operation.id,
    operationTitle: operation.title,
    terminalName,
    exitCode: null,
    exitCodeSource: 'mcp-capture-timeout',
    timedOut: true,
    outputAvailable: fileExists(capture.transcriptPath),
    output: readTextFileIfExists(capture.transcriptPath) || 'The terminal operation did not finish before the MCP timeout.'
  };
  const session = getOrCreateMcpPromptSession(capture.sessionId);
  session.status = timeoutResult.status;
  session.completedAt = new Date().toISOString();
  session.result = timeoutResult;
  touchMcpPromptSession(session);
  return timeoutResult;
}

function readMcpCaptureResult(operation, terminalName, capture) {
  if (!fileExists(capture.resultPath)) {
    return undefined;
  }

  const result = JSON.parse(readTextFile(capture.resultPath));
  const output = cleanPowerShellTranscript(readTextFileIfExists(capture.transcriptPath));
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1;
  return {
    status: exitCode === 0 ? 'completed' : 'failed',
    operationId: operation.id,
    operationTitle: operation.title,
    terminalName,
    exitCode,
    exitCodeSource: 'mcp-capture-file',
    timedOut: false,
    outputAvailable: true,
    output: result.error ? `${output}\n\nError: ${result.error}`.trim() : output
  };
}

function readTextFileIfExists(filePath) {
  return fileExists(filePath) ? readTextFile(filePath) : '';
}

function cleanPowerShellTranscript(value) {
  return stripAnsi(String(value || ''))
    .replace(/\*{10,}\s*\nWindows PowerShell transcript start[\s\S]*?Transcript started, output file is .*\n/i, '')
    .replace(/\*{10,}\s*\nWindows PowerShell transcript end[\s\S]*$/i, '')
    .trim();
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function waitForTerminalShellIntegration(terminal, timeoutMs) {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      resolve(terminal.shellIntegration);
    }, timeoutMs);

    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        clearTimeout(timeout);
        subscription.dispose();
        resolve(event.shellIntegration);
      }
    });
  });
}

async function readTerminalExecutionOutput(execution, outputParts) {
  try {
    for await (const data of execution.read()) {
      outputParts.push(data);
    }
  } catch (error) {
    outputParts.push(`\nFailed to read terminal output: ${error.message}`);
  }
}

function waitForTerminalReadToSettle(readPromise, timeoutMs) {
  return Promise.race([
    readPromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function stripAnsi(value) {
  return String(value).replace(new RegExp('\\u001b\\[[0-9;]*m', 'g'), '');
}

module.exports = {
  activate,
  deactivate
};
