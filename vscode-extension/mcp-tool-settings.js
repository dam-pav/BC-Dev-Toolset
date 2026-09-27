'use strict';

const groups = require('./package.json').contributes.configuration;
const properties = Object.assign({}, ...groups.map((group) => group.properties));
const toolSchemas = properties.bcDevToolset.properties.mcpTools.properties;
const toolDefaults = Object.freeze(Object.fromEntries(
  Object.entries(toolSchemas).map(([name, value]) => [name, value.default === true])
));

function resolveToolSettings(overrides = {}) {
  overrides = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  return Object.fromEntries(Object.entries(toolDefaults).map(([name, defaultValue]) => [
    name, Object.prototype.hasOwnProperty.call(overrides, name) && typeof overrides[name] === 'boolean'
      ? overrides[name] : defaultValue
  ]));
}

function readToolSettingsForScope(configuration, scope, localOverrides = {}) {
  const values = configuration.inspect('mcpTools') || {};
  const scopes = scope === 'local' ? ['local', 'workspaceValue', 'globalValue']
    : scope === 'workspaceValue' ? ['workspaceValue', 'globalValue'] : ['globalValue'];
  return resolveToolSettings(Object.fromEntries(Object.keys(toolDefaults).map((name) => {
    for (const currentScope of scopes) {
      const overrides = currentScope === 'local' ? localOverrides : values[currentScope];
      if (typeof overrides?.[name] === 'boolean') return [name, overrides[name]];
    }
    return [name, undefined];
  })));
}

function readEffectiveToolSettings(configuration, localOverrides = {}) {
  return readToolSettingsForScope(configuration, 'local', localOverrides);
}

function mergeToolSelection(existing, selectedNames) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) ||
      (existing.mcpTools !== undefined && (!existing.mcpTools || typeof existing.mcpTools !== 'object' || Array.isArray(existing.mcpTools)))) {
    throw new Error('bcDevToolset and mcpTools must be JSON objects before tool selections can be saved.');
  }
  const selected = new Set(selectedNames);
  const currentToolSettings = existing.mcpTools || {};
  const nextToolSettings = { ...currentToolSettings };
  for (const name of Object.keys(toolDefaults)) {
    nextToolSettings[name] = selected.has(name);
  }
  const currentKeys = Object.keys(currentToolSettings);
  const nextKeys = Object.keys(nextToolSettings);
  const changed = currentKeys.length !== nextKeys.length || currentKeys.some((name) =>
    !Object.prototype.hasOwnProperty.call(nextToolSettings, name) || currentToolSettings[name] !== nextToolSettings[name]);
  return changed ? { ...existing, mcpTools: nextToolSettings } : undefined;
}

module.exports = { toolSchemas, toolDefaults, resolveToolSettings, readEffectiveToolSettings, readToolSettingsForScope, mergeToolSelection };
