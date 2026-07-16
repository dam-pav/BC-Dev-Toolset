'use strict';

const path = require('path');

function authorizeRoot(value, label) {
  const resolvedRoot = path.resolve(String(value || '').trim());
  if (!String(value || '').trim()) {
    throw new Error(`${label || 'Filesystem root'} is required.`);
  }
  return resolvedRoot;
}

function authorizeExplicitPath(value, label) {
  if (!String(value || '').trim()) {
    throw new Error(`${label || 'Filesystem path'} is required.`);
  }
  return path.resolve(String(value));
}

function resolveWithinRoot(root, ...segments) {
  const authorizedRoot = authorizeRoot(root, 'Authorized filesystem root');
  const candidate = path.resolve(authorizedRoot, ...segments.map(String));
  assertWithinRoot(authorizedRoot, candidate);
  return candidate;
}

function assertWithinRoot(root, candidate) {
  const authorizedRoot = authorizeRoot(root, 'Authorized filesystem root');
  const resolvedCandidate = authorizeExplicitPath(candidate, 'Filesystem path');
  const relative = path.relative(authorizedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Filesystem path escapes its authorized root: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

module.exports = {
  assertWithinRoot,
  authorizeExplicitPath,
  authorizeRoot,
  resolveWithinRoot
};
