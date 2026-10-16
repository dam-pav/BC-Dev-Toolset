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
const definitions = [
  ['list_connections', 'List configured Dev/Test containers without connecting or checking installed state. Configuration names are connection IDs; ambiguous names cannot be used.', schema({}), 'listConnections'],
  ['list_companies', 'List company GUIDs/names for an explicit connection before selecting a company.', schema({ connectionId }), 'listCompanies'],
  ['get_readiness', 'Check companion contract, app version and advertised capabilities for an explicit connection/company.', schema({ connectionId, companyId }), 'readiness'],
  ['find_tables', 'Search installed table names/captions literally (numeric ID search is pending). Page using returned afterId with the same query. Structural support does not guarantee permission.', schema({ connectionId, companyId, query: { type: 'string', maxLength: 100, default: '' }, afterId: { type: 'integer', minimum: 0 }, pageSize }, ['connectionId', 'companyId']), 'findTables'],
  ['get_table_schema', 'Discover installed fields, extension fields, keys and enum ordinals. Relations/obsolescence details are explicitly unavailable in this slice. readSupportedInSlice governs scalar support.', schema({ connectionId, companyId, tableId }), 'getTableSchema'],
  ['read_records', 'Read 1-50 selected fields from an ordinary table in primary-key ascending order, at most 100 rows. Supports BC filter expressions and separate FlowFilters. Returns SystemId and string rowversion; decimal/BigInteger are strings, enum/option are ordinals, BLOB/Media are descriptors. Date/time types and other sorting are not yet supported. Continuation tokens expire after 30 minutes and bind target revision/company/query/client session. Pagination is not a snapshot; rowversion does not cover FlowField dependencies. Reduce selection/page size on response_too_large.', schema({ connectionId, companyId, tableId, fieldIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: fieldId }, filters, flowFilters: filters, pageSize, continuationToken: { type: 'string', minLength: 1, maxLength: 32768 } }, ['connectionId', 'companyId', 'tableId', 'fieldIds']), 'readRecords']
];
const dataTools = Object.freeze(definitions.map(([suffix, description, inputSchema]) => ({
  name: `bc_data_${suffix}`, description: prerequisite + description, inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
})));
const dataMethods = Object.freeze(Object.fromEntries(definitions.map(([suffix, , , method]) => [`bc_data_${suffix}`, method])));

// Validate at execution as well as advertising a schema: MCP clients need not
// enforce schemas, and extra endpoint/credential/operation inputs must fail.
function valid(value, rule) {
  if (rule.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    rule.required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => Object.hasOwn(rule.properties, key) && valid(value[key], rule.properties[key]));
  if (rule.type === 'array') return Array.isArray(value) && value.length >= (rule.minItems || 0) && value.length <= rule.maxItems &&
    (!rule.uniqueItems || new Set(value).size === value.length) && value.every(item => valid(item, rule.items));
  if (rule.type === 'integer') return Number.isSafeInteger(value) && value >= rule.minimum && value <= (rule.maximum ?? Number.MAX_SAFE_INTEGER);
  if (rule.type === 'string') return typeof value === 'string' && value.length >= (rule.minLength || 0) && value.length <= (rule.maxLength ?? Number.MAX_SAFE_INTEGER) && (!rule.pattern || new RegExp(rule.pattern).test(value));
  return false;
}
function validateDataArguments(name, args) {
  const tool = dataTools.find(item => item.name === name);
  return Boolean(tool && valid(args, tool.inputSchema));
}
module.exports = { dataTools, dataMethods, validateDataArguments };
