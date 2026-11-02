'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { authorizeRoot, assertWithinRoot, resolveWithinRoot } = require('./path-security');

// One explicit authorization root per home, checkout, lock parent, or test fixture.
// Recheck containment at every access; never let a helper authorize its own input path.
class BcQualityFiles {
  constructor(authorizedRoot) {
    if (!path.isAbsolute(authorizedRoot)) throw new Error('Filesystem authorization root must be absolute.');
    this.root = authorizeRoot(authorizedRoot, 'BCQuality filesystem root');
  }

  async checked(candidate, allowLeafLink = false) {
    const validatedPath = assertWithinRoot(this.root, candidate);
    const segments = path.relative(this.root, validatedPath).split(path.sep).filter(Boolean);
    let current = this.root;
    for (const [index, segment] of [undefined, ...segments].entries()) {
      if (index > 0) current = resolveWithinRoot(current, segment);
      const isLeaf = index === segments.length;
      let stat;
      // current is the authorized root or a descendant checked by resolveWithinRoot.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
      try { stat = await fs.lstat(current); } // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (stat.isSymbolicLink() && !(allowLeafLink && isLeaf)) {
        throw new Error(`BCQuality filesystem access must not traverse a symlink: ${current}`);
      }
    }
    return validatedPath;
  }

  async lstat(candidate) {
    const validatedPath = await this.checked(candidate, true);
    // A contained link may be inspected without following its target.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.lstat(validatedPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async stat(candidate) {
    const validatedPath = await this.checked(candidate);
    // checked enforces the authorized root and rejects symlink traversal.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.stat(validatedPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async open(candidate, flags) {
    const validatedPath = await this.checked(candidate);
    // checked confines lock creation to its explicitly authorized directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.open(validatedPath, flags); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async mkdir(candidate, options) {
    const validatedPath = await this.checked(candidate);
    // checked confines directory creation to the authorized root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.mkdir(validatedPath, options); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async link(source, destination) {
    const validatedSource = await this.checked(source);
    const validatedDestination = await this.checked(destination);
    // Both entries are confined to the authorized root and reject symlink traversal.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are checked against the explicit authorization root above.
    return fs.link(validatedSource, validatedDestination); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async readdir(candidate) {
    const validatedPath = await this.checked(candidate);
    // checked confines enumeration to the authorized root without following links.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.readdir(validatedPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async readFile(candidate, encoding) {
    const validatedPath = await this.checked(candidate);
    // checked confines reads to the authorized root without following links.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.readFile(validatedPath, encoding); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async writeFile(candidate, content) {
    const validatedPath = await this.checked(candidate);
    // checked confines writes to the authorized root without following links.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.writeFile(validatedPath, content); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async appendFile(candidate, content) {
    const validatedPath = await this.checked(candidate);
    // checked confines fixture edits to the authorized root without following links.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.appendFile(validatedPath, content); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async unlink(candidate) {
    const validatedPath = await this.checked(candidate, true);
    // Only the contained directory entry is removed; a link target is never followed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.unlink(validatedPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async rmdir(candidate) {
    const validatedPath = await this.checked(candidate);
    // checked confines removal to an authorized, non-symlink directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.rmdir(validatedPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
  async rm(candidate, options) {
    const validatedPath = await this.checked(candidate, true);
    // Fixture cleanup is confined to its owned temporary root; rm does not follow links.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is checked against its explicit authorization root above.
    return fs.rm(validatedPath, options); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  }
}

module.exports = { BcQualityFiles };
