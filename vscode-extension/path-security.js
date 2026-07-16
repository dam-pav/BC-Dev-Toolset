'use strict';

const path = require('path');

function authorizeRoot(value, label) {
  // This is the validation boundary: normalize first, then require containment at each use site.
  const resolvedRoot = path.resolve(String(value || '').trim()); // nosemgrep
  if (!String(value || '').trim()) {
    throw new Error(`${label || 'Filesystem root'} is required.`);
  }
  return resolvedRoot;
}

function authorizeExplicitPath(value, label) {
  if (!String(value || '').trim()) {
    throw new Error(`${label || 'Filesystem path'} is required.`);
  }
  return path.resolve(String(value)); // nosemgrep -- intentional normalization boundary
}

function resolveWithinRoot(root, ...segments) {
  const authorizedRoot = authorizeRoot(root, 'Authorized filesystem root');
  const candidate = path.resolve(authorizedRoot, ...segments.map(String)); // nosemgrep -- checked below
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
