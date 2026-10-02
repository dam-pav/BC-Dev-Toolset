const assert = require('node:assert/strict');
const test = require('node:test');

const localSettings = require('../schemas/bcdevtoolset-settings.schema.json');
const extension = require('../package.json');

test('OnPrem port accepts strings and valid numeric TCP ports in local and shared settings', () => {
  const sharedConfiguration = extension.contributes.configuration
    .flatMap(group => Object.values(group.properties || {}))
    .find(property => property.properties?.configurations)
    .properties.configurations.items;

  for (const configuration of [localSettings.definitions.configuration, sharedConfiguration]) {
    const onPrem = configuration.allOf.find(rule => rule.if?.properties?.serverType?.const === 'OnPrem');
    assert.deepEqual(onPrem.then.properties.port.anyOf, [
      { type: 'string' },
      { type: 'integer', minimum: 1, maximum: 65535 }
    ]);
  }
});
