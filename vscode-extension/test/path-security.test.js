'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const { assertWithinRoot, authorizeExplicitPath, authorizeRoot, resolveWithinRoot } = require('../path-security');

test('authorizes configured roots and explicit paths as absolute paths', () => {
  assert.equal(path.isAbsolute(authorizeRoot('relative-root', 'Root')), true);
  assert.equal(path.isAbsolute(authorizeExplicitPath('relative-file.txt', 'File')), true);
});

test('resolves fixed segments within an authorized root', () => {
  const root = path.resolve('root');
  assert.equal(resolveWithinRoot(root, 'operations', 'operations.json'), path.join(root, 'operations', 'operations.json'));
  assert.equal(assertWithinRoot(root, path.join(root, 'common')), path.join(root, 'common'));
});

test('rejects paths that escape an authorized root', () => {
  const root = path.resolve('root');
  assert.throws(() => resolveWithinRoot(root, '..', 'outside'), /escapes/);
  assert.throws(() => assertWithinRoot(root, path.resolve('outside')), /escapes/);
});
