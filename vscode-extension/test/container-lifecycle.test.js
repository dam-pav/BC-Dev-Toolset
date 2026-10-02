'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { __test: server } = require('../mcp-server');
const { toolDefaults } = require('../mcp-tool-settings');

const lifecyclePath = path.resolve(__dirname, '../../common/ContainerLifecycle.ps1');
function run(script) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    . '${lifecyclePath.replaceAll("'", "''")}'
    $script:calls = @()
    $script:states = @{}
    function Invoke-ConfiguredContainerDocker {
      param([string[]] $DockerArguments)
      $script:calls += ,$DockerArguments
      if ($DockerArguments[0] -eq 'info') { return 'windows' }
      $name = $DockerArguments[-1]
      if (-not $script:states.ContainsKey($name)) { throw 'No such container' }
      if ($DockerArguments[1] -in @('start', 'restart')) {
        $script:states[$name] = @{Status='running';Health=@{Status='healthy'}}
        return $name
      }
      @{Name="/$name";State=$script:states[$name]} | ConvertTo-Json -Depth 5 -Compress
    }
    ${script}
  `], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('starts stopped containers, restarts unhealthy containers once, and leaves healthy containers alone', () => {
  const calls = run(`
    $script:states = @{
      stopped=@{Status='exited'}; created=@{Status='created'};
      sick=@{Status='running';Health=@{Status='unhealthy'}};
      ready=@{Status='running';Health=@{Status='healthy'}}; plain=@{Status='running'}
    }
    $settings = @{configurations=@(
      @{serverType='Container';container='stopped'}, @{serverType='Container';container='stopped'},
      @{serverType='Container';container='created'}, @{serverType='Container';container='sick'},
      @{serverType='Container';container='ready'}, @{serverType='Container';container='plain'},
      @{serverType='OnPrem';container='unrelated'}, @{serverType='Cloud';container='unrelated'}
    )}
    Ensure-ConfiguredContainers $settings 6>$null
    ConvertTo-Json -InputObject $script:calls -Depth 5 -Compress
  `);
  assert.deepEqual(calls.filter(args => ['start', 'restart'].includes(args[1])), [
    ['container', 'start', '--', 'stopped'], ['container', 'start', '--', 'created'],
    ['container', 'restart', '--', 'sick']
  ]);
  assert.ok(calls.every(args => !args.includes('unrelated')));
});

test('missing, paused, and timed-out containers fail overall while remaining targets are recovered', () => {
  const result = run(`
    $script:states = @{paused=@{Status='paused'}; pending=@{Status='running';Health=@{Status='starting'}};
      restarting=@{Status='restarting'}; stopped=@{Status='exited'}}
    $settings = @{configurations=@('missing','paused','pending','restarting','stopped' | ForEach-Object {
      @{serverType='Container';container=$_}
    })}
    $message = ''
    try { Ensure-ConfiguredContainers $settings -TimeoutSeconds 0 6>$null } catch { $message=$_.Exception.Message }
    @{Message=$message;Calls=$script:calls} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.match(result.Message, /not ready: missing, paused, pending, restarting/);
  assert.deepEqual(result.Calls.filter(args => ['start', 'restart'].includes(args[1])), [
    ['container', 'start', '--', 'stopped']
  ]);
});

test('dependent operations can skip missing containers while recovering existing ones', () => {
  const result = run(`
    $script:states = @{stopped=@{Status='exited'}}
    $settings = @{configurations=@('missing','stopped' | ForEach-Object {
      @{serverType='Container';container=$_}
    })}
    Ensure-ConfiguredContainers $settings -SkipMissing 6>$null
    @{Calls=$script:calls} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.deepEqual(result.Calls.filter(args => args[1] === 'start'), [
    ['container', 'start', '--', 'stopped']
  ]);
});

test('blank Container placeholders do not prevent recovery of configured containers', () => {
  const result = run(`
    $script:states = @{stopped=@{Status='exited'}}
    $settings = @{configurations=@(
      @{serverType='Container';name='placeholder';container=''},
      @{serverType='Container';name='spaces';container='   '},
      @{serverType='Container';name='target';container='stopped'}
    )}
    Ensure-ConfiguredContainers $settings 6>$null
    @{Calls=$script:calls} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.deepEqual(result.Calls.filter(args => args[1] === 'start'), [
    ['container', 'start', '--', 'stopped']
  ]);
  assert.ok(result.Calls.every(args => !args.includes('')));
});

test('invalid target names fail before Docker access and blank configurations require no Docker', () => {
  const result = run(`
    $message = ''
    try { Ensure-ConfiguredContainers @{configurations=@(@{serverType='Container';container='--all'})} }
    catch { $message=$_.Exception.Message }
    Ensure-ConfiguredContainers @{configurations=@(
      @{serverType='Cloud'}, @{serverType='Container';container=''}, @{serverType='Container';container='  '}
    )} 6>$null
    @{Message=$message;Count=$script:calls.Count} | ConvertTo-Json -Compress
  `);
  assert.match(result.Message, /valid, non-empty container name/);
  assert.equal(result.Count, 0);
});

test('starting containers are polled until healthy without restarting them', () => {
  const result = run(`
    $script:inspections=0
    $script:sleeps=0
    function Start-Sleep { $script:sleeps++ }
    function Get-ConfiguredContainerState {
      $script:inspections++
      @{Status='running';Health=@{Status=$(if ($script:inspections -ge 3) {'healthy'} else {'starting'})}}
    }
    Ensure-ConfiguredContainers @{configurations=@(@{serverType='Container';container='bc'})} 6>$null
    @{Calls=$script:calls;Inspections=$script:inspections;Sleeps=$script:sleeps} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.equal(result.Inspections, 3);
  assert.equal(result.Sleeps, 1);
  assert.deepEqual(result.Calls, [['info', '--format', '{{.OSType}}']]);
});

test('Docker start failures are reported and do not prevent the next container from starting', () => {
  const result = run(`
    function Get-ConfiguredContainerState { @{Status='exited'} }
    function Invoke-ConfiguredContainerDocker {
      param($DockerArguments)
      $script:calls += ,$DockerArguments
      if ($DockerArguments[0] -eq 'info') { return 'windows' }
      if ($DockerArguments[-1] -eq 'broken') { throw 'start failed' }
      return 'started'
    }
    $message = ''
    try {
      Ensure-ConfiguredContainers @{configurations=@('broken','other' | ForEach-Object {
        @{serverType='Container';container=$_}
      })} -TimeoutSeconds 0 6>$null
    } catch { $message=$_.Exception.Message }
    @{Message=$message;Calls=$script:calls} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.match(result.Message, /not ready: broken, other/);
  assert.deepEqual(result.Calls.filter(args => args[1] === 'start'), [
    ['container', 'start', '--', 'broken'], ['container', 'start', '--', 'other']
  ]);
});

test('Docker failure and Linux mode abort before inspecting or starting targets', () => {
  for (const response of ["throw 'daemon unavailable'", "return 'linux'"]) {
    const result = run(`
      function Invoke-ConfiguredContainerDocker {
        param($DockerArguments)
        $script:calls += ,$DockerArguments
        ${response}
      }
      $message = ''
      try { Ensure-ConfiguredContainers @{configurations=@(@{serverType='Container';container='bc'})} }
      catch { $message=$_.Exception.Message }
      @{Message=$message;Count=$script:calls.Count} | ConvertTo-Json -Compress
    `);
    assert.match(result.Message, /daemon unavailable|Windows containers/);
    assert.equal(result.Count, 1);
  }
});

test('container ID resolution cannot act on a differently named container', () => {
  const result = run(`
    function Invoke-ConfiguredContainerDocker {
      param($DockerArguments)
      $script:calls += ,$DockerArguments
      if ($DockerArguments[0] -eq 'info') { return 'windows' }
      '{"Name":"/unrelated","State":{"Status":"exited"}}'
    }
    $message = ''
    try { Ensure-ConfiguredContainers @{configurations=@(@{serverType='Container';container='abc123'})} 6>$null }
    catch { $message=$_.Exception.Message }
    @{Message=$message;Calls=$script:calls} | ConvertTo-Json -Depth 5 -Compress
  `);
  assert.match(result.Message, /not ready: abc123/);
  assert.ok(result.Calls.every(args => !['start', 'restart'].includes(args[1])));
});

test('configured-container operation is exposed through MCP by default and the Command Palette', () => {
  const tool = server.getAllTools().find(tool => tool.name === 'bc_dev_toolset_ensure_containers');
  assert.ok(tool);
  assert.match(tool.description, /restart unhealthy/);
  assert.equal(toolDefaults[tool.name], true);
  const pkg = require('../package.json');
  assert.ok(pkg.activationEvents.includes('onCommand:bcDevToolset.operation.ensureContainers'));
  assert.ok(pkg.contributes.commands.some(command => command.command === 'bcDevToolset.operation.ensureContainers'));
  const schema = require('../schemas/bcdevtoolset-settings.schema.json');
  assert.equal(schema.properties.mcpTools.properties[tool.name].default, true);
});
