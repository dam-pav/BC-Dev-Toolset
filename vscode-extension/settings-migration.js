'use strict';
const path = require('node:path');

// Parse JSONC structure only; edits replace key tokens so values, comments and whitespace survive verbatim.
function parseSettingsTree(text) {
  const pattern = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gy;
  const tokens = [];
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) throw new Error('Invalid settings JSONC; file was left unchanged.');
    offset = pattern.lastIndex;
    if (!/^\s|^\//.test(match[0])) tokens.push({ raw: match[0], start: match.index, end: offset });
  }
  let index = 0;
  const take = raw => {
    const token = tokens[index++];
    if (!token || (raw && token.raw !== raw)) throw new Error('Invalid settings JSONC; file was left unchanged.');
    return token;
  };
  function value() {
    const token = take();
    if (token.raw === '{') {
      const properties = [];
      while (tokens[index]?.raw !== '}') {
        const key = take();
        if (!key.raw.startsWith('"')) throw new Error('Invalid settings property; file was left unchanged.');
        const name = JSON.parse(key.raw);
        take(':');
        properties.push({ name, key, value: value() });
        if (tokens[index]?.raw !== ',') break;
        take(',');
      }
      take('}');
      return { properties };
    }
    if (token.raw === '[') {
      while (tokens[index]?.raw !== ']') {
        value();
        if (tokens[index]?.raw !== ',') break;
        take(',');
      }
      take(']');
      return {};
    }
    JSON.parse(token.raw);
    return {};
  }
  const root = value();
  if (index !== tokens.length || !root.properties) throw new Error('Invalid settings document; file was left unchanged.');
  return root;
}

function planSettingsMigration(text, isWorkspaceFile = false) {
  // Do not report unrelated empty or unfinished settings files as migration failures.
  // Unicode escapes may encode part of a legacy key, so parse those conservatively.
  if (!/dam-pav|\\u/i.test(text)) return { edits: [], conflicts: [] };
  const root = parseSettingsTree(text);
  const settings = isWorkspaceFile ? root.properties.find(property => property.name === 'settings')?.value : root;
  const edits = [], conflicts = [];
  function visit(node) {
    if (!node?.properties) return;
    const names = new Set(node.properties.map(property => property.name));
    for (const property of node.properties) {
      if (/^\[.+\]$/.test(property.name)) visit(property.value);
      const name = property.name.replace(/^dam-pav\.bcdevtoolset(?=\.|$)/i, 'bcDevToolset');
      if (name === property.name) continue;
      if (names.has(name)) {
        conflicts.push(property.name);
        continue;
      }
      names.add(name);
      edits.push({ start: property.key.start, end: property.key.end, text: JSON.stringify(name) });
    }
  }
  visit(settings);
  return { edits, conflicts };
}

async function migrateSettingsOnStartup(vscode, context, log) {
  // Each URI is either explicitly supplied by VS Code for the open workspace or
  // constructed from its authorized user-storage/workspace roots and fixed segments.
  const targets = [
    { uri: vscode.Uri.joinPath(context.globalStorageUri, '..', '..', 'settings.json'),
      root: vscode.Uri.joinPath(context.globalStorageUri, '..', '..') },
    ...(vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.scheme !== 'untitled'
      ? [{ uri: vscode.workspace.workspaceFile, root: vscode.Uri.joinPath(vscode.workspace.workspaceFile, '..'), isWorkspaceFile: true }] : []),
    ...(vscode.workspace.workspaceFolders || []).map(folder => ({ uri: vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json'), root: folder.uri }))
  ];
  const seen = new Set();
  let renamed = 0, conflicts = 0, failed = 0;
  for (const target of targets) {
    if (seen.has(target.uri.toString())) continue;
    seen.add(target.uri.toString());
    try {
      const relative = path.posix.relative(path.posix.normalize(target.root.path), path.posix.normalize(target.uri.path));
      if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) throw new Error('Settings path escapes its authorized root.');
      // Missing settings files are normal. Do not create them just for migration.
      try { await vscode.workspace.fs.stat(target.uri); }
      catch (error) { if (error.code === 'FileNotFound' || error.code === 'ENOENT') continue; throw error; }
      const document = await vscode.workspace.openTextDocument(target.uri);
      const plan = planSettingsMigration(document.getText(), target.isWorkspaceFile);
      conflicts += plan.conflicts.length;
      if (plan.conflicts.length) log(`Settings migration retained conflicting entries in ${target.uri.toString()}: ${plan.conflicts.join(', ')}`);
      if (!plan.edits.length) continue;
      if (document.isDirty) throw new Error('Unsaved settings edits; migration deferred until the next startup.');
      const edit = new vscode.WorkspaceEdit();
      for (const change of plan.edits) {
        edit.replace(target.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
      }
      if (!await vscode.workspace.applyEdit(edit) || !await document.save()) throw new Error('Could not save migrated settings.');
      renamed += plan.edits.length;
    } catch (error) {
      failed++;
      log(`Settings migration: ${target.uri.toString()}: ${error.message}`);
    }
  }
  if (renamed) {
    void vscode.window.showInformationMessage(`BC Dev Toolset migrated ${renamed} setting entries to bcDevToolset. Existing contents were preserved.`);
  }
  if (conflicts || failed) {
    void vscode.window.showWarningMessage(`BC Dev Toolset settings migration left ${conflicts} conflicting entries and ${failed} files for review. See the BC Dev Toolset output; no conflicting values were overwritten.`);
  }
  return { renamed, conflicts, failed };
}

module.exports = { planSettingsMigration, migrateSettingsOnStartup };
