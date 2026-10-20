'use strict';

const connectionId = { type: 'string', minLength: 1, maxLength: 200, description: 'Exact unique Toolset configuration name; obtain it from bc_data_list_connections.' };
const companyId = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'Explicit company GUID from bc_data_list_companies.' };
const tableId = { type: 'integer', minimum: 1, maximum: 1999999999 };
const fieldId = { type: 'integer', minimum: 1, maximum: 2147483647 };
const pageSize = { type: 'integer', minimum: 1, maximum: 100, default: 25 };
const filters = { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false,
  required: ['fieldId', 'expression'], properties: { fieldId, expression: { type: 'string', maxLength: 4000 } } } };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const prerequisite = 'Read-only development-container access. Enable this tool in MCP settings and explicitly deploy companion contract 1 with published service BCDData first. Calls never install apps. Uses configured BC credentials and permissions; no credential arguments. ';
const mutationPrerequisite = 'Single-record development-container mutation. Explicitly enable this tool; initialize companion mutation protocol1/service BCDDataWrite and grant BCD DATA WRITE plus native target/trigger table permissions. Native validation and triggers always run. One call owns one five-minute request scope and permits one identical in-call retry after uncertain transport; commands are never queued across calls. An unknown outcome requires reconciliation, never blind repetition or a fresh version. Receipt guarantees cover this database transaction and uninterrupted history, not external trigger effects or restore/copy. ';
const systemId = { ...companyId, description: 'Existing physical record SystemId from a read; stable across native rename.' };
const expectedVersion = { type: 'string', minLength: 1, maxLength: 19, pattern: '^[1-9][0-9]*$', description: 'Exact positive rowversion string from the read being changed; never refresh it automatically after a conflict.' };
const mutationFieldId = { type: 'integer', minimum: 1, maximum: 1999999999 };
const mutationValue = { anyOf: [{ type: 'boolean' }, { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
  { type: 'string', maxLength: 32768 }, schema({ date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, closing: { type: 'boolean' } })] };
const assignments = maximum => ({ type: 'array', minItems: 1, maxItems: maximum,
  items: schema({ fieldId: mutationFieldId, value: mutationValue }) });
const definitions = [
  ['list_connections', 'List configured Dev/Test containers without connecting or checking installed state. Configuration names are connection IDs; ambiguous names cannot be used.', schema({}), 'listConnections'],
  ['list_companies', 'List company GUIDs/names for an explicit connection before selecting a company.', schema({ connectionId }), 'listCompanies'],
  ['get_readiness', 'Check companion contract, app version and advertised capabilities for an explicit connection/company.', schema({ connectionId, companyId }), 'readiness'],
  ['find_tables', 'Search installed table names/captions literally (numeric ID search is pending). Page using returned afterId with the same query. Structural support does not guarantee permission.', schema({ connectionId, companyId, query: { type: 'string', maxLength: 100, default: '' }, afterId: { type: 'integer', minimum: 0 }, pageSize }, ['connectionId', 'companyId']), 'findTables'],
  ['get_table_schema', 'Discover installed fields, extension fields, keys and enum ordinals. Relations/obsolescence details are explicitly unavailable in this slice. readSupportedInSlice governs scalar support.', schema({ connectionId, companyId, tableId }), 'getTableSchema'],
  ['read_records', 'Read 1-50 selected fields from an ordinary table in primary-key ascending order, at most 100 rows. Supports BC filter expressions and separate FlowFilters. Returns SystemId and string rowversion; decimal/BigInteger are strings, enum/option are ordinals, BLOB/Media are descriptors. Date/time use invariant wire values; other sorting is not yet supported. Continuation tokens expire after 30 minutes and bind target revision/company/query/client session. Pagination is not a snapshot; rowversion does not cover FlowField dependencies. Reduce selection/page size on response_too_large.', schema({ connectionId, companyId, tableId, fieldIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: fieldId }, filters, flowFilters: filters, pageSize, continuationToken: { type: 'string', minLength: 1, maxLength: 32768 } }, ['connectionId', 'companyId', 'tableId', 'fieldIds']), 'readRecords'],
  ['insert_record', 'Initialize and insert one company-local physical Normal record. Apply1-50 fieldId/value assignments in array order; identity is server-generated. Return persisted requested values/SystemId/version. Decimal/BigInteger use strings; enum/option use integer ordinals; null, system/content fields and unqualified FlowField writes are rejected.', schema({ connectionId, companyId, tableId, fields: assignments(50) }), 'insertRecord', true],
  ['modify_record', 'Modify one SystemId at the supplied expectedVersion. Apply1-50 ordered field assignments; omitted fields remain unchanged. Primary-key changes require rename. Return persisted requested values and the new version. Decimal/BigInteger are strings; null/content/system fields and unqualified FlowField writes are rejected.', schema({ connectionId, companyId, tableId, systemId, expectedVersion, fields: assignments(50) }), 'modifyRecord', true],
  ['delete_record', 'Delete one SystemId at the supplied expectedVersion with native OnDelete. Return minimal applied acknowledgement; no deleted values or fictitious post-delete version. Trigger effects on related records follow native permissions and transaction rules.', schema({ connectionId, companyId, tableId, systemId, expectedVersion }), 'deleteRecord', true],
  ['rename_record', 'Rename one SystemId at the supplied expectedVersion using every primary-key field in key order. Native dispatch supports up to16 components; the qualified runtime fixture covers a three-part GUID/Code/Integer key. Native relations/triggers decide the result; arbitrary relation cascades and other arities are not certified. Return persisted key values/SystemId/version.', schema({ connectionId, companyId, tableId, systemId, expectedVersion, primaryKey: assignments(16) }), 'renameRecord', true]
];
const dataTools = Object.freeze(definitions.map(([suffix, description, inputSchema, , mutation]) => ({
  name: `bc_data_${suffix}`, description: (mutation ? mutationPrerequisite : prerequisite) + description, inputSchema,
  annotations: { readOnlyHint: !mutation, destructiveHint: Boolean(mutation), idempotentHint: !mutation, openWorldHint: true }
})));
const dataMethods = Object.freeze(Object.fromEntries(definitions.map(([suffix, , , method]) => [`bc_data_${suffix}`, method])));
const mutationToolNames = Object.freeze(definitions.filter(item => item[4]).map(([suffix]) => `bc_data_${suffix}`));

// Validate at execution as well as advertising a schema: MCP clients need not
// enforce schemas, and extra endpoint/credential/operation inputs must fail.
function valid(value, rule) {
  if (rule.anyOf) return rule.anyOf.some(option => valid(value, option));
  if (rule.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    rule.required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => Object.hasOwn(rule.properties, key) && valid(value[key], rule.properties[key]));
  if (rule.type === 'array') return Array.isArray(value) && value.length >= (rule.minItems || 0) && value.length <= rule.maxItems &&
    (!rule.uniqueItems || new Set(value).size === value.length) && value.every(item => valid(item, rule.items));
  if (rule.type === 'integer') return Number.isSafeInteger(value) && value >= rule.minimum && value <= (rule.maximum ?? Number.MAX_SAFE_INTEGER);
  if (rule.type === 'string') return typeof value === 'string' && value.length >= (rule.minLength || 0) && value.length <= (rule.maxLength ?? Number.MAX_SAFE_INTEGER) && (!rule.pattern || new RegExp(rule.pattern).test(value));
  if (rule.type === 'boolean') return typeof value === 'boolean';
  return false;
}
function validateDataArguments(name, args) {
  const tool = dataTools.find(item => item.name === name);
  return Boolean(tool && valid(args, tool.inputSchema));
}
module.exports = { dataTools, dataMethods, mutationToolNames, validateDataArguments };
