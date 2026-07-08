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

function getMcpBridgeStatePath(context) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — os.tmpdir() returns a system temp directory
  // eslint-disable-next-line security/detect-non-literal-fs-filename — os.tmpdir() returns a system temp directory
  return path.join(os.tmpdir(), 'bc-dev-toolset-mcp', 'vscode-bridge.json');
}

function writeMcpBridgeState(context) {
  if (!mcpBridgeUrl || !mcpBridgeToken) {
    return;
  }

  mcpBridgeStatePath = getMcpBridgeStatePath(context);
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — mcpBridgeStatePath is set internally by the extension
  fs.mkdirSync(path.dirname(mcpBridgeStatePath), { recursive: true });
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — mcpBridgeStatePath is set internally by the extension
  fs.writeFileSync(mcpBridgeStatePath, `${JSON.stringify({
    url: mcpBridgeUrl,
    token: mcpBridgeToken,
    pid: process.pid,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

function removeMcpBridgeState() {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — mcpBridgeStatePath is set internally by the extension
  // eslint-disable-next-line security/detect-non-literal-fs-filename — mcpBridgeStatePath is set internally by the extension
  if (mcpBridgeStatePath && fs.existsSync(mcpBridgeStatePath)) {
    fs.rmSync(mcpBridgeStatePath, { force: true });
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename — filePath comes from MCP capture metadata set by the extension
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.rmSync(filePath, { force: true });
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — context.extensionPath is set by VS Code, not user-controlled
  const serverPath = path.join(context.extensionPath, 'mcp-server.js');
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — extensionContext.extensionPath is set by VS Code, not user-controlled
  // eslint-disable-next-line security/detect-non-literal-fs-filename — extensionContext.extensionPath is set by VS Code, not user-controlled
  const serverPath = extensionContext ? path.join(extensionContext.extensionPath, 'mcp-server.js') : '';
  const nodeExecutable = getMcpNodeExecutable();
  const integrationSetting = getCodexMcpIntegrationSetting();
  const configPath = getCodexConfigPath();
  // eslint-disable-next-line security/detect-non-literal-fs-filename — configPath is derived from VS Code's Codex home directory
  const configContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const codexConfiguration = classifyCodexMcpConfiguration(configContent, serverPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename — codexConfiguration.configuredServerPath is derived from VS Code's Codex home directory
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — codexConfiguration.configuredServerPath is derived from VS Code's Codex home directory
  const configuredServerExists = Boolean(codexConfiguration.configuredServerPath && fs.existsSync(codexConfiguration.configuredServerPath));
  const message = [
    `Extension path: ${extensionContext ? extensionContext.extensionPath : '(not set)'}`,
    `MCP API available: ${hasMcpApi}`,
    // eslint-disable-next-line security/detect-non-literal-fs-filename — serverPath is derived from extensionContext.extensionPath (VS Code internal)
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — serverPath is derived from extensionContext.extensionPath (VS Code internal)
    `MCP server file exists: ${serverPath ? fs.existsSync(serverPath) : false}`,
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — configPath is derived from VS Code's Codex home directory
  const existingContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const expectedServerPath = path.join(extensionContext.extensionPath, 'mcp-server.js');
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — configPath is derived from VS Code's Codex home directory
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const expectedServerPath = path.join(context.extensionPath, 'mcp-server.js');
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

  const mcpServerPath = path.join(context.extensionPath, 'mcp-server.js');
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — mcpServerPath is derived from context.extensionPath (VS Code internal)
  // eslint-disable-next-line security/detect-non-literal-fs-filename — mcpServerPath is derived from context.extensionPath (VS Code internal)
  if (!fs.existsSync(mcpServerPath)) {
    throw new Error(`BC Dev Toolset MCP server was not found at ${mcpServerPath}.`);
  }

  const configPath = getCodexConfigPath();
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — configPath is derived from VS Code's Codex home directory
  const existingContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
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

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — homePath is set by the OS, not user-controlled
  // eslint-disable-next-line security/detect-non-literal-fs-filename — homePath is set by the OS, not user-controlled
  return path.join(homePath, '.codex');
}

function getCodexConfigPath() {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — getCodexHomePath() returns a path from VS Code's Codex home directory
  // eslint-disable-next-line security/detect-non-literal-fs-filename — getCodexHomePath() returns a path from VS Code's Codex home directory
  return path.join(getCodexHomePath(), 'config.toml');
}

function getTimestampForFileName() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function writeFileWithBackupIfChanged(filePath, content) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename — filePath is derived from VS Code workspace or Codex home directory
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — filePath is derived from VS Code workspace or Codex home directory
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (currentContent === content) {
    return false;
  }

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — filePath is derived from VS Code workspace or Codex home directory
  // eslint-disable-next-line security/detect-non-literal-fs-filename — filePath is derived from VS Code workspace or Codex home directory
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (currentContent) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename — filePath is derived from VS Code workspace or Codex home directory
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — filePath is derived from VS Code workspace or Codex home directory
    fs.writeFileSync(`${filePath}.${getTimestampForFileName()}.bak`, currentContent, 'utf8');
  }

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename — temporaryPath is derived from filePath
    fs.writeFileSync(temporaryPath, content, 'utf8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename — temporaryPath and filePath are derived from the same source
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename — temporaryPath is derived from filePath
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
    throw error;
  }

  return true;
}

function ensureCodexGlobalAgentsInstructions() {
  const codexHomePath = getCodexHomePath();
  const agentsPath = getCodexGlobalAgentsPath(codexHomePath);
  const section = getCodexAgentsInstructionSection();
  // eslint-disable-next-line security/detect-non-literal-fs-filename — agentsPath is derived from VS Code's Codex home directory
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — agentsPath is derived from VS Code's Codex home directory
  const currentContent = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — agentsPath is derived from VS Code's Codex home directory
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — agentsPath is derived from VS Code's Codex home directory
  if (!fs.existsSync(agentsPath)) {
    return { path: agentsPath, changed: false };
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename — agentsPath is derived from VS Code's Codex home directory
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — agentsPath is derived from VS Code's Codex home directory
  const currentContent = fs.readFileSync(agentsPath, 'utf8');
  const updatedContent = removeGeneratedMarkdownSection(currentContent, 'bc-dev-toolset-codex-mcp');
  return {
    path: agentsPath,
    changed: writeFileWithBackupIfChanged(agentsPath, updatedContent)
  };
}

function getCodexGlobalAgentsPath(codexHomePath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — codexHomePath is set by VS Code, not user-controlled
  // eslint-disable-next-line security/detect-non-literal-fs-filename — codexHomePath is set by VS Code, not user-controlled
  const overridePath = path.join(codexHomePath, 'AGENTS.override.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename — overridePath is derived from VS Code's Codex home directory
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — overridePath is derived from VS Code's Codex home directory
  if (fs.existsSync(overridePath) && fs.readFileSync(overridePath, 'utf8').trim()) {
    return overridePath;
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — codexHomePath is set by VS Code, not user-controlled
  // eslint-disable-next-line security/detect-non-literal-fs-filename — codexHomePath is set by VS Code, not user-controlled
  return path.join(codexHomePath, 'AGENTS.md');
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

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — process.execPath is set by Node.js/VS Code, not user-controlled
  return process.execPath;
}

function getMcpServerVersion(context, serverPath) {
  const extensionVersion = context.extension.packageJSON.version || 'unknown';
  try {
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — serverPath is derived from context.extensionPath (VS Code internal)
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — serverPath is derived from context.extensionPath (VS Code internal)
    // eslint-disable-next-line security/detect-non-literal-fs-filename — serverPath is derived from context.extensionPath (VS Code internal)
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — hostHelperFolder comes from extension settings with a safe default
  // eslint-disable-next-line security/detect-non-literal-fs-filename — hostHelperFolder comes from extension settings with a safe default
  return getConfiguration().get('hostHelperFolder') || 'C:\\ProgramData\\BcContainerHelper';
}

function getDefaultToolsetPath() {
  const localAppData = process.env.LOCALAPPDATA || process.env.HOME || process.env.USERPROFILE;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — localAppData is set by the OS, not user-controlled
  // eslint-disable-next-line security/detect-non-literal-fs-filename — localAppData is set by the OS, not user-controlled
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

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — extensionContext.extensionPath is set by VS Code, not user-controlled
  // eslint-disable-next-line security/detect-non-literal-fs-filename — extensionContext.extensionPath is set by VS Code, not user-controlled
  const candidatePath = path.resolve(extensionContext.extensionPath, '..');
  return isDevelopmentToolsetPath(candidatePath) ? candidatePath : '';
}

function isExtensionDevelopmentMode() {
  return extensionContext && extensionContext.extensionMode === vscode.ExtensionMode.Development;
}

function isDevelopmentToolsetPath(candidatePath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — candidatePath is derived from extensionContext.extensionPath (VS Code internal)
  // eslint-disable-next-line security/detect-non-literal-fs-filename — candidatePath is derived from extensionContext.extensionPath (VS Code internal)
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — candidatePath is derived from extensionContext.extensionPath (VS Code internal)
  return fs.existsSync(getOperationMetadataPath(candidatePath)) &&
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — getOperationMetadataPath returns a path derived from candidatePath
    fs.existsSync(getOperationBridgePath(candidatePath)) &&
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — candidatePath is derived from extensionContext.extensionPath (VS Code internal)
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — candidatePath is derived from extensionContext.extensionPath (VS Code internal)
    fs.existsSync(path.join(candidatePath, 'vscode-extension', 'package.json'));
}

function getOperationMetadataPath(toolsetPath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — toolsetPath is validated by isDevelopmentToolsetPath or comes from extension settings
  // eslint-disable-next-line security/detect-non-literal-fs-filename — toolsetPath is validated by isDevelopmentToolsetPath or comes from extension settings
  return path.join(toolsetPath, 'operations', 'operations.json');
}

function getOperationBridgePath(toolsetPath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — toolsetPath is validated by isDevelopmentToolsetPath or comes from extension settings
  // eslint-disable-next-line security/detect-non-literal-fs-filename — toolsetPath is validated by isDevelopmentToolsetPath or comes from extension settings
  return path.join(toolsetPath, 'Invoke-BcDevToolsetOperation.ps1');
}

function getMissingRuntimeFiles(toolsetPath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — toolsetPath is validated by isDevelopmentToolsetPath or comes from extension settings
  // eslint-disable-next-line security/detect-non-literal-fs-filename — toolsetPath is validated by isDevelopmentToolsetPath or comes from extension settings
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — toolsetPath is validated by isDevelopmentToolsetPath or comes from extension settings
  return requiredRuntimeFiles.filter((relativePath) => !fs.existsSync(path.join(toolsetPath, relativePath)));
}

function getMissingBundledRuntimeItems(runtimePath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — runtimePath is derived from toolsetPath which is validated
  // eslint-disable-next-line security/detect-non-literal-fs-filename — runtimePath is derived from toolsetPath which is validated
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — runtimePath is derived from toolsetPath which is validated
  return [
    ...getMissingRuntimeFiles(runtimePath),
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — runtimePath is derived from toolsetPath which is validated
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

  // eslint-disable-next-line security/detect-non-literal-fs-filename — configuredToolsetPath is validated by getToolsetPath
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — configuredToolsetPath is validated by getToolsetPath
  await vscode.window.showErrorMessage(
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — configuredToolsetPath is validated by getToolsetPath
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

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — folder.uri.fsPath comes from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — folder.uri.fsPath comes from VS Code workspace folders
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
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — vscode.workspace.workspaceFile.fsPath comes from VS Code
    // eslint-disable-next-line security/detect-non-literal-fs-filename — vscode.workspace.workspaceFile.fsPath comes from VS Code
    return path.dirname(vscode.workspace.workspaceFile.fsPath);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length > 1) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFolders[].uri.fsPath comes from VS Code workspace folders
    return getCommonParentPath(workspaceFolders.map((folder) => folder.uri.fsPath));
  }

  const workspacePath = getWorkspacePath();
  const workspaceFiles = getWorkspaceFilesInDirectory(workspacePath);
  if (workspaceFiles.length === 1) {
    return workspacePath;
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — workspacePath is from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspacePath is from VS Code workspace folders
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — workspacePath is from VS Code workspace folders
  if (fs.existsSync(path.join(workspacePath, 'app.json'))) {
    return path.dirname(workspacePath);
  }

  return workspacePath;
}

function getCommonParentPath(paths) {
  if (paths.length === 0) {
    return '';
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — paths come from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — paths come from VS Code workspace folders
  let commonPath = path.resolve(paths[0]);
  for (const candidate of paths.slice(1)) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — candidate comes from VS Code workspace folders
    // eslint-disable-next-line security/detect-non-literal-fs-filename — candidate comes from VS Code workspace folders
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — getWorkspaceBasePath() returns a path from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — getWorkspaceBasePath() returns a path from VS Code workspace folders
  return path.join(getWorkspaceBasePath(), '.bcdevtoolset');
}

function getVisualizationDataPath() {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — getConfigPath() and getWorkspaceName() are derived from VS Code workspace
  // eslint-disable-next-line security/detect-non-literal-fs-filename — getConfigPath() and getWorkspaceName() are derived from VS Code workspace
  return path.join(getConfigPath(), `${getWorkspaceName()}.visualization.json`);
}

function getWorkspaceName() {
  const workspaceFile = getWorkspaceFileName();
  if (workspaceFile) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFile comes from VS Code workspace
    return path.basename(workspaceFile, '.code-workspace');
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename — getWorkspacePath() returns a path from VS Code workspace folders
  return path.basename(getWorkspacePath());
}

function resolveWorkspaceBasePath(value) {
  if (!value || !value.trim()) {
    return '';
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — getWorkspaceBasePath() returns a path from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — getWorkspaceBasePath() returns a path from VS Code workspace folders
  return path.isAbsolute(value) ? value : path.join(getWorkspaceBasePath(), value);
}

function getWorkspaceFileName() {
  if (vscode.workspace.workspaceFile) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — vscode.workspace.workspaceFile.fsPath comes from VS Code
    // eslint-disable-next-line security/detect-non-literal-fs-filename — vscode.workspace.workspaceFile.fsPath comes from VS Code
    return vscode.workspace.workspaceFile.fsPath;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length === 1) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — workspaceFolders[0].uri.fsPath comes from VS Code
    // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFolders[0].uri.fsPath comes from VS Code
    const openedFolderWorkspaceFiles = getWorkspaceFilesInDirectory(workspaceFolders[0].uri.fsPath);
    if (openedFolderWorkspaceFiles.length === 1) {
      return openedFolderWorkspaceFiles[0];
    }
  }

  const workspaceBasePath = getWorkspaceBasePath();
  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceBasePath comes from VS Code workspace folders
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
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — getConfigPath() is derived from VS Code workspace
    // eslint-disable-next-line security/detect-non-literal-fs-filename — getConfigPath() is derived from VS Code workspace
    return configuredLocalSettingsPath || path.join(getConfigPath(), 'settings.json');
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — activeAlProjectPath comes from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — activeAlProjectPath comes from VS Code workspace folders
  const appJsonPath = activeAlProjectPath ? path.join(activeAlProjectPath, 'app.json') : '';

  return {
    source: 'vscode',
    workspacePath: getOptionalWorkspacePath(),
    workspaceFilePath: getOptionalWorkspaceFileName(),
    workspaceBasePath: getOptionalValue(getWorkspaceBasePath),
    localSettingsPath: getOptionalLocalSettingsPath(),
    workspaceFolders,
    activeAlProjectPath,
    // eslint-disable-next-line security/detect-non-literal-fs-filename — appJsonPath is derived from activeAlProjectPath (VS Code workspace)
    appJsonPath: fs.existsSync(appJsonPath) ? appJsonPath : '',
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — folderPath comes from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — folderPath comes from VS Code workspace folders
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — folderPath comes from VS Code workspace folders
  const firstAppFolder = workspaceFolderPaths.find((folderPath) => fs.existsSync(path.join(folderPath, 'app.json')));
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — directoryPath comes from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — directoryPath comes from VS Code workspace folders
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — directoryPath comes from VS Code workspace folders
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return [];
  }

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — directoryPath comes from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — directoryPath comes from VS Code workspace folders
  return fs.readdirSync(directoryPath)
    .filter((fileName) => fileName.endsWith('.code-workspace'))
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — directoryPath comes from VS Code workspace, fileName comes from readdirSync
    // eslint-disable-next-line security/detect-non-literal-fs-filename — directoryPath and fileName come from VS Code workspace
    .map((fileName) => path.join(directoryPath, fileName));
}

function getWorkspaceFileNameForInitializeWorkspace() {
  if (vscode.workspace.workspaceFile) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — vscode.workspace.workspaceFile.fsPath comes from VS Code
    // eslint-disable-next-line security/detect-non-literal-fs-filename — vscode.workspace.workspaceFile.fsPath comes from VS Code
    return vscode.workspace.workspaceFile.fsPath;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  if (workspaceFolders.length !== 1) {
    return getWorkspaceFileName();
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — workspaceFolders[0].uri.fsPath comes from VS Code
  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFolders[0].uri.fsPath comes from VS Code
  const openedFolderPath = workspaceFolders[0].uri.fsPath;
  const existingWorkspaceFiles = getWorkspaceFilesInDirectory(openedFolderPath);
  if (existingWorkspaceFiles.length === 1) {
    return existingWorkspaceFiles[0];
  }

  if (existingWorkspaceFiles.length > 1) {
    return '';
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — openedFolderPath comes from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — openedFolderPath comes from VS Code workspace folders
  const workspaceFile = path.join(openedFolderPath, `${path.basename(openedFolderPath)}.code-workspace`);
  const workspace = {
    folders: getAppFolderWorkspacePaths(openedFolderPath).map((folderPath) => ({ path: folderPath }))
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFile is derived from VS Code workspace folders
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — workspaceFile is derived from VS Code workspace folders
  fs.writeFileSync(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  return workspaceFile;
}

function getAppFolderWorkspacePaths(rootPath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — rootPath comes from VS Code workspace folders
  // eslint-disable-next-line security/detect-non-literal-fs-filename — rootPath comes from VS Code workspace folders
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — rootPath comes from VS Code workspace folders
  if (fs.existsSync(path.join(rootPath, 'app.json'))) {
    return ['.'];
  }

  const appFolderPaths = [];
  collectAppFolderWorkspacePaths(rootPath, rootPath, appFolderPaths);
  return appFolderPaths.sort((left, right) => left.localeCompare(right));
}

function collectAppFolderWorkspacePaths(rootPath, currentPath, appFolderPaths) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — currentPath comes from VS Code workspace folders or recursive traversal within them
  // eslint-disable-next-line security/detect-non-literal-fs-filename — currentPath comes from VS Code workspace folders or recursive traversal within them
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || shouldSkipWorkspaceFolderDiscovery(entry.name)) {
      continue;
    }

    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — currentPath comes from VS Code workspace, entry.name is a directory entry within it
    // eslint-disable-next-line security/detect-non-literal-fs-filename — currentPath comes from VS Code workspace, entry.name is a directory entry within it
    const entryPath = path.join(currentPath, entry.name);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — entryPath is derived from VS Code workspace folders
    // eslint-disable-next-line security/detect-non-literal-fs-filename — entryPath is derived from VS Code workspace folders
    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — entryPath is derived from VS Code workspace folders
    if (fs.existsSync(path.join(entryPath, 'app.json'))) {
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
  const escapedPropertyName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propertyMatch = objectText.match(new RegExp(`"${escapedPropertyName}"\\s*:\\s*"([^"]*)"`));
  return propertyMatch ? propertyMatch[1] : undefined;
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFile comes from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — workspaceFile comes from VS Code workspace
  if (!workspaceFile || !fs.existsSync(workspaceFile)) {
    return false;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFile comes from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — workspaceFile comes from VS Code workspace
  const workspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  if (!workspace.settings) {
    workspace.settings = {};
  }

  if (workspace.settings['dam-pav.bcdevtoolset']) {
    return false;
  }

  workspace.settings['dam-pav.bcdevtoolset'] = getDefaultWorkspaceSettings();
  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFile comes from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — workspaceFile comes from VS Code workspace
  fs.writeFileSync(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  return true;
}

function ensureDefaultLocalConfiguration(localPath) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename — localPath comes from user's .bcdevtoolset/settings.json
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — localPath comes from user's .bcdevtoolset/settings.json
  if (!fs.existsSync(localPath)) {
    return;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename — localPath comes from user's .bcdevtoolset/settings.json
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — localPath comes from user's .bcdevtoolset/settings.json
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — localPath comes from user's .bcdevtoolset/settings.json
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — localPath comes from user's .bcdevtoolset/settings.json
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
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — powershellExecutable comes from extension settings or operation metadata
    // eslint-disable-next-line security/detect-non-literal-fs-filename — powershellExecutable comes from extension settings or operation metadata
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — getToolsetPath() returns a validated path
  // eslint-disable-next-line security/detect-non-literal-fs-filename — getToolsetPath() returns a validated path
  return `${extensionVersion}|${getToolsetPath()}`;
}

async function syncRuntimeToolsetAfterExtensionUpdate(context) {
  if (isExtensionDevelopmentMode()) {
    return;
  }

  const syncStateKey = getRuntimeSyncStateKey(context);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — getToolsetPath() returns a validated path
  // eslint-disable-next-line security/detect-non-literal-fs-filename — getToolsetPath() returns a validated path
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

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — toolsetPath is validated by getToolsetPath
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — extensionContext.extensionPath is set by VS Code, not user-controlled
  // eslint-disable-next-line security/detect-non-literal-fs-filename — extensionContext.extensionPath is set by VS Code, not user-controlled
  return path.join(extensionContext.extensionPath, 'runtime');
}

function copyRuntimeFile(sourceRoot, targetRoot, relativePath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — sourceRoot and targetRoot are validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — sourceRoot and targetRoot are validated paths
  const sourcePath = path.join(sourceRoot, relativePath);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — targetRoot is validated, relativePath is a known constant
  // eslint-disable-next-line security/detect-non-literal-fs-filename — targetRoot is validated, relativePath is a known constant
  const targetPath = path.join(targetRoot, relativePath);

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — targetPath is derived from validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — targetPath is derived from validated paths
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — sourcePath and targetPath are derived from validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — sourcePath and targetPath are derived from validated paths
  fs.copyFileSync(sourcePath, targetPath);
}

function copyRuntimeDirectory(sourceRoot, targetRoot, relativePath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — sourceRoot and targetRoot are validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — sourceRoot and targetRoot are validated paths
  const sourcePath = path.join(sourceRoot, relativePath);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — targetRoot is validated, relativePath is a known constant
  // eslint-disable-next-line security/detect-non-literal-fs-filename — targetRoot is validated, relativePath is a known constant
  const targetPath = path.join(targetRoot, relativePath);
  const temporaryTargetPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — temporaryTargetPath is derived from validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — temporaryTargetPath is derived from validated paths
  fs.rmSync(temporaryTargetPath, { recursive: true, force: true });
  copyDirectoryRecursive(sourcePath, temporaryTargetPath);
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — targetPath is derived from validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — targetPath is derived from validated paths
  fs.rmSync(targetPath, { recursive: true, force: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename — temporaryTargetPath and targetPath are derived from validated paths
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — temporaryTargetPath and targetPath are derived from validated paths
  fs.renameSync(temporaryTargetPath, targetPath);
}

function copyDirectoryRecursive(sourcePath, targetPath) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — targetPath is derived from validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — targetPath is derived from validated paths
  fs.mkdirSync(targetPath, { recursive: true });

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — sourcePath is derived from validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename — sourcePath is derived from validated paths
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — sourcePath is validated, entry.name is a directory entry
    // eslint-disable-next-line security/detect-non-literal-fs-filename — sourcePath is validated, entry.name is a directory entry
    const sourceEntryPath = path.join(sourcePath, entry.name);
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — targetPath is validated, entry.name is a directory entry
    // eslint-disable-next-line security/detect-non-literal-fs-filename — targetPath is validated, entry.name is a directory entry
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourceEntryPath, targetEntryPath);
      continue;
    }

    // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — sourceEntryPath and targetEntryPath are derived from validated paths
    // eslint-disable-next-line security/detect-non-literal-fs-filename — sourceEntryPath and targetEntryPath are derived from validated paths
    fs.copyFileSync(sourceEntryPath, targetEntryPath);
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — workspaceFile comes from VS Code workspace
  // eslint-disable-next-line security/detect-non-literal-fs-filename — workspaceFile comes from VS Code workspace
  const configPath = workspaceFile ? path.join(path.dirname(workspaceFile), '.bcdevtoolset') : getConfigPath();
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — configPath is derived from VS Code workspace
  // eslint-disable-next-line security/detect-non-literal-fs-filename — configPath is derived from VS Code workspace
  const localPath = path.join(configPath, 'settings.json');

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — configPath is derived from VS Code workspace
  // eslint-disable-next-line security/detect-non-literal-fs-filename — configPath is derived from VS Code workspace
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — configPath is derived from VS Code workspace
  // eslint-disable-next-line security/detect-non-literal-fs-filename — configPath is derived from VS Code workspace
  const localPath = path.join(configPath, 'settings.json');

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — configPath is derived from VS Code workspace
  // eslint-disable-next-line security/detect-non-literal-fs-filename — configPath is derived from VS Code workspace
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

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — toolsetPath is validated by resolveToolsetRuntimePath
  // eslint-disable-next-line security/detect-non-literal-fs-filename — toolsetPath is validated by resolveToolsetRuntimePath
  const htmlPath = path.join(toolsetPath, 'visualization', 'WorkspaceAnalysis.html');
  const dataPath = getVisualizationDataPath();

  // eslint-disable-next-line security/detect-non-literal-fs-filename — htmlPath is derived from validated toolsetPath
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — htmlPath is derived from validated toolsetPath
  if (!fs.existsSync(htmlPath)) {
    await vscode.window.showErrorMessage(`WorkspaceAnalysis.html was not found at ${htmlPath}.`);
    return;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename — dataPath is derived from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — dataPath is derived from VS Code workspace
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

  // eslint-disable-next-line security/detect-non-literal-fs-filename — dataPath is derived from VS Code workspace
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const injectedDataScript = `<script>window.bcDevToolsetData = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename — htmlPath is derived from validated toolsetPath
  const html = fs.readFileSync(htmlPath, 'utf8').replace('</head>', `${injectedDataScript}\n</head>`);
  panel.webview.html = html;
}

function ensureBcDevToolsetGitIgnore(basePath) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — basePath is derived from VS Code workspace
  // eslint-disable-next-line security/detect-non-literal-fs-filename — basePath is derived from VS Code workspace
  const gitIgnorePath = path.join(basePath, '.gitignore');
  const ignoredFolder = '.bcdevtoolset/';
  // eslint-disable-next-line security/detect-non-literal-fs-filename — gitIgnorePath is derived from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — gitIgnorePath is derived from VS Code workspace
  const currentContent = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, 'utf8') : '';
  const ignoredEntries = currentContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (ignoredEntries.includes(ignoredFolder) || ignoredEntries.includes('.bcdevtoolset')) {
    return;
  }

  const separator = currentContent && !currentContent.endsWith('\n') ? '\n' : '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename — gitIgnorePath is derived from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — gitIgnorePath is derived from VS Code workspace
  fs.writeFileSync(gitIgnorePath, `${currentContent}${separator}${ignoredFolder}\n`, 'utf8');
}

function writeJsonIfMissing(filePath, value) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename — filePath is derived from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — filePath is derived from VS Code workspace
  if (fs.existsSync(filePath)) {
    return;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename — filePath is derived from VS Code workspace
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — filePath is derived from VS Code workspace
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — toolsetPath is validated by resolveToolsetRuntimePath
  return JSON.parse(fs.readFileSync(getOperationMetadataPath(toolsetPath), 'utf8'));
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — configPath is derived from VS Code workspace
  const localSettingsPath = options.localSettingsPath || resolveWorkspaceBasePath(getConfiguration().get('localSettingsPath')) || path.join(configPath, 'settings.json');
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
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal — os.tmpdir() returns a system temp directory
  const directoryPath = path.join(os.tmpdir(), 'bc-dev-toolset-mcp');
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename — directoryPath is derived from os.tmpdir()
  fs.mkdirSync(directoryPath, { recursive: true });
  const id = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${operationId}`;
  return {
    sessionId: id,
    transcriptPath: path.join(directoryPath, `${id}.transcript.txt`),
    resultPath: path.join(directoryPath, `${id}.result.json`)
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
        // eslint-disable-next-line security/detect-non-literal-fs-filename — capture.transcriptPath is derived from os.tmpdir()
        outputAvailable: fs.existsSync(capture.transcriptPath),
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
    outputAvailable: fs.existsSync(capture.transcriptPath),
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — capture.resultPath is derived from os.tmpdir()
  if (!fs.existsSync(capture.resultPath)) {
    return undefined;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename — capture.resultPath is derived from os.tmpdir()
  const result = JSON.parse(fs.readFileSync(capture.resultPath, 'utf8'));
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename — filePath is derived from os.tmpdir()
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
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

function getMcpExitCodeFromTerminalOutput(output) {
  const match = String(output).match(/__BCDEVTOOLSET_MCP_EXIT_CODE__\s+(-?\d+)/);
  return match ? Number(match[1]) : undefined;
}

function removeMcpExitCodeFromTerminalOutput(output) {
  return String(output)
    .replace(/\s*__BCDEVTOOLSET_MCP_EXIT_CODE__\s+-?\d+\s*/g, '\n')
    .trim();
}

function isSuccessfulOperationOutput(output) {
  const text = String(output || '');
  if (/(\bfailed\b|\berror\b|exception|timed out)/i.test(text)) {
    return false;
  }

  return /Running BC Dev Toolset operation:/i.test(text) &&
    /Operation ID:/i.test(text) &&
    /(!{4,}\s*DONE\s*!{4,}|Active license information|Current installed BcContainerHelper version|Docker Client Version)/i.test(text);
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

function waitForTerminalExecutionEnd(execution, timeoutMs) {
  return Promise.race([
    waitForTerminalExecutionEndEvent(execution),
    waitForTerminalExecutionExitCode(execution),
    new Promise((resolve) => setTimeout(() => resolve({ exitCode: null, timedOut: true }), timeoutMs))
  ]);
}

function waitForTerminalExecutionEndEvent(execution) {
  return new Promise((resolve) => {
    const subscription = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) {
        subscription.dispose();
        resolve({
          exitCode: typeof event.exitCode === 'number' ? event.exitCode : null,
          timedOut: false
        });
      }
    });
  });
}

async function waitForTerminalExecutionExitCode(execution) {
  try {
    const exitCode = await execution.exitCode;
    return {
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      timedOut: false
    };
  } catch (error) {
    return {
      exitCode: null,
      timedOut: false
    };
  }
}

function waitForTerminalReadToSettle(readPromise, timeoutMs) {
  return Promise.race([
    readPromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = {
  activate,
  deactivate
};
