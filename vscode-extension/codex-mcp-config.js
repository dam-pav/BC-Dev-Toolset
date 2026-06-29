'use strict';

const path = require('path');

const serverTableName = 'mcp_servers.bc-dev-toolset';
const environmentTableName = `${serverTableName}.env`;

function updateCodexMcpConfigContent(content, values) {
  const normalizedContent = content || '';
  const withoutExistingSection = removeCodexMcpConfigContent(normalizedContent).trimEnd();
  const section = [
    `[${serverTableName}]`,
    'command = "node"',
    `args = [${quoteTomlString(values.mcpServerPath)}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 7200',
    '',
    `[${environmentTableName}]`,
    `BCDEVTOOLSET_MCP_TOOLSET_PATH = ${quoteTomlString(values.toolsetPath)}`,
    ''
  ].join('\n');

  return `${withoutExistingSection}${withoutExistingSection ? '\n\n' : ''}${section}`;
}

function removeCodexMcpConfigContent(content) {
  return removeTomlTableSection(
    removeTomlTableSection(content || '', environmentTableName),
    serverTableName
  );
}

function removeTomlTableSection(content, tableName) {
  const lines = String(content || '').split(/\r?\n/);
  const result = [];
  const tableHeader = `[${tableName}]`;
  let skipping = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
      if (trimmedLine === tableHeader) {
        skipping = true;
        continue;
      }

      skipping = false;
    }

    if (!skipping) {
      result.push(line);
    }
  }

  return result.join('\n');
}

function quoteTomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function getCodexMcpConfiguredServerPath(content) {
  const table = getTomlTableContent(content, serverTableName);
  if (!table) {
    return '';
  }

  const argsMatch = table.match(/^\s*args\s*=\s*\[\s*("(?:\\.|[^"\\])*")/m);
  if (!argsMatch) {
    return '';
  }

  try {
    return JSON.parse(argsMatch[1]);
  } catch (error) {
    return '';
  }
}

function getTomlTableContent(content, tableName) {
  const lines = String(content || '').split(/\r?\n/);
  const tableHeader = `[${tableName}]`;
  const result = [];
  let collecting = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
      if (trimmedLine === tableHeader) {
        collecting = true;
        continue;
      }

      if (collecting) {
        break;
      }
    }

    if (collecting) {
      result.push(line);
    }
  }

  return collecting ? result.join('\n') : '';
}

function classifyCodexMcpConfiguration(content, expectedServerPath) {
  const configuredServerPath = getCodexMcpConfiguredServerPath(content);
  if (!configuredServerPath) {
    return {
      status: getTomlTableContent(content, serverTableName) ? 'invalid' : 'missing',
      configuredServerPath: ''
    };
  }

  if (arePathsEqual(configuredServerPath, expectedServerPath)) {
    return { status: 'current', configuredServerPath };
  }

  return {
    status: isRecognizedVersionedServerPath(configuredServerPath) ? 'stale' : 'custom',
    configuredServerPath
  };
}

function arePathsEqual(first, second) {
  if (!first || !second) {
    return false;
  }

  const normalize = (value) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(first) === normalize(second);
}

function isRecognizedVersionedServerPath(serverPath) {
  return /[\\/]dam-pav\.bc-dev-toolset-[^\\/]+[\\/]mcp-server\.js$/i.test(String(serverPath || ''));
}

function resolveCodexMcpIntegrationState(options) {
  if (options.explicitValue !== undefined) {
    return {
      enabled: options.explicitValue === true,
      persistSetting: false,
      completeMigration: !options.migrationCompleted
    };
  }

  if (!options.allowLegacyMigration || options.migrationCompleted) {
    return { enabled: false, persistSetting: false, completeMigration: false };
  }

  return {
    enabled: options.configurationStatus === 'current' || options.configurationStatus === 'stale',
    persistSetting: true,
    completeMigration: true
  };
}

module.exports = {
  classifyCodexMcpConfiguration,
  getCodexMcpConfiguredServerPath,
  isRecognizedVersionedServerPath,
  removeCodexMcpConfigContent,
  resolveCodexMcpIntegrationState,
  updateCodexMcpConfigContent
};
