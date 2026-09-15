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

function readEffectiveToolSettings(configuration) {
  return resolveToolSettings(Object.fromEntries(Object.keys(toolDefaults).map((name) => {
    const current = configuration.inspect(`mcpTools.${name}`);
    for (const scope of ['workspaceValue', 'globalValue']) {
      if (current?.[scope] !== undefined) return [name, current[scope]];
    }
    return [name, undefined];
  })));
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

module.exports = { toolSchemas, toolDefaults, resolveToolSettings, readEffectiveToolSettings, mergeToolSelection };
