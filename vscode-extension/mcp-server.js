#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-undef, no-constant-condition, no-control-regex */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const defaultProtocolVersion = '2025-11-25';
const toolsetPath = process.env.BCDEVTOOLSET_MCP_TOOLSET_PATH || path.resolve(__dirname, '..');
const operationsPath = joinTrustedPath(toolsetPath, 'operations', 'operations.json');
const bridgePath = joinTrustedPath(toolsetPath, 'Invoke-BcDevToolsetOperation.ps1');
const defaultWorkspacePath = process.env.BCDEVTOOLSET_MCP_WORKSPACE_PATH || process.cwd();
const defaultWorkspaceFile = process.env.BCDEVTOOLSET_MCP_WORKSPACE_FILE || '';
const defaultWorkspaceContext = parseJsonEnvironmentValue(process.env.BCDEVTOOLSET_MCP_WORKSPACE_CONTEXT);
const defaultLocalSettingsPath = process.env.BCDEVTOOLSET_MCP_LOCAL_SETTINGS_PATH || '';
const defaultPowerShellExecutable = process.env.BCDEVTOOLSET_MCP_POWERSHELL_EXECUTABLE || 'pwsh';
const bridgeStatePath = process.env.BCDEVTOOLSET_MCP_BRIDGE_STATE_PATH || joinTrustedPath(os.tmpdir(), 'bc-dev-toolset-mcp', 'vscode-bridge.json');
const bridgeState = readBridgeState();
const bridgeUrl = process.env.BCDEVTOOLSET_MCP_BRIDGE_URL || bridgeState.url || '';
const bridgeToken = process.env.BCDEVTOOLSET_MCP_BRIDGE_TOKEN || bridgeState.token || '';
const outputLimit = 60000;

let inputBuffer = Buffer.alloc(0);
let waitingForMessageLogged = false;
let transportMode = 'unknown';

function joinTrustedPath(basePath, ...segments) {
  if (!basePath || segments.some((segment) => !segment || path.isAbsolute(segment) || segment.split(/[\\/]+/).includes('..'))) {
    throw new Error(`Invalid path segment for base path '${basePath}'.`);
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  // eslint-disable-next-line -- paths are anchored to the configured toolset/runtime root.
  return path.join(basePath, ...segments);
}

function fileExists(filePath) {
  if (!filePath) {
    return false;
  }

  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- MCP server validates paths before running operations.
  return fs.existsSync(filePath);
}

function readTextFile(filePath) {
  // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line -- MCP server reads trusted toolset metadata and bridge state files.
  return fs.readFileSync(filePath, 'utf8');
}

function startServer() {
  log(`started pid=${process.pid} node=${process.execPath}`);
  log(`toolsetPath=${toolsetPath}`);
  log(`bridgeUrl=${bridgeUrl || '(none)'}`);
  log(`bridgeStatePath=${bridgeStatePath || '(none)'}`);

  process.stdin.on('data', (chunk) => {
    log(`stdin ${chunk.length} bytes`);
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    readBufferedMessages();
  });
}

function send(message) {
  const body = JSON.stringify(message);
  log(`response id=${Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : '(notification)'} mode=${transportMode} bytes=${Buffer.byteLength(body, 'utf8')}`);
  if (transportMode === 'raw-json') {
    process.stdout.write(`${body}\n`);
    return;
  }

  const bodyLength = Buffer.byteLength(body, 'utf8');
  process.stdout.write(`Content-Length: ${bodyLength}\r\n\r\n${body}`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function readBufferedMessages() {
  while (true) {
    if (inputBuffer.length === 0) {
      return;
    }

    const headerBoundary = findHeaderBoundary(inputBuffer);
    if (!headerBoundary) {
      if (tryReadRawJsonMessage()) {
        continue;
      }

      logWaitingForMessage('header-boundary-not-found');
      return;
    }

    const header = inputBuffer.slice(0, headerBoundary.index).toString('utf8');
    const contentLengthMatch = header.match(/content-length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      inputBuffer = inputBuffer.slice(headerBoundary.index + headerBoundary.length);
      sendError(null, -32600, 'Missing Content-Length header.');
      continue;
    }

    const bodyLength = Number(contentLengthMatch[1]);
    const messageStart = headerBoundary.index + headerBoundary.length;
    const messageEnd = messageStart + bodyLength;
    if (inputBuffer.length < messageEnd) {
      logWaitingForMessage(`body-incomplete headerBytes=${headerBoundary.index} boundaryBytes=${headerBoundary.length} bodyBytes=${bodyLength} bufferedBytes=${inputBuffer.length}`);
      return;
    }

    const body = inputBuffer.slice(messageStart, messageEnd).toString('utf8');
    inputBuffer = inputBuffer.slice(messageEnd);
    transportMode = 'framed';
    waitingForMessageLogged = false;
    void handleMessage(body);
  }
}

function tryReadRawJsonMessage() {
  const newlineIndex = inputBuffer.indexOf('\n');
  if (newlineIndex >= 0) {
    const text = inputBuffer
      .slice(0, newlineIndex)
      .toString('utf8')
      .trim();

    if (!text) {
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      return true;
    }

    if (!text.startsWith('{')) {
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      return transportMode === 'raw-json';
    }

    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    transportMode = 'raw-json';
    waitingForMessageLogged = false;
    void handleMessage(text);
    return true;
  }

  // Preserve compatibility with clients that send one JSON message without a delimiter.
  const firstNonWhitespaceByte = inputBuffer.find(
    (byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0d
  );
  if (firstNonWhitespaceByte !== 0x7b) {
    return false;
  }

  const text = inputBuffer.toString('utf8').trim();

  try {
    JSON.parse(text);
  } catch (error) {
    return false;
  }

  transportMode = 'raw-json';
  inputBuffer = Buffer.alloc(0);
  waitingForMessageLogged = false;
  void handleMessage(text);
  return true;
}

function findHeaderBoundary(buffer) {
  const crlfIndex = buffer.indexOf('\r\n\r\n');
  const lfIndex = buffer.indexOf('\n\n');

  if (crlfIndex < 0 && lfIndex < 0) {
    return undefined;
  }

  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex <= lfIndex)) {
    return { index: crlfIndex, length: 4 };
  }

  return { index: lfIndex, length: 2 };
}

async function handleMessage(body) {
  let message;
  try {
    message = JSON.parse(body);
  } catch (error) {
    log(`invalid-json ${error.message} bodyPreview=${formatPreview(body)}`);
    sendError(null, -32700, `Invalid JSON: ${error.message}`);
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
    log(`notification ${message.method || '(unknown)'}`);
    return;
  }

  log(`request ${message.method || '(unknown)'} id=${message.id}`);

  try {
    switch (message.method) {
      case 'initialize':
        sendResult(message.id, {
          protocolVersion: getProtocolVersion(message),
          capabilities: { tools: {}, resources: {} },
          instructions: getServerInstructions(),
          serverInfo: {
            name: 'bc-dev-toolset',
            version: process.env.BCDEVTOOLSET_MCP_EXTENSION_VERSION || '0.0.0'
          }
        });
        break;
      case 'tools/list':
        sendResult(message.id, { tools: getTools() });
        break;
      case 'tools/call':
        sendResult(message.id, await callTool(message.params || {}));
        break;
      case 'resources/list':
        sendResult(message.id, { resources: getResources() });
        break;
      case 'resources/read':
        sendResult(message.id, await readResource(message.params || {}));
        break;
      case 'resources/templates/list':
        sendResult(message.id, { resourceTemplates: [] });
        break;
      case 'prompts/list':
        sendResult(message.id, { prompts: [] });
        break;
      case 'ping':
        sendResult(message.id, {});
        break;
      default:
        sendError(message.id, -32601, `Unsupported method: ${message.method}`);
        break;
    }
  } catch (error) {
    sendError(message.id, -32603, error.message);
  }
}

function getServerInstructions() {
  return [
    'Use this server for Business Central Developer\'s Toolset operations. Prefer direct tools named bc_dev_toolset_* for matching user requests; do not inspect Docker containers or call BcContainerHelper directly to duplicate a supported toolset operation.',
    'Before answering questions about the active VS Code workspace, workspace file, workspace folders, AL project path, app.json location, .code-workspace settings, local .bcdevtoolset settings path, or AL settings such as assembly probing paths, call bc_dev_toolset_get_workspace or read bcdevtoolset://workspace/current. Do not infer the workspace by scanning parent folders unless this tool/resource is unavailable.',
    'PowerShell-backed operations require the VS Code terminal bridge and run visibly in the BC Dev Toolset terminal. If the bridge is unavailable, report that the BC Dev Toolset VS Code extension must be active instead of falling back to manual PowerShell.',
    'Use bc_dev_toolset_show_active_licenses for requests about the current container license. Use bc_dev_toolset_new_docker_container for creating or recreating containers.',
    'When an operation returns status "waiting_for_input", you MUST call bc_dev_toolset_answer_operation_prompt with the sessionId and the user\'s answer. Do not retry the original operation. Do not ask the user to type in the terminal. The answer is relayed through MCP to the running script.'
  ].join('\n');
}

function getProtocolVersion(message) {
  return message.params && message.params.protocolVersion
    ? message.params.protocolVersion
    : defaultProtocolVersion;
}

function getTools() {
  const tools = getOperationTools();
  tools.push(
    {
      name: 'bc_dev_toolset_get_workspace',
      description: 'Use this tool first whenever the user asks about the current workspace, active VS Code workspace file, workspace folders, AL project context, app.json location, .code-workspace settings, local .bcdevtoolset settings path, or AL settings such as assembly probing paths. Returns the active VS Code workspace context known to BC Dev Toolset. Do not guess by scanning folders before calling this.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'bc_dev_toolset_get_operation_status',
      description: 'Get status for a BC Dev Toolset MCP operation session, including pending prompts and captured completion output.',
      inputSchema: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID returned by an operation that is waiting for input.'
          }
        }
      }
    },
    {
      name: 'bc_dev_toolset_answer_operation_prompt',
      description: 'Answer a pending BC Dev Toolset operation prompt. Use only when a prior operation result or status says it is waiting for input.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'answer'],
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID returned by the waiting operation.'
          },
          answer: {
            type: 'string',
            description: 'Prompt answer. Use yes/no for confirmation prompts; use the requested text or choice value for other prompt types.'
          }
        }
      }
    }
  );
  if (shouldExposeGenericTools()) {
    tools.push(
      {
        name: 'list_bc_dev_toolset_operations',
        description: 'List BC Dev Toolset operation IDs. Use this only for diagnostics or when no direct bc_dev_toolset_* tool matches the request.',
        inputSchema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              description: 'Optional operation category filter.'
            }
          }
        }
      },
      {
        name: 'run_bc_dev_toolset_operation',
        description: 'Run a BC Dev Toolset operation by operationId. Prefer direct bc_dev_toolset_* tools for natural-language user requests.',
        inputSchema: {
          type: 'object',
          required: ['operationId'],
          properties: {
            operationId: {
              type: 'string',
              description: 'Operation ID from list_bc_dev_toolset_operations.'
            },
            workspacePath: {
              type: 'string',
              description: 'Optional workspace path. Defaults to the workspace that registered the MCP server.'
            },
            workspaceFile: {
              type: 'string',
              description: 'Optional .code-workspace file path.'
            },
            localSettingsPath: {
              type: 'string',
              description: 'Optional .bcdevtoolset/settings.json path.'
            },
            settingsPath: {
              type: 'string',
              description: 'Optional legacy settings path passed to the PowerShell bridge.'
            },
            powershellExecutable: {
              type: 'string',
              description: 'Optional PowerShell executable. Defaults to the extension setting.'
            },
            nonInteractive: {
              type: 'boolean',
              description: 'Run with BCDEVTOOLSET_NON_INTERACTIVE enabled. Defaults to true.'
            },
            confirm: {
              type: 'boolean',
              description: 'Required for operations marked as requiring confirmation.'
            },
            timeoutSeconds: {
              type: 'number',
              description: 'Maximum runtime in seconds. Defaults to 3600.'
            }
          }
        }
      }
    );
  }

  return tools;
}

function getLegacyTools() {
  return [
    {
      name: 'show_active_container_licenses',
      description: 'Show active Business Central container license information for the current workspace. Legacy alias for bc_dev_toolset_show_active_licenses.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: {
            type: 'string',
            description: 'Optional workspace path. Defaults to the workspace that registered the MCP server.'
          },
          workspaceFile: {
            type: 'string',
            description: 'Optional .code-workspace file path.'
          },
          localSettingsPath: {
            type: 'string',
            description: 'Optional .bcdevtoolset/settings.json path.'
          },
          timeoutSeconds: {
            type: 'number',
            description: 'Maximum runtime in seconds. Defaults to 3600.'
          }
        }
      }
    }
  ];
}

function getResources() {
  return [
    {
      uri: 'bcdevtoolset://workspace/current',
      name: 'Current BC Dev Toolset Workspace Context',
      description: 'Active VS Code workspace context known to BC Dev Toolset: workspace file, folders, active AL project, app.json, local settings path, and effective AL settings.',
      mimeType: 'application/json'
    }
  ];
}

async function readResource(params) {
  const uri = String(params.uri || '').trim();
  if (uri !== 'bcdevtoolset://workspace/current') {
    throw new Error(`Unknown resource: ${uri}`);
  }

  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(await getWorkspaceContextObject(), null, 2)
      }
    ]
  };
}

function shouldExposeGenericTools() {
  return process.env.BCDEVTOOLSET_MCP_EXPOSE_GENERIC_TOOLS === 'true';
}

function shouldExposeLegacyTools() {
  return process.env.BCDEVTOOLSET_MCP_EXPOSE_LEGACY_TOOLS === 'true';
}

async function callTool(params) {
  const toolArguments = params.arguments || {};
  const progress = createProgressReporter(params._meta && params._meta.progressToken);
  const operationId = getOperationIdForToolName(params.name);
  if (operationId) {
    return runOperation({
      ...toolArguments,
      operationId
    }, progress);
  }

  switch (params.name) {
    case 'bc_dev_toolset_get_workspace':
      return getWorkspaceContext();
    case 'bc_dev_toolset_get_operation_status':
      return getOperationStatus(toolArguments);
    case 'bc_dev_toolset_answer_operation_prompt':
      return answerOperationPrompt(toolArguments);
    case 'list_bc_dev_toolset_operations':
      return textResult(JSON.stringify(listRunnableOperations(toolArguments.category), null, 2));
    case 'run_bc_dev_toolset_operation':
      return runOperation(toolArguments, progress);
    case 'show_active_container_licenses':
      return runOperation({
        ...toolArguments,
        operationId: 'showActiveLicenses'
      }, progress);
    default:
      return textResult(`Unknown tool: ${params.name}`, true);
  }
}

async function getWorkspaceContext() {
  return textResult(JSON.stringify(await getWorkspaceContextObject(), null, 2));
}

async function getWorkspaceContextObject() {
  if (shouldUseTerminalBridge()) {
    const response = await postBridgeJson('/workspace-context', {});
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.body || {};
    }
  }

  return getFallbackWorkspaceContext();
}

function getFallbackWorkspaceContext() {
  if (defaultWorkspaceContext && typeof defaultWorkspaceContext === 'object') {
    return defaultWorkspaceContext;
  }

  const workspaceFilePath = defaultWorkspaceFile || '';
  const workspaceFolders = defaultWorkspacePath
    ? [{ name: path.basename(defaultWorkspacePath), path: defaultWorkspacePath }]
    : [];

  return {
    source: 'mcp-server-env',
    workspacePath: defaultWorkspacePath,
    workspaceFilePath,
    workspaceBasePath: '',
    localSettingsPath: defaultLocalSettingsPath,
    workspaceFolders,
    activeAlProjectPath: defaultWorkspacePath,
    appJsonPath: '',
    settings: {}
  };
}

function parseJsonEnvironmentValue(value) {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return undefined;
  }
}

function getOperationTools() {
  return loadOperations()
    .filter((operation) => operation.script)
    .map((operation) => ({
      name: getOperationToolName(operation),
      description: getOperationToolDescription(operation),
      inputSchema: getOperationToolInputSchema(operation)
    }));
}

function getOperationToolName(operation) {
  return `bc_dev_toolset_${toSnakeCase(operation.id)}`;
}

function getOperationIdForToolName(toolName) {
  const operation = loadOperations()
    .filter((candidate) => candidate.script)
    .find((candidate) => getOperationToolName(candidate) === toolName);
  return operation ? operation.id : '';
}

function toSnakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function getOperationToolDescription(operation) {
  const aliases = getOperationToolAliases(operation.id);
  const aliasText = aliases.length > 0
    ? ` Use this when the user asks to ${aliases.join(', ')}.`
    : '';
  const confirmationText = operation.requiresConfirmation
    ? ' This operation changes state and requires confirm: true.'
    : '';
  return `BC Dev Toolset: ${operation.title}. Category: ${operation.category}.${aliasText}${confirmationText}`;
}

function getOperationToolAliases(operationId) {
  switch (operationId) {
    case 'showActiveLicenses':
      return [
        'show the license from the current container',
        'show active container license details',
        'inspect the active Business Central container license',
        'display current BC license information'
      ];
    case 'updateBcLicenseContainer':
      return [
        'update or import the license file into containers',
        'apply a BC license to configured containers'
      ];
    case 'showBcContainerHelperVersions':
      return [
        'show installed and available BcContainerHelper versions',
        'check BcContainerHelper version'
      ];
    case 'newDockerContainer':
      return [
        'create or recreate the development container',
        'create a Business Central Docker container'
      ];
    case 'invokeTests':
      return [
        'run automated tests in configured containers',
        'run Business Central tests'
      ];
    case 'invokePageScriptTests':
      return [
        'run page scripting tests',
        'run BC page script recordings'
      ];
    default:
      return [];
  }
}

function getOperationToolInputSchema(operation) {
  const properties = {
    workspacePath: {
      type: 'string',
      description: 'Optional workspace path. Defaults to the workspace that registered the MCP server.'
    },
    workspaceFile: {
      type: 'string',
      description: 'Optional .code-workspace file path.'
    },
    localSettingsPath: {
      type: 'string',
      description: 'Optional .bcdevtoolset/settings.json path.'
    },
    timeoutSeconds: {
      type: 'number',
      description: getOperationTimeoutDescription(operation)
    }
  };

  if (operation.requiresConfirmation) {
    properties.confirm = {
      type: 'boolean',
      description: 'Required. Set to true to confirm this state-changing operation.'
    };
  }

  return {
    type: 'object',
    properties
  };
}

function getOperationTimeoutDescription(operation) {
  if (operation.id === 'newDockerContainer') {
    return 'Maximum runtime in seconds. Container creation can download artifacts and run for a long time; values below 7200 are raised to 7200.';
  }

  if (operation.id === 'initPrerequisites' || operation.id === 'updatePowerShell') {
    return 'Maximum runtime in seconds. This operation can run for a long time; values below 3600 are raised to 3600.';
  }

  return 'Maximum runtime in seconds. Defaults to 3600.';
}

function loadOperations() {
  if (!fileExists(operationsPath)) {
    throw new Error(`BC Dev Toolset operation metadata was not found at ${operationsPath}.`);
  }

  return JSON.parse(readTextFile(operationsPath));
}

function listRunnableOperations(category) {
  return loadOperations()
    .filter((operation) => operation.script)
    .filter((operation) => !category || operation.category === category)
    .map((operation) => ({
      id: operation.id,
      title: operation.title,
      category: operation.category,
      requiresConfirmation: Boolean(operation.requiresConfirmation),
      runTool: 'run_bc_dev_toolset_operation',
      runArguments: {
        operationId: operation.id
      }
    }));
}

async function runOperation(args, progress) {
  const operationId = String(args.operationId || '').trim();
  if (!operationId) {
    return textResult('operationId is required.', true);
  }

  const operation = loadOperations().find((candidate) => candidate.id === operationId);
  if (!operation) {
    return textResult(`BC Dev Toolset operation '${operationId}' was not found.`, true);
  }

  if (!operation.script) {
    return textResult(`BC Dev Toolset operation '${operationId}' is handled by the VS Code extension UI and is not available through MCP.`, true);
  }

  if (operation.requiresConfirmation && args.confirm !== true) {
    return textResult(`BC Dev Toolset operation '${operationId}' requires confirmation. Call again with confirm: true to run it.`, true);
  }

  if (!fileExists(bridgePath)) {
    return textResult(`BC Dev Toolset operation bridge was not found at ${bridgePath}.`, true);
  }

  const workspacePath = String(args.workspacePath || defaultWorkspacePath || '').trim();
  if (!fileExists(workspacePath)) {
    return textResult(`Workspace path not found: ${workspacePath}`, true);
  }

  if (!shouldUseTerminalBridge()) {
    return textResult(
      `BC Dev Toolset operation '${operation.id}' requires the VS Code terminal bridge, but the bridge is not available. Restart the extension host and check 'BC Dev Toolset: Show MCP Status'.`,
      true
    );
  }

  return runOperationInTerminal(operation, args, progress);
}

async function runOperationInTerminal(operation, args, progress) {
  progress.report(`Starting BC Dev Toolset operation in VS Code terminal: ${operation.title}`, true);
  const response = await postBridgeJson('/run-operation', {
    operationId: operation.id,
    workspacePath: args.workspacePath,
    workspaceFile: args.workspaceFile,
    localSettingsPath: args.localSettingsPath,
    timeoutSeconds: getTerminalTimeoutSeconds(operation, args)
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return textResult(`Failed to start BC Dev Toolset operation '${operation.id}' in the VS Code terminal: ${response.body.error || response.rawBody}`, true);
  }

  const bridgeResult = response.body || {};
  const completed = bridgeResult.status === 'completed';
  const startedOnly = bridgeResult.status === 'started';
  const waitingForInput = bridgeResult.status === 'waiting_for_input';
  return textResult([
    `Operation: ${operation.title}`,
    `Operation ID: ${operation.id}`,
    `Status: ${bridgeResult.status || 'unknown'}`,
    bridgeResult.sessionId ? `Session ID: ${bridgeResult.sessionId}` : '',
    typeof bridgeResult.exitCode === 'number' ? `Exit code: ${bridgeResult.exitCode}` : '',
    bridgeResult.exitCodeSource ? `Exit code source: ${bridgeResult.exitCodeSource}` : '',
    `Terminal: ${bridgeResult.terminalName || 'BC Dev Toolset PowerShell terminal'}`,
    waitingForInput
      ? formatPendingPromptInstruction(bridgeResult)
      : startedOnly
      ? 'Instruction: The operation is running visibly in the VS Code terminal. Terminal output capture was unavailable, so watch that terminal for progress and final output.'
      : 'Instruction: The operation ran visibly in the VS Code terminal. Use the captured terminal output below as the MCP result.',
    bridgeResult.output ? ['', 'TERMINAL OUTPUT:', truncateOutput(bridgeResult.output)].join('\n') : ''
  ].filter((line) => line !== '').join('\n'), !completed && !startedOnly && !waitingForInput);
}

async function getOperationStatus(args) {
  if (!shouldUseTerminalBridge()) {
    return textResult('BC Dev Toolset MCP operation status requires the VS Code terminal bridge.', true);
  }

  const sessionId = String(args.sessionId || '').trim();
  if (!sessionId) {
    return textResult('sessionId is required.', true);
  }

  const response = await postBridgeJson('/operation-status', { sessionId });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return textResult(`Failed to get BC Dev Toolset operation status: ${response.body.error || response.rawBody}`, true);
  }

  return textResult(formatOperationStatus(response.body || {}), response.body && response.body.status === 'failed');
}

async function answerOperationPrompt(args) {
  if (!shouldUseTerminalBridge()) {
    return textResult('BC Dev Toolset MCP prompt answers require the VS Code terminal bridge.', true);
  }

  const sessionId = String(args.sessionId || '').trim();
  const answer = String(args.answer || '').trim();
  if (!sessionId) {
    return textResult('sessionId is required.', true);
  }
  if (!answer) {
    return textResult('answer is required.', true);
  }

  const response = await postBridgeJson('/prompt/answer', { sessionId, answer });
  if (response.statusCode < 200 || response.statusCode >= 300 || response.body.status === 'failed') {
    return textResult(`Failed to answer BC Dev Toolset prompt: ${response.body.error || response.rawBody}`, true);
  }

  return textResult([
    `Status: ${response.body.status}`,
    `Session ID: ${response.body.sessionId}`,
    `Answer: ${response.body.answer}`,
    'Instruction: The operation has resumed in the visible VS Code terminal. Call bc_dev_toolset_get_operation_status with this session ID to check completion and captured output.'
  ].join('\n'));
}

function formatPendingPromptInstruction(bridgeResult) {
  const prompt = bridgeResult.prompt || {};
  const answerHint = prompt.type === 'confirm'
    ? "answer 'yes' or 'no'"
    : 'answer with the requested text or choice value';
  const lines = [
    'Instruction: The operation is waiting for input and remains paused in the visible VS Code terminal.',
    `Prompt ID: ${prompt.id || '(unknown)'}`,
    prompt.question ? `Question: ${prompt.question}` : '',
    prompt.default ? `Default: ${prompt.default}` : '',
    Array.isArray(prompt.choices) ? `Choices: ${prompt.choices.join(', ')}` : '',
    prompt.risk ? `Risk: ${prompt.risk}` : '',
    prompt.agentAllowed === false ? 'Agent autonomous decision allowed: false. Ask the user before answering this prompt.' : 'Agent autonomous decision allowed: true.',
    prompt.destructive ? 'Destructive: true' : '',
    prompt.sensitive ? 'Sensitive: true. Do not answer sensitive prompts through MCP.' : ''
  ];

  if (prompt.sensitive) {
    lines.push('Next: Ask the user to type their answer directly in the VS Code terminal. Do not call answer_operation_prompt for sensitive prompts.');
  } else {
    lines.push(`Next: Call bc_dev_toolset_answer_operation_prompt with sessionId '${bridgeResult.sessionId}' and ${answerHint}.`);
  }

  return lines.filter((line) => line !== '').join('\n');
}

function formatOperationStatus(status) {
  const result = status.result || {};
  const prompt = status.prompt || {};
  return [
    `Status: ${status.status || 'unknown'}`,
    `Session ID: ${status.sessionId || ''}`,
    status.operationId ? `Operation ID: ${status.operationId}` : '',
    status.operationTitle ? `Operation: ${status.operationTitle}` : '',
    status.terminalName ? `Terminal: ${status.terminalName}` : '',
    status.status === 'waiting_for_input' ? formatPendingPromptInstruction(status) : '',
    result.exitCodeSource ? `Exit code source: ${result.exitCodeSource}` : '',
    typeof result.exitCode === 'number' ? `Exit code: ${result.exitCode}` : '',
    result.output ? ['', 'TERMINAL OUTPUT:', truncateOutput(result.output)].join('\n') : '',
    status.status === 'running' && prompt.id ? `Last prompt: ${prompt.id}` : ''
  ].filter((line) => line !== '').join('\n');
}

function getTerminalTimeoutSeconds(operation, args) {
  const requestedTimeoutSeconds = Number(args.timeoutSeconds);
  const defaultTimeoutSeconds = 3600;
  const minimumTimeoutSeconds = getMinimumTerminalTimeoutSeconds(operation.id);

  if (!Number.isFinite(requestedTimeoutSeconds) || requestedTimeoutSeconds <= 0) {
    return Math.max(defaultTimeoutSeconds, minimumTimeoutSeconds);
  }

  return Math.max(requestedTimeoutSeconds, minimumTimeoutSeconds);
}

function getMinimumTerminalTimeoutSeconds(operationId) {
  switch (operationId) {
    case 'newDockerContainer':
      return 7200;
    case 'initPrerequisites':
    case 'updatePowerShell':
      return 3600;
    default:
      return 0;
  }
}

function shouldUseTerminalBridge() {
  return Boolean(bridgeUrl && bridgeToken);
}

function postBridgeJson(route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, bridgeUrl);
    const content = JSON.stringify(body || {});
    const request = http.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(content)
      }
    }, (response) => {
      let rawBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        rawBody += chunk;
      });
      response.on('end', () => {
        let parsedBody = {};
        try {
          parsedBody = rawBody ? JSON.parse(rawBody) : {};
        } catch (error) {
          parsedBody = {};
        }

        resolve({
          statusCode: response.statusCode || 0,
          body: parsedBody,
          rawBody
        });
      });
    });

    request.on('error', reject);
    request.write(content);
    request.end();
  });
}

function readBridgeState() {
  if (!fileExists(bridgeStatePath)) {
    return {};
  }

  try {
    return JSON.parse(readTextFile(bridgeStatePath));
  } catch (error) {
    return {};
  }
}

function truncateOutput(output) {
  if (output.length <= outputLimit) {
    return output;
  }

  return `${output.slice(0, outputLimit)}\n\n[Output truncated to ${outputLimit} characters.]`;
}

function textResult(text, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text
      }
    ],
    isError
  };
}

function createProgressReporter(progressToken) {
  let progress = 0;
  return {
    report(message, force = false) {
      if (!progressToken) {
        return;
      }

      const cleanedMessage = cleanProgressMessage(message);
      if (!cleanedMessage) {
        return;
      }

      progress += force ? 10 : 1;
      sendNotification('notifications/progress', {
        progressToken,
        progress,
        message: cleanedMessage
      });
    }
  };
}

function cleanProgressMessage(message) {
  return stripAnsi(String(message || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function stripAnsi(value) {
  return String(value).replace(new RegExp('\\u001b\\[[0-9;]*m', 'g'), '');
}

function log(message) {
  process.stderr.write(`[bc-dev-toolset-mcp] ${message}\n`);
}

function logWaitingForMessage(reason) {
  if (waitingForMessageLogged) {
    return;
  }

  waitingForMessageLogged = true;
  log(`waiting ${reason} bufferedBytes=${inputBuffer.length} preview=${formatPreview(inputBuffer.toString('utf8', 0, Math.min(inputBuffer.length, 200)))}`);
}

function formatPreview(value) {
  return JSON.stringify(String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
}

if (require.main === module) {
  startServer();
}

module.exports = {
  __test: {
    getInputBuffer: () => inputBuffer,
    resetState: () => {
      inputBuffer = Buffer.alloc(0);
      waitingForMessageLogged = false;
      transportMode = 'unknown';
    },
    setInputBuffer: (value) => {
      inputBuffer = Buffer.from(value, 'utf8');
    },
    tryReadRawJsonMessage
  }
};
