const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const operations = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'operations', 'operations.json'), 'utf8'));

function fixture(t) {
  const root = authorizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-operation-messages-')), 'Test fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); // nosemgrep -- test-owned authorized root
  const write = (relative, content) => {
    const target = resolveWithinRoot(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); // nosemgrep -- contained by test-owned root
    fs.writeFileSync(target, content); // nosemgrep -- contained by test-owned root
  };
  write('Invoke-BcDevToolsetOperation.ps1', fs.readFileSync(path.join(repositoryRoot, 'Invoke-BcDevToolsetOperation.ps1'), 'utf8'));
  write('common/WorkspaceMgt.ps1', `
    function Get-OperationDefinitions {
      param($ScriptPath)
      $definitions = Get-Content (Join-Path $PSScriptRoot '../operations/operations.json') -Raw | ConvertFrom-Json
      foreach ($definition in $definitions) {
        $definition | Add-Member ScriptPath (Join-Path $ScriptPath $definition.script)
        $definition
      }
    }
    function Initialize-Context {}
    function Test-DockerProcess {}
    function Invoke-ContainerAssemblyExtraction { return ($env:TEST_EXTRACTION_SUCCESS -eq 'true') }
    function Write-Done { Write-Host '!!!!     DONE     !!!!' }
  `);
  write('common/ContainerLifecycle.ps1', 'function Ensure-ConfiguredContainers {}');
  return { root, write };
}

function run(root, script, extraEnv = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', cwd: root, env: { ...process.env, ...extraEnv }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.replace(/\r/g, '');
}

for (const nonInteractive of [false, true]) {
  test(`launcher identifies every PowerShell operation (nonInteractive=${nonInteractive})`, (t) => {
    const { root, write } = fixture(t);
    const psOperations = operations.filter(operation => operation.script?.endsWith('.ps1'));
    write('operations/operations.json', JSON.stringify(psOperations));
    for (const operation of psOperations) {
      const source = fs.readFileSync(resolveWithinRoot(repositoryRoot, operation.script), 'utf8'); // nosemgrep -- contained by repository root
      assert.doesNotMatch(source, /^\s*Clear-Host\s*$/m, `${operation.id} must not erase the launcher banner`);
      write(operation.script, "Write-Host 'OPERATION BODY'");
    }
    const output = run(root, `
      function Clear-Host { Write-Host 'TERMINAL CLEARED' }
      $operations = Get-Content './operations/operations.json' -Raw | ConvertFrom-Json
      foreach ($operation in $operations) {
        & ./Invoke-BcDevToolsetOperation.ps1 -Operation $operation.id ${nonInteractive ? '-NonInteractive' : ''}
      }
    `);
    const headings = output.split('\n').filter(line => /^!!!!  .*  !!!!$/.test(line));
    assert.deepEqual(headings, psOperations.map(operation => `!!!!  ${operation.title}  !!!!`));
    assert.equal(output.split('TERMINAL CLEARED').length - 1, nonInteractive ? 0 : psOperations.length);
    const lines = output.trim().split('\n');
    for (const heading of headings) {
      const index = lines.indexOf(heading);
      assert.equal(lines[index - 1], '!'.repeat(heading.length));
      assert.equal(lines[index + 1], '!'.repeat(heading.length));
      if (!nonInteractive) assert.equal(lines[index - 2], 'TERMINAL CLEARED');
      assert.equal(lines[index + 4], 'OPERATION BODY');
    }
  });
}

for (const success of [true, false]) {
  test(`assembly extraction prints reload instructions only on success (${success})`, (t) => {
    const { root, write } = fixture(t);
    const operation = operations.find(operation => operation.id === 'extractContainerAssemblies');
    write('operations/operations.json', JSON.stringify([operation]));
    write(operation.script, fs.readFileSync(path.join(repositoryRoot, 'operations', 'ExtractContainerAssemblies.ps1'), 'utf8'));
    const output = run(root, '& ./Invoke-BcDevToolsetOperation.ps1 -Operation extractContainerAssemblies -NonInteractive', {
      TEST_EXTRACTION_SUCCESS: String(success)
    });
    if (success) {
      assert.match(output, /!{10,}\nReload VS Code now \(Developer: Reload Window\).*\.netpackages.*workspace\.\n!{10,}/);
      assert.ok(output.indexOf('Reload VS Code') < output.indexOf('DONE'));
    } else {
      assert.doesNotMatch(output, /Reload VS Code|DONE/);
    }
  });
}
