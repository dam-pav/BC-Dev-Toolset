'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const http = require('node:http');
const readline = require('node:readline');
const path = require('node:path');
const { toolDefaults, resolveToolSettings, readEffectiveToolSettings, mergeToolSelection } = require('../mcp-tool-settings');
const { updateCodexMcpConfigContent } = require('../codex-mcp-config');
const { __test: server } = require('../mcp-server');

function request(settings, method, params) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../mcp-server.js')], {
    env: { ...process.env, BCDEVTOOLSET_MCP_TOOL_SETTINGS: JSON.stringify(settings) },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n',
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).result;
}

test('every tool has exactly one user switch and only the requested four default on', () => {
  assert.deepEqual(Object.keys(toolDefaults).sort(), server.getAllTools().map(tool => tool.name).sort());
  assert.deepEqual(Object.keys(toolDefaults).filter(name => toolDefaults[name]).sort(), [
    'bc_dev_toolset_answer_operation_prompt', 'bc_dev_toolset_get_operation_status',
    'bc_dev_toolset_get_workspace', 'bc_dev_toolset_invoke_tests'
  ]);
  const groups = require('../package.json').contributes.configuration;
  const properties = groups[0].properties.bcDevToolset.properties.mcpTools.properties;
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(toolDefaults).sort());
  assert.ok(!groups.some(group => Object.keys(group.properties).some(key => key.startsWith('bcDevToolset.mcp.tools.'))));
});

test('protocol discovery uses defaults, explicit off, and individual opt-in including aliases', () => {
  assert.deepEqual(request({}, 'tools/list').tools.map(tool => tool.name).sort(), [
    'bc_dev_toolset_answer_operation_prompt', 'bc_dev_toolset_get_operation_status',
    'bc_dev_toolset_get_workspace', 'bc_dev_toolset_invoke_tests'
  ]);
  const settings = Object.fromEntries(Object.keys(toolDefaults).map(name => [name, false]));
  assert.deepEqual(request(settings, 'tools/list').tools, []);
  settings.show_active_container_licenses = true;
  assert.deepEqual(request(settings, 'tools/list').tools.map(tool => tool.name), ['show_active_container_licenses']);
});

test('disabled tools and generic bypasses are rejected before execution', () => {
  const disabled = request({}, 'tools/call', { name: 'bc_dev_toolset_show_help' });
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /disabled/);
  const bypass = request({ run_bc_dev_toolset_operation: true }, 'tools/call', {
    name: 'run_bc_dev_toolset_operation', arguments: { operationId: 'showHelp' }
  });
  assert.equal(bypass.isError, true);
  const enabled = request({ bc_dev_toolset_show_help: true }, 'tools/call', { name: 'bc_dev_toolset_show_help' });
  assert.equal(enabled.isError, false);
});

test('selection is captured at process startup', () => {
  const before = server.getToolsForList();
  const previous = process.env.BCDEVTOOLSET_MCP_TOOL_SETTINGS;
  try {
    process.env.BCDEVTOOLSET_MCP_TOOL_SETTINGS = JSON.stringify({ bc_dev_toolset_get_workspace: false });
    assert.deepEqual(server.getToolsForList(), before);
  } finally {
    if (previous === undefined) delete process.env.BCDEVTOOLSET_MCP_TOOL_SETTINGS;
    else process.env.BCDEVTOOLSET_MCP_TOOL_SETTINGS = previous;
  }
});

test('effective workspace values override user values including explicit false', () => {
  const user = { bc_dev_toolset_get_workspace: true, bc_dev_toolset_show_help: true };
  const workspace = { bc_dev_toolset_get_workspace: false, bc_dev_toolset_build_all_apps: true };
  const settings = readEffectiveToolSettings({ inspect: key => {
    const name = key.replace('mcpTools.', '');
    return { workspaceValue: workspace[name], globalValue: user[name] };
  } });
  assert.equal(settings.bc_dev_toolset_get_workspace, false);
  assert.equal(settings.bc_dev_toolset_show_help, true);
  assert.equal(settings.bc_dev_toolset_build_all_apps, true);
  assert.equal(settings.bc_dev_toolset_new_docker_container, false);
  assert.deepEqual(resolveToolSettings(null), toolDefaults);
});

test('managed Codex config reads workspace settings from the bridge without storing one workspace selection globally', () => {
  const config = updateCodexMcpConfigContent('', {
    mcpServerPath: 'server.js', toolsetPath: '.', bridgeStateDirectory: '.',
    toolSettings: { bc_dev_toolset_show_help: true }
  });
  assert.match(config, /BCDEVTOOLSET_MCP_TOOL_SETTINGS_SOURCE = "bridge"/);
  assert.doesNotMatch(config, /BCDEVTOOLSET_MCP_TOOL_SETTINGS =/);
});

test('picker saves changed switches inside mcpTools and preserves unrelated values', () => {
  const before = resolveToolSettings();
  const existing = { selectArtifact: 'Latest', configurations: [{ name: 'Local' }], mcpTools: { future_tool: true } };
  const selected = Object.keys(before).filter(name => before[name]);
  selected.push('bc_dev_toolset_create_runtime_package');
  const result = mergeToolSelection(existing, before, selected);
  assert.deepEqual(result, { ...existing, mcpTools: { future_tool: true, bc_dev_toolset_create_runtime_package: true } });
  assert.deepEqual(existing.mcpTools, { future_tool: true });
  assert.equal(mergeToolSelection(existing, before, Object.keys(before).filter(name => before[name])), undefined);
});

test('dotted development tool keys are ignored', () => {
  const settings = readEffectiveToolSettings({ inspect: key => key.startsWith('mcp.tools.')
    ? { workspaceValue: true } : undefined });
  assert.deepEqual(settings, toolDefaults);
});

async function workspaceBridge(t, overrides) {
  const identity = {
    protocolVersion: 2, instanceId: require('node:crypto').randomUUID(),
    extensionHostPid: process.pid, workspace: { workspacePath: process.cwd() }
  };
  const token = 'test-workspace-bridge-token-1234567890';
  let settings = resolveToolSettings(overrides);
  let reads = 0;
  let mismatch = false;
  const bridge = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const binding = JSON.parse(body).binding;
    if (req.headers.authorization !== `Bearer ${token}` || binding.instanceId !== identity.instanceId) {
      res.writeHead(401).end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/handshake') {
      res.end(JSON.stringify({ ...identity, instanceId: mismatch ? 'wrong-window' : identity.instanceId }));
    } else if (req.url === '/tool-settings') {
      reads++;
      res.end(JSON.stringify({ toolSettings: settings }));
    } else res.writeHead(404).end('{}');
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => bridge.close());
  return {
    setSettings(value) { settings = value; },
    mismatch() { mismatch = true; },
    get reads() { return reads; },
    start() {
      const child = spawn(process.execPath, [path.join(__dirname, '../mcp-server.js')], {
        windowsHide: true,
        env: {
          ...process.env,
          BCDEVTOOLSET_MCP_TOOL_SETTINGS_SOURCE: 'bridge',
          BCDEVTOOLSET_MCP_TOOL_SETTINGS: JSON.stringify({ bc_dev_toolset_show_help: true }),
          BCDEVTOOLSET_MCP_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`,
          BCDEVTOOLSET_MCP_BRIDGE_TOKEN: token,
          BCDEVTOOLSET_MCP_BRIDGE_INSTANCE_ID: identity.instanceId,
          BCDEVTOOLSET_MCP_BRIDGE_PROTOCOL_VERSION: '2',
          BCDEVTOOLSET_MCP_EXTENSION_HOST_PID: String(process.pid),
          BCDEVTOOLSET_MCP_WORKSPACE_CONTEXT: JSON.stringify(identity.workspace)
        }
      });
      child.stderr.resume();
      const pending = new Map();
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      });
      t.after(() => { lines.close(); child.kill(); });
      let id = 0;
      return (method, params) => new Promise(resolve => {
        pending.set(++id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
  };
}

test('each workspace snapshots its own bridge selection and changes require a new process', { timeout: 10000 }, async t => {
  const first = await workspaceBridge(t, { bc_dev_toolset_show_help: true });
  const second = await workspaceBridge(t, { bc_dev_toolset_get_workspace: false });
  const a = first.start(), b = second.start();
  const [one, two] = await Promise.all([a('tools/list'), b('tools/list')]);
  assert.ok(one.result.tools.some(tool => tool.name === 'bc_dev_toolset_show_help'));
  assert.ok(!two.result.tools.some(tool => tool.name === 'bc_dev_toolset_show_help'));
  assert.ok(!two.result.tools.some(tool => tool.name === 'bc_dev_toolset_get_workspace'));
  first.setSettings(resolveToolSettings({ bc_dev_toolset_show_help: false }));
  assert.deepEqual((await a('tools/list')).result, one.result);
  assert.equal(first.reads, 1);
  assert.ok(!(await first.start()('tools/list')).result.tools.some(tool => tool.name === 'bc_dev_toolset_show_help'));
});

test('incomplete bridge settings fail closed for discovery and calls', { timeout: 10000 }, async t => {
  const bridge = await workspaceBridge(t, {});
  bridge.setSettings({});
  const request = bridge.start();
  assert.match((await request('initialize')).error.message, /complete MCP tool settings/);
  assert.ok((await request('tools/list')).error);
  assert.ok((await request('tools/call', { name: 'bc_dev_toolset_show_help' })).error);
  assert.equal(bridge.reads, 1);
});

test('workspace selection rejects a mismatched bridge before reading settings', { timeout: 10000 }, async t => {
  const bridge = await workspaceBridge(t, {});
  bridge.mismatch();
  assert.match((await bridge.start()('tools/list')).error.message, /handshake mismatch/);
  assert.equal(bridge.reads, 0);
});
