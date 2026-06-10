#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const http = require('http');
const os = require('os');

const defaultProtocolVersion = '2025-11-25';
const toolsetPath = process.env.BCDEVTOOLSET_MCP_TOOLSET_PATH || path.resolve(__dirname, '..');
const operationsPath = path.join(toolsetPath, 'operations', 'operations.json');
const bridgePath = path.join(toolsetPath, 'Invoke-BcDevToolsetOperation.ps1');
const defaultWorkspacePath = process.env.BCDEVTOOLSET_MCP_WORKSPACE_PATH || process.cwd();
const defaultWorkspaceFile = process.env.BCDEVTOOLSET_MCP_WORKSPACE_FILE || '';
const defaultLocalSettingsPath = process.env.BCDEVTOOLSET_MCP_LOCAL_SETTINGS_PATH || '';
const defaultPowerShellExecutable = process.env.BCDEVTOOLSET_MCP_POWERSHELL_EXECUTABLE || 'pwsh';
const bridgeStatePath = process.env.BCDEVTOOLSET_MCP_BRIDGE_STATE_PATH || path.join(os.tmpdir(), 'bc-dev-toolset-mcp', 'vscode-bridge.json');
const bridgeState = readBridgeState();
const bridgeUrl = process.env.BCDEVTOOLSET_MCP_BRIDGE_URL || bridgeState.url || '';
const bridgeToken = process.env.BCDEVTOOLSET_MCP_BRIDGE_TOKEN || bridgeState.token || '';
const outputLimit = 60000;

let inputBuffer = Buffer.alloc(0);
let waitingForMessageLogged = false;
let transportMode = 'unknown';

log(`started pid=${process.pid} node=${process.execPath}`);
log(`toolsetPath=${toolsetPath}`);
log(`bridgeUrl=${bridgeUrl || '(none)'}`);
log(`bridgeStatePath=${bridgeStatePath || '(none)'}`);

process.stdin.on('data', (chunk) => {
  log(`stdin ${chunk.length} bytes`);
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  readBufferedMessages();
});

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
  const text = inputBuffer.toString('utf8').trim();
  if (!text.startsWith('{')) {
    return false;
  }

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
          capabilities: { tools: {} },
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
        sendResult(message.id, { resources: [] });
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
    'PowerShell-backed operations require the VS Code terminal bridge and run visibly in the BC Dev Toolset terminal. If the bridge is unavailable, report that the BC Dev Toolset VS Code extension must be active instead of falling back to manual PowerShell.',
    'Use bc_dev_toolset_show_active_licenses for requests about the current container license. Use bc_dev_toolset_new_docker_container for creating or recreating containers.'
  ].join('\n');
}

function getProtocolVersion(message) {
  return message.params && message.params.protocolVersion
    ? message.params.protocolVersion
    : defaultProtocolVersion;
}

function getTools() {
  const tools = getOperationTools();
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

function shouldExposeGenericTools() {
  return process.env.BCDEVTOOLSET_MCP_EXPOSE_GENERIC_TOOLS === 'true';
}

function shouldExposeLegacyTools() {
  return process.env.BCDEVTOOLSET_MCP_EXPOSE_LEGACY_TOOLS === 'true';
}

function getAllTools() {
  const tools = getTools();
  if (shouldExposeLegacyTools()) {
    tools.push(...getLegacyTools());
  }

  return tools;
}

function getToolsForList() {
  return getAllTools();
}

function getToolByName(toolName) {
  return getAllTools().find((tool) => tool.name === toolName);
}

function getGenericToolsForDocumentation() {
  return [
    {
      name: 'list_bc_dev_toolset_operations',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Optional operation category filter.'
          }
        }
      }
    }
  ];
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
  if (!fs.existsSync(operationsPath)) {
    throw new Error(`BC Dev Toolset operation metadata was not found at ${operationsPath}.`);
  }

  return JSON.parse(fs.readFileSync(operationsPath, 'utf8'));
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

  if (!fs.existsSync(bridgePath)) {
    return textResult(`BC Dev Toolset operation bridge was not found at ${bridgePath}.`, true);
  }

  const workspacePath = String(args.workspacePath || defaultWorkspacePath || '').trim();
  if (!workspacePath || !fs.existsSync(workspacePath)) {
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
  return textResult([
    `Operation: ${operation.title}`,
    `Operation ID: ${operation.id}`,
    `Status: ${bridgeResult.status || 'unknown'}`,
    typeof bridgeResult.exitCode === 'number' ? `Exit code: ${bridgeResult.exitCode}` : '',
    bridgeResult.exitCodeSource ? `Exit code source: ${bridgeResult.exitCodeSource}` : '',
    `Terminal: ${bridgeResult.terminalName || 'BC Dev Toolset PowerShell terminal'}`,
    startedOnly
      ? 'Instruction: The operation is running visibly in the VS Code terminal. Terminal output capture was unavailable, so watch that terminal for progress and final output.'
      : 'Instruction: The operation ran visibly in the VS Code terminal. Use the captured terminal output below as the MCP result.',
    bridgeResult.output ? ['', 'TERMINAL OUTPUT:', truncateOutput(bridgeResult.output)].join('\n') : ''
  ].filter((line) => line !== '').join('\n'), !completed && !startedOnly);
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
  if (!bridgeStatePath || !fs.existsSync(bridgeStatePath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(bridgeStatePath, 'utf8'));
  } catch (error) {
    return {};
  }
}

function addOptionalArgument(args, name, value) {
  if (value && String(value).trim()) {
    args.push(name, String(value));
  }
}

function runProcess(command, args, cwd, timeoutSeconds, progress) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        BCDEVTOOLSET_SHORTCUTS: process.env.BCDEVTOOLSET_SHORTCUTS || 'None',
        BCDEVTOOLSET_HOST_HELPER_FOLDER: process.env.BCDEVTOOLSET_HOST_HELPER_FOLDER || 'C:\\ProgramData\\BcContainerHelper'
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const outputProgress = createOutputProgressEmitter(progress);
    const timeout = timeoutSeconds > 0
      ? setTimeout(() => {
          timedOut = true;
          progress.report(`Timeout reached after ${timeoutSeconds} seconds. Stopping operation.`, true);
          child.kill();
        }, timeoutSeconds * 1000)
      : undefined;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      outputProgress(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      outputProgress(text);
    });
    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function formatProcessResult(operation, result) {
  const succeeded = result.exitCode === 0 && !result.timedOut;
  const parts = [
    `Operation: ${operation.title}`,
    `Operation ID: ${operation.id}`,
    `Status: ${succeeded ? 'completed' : 'failed'}`,
    `Exit code: ${result.exitCode}`,
    succeeded
      ? 'Instruction: Treat this MCP tool result as authoritative. Do not rerun the same BC Dev Toolset operation through PowerShell unless the user explicitly asks for a manual fallback.'
      : 'Instruction: Report this MCP tool failure to the user. Do not try an unrelated BcContainerHelper or PowerShell workaround unless the user explicitly asks for a manual fallback.'
  ];

  if (result.timedOut) {
    parts.push('Timed out: true');
  }

  if (result.stdout.trim()) {
    parts.push('', 'STDOUT:', result.stdout.trim());
  }

  if (result.stderr.trim()) {
    parts.push('', 'STDERR:', result.stderr.trim());
  }

  return parts.join('\n');
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

function createOutputProgressEmitter(progress) {
  let buffer = '';
  let lastMessage = '';
  let lastEmittedAt = 0;

  return (text) => {
    buffer += stripAnsi(text).replace(/\r/g, '\n');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const message = cleanProgressMessage(line);
      if (!message || message === lastMessage) {
        continue;
      }

      const now = Date.now();
      if (now - lastEmittedAt < 1500 && !isImportantProgressMessage(message)) {
        continue;
      }

      lastMessage = message;
      lastEmittedAt = now;
      progress.report(message);
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
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function isImportantProgressMessage(message) {
  return /download|artifact|extract|creating|running|importing|publishing|installing|updating|waiting|container|license|docker|version|done|error|failed/i.test(message);
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
