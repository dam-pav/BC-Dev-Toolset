'use strict';

const path = require('node:path');
const { authorizeRoot } = require('./path-security');

class CuratedSkillsConfigurationFailure extends Error {}
function fail(message) { throw new CuratedSkillsConfigurationFailure(message); }

function validateRepositoryUrl(value) {
  if (typeof value !== 'string') fail('Set a GitHub repository URL without credentials in bcDevToolset.curatedSkillsRepositoryUrl.');
  const url = value.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (!match || !/[A-Za-z0-9]/.test(match[2]) || /[\x00-\x20\x7f]/.test(url)) {
    fail('Use a GitHub HTTPS or git SSH repository URL without credentials, query parameters, fragments, or extra path segments in bcDevToolset.curatedSkillsRepositoryUrl.');
  }
  return { url, identity: `${match[1]}/${match[2]}`.toLowerCase() };
}

function validateClonePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim()) || /[\x00-\x1f\x7f`]/.test(value)) {
    fail('Set bcDevToolset.curatedSkillsPath to an absolute dedicated checkout path without control characters or backticks.');
  }
  const root = authorizeRoot(value, 'Curated skills checkout');
  if (root === path.parse(root).root) fail('bcDevToolset.curatedSkillsPath must not be a filesystem root.');
  return root;
}

module.exports = { validateRepositoryUrl, validateClonePath, CuratedSkillsConfigurationFailure };
