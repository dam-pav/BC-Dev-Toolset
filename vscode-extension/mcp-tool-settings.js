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

function readToolSettingsForScope(configuration, scope, localOverrides = {}, includeScope = true) {
  const values = configuration.inspect('mcpTools') || {};
  const scopes = scope === 'local' ? ['local', 'workspaceValue', 'globalValue']
    : scope === 'workspaceValue' ? ['workspaceValue', 'globalValue'] : ['globalValue'];
  if (!includeScope) scopes.shift();
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

function mergeToolSelection(existing, before, selectedNames) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) ||
      (existing.mcpTools !== undefined && (!existing.mcpTools || typeof existing.mcpTools !== 'object' || Array.isArray(existing.mcpTools)))) {
    throw new Error('bcDevToolset and mcpTools must be JSON objects before tool selections can be saved.');
  }
  const selected = new Set(selectedNames);
  const changes = Object.fromEntries(Object.keys(toolDefaults).filter(name => before[name] !== selected.has(name)).map(name => [name, selected.has(name)]));
  return Object.keys(changes).length ? { ...existing, mcpTools: { ...existing.mcpTools, ...changes } } : undefined;
}

module.exports = { toolSchemas, toolDefaults, resolveToolSettings, readEffectiveToolSettings, readToolSettingsForScope, mergeToolSelection };
