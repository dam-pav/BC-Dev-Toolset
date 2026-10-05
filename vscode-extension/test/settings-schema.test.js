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

test('automatic assembly extraction is valid only for OnPrem containers in both settings schemas', () => {
  const sharedConfiguration = extension.contributes.configuration
    .flatMap(group => Object.values(group.properties || {}))
    .find(property => property.properties?.configurations)
    .properties.configurations.items;

  for (const configuration of [localSettings.definitions.configuration, sharedConfiguration]) {
    const restriction = configuration.allOf.find(rule =>
      rule.if?.properties?.serverType?.const === 'Container' &&
      rule.if?.not?.properties?.environmentType?.const === 'OnPrem');
    assert.ok(restriction);
    assert.deepEqual(restriction.if.required, ['serverType']);
    assert.deepEqual(restriction.if.not.required, ['environmentType']);
    assert.deepEqual(restriction.then.properties.autoExtractAssemblies, {
      not: {},
      errorMessage: 'Field "autoExtractAssemblies" is valid only when "environmentType" is "OnPrem".',
      doNotSuggest: true
    });
  }

  for (const sample of localSettings.properties.configurations.default) {
    assert.equal(sample.environmentType, 'Sandbox');
    assert.equal(Object.hasOwn(sample, 'autoExtractAssemblies'), false);
  }
});
