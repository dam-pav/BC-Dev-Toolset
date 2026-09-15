'use strict';

const configurationPrefix = 'bcDevToolset';
const legacyConfigurationPrefix = 'dam-pav.bcdevtoolset';
const properties = Object.assign({}, ...require('./package.json').contributes.configuration.map(group => group.properties));

// Preserve old values at their original scope without registering duplicate UI entries.
function createConfigurationAccess(current, legacy, legacyCased = legacy) {
  function inspect(key) {
    const preferred = current.inspect(key);
    const older = legacy.inspect(key);
    const cased = legacyCased.inspect(key);
    const previous = older || cased ? { ...older, ...cased } : undefined;
    if (previous) {
      for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue']) {
        previous[scope] = cased?.[scope] !== undefined ? cased[scope] : older?.[scope];
      }
    }
    if (!preferred && !previous) return undefined;
    const result = { ...previous, ...preferred };
    for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue']) {
      result[scope] = preferred?.[scope] !== undefined ? preferred[scope] : previous?.[scope];
    }
    return result;
  }
  return {
    inspect,
    get(key, fallback) {
      const values = inspect(key);
      const scope = properties[`${configurationPrefix}.${key}`]?.scope;
      const levels = scope === 'application' || scope === 'machine'
        ? ['globalValue']
        : scope === 'resource' ? ['workspaceFolderValue', 'workspaceValue', 'globalValue']
          : ['workspaceValue', 'globalValue'];
      for (const scope of levels) {
        if (values?.[scope] !== undefined) return values[scope];
      }
      return current.get(key, fallback);
    },
    update(key, value, target) {
      return current.update(key, value, target);
    }
  };
}

function affectsToolsetConfiguration(event, key) {
  return event.affectsConfiguration(`${configurationPrefix}.${key}`) ||
    event.affectsConfiguration(`${legacyConfigurationPrefix}.${key}`) ||
    event.affectsConfiguration(`dam-pav.bcDevToolset.${key}`);
}

module.exports = { configurationPrefix, legacyConfigurationPrefix, createConfigurationAccess, affectsToolsetConfiguration };
