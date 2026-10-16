# BC Data: agreed design and verification plan

Status (2026-10-16): companion read-only contract 1, bounded Node HTTP/1.0 transport, six opt-in read-only MCP tools, companion bundling, explicit initialization, independent opt-in provisioning and Windows stored-credential integration are implemented and exercised on dedicated BC23/BC27.1 targets. See the compatibility ledger for exact evidence and limits. Mutations and remaining compatibility experiments are pending.
Decision record: 2026-10-06.

## Purpose and scope

BC Data is an optional agent-facing capability within BC Dev Toolset. It exposes discovery and generic read, insert, modify, delete (RIMD), and rename operations through MCP and a bundled companion AL app. It is a general development capability for investigation, configuration, data maintenance, debugging, and other agent workflows; it is not restricted to testing.

The initial supported target is BC development containers. BC23 is the minimum compatibility baseline, with support required through at least BC27.1, including intervening major releases. This is a support target, not a claim of completed verification. Later releases should be accommodated without architectural redesign. Remote on-premises and online test environments are deferred. Native Microsoft MCP availability does not replace this capability or determine its connection path.

No alternative BC UI is planned. VS Code provides configuration, initialization, status, and diagnostics. Page objects and page execution are outside scope; this service will not reproduce business logic placed in pages. Generic table operations do not implicitly invoke posting or other separate business processes.

## Architecture

Open `../BC-Dev-Toolset.code-workspace` for the repository's multi-root development layout: repository root, `vscode-extension`, `al/BCData` (companion app), and `al/BCData.Tests` (separate test app). Use `BCData.Development.code-workspace` in an Extension Development Host for isolated MCP integration tests. The external BCQuality root supplies AL guidance. The companion and separate test app target BC23; dedicated BC23 and BC27.1 Test targets provide runtime evidence. Full compatibility verification, including intervening releases and concurrency, remains pending.

Ship one VS Code extension. Reuse Toolset's environment configuration, credentials, deployment machinery, workspace routing, MCP registration, and diagnostics rather than duplicating them in another product.

Keep these implementation boundaries:

1. Companion AL app: stable app ID, independent app version and service contract; metadata discovery, typed conversion, filters, record operations, concurrency, and request receipts.
2. Data client and tool handlers: direct HTTP calls, structured MCP inputs/results, target-scoped caching, errors, and retry handling. Keep these modules separate from VS Code UI and the PowerShell operation runner.
3. Toolset integration: resolve configured targets and credentials, provision the companion app, register tools, and expose configuration/status operations.

Implemented transport: a published codeunit with OData V4 unbound actions carrying structured JSON in Text parameters, called through bounded native Node HTTP/1.0 connection-close requests. This avoids the reproduced HTTP.sys unbuffered chunked-response failure without changing BC server settings. TLS retains normal certificate validation; live HTTPS qualification remains pending. The existing MCP server exposes six read-only `bc_data_*` tools behind default-off switches. Credential resolution and data execution stay inside the extension host; MCP forwards validated arguments through its authenticated workspace bridge.

Ordinary data calls must not launch a PowerShell operation per request. Deployment and upgrades use the existing Toolset deployment mechanisms. No dependencies on the developer's project apps belong in the companion app.

## Configuration and overhead

Two independent scopes are agreed; both default to disabled:

| Scope | Responsibility |
| --- | --- |
| Container configuration | Provision and maintain the companion app |
| Workspace MCP configuration | Expose data tools to agents |

Provisioning alone does not expose tools. Tool exposure alone does not silently install the app. A call against an uninitialized target returns actionable initialization information. An explicit Initialize BC Data Access operation can coordinate both scopes for the chosen container and current workspace.

Disabled workspaces perform no data connection checks, schema discovery, background polling, or data tool registration. Load the data module lazily. The bundled app adds VSIX size even when disabled. Follow existing MCP restart/refresh behavior when tool settings change.

Disabling provisioning stops automatic app maintenance. Disabling tools stops data activity and exposure. Neither uninstalls the app. Uninstallation is a separate explicit environment operation.

## Target identity and tool surface

Every record operation carries an explicit connection ID and company ID. IDs resolve through existing Toolset configuration; credentials never appear in tool arguments or results. Do not rely on a mutable active target. Capture the resolved environment context for each call, including concurrent calls.

Proposed tool names, with agreed responsibilities:

| Tool | Responsibility |
| --- | --- |
| `bc_data_list_connections` | Configured container targets and readiness |
| `bc_data_list_companies` | Companies within a selected connection |
| `bc_data_find_tables` | Paginated search by table ID, name, or caption |
| `bc_data_get_table_schema` | Fields, keys, and structural capabilities |
| `bc_data_read_records` | Selected fields, filters, sorting, and pagination |
| `bc_data_insert_record` | Single-record insertion |
| `bc_data_modify_record` | Single-record modification |
| `bc_data_delete_record` | Single-record deletion |
| `bc_data_rename_record` | Primary-key rename using BC semantics |

Table and field IDs are authoritative; names and captions aid understanding. Existing physical records are identified by SystemId. Tables that cannot satisfy this contract must report their limitations explicitly; do not claim universal SystemId support for virtual or special tables.

Tool descriptions must explain prerequisites, inputs, results, and semantics. Routine data calls require no interactive VS Code dialogs. Missing context is returned structurally for the agent to resolve.

## Discovery

Discover installed table metadata, including custom tables and extension fields, without per-entity API development. OData service metadata alone is not a catalog of all installed BC tables.

Table discovery includes identity and whether data is company-specific. Field schema includes ID, name, caption, AL type, length where applicable, Normal/FlowField/FlowFilter class, enum/option ordinals and captions, system-managed status, and obsolescence information. Include primary-key order, available sorting keys, and relation metadata where obtainable. Explicitly label unavailable or incomplete relation metadata; do not invent conditional relations.

Structural capability is not a promise of successful execution. Permissions, validation logic, field values, and record state remain authoritative. A Normal field is not automatically writable; FlowFields are not categorically unwritable.

Cache metadata within the resolved target context, including any identity/company distinctions affecting results. Provide explicit refresh and invalidate after Toolset app publication and container recreation/restoration. External changes require refresh or a future independently verified detection mechanism.

## Reads

Use BC-native filter expressions in structured field-ID entries. Different fields combine with AND; a field expression may contain BC ranges and alternatives. Reject malformed or ambiguous duplicate entries rather than silently replacing filters. FlowFilters are explicit and applied before calculating selected FlowFields.

Example proposed request:

```json
{
  "connectionId": "dev-container",
  "companyId": "<guid>",
  "tableId": 18,
  "fieldIds": [1, 2, 58],
  "filters": [{ "fieldId": 1, "expression": "10000..20000" }],
  "flowFilters": [{ "fieldId": 55, "expression": "2026-01-01..2026-12-31" }],
  "pageSize": 100
}
```

Require field selection, cap page size, and return selected values plus record identity and version. Sorting selects a table key and must be deterministic even when secondary-key values repeat. Continuation tokens are opaque and bound to target, company, and query. Responses indicate whether more records exist. Pagination does not promise snapshot isolation across calls when data changes.

Initial reads operate on one table per call; joins and aggregations are deferred. Agents may follow relations through additional calls. Exact limit values, token representation, and supported sorting combinations remain implementation decisions.

## Writes and rename

Expose BC table behavior faithfully, with field validation and table triggers enabled and no initial bypass switches. Apply insert/modify fields in their supplied array order. Initialize on insert. Omitted fields on modify remain unchanged. Reject ambiguous nulls and writes to system-managed fields. FlowFilters provide calculation context and are not persisted as ordinary field changes.

FlowField write-through is in scope where BC supports it. Verify behavior through FieldRef before defining its exact invocation contract. Do not emulate unsupported write-through by guessing a related table or bypassing validation. Return precise unsupported-operation errors when appropriate.

Rename is a dedicated operation, identified by SystemId, with ordered primary-key values and an expected-version token. Use BC rename semantics and verify trigger execution, related-record behavior, and post-rename identity. Ordinary modify must not silently turn into rename.

Require expected-version tokens for modify, delete, and rename. Verify the comparison and mutation form an effective concurrency boundary; a precheck alone is insufficient. Never retry a conflict using a freshly fetched version without the agent reconsidering the change.

Successful insert/modify responses include the resulting identity, version, and persisted values of requested fields; validation can normalize values. Rename returns resulting identity/key/version. Delete reports the deleted identity and outcome, not a fictitious new record version. Initial mutations affect one target record per call, while BC triggers may legitimately affect other records.

## Values and content

| AL type | Wire representation |
| --- | --- |
| Boolean | JSON boolean |
| Integer | JSON number |
| BigInteger / Decimal | String preserving precision; decimal separator `.` |
| Text / Code | String |
| GUID | Standard GUID string |
| Date | `YYYY-MM-DD` |
| Time | `HH:mm:ss.fff` |
| DateTime | UTC ISO 8601 string |
| Enum / Option | Integer ordinal, interpreted through schema |

Zero dates, times, and datetimes use `""`, distinguished by schema type. Closing dates use an explicit shape such as `{ "date": "2026-12-31", "closing": true }`. Reject null; use explicit type-appropriate empty/zero values to clear fields. Display captions are supplementary, never authoritative values. Other AL types need explicit mappings before being advertised as supported; no fallback to locale-dependent Format output.

BLOB, Media, and MediaSet reads return content descriptors. Dedicated content retrieval/mutation tools are deferred; ordinary RIMD must explicitly reject unsupported content changes rather than silently drop them.

## Errors, outcomes, and retries

Errors carry a stable category, original BC message, available table/field context, correlation ID, and outcome: not applied, applied, or unknown. Categories include invalid input, permission denied, record not found, validation failure, concurrency conflict, connection failure, and incompatible companion app. Add unsupported-operation classification where necessary. Do not claim rollback merely because an HTTP request failed.

All mutations carry request IDs. The intended receipt contract is:

- Same request ID and same payload returns the recorded result without re-execution.
- Same ID with different payload is rejected.
- Scope requests to resolved environment/company and an appropriate identity boundary.
- Commit mutation and receipt together wherever transaction behavior permits.
- Do not automatically resubmit an uncertain write with a new ID.

The companion app needs a receipt table and bounded retention. Retention duration and handling of expired IDs must be specified before claiming retry guarantees. Concurrent duplicate calls, permissions on receipt replay, restoration, and explicit or implicit commits require experiments. Universal exactly-once execution is not promised. Triggers may have external effects beyond a database transaction.

## Authentication and app lifecycle

Reuse the selected container's configured BC credentials. Data calls run as that BC identity and honor its permissions and security filters. Companion permissions cover service execution and the app's own setup/receipt data; do not grant blanket elevation over business tables. Provisioning privileges remain separate from data-operation permissions. Connectivity diagnostics identify the connected principal without exposing credentials.

Bundle a compiled app and compatibility manifest. Initialization inspects installed state and negotiates service capabilities. Install if absent; upgrade when required; accept compatible newer versions without downgrading shared containers. Reject incompatible contracts with corrective instructions. The exact stable app ID and object range must be allocated before implementation.

Reconcile actual installed state following recreation/restoration. Updating Toolset changes the bundled artifact; deployment occurs during explicit initialization or enabled container preparation, not unexpectedly during a data call. Prefer one BC23-compatible app across the range unless experiments demonstrate a need for variants.

## Verification gates and implementation sequence

1. Execute the [compatibility experiments](BCDataCompatibilityExperiments.md) and record exact platform/application builds and results.
2. Resolve gaps exposed by the experiments; finalize schemas, limits, concurrency, and retry guarantees.
3. Build the companion app and its AL regression tests, then the direct HTTP client and MCP contract tests.
4. Integrate opt-in settings, provisioning, tool exposure, and packaging. Update operation metadata, command contributions, MCP schemas, documentation, and the MCP definition revision together.
5. Verify the complete loop on BC23 and BC27.1, then intervening majors. Verify disabled behavior and existing Toolset regression tests.

Do not mark support verified from compilation alone. Runtime tests must assert database effects and error outcomes. Each compatibility experiment should become a regression test. Any remediation of a user-reported discrepancy must include a directly covering regression test in each affected project.

## Current evidence and limits

Repository inspection found existing integration points in `vscode-extension/extension.js`, `mcp-server.js`, `mcp-bridge-identity.js`, `mcp-tool-settings.js`, and `build/prepare-runtime-package.js`. These are reuse candidates; no runtime implementation changed as part of this design record.

Microsoft documents OData unbound codeunit actions, SystemRowVersion, and CommitBehavior, but documentation does not establish all generic behaviors or cross-version compatibility. In particular, CommitBehavior does not cover implicit commits from Codeunit.Run; it is not sufficient evidence for universal atomic receipts.

- [OData V4 unbound actions](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-creating-and-interacting-with-odatav4-unbound-action)
- [Table system fields](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-table-system-fields)
- [CommitBehavior attribute](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/attributes/devenv-commitbehavior-attribute)

At creation of this record, no BC Dev Toolset build/test/workspace tools were exposed in the agent session, and no AL app manifest or AL workspace was found in this tooling repository. Container experiments have not run. Use a dedicated AL experiment workspace and the Toolset build/test MCP operations once available; do not treat this repository as a consuming AL workspace or bypass an MCP failure with manual container/compiler commands.
