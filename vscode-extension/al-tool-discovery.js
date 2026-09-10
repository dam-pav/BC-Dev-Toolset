'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { authorizeRoot, assertWithinRoot, resolveWithinRoot } = require('./path-security');

function discoverAlTool(extensionPath, options = {}) {
  const platform = options.platform || process.platform;
  const root = authorizeRoot(extensionPath, 'Microsoft AL extension root');
  const realRoot = fs.realpathSync(root); // nosemgrep -- explicitly authorized extension installation
  const executable = platform === 'win32' ? 'altool.exe' : 'altool';
  const probe = options.probe || ((validatedPath) => execFileSync(validatedPath, ['--help'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true
  }));
  const failures = [];
  const tried = new Set();

  function validate(candidate) {
    const validatedPath = assertWithinRoot(root, candidate);
    if (tried.has(validatedPath)) return false;
    tried.add(validatedPath);
    try {
      const realPath = fs.realpathSync(validatedPath); // nosemgrep -- lexical containment checked above; physical containment checked before use
      assertWithinRoot(realRoot, realPath);
      if (!fs.statSync(realPath).isFile()) return false; // nosemgrep -- physical containment in authorized extension root checked above
      const help = probe(realPath);
      if (!/Microsoft AL CLI tools/i.test(help) || !/\bcompile\b/i.test(help)) {
        throw new Error('Unexpected ALTool help; compile command is unavailable');
      }
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push(`${validatedPath}: ${error.message}`);
      return false;
    }
  }

  for (const segments of [['bin', executable], ['bin', platform, executable]]) {
    const candidate = resolveWithinRoot(root, ...segments);
    if (validate(candidate)) return candidate;
  }

  // Search only this installation. Never follow directory symlinks/junctions.
  const pending = [root];
  const candidates = [];
  let entriesSeen = 0;
  while (pending.length) {
    const directory = assertWithinRoot(root, pending.pop());
    assertWithinRoot(realRoot, fs.realpathSync(directory)); // nosemgrep -- directory is lexically contained; physical containment checked before enumeration
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { // nosemgrep -- both lexical and physical containment verified above
      if (++entriesSeen > 50000) throw new Error('ALTool discovery exceeded the 50000-entry limit');
      if (entry.isSymbolicLink()) continue;
      const candidate = resolveWithinRoot(root, path.relative(root, directory), entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === executable) candidates.push(candidate);
    }
  }
  // Do not guess between multiple runnable copies, even if both advertise compile.
  if (candidates.length > 16) throw new Error('ALTool discovery found more than 16 candidates; refusing to probe an ambiguous installation');
  const usable = candidates.sort().filter(validate);
  if (usable.length === 1) return usable[0];
  if (usable.length > 1) throw new Error(`Ambiguous ALTool installation; multiple runnable candidates: ${usable.join(', ')}`);
  throw new Error(`No compatible ALTool for ${platform} in ${root}. ${failures.join('; ')}`);
}

module.exports = { discoverAlTool };
