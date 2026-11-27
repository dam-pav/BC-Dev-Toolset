'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assertWithinRoot, authorizeRoot, resolveWithinRoot } = require('./path-security');
const { parseSettingsJsonc } = require('./settings-migration');

const selectionFilename = 'test-codeunit-selection.json';
const ignoredDirectories = new Set(['.git', '.alpackages', '.bcdevtoolset', '.vscode', 'node_modules']);
const codeunitIdMaximum = 2 ** 31 - 1;

function normalizeTestCodeunitIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || [...value].some(id =>
    !Number.isInteger(id) || id < 1 || id > codeunitIdMaximum)) {
    throw new Error('codeunitIds must contain at least one integer ID between 1 and 2147483647. Supply test codeunit IDs from the workspace catalog or omit codeunitIds to run all tests.');
  }
  return [...new Set(value)].sort((first, second) => first - second);
}

function assertKnownTestCodeunits(ids, catalog) {
  if (ids === undefined) return;
  const knownIds = new Set(catalog.flatMap(app => app.codeunits.map(codeunit => codeunit.id)));
  const unknownIds = ids.filter(id => !knownIds.has(id));
  if (unknownIds.length) {
    throw new Error(`Selected AL test codeunit IDs were not found in workspace source (${unknownIds.join(', ')}). Refresh the test codeunit catalog and select IDs from an open app.`);
  }
}

function isToken(token, word) {
  return token?.toLowerCase() === word;
}

function getSourceTestCodeunits(source) {
  // Keep identifiers and strings intact so their contents cannot imitate AL declarations.
  const tokens = (source.match(/\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|^[ \t]*#[ \t]*\w+[^\r\n]*|"(?:[^"]|"")*"|'(?:[^']|'')*'|[a-z_][a-z0-9_]*|[0-9]+|[{}=;]/gim) || [])
    .filter(token => !token.startsWith('/'));
  const codeunits = [];
  let depth = 0;
  let conditionalDepth = 0;
  let declaration;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const directive = token.match(/^\s*#\s*(\w+)/)?.[1]?.toLowerCase();
    if (directive) {
      switch (directive) {
        case 'if': conditionalDepth++; break;
        case 'endif': conditionalDepth = Math.max(0, conditionalDepth - 1); break;
      }
      continue;
    }
    if (depth === 0 && isToken(token, 'codeunit')) {
      const [id, name, opening] = tokens.slice(index + 1, index + 4);
      if (/^\d+$/.test(id) && /^(?:"|[a-z_])/i.test(name) && opening === '{') {
        declaration = { id: Number(id), name: name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name };
        if (conditionalDepth > 0) declaration.conditional = true;
        index += 2;
      }
    } else if (depth === 1 && declaration && isToken(token, 'subtype') &&
        tokens[index + 1] === '=' && isToken(tokens[index + 2], 'test') && tokens[index + 3] === ';') {
      if (conditionalDepth > 0) declaration.conditional = true;
      if (declaration.id >= 1 && declaration.id <= codeunitIdMaximum) codeunits.push(declaration);
      declaration = undefined;
    }

    switch (token) {
      case '{':
        depth++;
        break;
      case '}':
        depth = Math.max(0, depth - 1);
        if (depth === 0) declaration = undefined;
        break;
    }
  }
  return codeunits;
}

function pathKey(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function reasonCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : '';
}

async function optionalLstat(authorizedRoot, candidate) {
  const validatedPath = assertWithinRoot(authorizedRoot, candidate);
  try {
    return await fs.lstat(validatedPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- containment is checked against the caller's authorized root and lstat does not follow the leaf
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readAppManifest(appRoot) {
  const manifestPath = resolveWithinRoot(appRoot, 'app.json');
  let source;
  try {
    const manifestStat = await optionalLstat(appRoot, manifestPath);
    if (!manifestStat) return undefined;
    if (!manifestStat.isFile()) {
      throw new Error('Read AL app manifest failed. Use a regular app.json file in the workspace app folder.');
    }
    source = await fs.readFile(manifestPath, 'utf8'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- fixed manifest path is confined to the canonical app root and verified to be a regular file
  } catch (error) {
    if (!error.code) throw error;
    throw new Error(`Read AL app manifest failed${reasonCode(error)}. Check read access to workspace app.json files.`);
  }

  try {
    const manifest = parseSettingsJsonc(source);
    if (typeof manifest?.application !== 'string' || !manifest.application.trim()) return undefined;
    if (typeof manifest.id !== 'string' || !manifest.id.trim() ||
        typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new Error('Missing app identity.');
    }
    return { appId: manifest.id, appName: manifest.name };
  } catch {
    throw new Error('Read AL app manifest failed. Correct invalid JSON or missing AL app identity in app.json, then refresh the test codeunit catalog.');
  }
}

async function readAppTestCodeunits(appRoot, workspaceRoots) {
  const codeunits = new Map();
  const directories = [appRoot];
  while (directories.length) {
    const directory = directories.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true }); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- queue contains the canonical workspace app root and contained, non-link directories only
    for (const entry of entries) {
      const entryPath = resolveWithinRoot(appRoot, directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name.toLowerCase()) &&
          !workspaceRoots.has(pathKey(entryPath))) {
        const nestedManifest = resolveWithinRoot(appRoot, entryPath, 'app.json');
        if (!await optionalLstat(appRoot, nestedManifest)) directories.push(entryPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.al') {
        const source = await fs.readFile(entryPath, 'utf8'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- resolveWithinRoot confines the entry to the app root and the directory entry identifies a regular file
        for (const codeunit of getSourceTestCodeunits(source)) codeunits.set(codeunit.id, codeunit);
      }
    }
  }
  return [...codeunits.values()].sort((first, second) => first.id - second.id);
}

async function getTestCodeunitCatalog(vscode) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length || folders.some(folder => folder.uri.scheme !== 'file')) {
    throw new Error('Discover AL test codeunits failed. Open a local VS Code workspace with AL app folders and try again.');
  }

  const workspaceRoots = new Map();
  try {
    for (const folder of folders) {
      const authorizedFolder = authorizeRoot(folder.uri.fsPath, 'VS Code workspace folder');
      const appRoot = await fs.realpath(authorizedFolder); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- canonicalizes only the explicitly opened VS Code workspace folder root
      workspaceRoots.set(pathKey(appRoot), appRoot);
    }
  } catch (error) {
    throw new Error(`Resolve AL app folders failed${reasonCode(error)}. Check that the workspace folders exist and are readable, then refresh the test codeunit catalog.`);
  }

  const catalog = [];
  for (const appRoot of workspaceRoots.values()) {
    const app = await readAppManifest(appRoot);
    if (!app) continue;
    let codeunits;
    try {
      codeunits = await readAppTestCodeunits(appRoot, workspaceRoots);
    } catch (error) {
      throw new Error(`Read AL test source failed${reasonCode(error)}. Check read access to AL source in the workspace app folders, then refresh the test codeunit catalog.`);
    }
    if (codeunits.length) catalog.push({ ...app, codeunits });
  }
  return catalog.sort((first, second) => first.appName.localeCompare(second.appName) ||
    first.appId.localeCompare(second.appId));
}

async function getSelectionFile(workspaceBasePath, localSettingsPath, createDirectory) {
  const workspaceRoot = authorizeRoot(workspaceBasePath, 'VS Code workspace base');
  let settingsPath;
  try {
    settingsPath = resolveWithinRoot(workspaceRoot, localSettingsPath || '.bcdevtoolset/settings.json');
    if (settingsPath === workspaceRoot) throw new Error('A settings filename is required.');
  } catch {
    throw new Error('Resolve AL test selection storage failed. Set bcDevToolset.localSettingsPath to a settings file inside the workspace. No selection was changed.');
  }

  const relativeDirectory = path.relative(workspaceRoot, path.dirname(settingsPath));
  const realWorkspaceRoot = await fs.realpath(workspaceRoot); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- canonicalizes only the authorized VS Code workspace base, without using the configured settings path
  let directory = realWorkspaceRoot;
  for (const component of relativeDirectory.split(path.sep).filter(Boolean)) {
    const nextDirectory = resolveWithinRoot(realWorkspaceRoot, directory, component);
    let stat = await optionalLstat(realWorkspaceRoot, nextDirectory);
    if (!stat && !createDirectory) return { exists: false };
    if (!stat) {
      try {
        await fs.mkdir(nextDirectory); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- a single contained component beneath the canonical workspace root or a checked non-link parent
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      stat = await fs.lstat(nextDirectory); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- resolveWithinRoot confines the component to the canonical workspace root and lstat does not follow the leaf
    }
    if (!stat.isDirectory()) {
      throw new Error('Resolve AL test selection storage failed. Set bcDevToolset.localSettingsPath inside an ordinary workspace directory without filesystem links. No selection was changed.');
    }
    directory = nextDirectory;
  }
  const selectionPath = resolveWithinRoot(realWorkspaceRoot, directory, selectionFilename);
  const stat = await optionalLstat(realWorkspaceRoot, selectionPath);
  if (stat && !stat.isFile()) {
    throw new Error(`Open AL test selection failed. Replace the linked or non-file ${selectionFilename} beside bcDevToolset.localSettingsPath with a regular JSON file, then reopen the picker. No selection was changed.`);
  }
  return { selectionPath, exists: Boolean(stat) };
}

async function readSelection(workspaceBasePath, localSettingsPath) {
  let source;
  try {
    const { selectionPath, exists } = await getSelectionFile(workspaceBasePath, localSettingsPath, false);
    if (!exists) return undefined;
    source = await fs.readFile(selectionPath, 'utf8'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- getSelectionFile checks containment and excludes directory and leaf links
  } catch (error) {
    if (!error.code) throw error;
    throw new Error(`Read saved AL test selection failed${reasonCode(error)}. Check access to the folder containing bcDevToolset.localSettingsPath, then reopen the picker. No selection was changed.`);
  }

  try {
    const saved = JSON.parse(source);
    if (!Array.isArray(saved?.codeunitIds)) throw new Error('Missing codeunitIds.');
    return normalizeTestCodeunitIds(saved.codeunitIds);
  } catch {
    throw new Error(`Read saved AL test selection failed. Correct the codeunitIds list or remove ${selectionFilename} beside bcDevToolset.localSettingsPath, then reopen the picker. No selection was changed.`);
  }
}

async function writeSelection(workspaceBasePath, localSettingsPath, ids) {
  let temporaryPath;
  let temporaryFile;
  try {
    const { selectionPath } = await getSelectionFile(workspaceBasePath, localSettingsPath, true);
    const selectionDirectory = path.dirname(selectionPath);
    temporaryPath = resolveWithinRoot(selectionDirectory, `.${selectionFilename}.${randomUUID()}.tmp`);
    temporaryFile = await fs.open(temporaryPath, 'wx'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- exclusive creation of a generated filename confined to the validated workspace selection directory
    try {
      await temporaryFile.writeFile(`${JSON.stringify({ codeunitIds: ids })}\n`, 'utf8');
    } finally {
      await temporaryFile.close();
    }
    await fs.rename(temporaryPath, selectionPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- both entries are contained in the same validated workspace selection directory
  } catch (error) {
    if (!error.code) throw error;
    if (temporaryFile) {
      try {
        await fs.unlink(temporaryPath); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename -- remove only the exclusively created staging file within the validated selection directory
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          throw new Error(`Save AL test selection failed${reasonCode(error)}. The saved selection was not replaced and temporary file cleanup failed${reasonCode(cleanupError)}. Remove leftover selection temporary files beside bcDevToolset.localSettingsPath and check write access before retrying.`);
        }
      }
    }
    throw new Error(`Save AL test selection failed${reasonCode(error)}. The saved selection was not replaced. Check write access to the folder containing bcDevToolset.localSettingsPath, then reopen the picker.`);
  }
}

async function pickTestCodeunits(vscode, workspaceBasePath, localSettingsPath) {
  const previousIds = await readSelection(workspaceBasePath, localSettingsPath);
  const catalog = await getTestCodeunitCatalog(vscode);
  if (!catalog.length) {
    throw new Error('Select AL test codeunits failed. No test codeunits were found. Open the test app folder as part of the workspace and try again. No selection was changed.');
  }

  const previousIdSet = new Set(previousIds);
  const items = catalog.flatMap(app => [
    { label: app.appName, kind: vscode.QuickPickItemKind.Separator },
    ...app.codeunits.map(codeunit => ({
      label: codeunit.name,
      description: String(codeunit.id),
      detail: codeunit.conditional ? 'Conditional in source. The test run verifies that it is deployed.' : undefined,
      id: codeunit.id,
      picked: previousIdSet.has(codeunit.id)
    }))
  ]);

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select AL test codeunits',
    placeHolder: 'Choose at least one test codeunit',
    canPickMany: true,
    matchOnDescription: true
  });
  if (picked === undefined) {
    assertKnownTestCodeunits(previousIds, catalog);
    return previousIds;
  }
  if (picked.length === 0) {
    await vscode.window.showWarningMessage('Select at least one AL test codeunit to save a selection.');
    return undefined;
  }

  const ids = normalizeTestCodeunitIds(picked.map(item => item.id));
  await writeSelection(workspaceBasePath, localSettingsPath, ids);
  return ids;
}

module.exports = {
  assertKnownTestCodeunits,
  getTestCodeunitCatalog,
  normalizeTestCodeunitIds,
  pickTestCodeunits
};
