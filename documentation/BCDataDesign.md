# BC Data: agreed design and verification plan

Status (2026-10-20): read contract1 remains compatible; companion0.1.10.0 adds separate mutation protocol1/service and an opt-in write permission set. Generic RIMD, receipt composition, native users/filters and the public Node client have dedicated BC23/BC27.1 AL/direct-HTTP evidence. Four new default-off MCP write tools have source/bridge tests; live development-binding verification requires refreshing the running Extension Development Host/MCP. See the compatibility ledger for exact evidence and limits. Intervening versions, arbitrary rename relations/arities and supported FlowField write paths remain pending.
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

Implemented transport: a published codeunit with OData V4 unbound actions carrying structured JSON in Text parameters, called through bounded native Node HTTP/1.0 connection-close requests. This avoids the reproduced HTTP.sys unbuffered chunked-response failure without changing BC server settings. TLS retains normal certificate validation; live HTTPS qualification remains pending. The MCP server defines six read-only and four mutation `bc_data_*` tools behind individual default-off switches; mutation execution uses the separate BCDDataWrite service and permission boundary. Credential resolution and data execution stay inside the extension host; MCP forwards validated arguments through its authenticated workspace bridge.

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
| DateTime | UTC ISO 8601 string, `YYYY-MM-DDTHH:mm:ss.fffZ` |
| Enum / Option | Integer ordinal, interpreted through schema |

Zero dates, times, and datetimes use `""`, distinguished by schema type. Closing dates use an explicit shape such as `{ "date": "2026-12-31", "closing": true }`. Reject null; use explicit type-appropriate empty/zero values to clear fields. Display captions are supplementary, never authoritative values. Other AL types need explicit mappings before being advertised as supported; no fallback to locale-dependent Format output.

Read encodings describe the values persisted by BC. SQL storage can round Time/DateTime fractions, so eventual mutation responses must reread and report persisted values instead of echoing inputs. E11 observed a Time input of 23:59:59.999 persisting as defined midnight; precision-preserving text transport cannot undo storage normalization. Arbitrary-millisecond write round trips remain unqualified.

Decimal reads use invariant JSON serialization of the native Decimal, then return its canonical text as a string. Standard XML Format rounded a persisted 0.00000000000000000001 to zero on BC23; the regression now requires exact positive and negative strings. Native parsing and SQL storage impose separate limits: E11 distinguishes parsing normalization of wider significant-digit inputs from storage rounding at 21 fractional places. This qualifies the tested persisted values, not arbitrary Decimal write precision. Actual HTTP Accept-Language requests qualify invariant read scalars under en-US, de-DE and sl-SI; service-time-zone permutations remain pending.

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

E07 now has four passing single-session probes on BC23 and BC27.1. Error policy rejects explicit commits; Ignore suppresses them, changing execution behavior. Boolean Codeunit.Run can still commit a fixture mutation under Error policy before a later receipt-stage error. These tests do not qualify behavior with an already active write transaction, independent HTTP visibility, or receipt races. Mutation implementation remains gated on those experiments; silently suppressing trigger commits is not an accepted remedy.

The subsequent E07 batch adds five receipt-first probes and seven HTTP scenarios on both targets. Writing a fixture receipt before invoking user code, within CommitBehavior Error, permits ordinary mutation/receipt success and rolls both back on a later error. Boolean Codeunit.Run after that write stops the transaction, and explicit Commit is rejected; separate HTTP inspections find neither row. The unanchored controls still leave a mutation without a receipt. This supports starting the actual receipt write before any user-trigger execution and rejecting commit-using paths. It does not qualify arbitrary triggers, isolated execution, external effects, duplicate-ID races, replay permissions or response-loss recovery. HTTP Internal_ServerError and native DB:Ok alone must not be mapped to not-applied; these outcomes were established by fixture-state inspection.

E06 now qualifies a fixed integer-counter receipt prototype on BC23 and BC27.1: unique-key Boolean Insert before mutation, committed lookup on duplicates, canonical payload comparison, and exact stored-result replay. Overlapping same-ID requests apply once; mismatched payloads are rejected; distinct IDs preserve both counter updates. Independent observer sessions prove the owner is still pending before competitor submission. A loopback proxy discards a complete committed response; same-ID retry returns that result without repeating the mutation. These are test-app fixtures under one administrator identity. They support the transaction/replay approach for that operation, while receipt permissions, identity/company boundaries, retention/restoration, generic mutations and arbitrary trigger effects remain gates. Dirty-read observation and cache refresh are test instrumentation, not part of production replay semantics.

The subsequent E06/E12 batch qualifies that fixture under separate users and live permission changes on both targets. Cross-owner service calls are rejected, and native Principal security filters hide other users' receipts. Historical replay succeeds after counter Modify is revoked while current Read/ownership and receipt permissions remain sufficient; new mutations still fail. Counter Read revocation blocks result disclosure. The current insert-first protocol also requires receipt Insert for replay, so receipt Read alone is insufficient. These measured semantics do not yet define generic delete/rename replay authorization or a public receipt-status API. Minimal roles also need execution of native insert-path components: codeunit 7233 on the measured baseline, plus 36951 Initialization when present on BC27.1. Native permission status/body differences and post-error state must be handled deliberately when implementing production mutations.

E04's dedicated fixture identifies rows by SystemId and carries expected versions as canonical BigInteger strings. The candidate mutation path locks, rereads and checks that version in the same transaction as the write. Its preliminary check is only an early rejection; it cannot replace the protected comparison. On both BC23 and BC27.1, independent HTTP scenarios prove a competing write commits after the first check and before the protected reread; protected modify/delete/rename then reject the stale token and preserve the competing row. A deliberately unchecked control demonstrates the lost update when the second comparison is omitted. This stage qualifies a simple fixture without receipts or arbitrary business triggers; combining receipt-first reservation, replay-before-stale-check semantics and these protected mutations remains a separate gate. That combined fixture must prove a new stale request leaves no pending receipt, historical replay survives its original token becoming stale, and a fresh retry applies once. Parent rowversion still provides no protection for child changes underlying FlowFields.

The subsequent E04/E06 composition fixture qualifies that ordering for a fixed modify operation on both targets. Receipt reservation precedes target lookup/version checks; completed identical requests replay their exact stored historical result before checking the now-stale token. Canonical payload identity includes SystemId, expected version and amount, so changing any of them for a completed ID is rejected. A new stale request or injected post-mutation failure rolls back its receipt, row and apply count. Same-ID races replay once; different IDs competing on one version leave one completed receipt and a conflict for the loser, whose fresh-version same-ID retry can then apply once. These administrator-only fixture results do not qualify target Read revocation, missing/deleted-target replay authorization, generic RIMD triggers, receipt expiry/restore or company boundaries. Production mutations remain disabled.

The next fixture revision adds a conservative modify-result disclosure policy: a completed receipt returns its historical result only when the caller can currently read the original SystemId in the owned run. A security-filtered ReadCommitted RecordRef checks visibility without requiring the original version to remain current. On both targets, Permissions Mock verifies Read revocation blocks disclosure, restoring Read returns the exact result, and losing Modify still permits replay while denying new writes. Administrator HTTP checks reject deleted and same-primary-key replacement targets without erasing their completed receipts; renames preserve identity and permit exact historical replay. Disclosure denial must not be reported as proof the earlier mutation was not applied. Separately authenticated target-permission changes and dynamic row filters still need qualification, and deletion receipts require a distinct authorization policy because their original target is absent by design. No production write or receipt-status contract is enabled.

Separately authenticated HTTP checks now qualify that modify policy on BC23 and BC27.1 under the same owner's live role changes. Target Read-only permits exact replay while new mutation requires Modify; revoking target Read blocks replay and inspection. Moving the target outside a native Amount=4 security filter blocks stored-result disclosure while preserving its completed receipt, and moving it back restores exact history despite the current version changing. Another principal cannot operate on the owner's run or execute administration. This evidence covers the stated fixture roles and fixed predicate, not generic business-table permissions or all filter compositions. Delete/rename receipt policies, receipt retention/restore, company boundaries and arbitrary trigger/external effects remain separate gates; production writes remain disabled.

Two-company administrator HTTP checks now establish company-local target/receipt behavior on BC23 and BC27.1. Reusing the same principal/run/request IDs across the existing and a new empty company produces independent results and counts. Foreign payloads, targets and versions cannot cross those boundaries; later mutation or cleanup in one company leaves the other receipt and historical replay intact. The read client reports the selected company, returns only its fixture rows, binds continuation tokens to it and rejects a missing explicit company; unknown company GUIDs do not fall back to existing state. Company-specific restricted-user grants, tenant separation and company rename/copy/restore remain unqualified. This evidence supports the explicit-company design without enabling production mutations or extending receipt deduplication guarantees across copied/restored companies.

Company-scoped authenticated tests now qualify live grants and revocation for the fixed modify fixture and actual read client on both targets. Each identity starts with explicit access to one company; granting the owner a second company permits independent history there, revoking the original blocks reads/new writes/replay of its existing receipt, and restoration returns both exact histories without another mutation. Retained-company access and other-principal ownership checks remain intact. The System execute-only permission set definition is unchanged; test-only exact-key administration removes its company assignment because the measured BC23 native removal forms selected mismatched scope/app-ID predicates. Native company-filter failures are conservatively surfaced as bc_error by the read client rather than universally treated as permission-denied. These results establish the measured roles/companies, not tenant isolation, copy/restore semantics or generic business-trigger authorization, and production mutations remain disabled.

- [OData V4 unbound actions](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-creating-and-interacting-with-odatav4-unbound-action)
- [Table system fields](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-table-system-fields)
- [CommitBehavior attribute](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/attributes/devenv-commitbehavior-attribute)

At creation of this record, no BC Dev Toolset build/test/workspace tools were exposed in the agent session, and no AL app manifest or AL workspace was found in this tooling repository. Container experiments have not run. Use a dedicated AL experiment workspace and the Toolset build/test MCP operations once available; do not treat this repository as a consuming AL workspace or bypass an MCP failure with manual container/compiler commands.

The qualified fixed-destination rename prototype extends only the test receipt fixture to the fixed key `RENAMED`. Receipt identity binds the operation, SystemId, expected version and fixed destination; rename does not use modify's amount. The same transaction reserves the receipt, locks and rechecks the target, performs rename, increments apply count and stores the exact result. Historical replay requires the current target to remain readable by its stable SystemId; a later version does not invalidate that completed history. A failed rename transaction must restore the key, version, count and reservation together. This is separate from delete replay, where the target is intentionally absent and an explicit disclosure policy is still required. Arbitrary key schemas, related-table rename effects and independently authenticated rename permission/filter transitions remain gates.

On BC23 and BC27.1, test app 0.1.17.0 passes 65 AL tests and fourteen EV HTTP scenarios per target. The added HTTP cases confirm preserved identity and changed version, exact rename history after a later modify, operation-bound request identity, rollback and fresh retry, and an overlapping identical-ID rename applied once. All scoped test state was removed and verified. This evidence does not enable production writes or establish the remaining generic rename/deletion policies.

The qualified rename authorization fixture uses the same temporary principal across full, target Read-only, no target Read, key-filtered Read and restored-full profiles. The key-filtered role reads only `Name=RENAMED`. A test-only administration action moves the marked owner's target between ORIGINAL and RENAMED while retaining SystemId, completed receipts and apply count. This separates current row visibility from historical receipt identity. Before testing fresh-rename denial without Modify, the administrator restores ORIGINAL so the request must change a key. The same current-target Read guard remains the replay policy; successful deletion still requires a separate policy because it removes that target. These fixture results do not define authorization for arbitrary business keys or related-record effects.

Test app 0.1.18.0 passes 67 AL tests, sixteen real-user rename authorization checks and sixteen modify regression checks on each of BC23 and BC27.1. Completed rename replay requires current target Read/visibility but not Modify; a fresh key-changing rename without Modify is denied. Moving the stable SystemId outside `Name=RENAMED` blocks result disclosure without erasing its receipt; restoring visibility returns exact history despite newer row versions. All temporary data/users/roles were removed and verified. Production mutations remain disabled.

The qualified fixed-key insert prototype reuses receipt-first execution and current-target replay authorization for a fixed ORIGINAL key. It takes a caller-supplied nonzero SystemId so mutation identity can bind to a known row identity before execution; this is a test design choice, not a generic business-table insertion contract. The canonical payload binds operation, SystemId, fixed key and amount, and rejects expectedVersion because the target does not yet exist. The receipt and insertion commit together, with persisted-state readback before result storage. A later modification must not replace the historical insertion result, while deletion or a new same-key identity must block disclosure of that old result. Duplicate IDs must replay before attempting another insert; a failed new insertion must roll back its receipt so the same request can be retried after the conflicting target is removed.

[Microsoft's Record.Insert documentation](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-insert-boolean-boolean-method) defines the RunTrigger and InsertWithSystemId options used by this fixture. The runtime experiments, rather than that API signature alone, must establish transaction and replay behavior on each tested version. Native restricted-user Insert authorization, arbitrary keys/field validation, related-record/trigger effects and retention/restore remain separate gates.

Test app 0.1.19.0 passes 70 AL tests and nineteen EV HTTP scenarios per BC23/BC27.1 target. The insertion cases establish persisted caller identity, historical replay after modification, rollback and retry, receipt rollback on identity/key conflicts, visibility denial for deleted/replacement targets, and one apply under overlapping identical insert IDs. Mismatched duplicate payloads are rejected. All test state was removed and verified. Native restricted-user Insert permissions and generic business-table insertion remain unqualified; production mutations are disabled.

The insert authorization fixture separates target Insert rights from receipt Insert rights. Its Read-only target profile still has the existing receipt RIMD rights required by the reservation-first replay protocol. A completed insert may replay only while the original SystemId remains currently readable. A fresh insertion with a different request ID/SystemId must still require target Insert. To isolate that permission check from uniqueness conflicts, the administrator moves the existing row from ORIGINAL to RENAMED before the attempt, then restores its key while retaining identity and history. The Amount=4 visibility profile moves that same target outside/inside a native Read filter without rewriting its receipt or apply count. This is the fixed fixture's policy, not a public receipt-status or arbitrary business-table contract.

Test app 0.1.20.0 passes 72 AL tests and sixteen real-user HTTP authorization checks in each of insert/modify/rename modes on BC23 and BC27.1. Insert replay is available with current target Read and no target Insert; a fresh insertion with a free key and new identity is denied without Insert and leaves no new target/receipt/apply. Native Read revocation and Amount-filter disappearance block history, while restored visibility/rights return exact history despite current version changes. All fixture data/users/roles were removed and verified. One BC27.1 rename regression encountered an unexplained local Node phase-process exit after fifteen passing checks; its evidence is preserved and an unchanged-source full rerun passed. Production mutations remain disabled.

Delete receipt policy prototype: store/replay only the caller's minimal transaction acknowledgement (request/result IDs, deleted SystemId, applied outcome and fixture apply count). No historical business fields/key snapshot or new row version is disclosed. Authorize replay through current native access to the company-local principal-scoped receipt plus run ownership; do not look up an intentionally absent business row. Losing business-table Read/Delete does not erase the caller's acknowledgement, while losing receipt Read blocks it. This differs from insert/modify/rename results, whose stored business values still require current original-target visibility. Same-ID replay must never act on a same-key replacement or be represented as a new delete. Current row security filters cannot validate an absent record; the prototype therefore returns only acknowledgement metadata and retains no replayable deleted row image.

The fixture's fresh-delete path retains the protected expected-version check and native target rights; receipt reservation precedes all mutation code. Generic production writes remain disabled. Receipt retention/restoration, generic trigger/related-record effects, broader company/tenant permutations and the intervening-version matrix remain separate gates.

The minimal delete acknowledgement policy is qualified in test app 0.1.21.0 on BC23/BC27.1: 77 AL tests, twenty-four core HTTP scenarios and sixteen independently authenticated delete authorization checks per target. Native receipt Read revocation denies history and restoration returns the exact acknowledgement; loss of business Read/Delete does not block that acknowledgement. Fresh deletion still requires native Delete, and historical replay preserves a same-key replacement's identity/version. All temporary data/users/roles were removed and verified. Receipt lifetime/restore and generic business effects remain gates; production writes are disabled.

E08 issue confirmed on BC23 in test app 0.1.22.0: deleting a completed fixture receipt while retaining the mutation allows the identical request ID/payload to execute again, changing counter total 4 to 8 with two applies. The 78-test suite includes a passing negative control that asserts this hazard and verifies cleanup; it does not implement expiry or certify restore semantics. The experimental algorithm currently distinguishes new/completed IDs only by receipt presence. Before adding receipt purge or production writes, require an expiry-aware request scope/generation that rejects forgotten/retired history before execution, and define outcomes that preserve uncertainty about prior application. Restoration/copy needs separate generation/invalidation qualification. Work paused at this reproduced issue under the user's autonomous-work instruction; BC27.1 was not rerun for the new diagnostic control.

Expiry-aware prototype (test app 0.1.23.0): Prepare issues a fresh server epoch and fixed 60-second deadline for a principal/company-local run. Every scoped mutation carries that epoch. Validation before receipt reservation and before a new mutation completes rejects missing, retired and expired scopes. Expired receipt cleanup retains scope metadata and applied state, so an absent receipt cannot reopen execution. Recreating the run issues a new epoch, and old tokens cannot be used against a legacy unscoped run either. Scoped execution, expiry and purge share a run-first lock order. The fixed duration is test configuration, not a chosen production retention period.

Expiry errors preserve uncertainty about historical application. Completed results cease to be replayable after the deadline, even if their receipts are temporarily retained. An agent must not convert an old request to a fresh scope/new ID automatically. The original unscoped counter remains an unsafe control; production write tools do not expose it. This prototype does not certify database restore/copy: restoring both the generation and receipts can rewind the guard itself. Native scoped-user authorization, restoration generation handling and production integration remain separate gates.

Expiry-aware test app 0.1.23.0 passes 82 AL tests, six E08 HTTP cases and twenty-four core receipt regressions per BC23/BC27.1 target. The scoped endpoint rejects legacy contexts; expired purged scopes and retired/missing generations do not reapply. A second check rolls back work crossing its deadline, and observed duplicate/purge interleavings preserve active history. This qualifies the candidate scope protocol under an administrator, not production write exposure, native scoped-user permissions or restoration. One local Node process exit was recovered through scoped cleanup and an unchanged-source rerun.

Actual BC23 and BC27.1 SQL restoration now establishes the within-window negative control in test app0.1.24.0. BC23 restored through Toolset MCP after explicit approval. BC27.1's administration dependency failure persisted after restart/helper update and needed separately approved native SQL recovery; the restore tooling defect remains unresolved. On both targets, unchanged principal/epoch/deadline coexisted with zero counters/receipts after rollback; the identical request executed again with a new result ID. Already-expired companion scopes rejected old/new IDs after purge. Both owned scope sets were cleaned and independently verified, with service readiness restored. See [the qualification record](BCDataRestoreQualification.md) for paths, timing and exact results. These are negative controls demonstrating the hazard, not restore-safe retry certification.

The supported initial retry contract is limited to one explicit tool operation and uninterrupted database history. Pending commands are not queued or automatically carried into later tool operations; clearing local pending state does not cancel work already executing in BC. A lost response preserves an unknown outcome until reconciled. Durable receipts are separate from that local pending state and must not be removed while their retry window is usable. Never silently resubmit an uncertain command under a fresh ID/scope.

The user clarified that backup/restore is administrative test infrastructure, outside regular BC Data usage. Automatic retry continuity across an externally initiated restore/copy is outside the initial supported contract and is not a gate on RIMD implementation. The experiment rolled back both the original mutation and its receipt, then applied the command once in restored history: counter0 became4, not8. Calling that a duplicate persisted database mutation overstated the evidence. External effects and the intention to reissue an old command after recovery are separate concerns. An independently maintained recovery generation would be an optional future capability for a broader contract, not a prerequisite for ordinary RIMD.

Continue implementation with ordered native validation/triggers, generic typed values, expected-version protection, native permissions/security filters, and atomic mutation/receipt composition. Production exposure remains gated on those operation-specific implementation and verification steps. No further backup/restore investigation is required for RIMD development; the administration assembly failure remains a separate Toolset issue.

Implementation decision2026-10-20: retain read contract1 and add capability mutation-scopes-v1/mutationProtocolVersion1 rather than breaking existing read clients. Registration preserves BCDData and separately registers BCDDataWrite, rejecting collisions for either name. BCD DATA EXECUTE remains read-service execution only; BCD DATA WRITE grants the mutation objects and own receipt table but no blanket business-table rights. Generic record/schema access excludes the receipt table, and discovery labels that boundary. Readiness advertises structural availability, not current native rights or tool exposure.

The Node client generates a new UUID for each explicit tool operation, captures one target and frozen payload before awaits, and prepares a server-issued five-minute epoch/deadline. Only uncertain target HTTP transport/invalid-response failures may cause one identical in-call Execute retry. There is no cross-call queue/resume, automatic fresh version, replacement ID or attempt to continue across external restore/copy. A new MCP tool invocation is a new command, including after an unresolved old invocation; agent descriptions forbid blind repetition. Successful or known-not-applied calls close their scopes; failed close confirmation never changes applied to not_applied. Unknown calls preserve server history and return request/epoch/deadline diagnostics for reconciliation. Generic server/native errors (including DB:Ok) do not prove rollback; only qualified companion rejection semantics classify a submitted mutation as not_applied. External trigger effects remain outside the database guarantee.

Foreground Prepare removes at most64 already expired scopes for the current principal/company, with an owned-expiry index. Active history is retained even after Close; no background work runs when tools are disabled. Execution never prepares missing state or rewrites an old epoch. Initial production tool schemas intentionally do not accept a request-resume ID/epoch; direct protocol callers must retain the original epoch for retry and must not treat a fresh Prepare as an automatic continuation of an uncertain operation. Full compatibility and remaining operation-specific limits stay visible rather than inferred from a passing three-part fixture.
Expiry is the execution/retry cutoff. Physical collection occurs on a later preparation by that principal or explicit administration; expired rows belonging to an inactive principal can remain stored. No immediate wall-clock deletion guarantee is claimed.
