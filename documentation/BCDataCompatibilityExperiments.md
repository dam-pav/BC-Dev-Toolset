# BC Data compatibility experiments

Status (2026-10-15): initial six-test batch passed on BC27.1; BC23 baseline success confirmed by the user. E01 HTTP transport and remaining experiments are pending. Older entries below are historical, including resolved symbol and MCP blockers.
Related requirements: [BC Data design](BCDataDesign.md).

## Execution prerequisites

Use the AL experiment workspace with dedicated disposable development containers, as requested by the user. Do not reuse unrelated project containers or business tables for mutation fixtures. The initial targets must be separate BC23 and BC27.1 containers. Allocate test object IDs and use the existing Toolset build/publish/test workflow. Discover workspace, package-cache, and assembly context before compiling. Never use runtime-package creation as a compile substitute.

Run first on BC23 and BC27.1. Repeat on BC24, BC25, BC26, and BC27.0 before claiming the complete range. Record exact platform and application versions, localization, compiler version, fixture version, and authentication mode. A container label alone is insufficient evidence.

Fixtures should include a parent table with composite primary key, duplicate secondary-key values, typed scalar fields, FlowFilters and several FlowField formulas; a child table with a relation; a table extension and enum extension; and trigger instrumentation. Separate mutation fixtures should exercise validation failure, explicit commit, and relevant implicit-commit paths. Keep cleanup scoped to fixture records.

Implement assertions in AL test codeunits for database semantics and bridge integration tests for HTTP outcomes, serialization, lost responses, and concurrency. Where independent sessions are required, ordinary sequential AL tests are insufficient. Every fix prompted by a failed experiment needs a regression assertion reproducing that failure.

## Experiment matrix

| ID | Setup and action | Required evidence / assertions |
| --- | --- | --- |
| E01 Transport | Publish a minimal codeunit action; pass JSON with Unicode, escaping, empty strings, and typed values through Text. Exercise a deliberate AL error. | Exact request/response envelope, company context, authentication, error shape, and payload behavior on each version. No assumption of custom HTTP status control. |
| E02 FlowField writes | Use Sum plus representative Lookup/Count/etc. fixtures. Compare typed-record and FieldRef paths; vary FlowFilters, existing/no matching child rows, and validation. Reopen affected records. | Which paths actually persist changes, resulting child records and calculated value, fired triggers, errors, rollback, and permission behavior. A changed in-memory value alone is not success. No blanket FlowField rejection. |
| E03 Rename | Rename a composite key with mixed types via the generic path; exercise duplicate target key, validation/OnRename failure, and dependent relations. | Exact supported generic invocation, key ordering/arity limits, OnRename behavior, unchanged SystemId where supported, persisted new key, related effects, rollback, and useful failures. |
| E04 Concurrency | Read a token; modify from a second session; attempt stale modify/delete/rename. Also interleave writes after the first session's version check. | One stale operation fails without overwriting intervening changes. Capture locking/transaction technique and freshly reread token. Verify SystemRowVersion access on BC23 rather than assume its field number. |
| E05 FlowField concurrency | Read parent plus FlowField; change child data without modifying the parent; attempt write-through using the earlier token. | Determine whether parent rowversion is insufficient and specify related-data concurrency or a disclosed unsupported combination. Do not advertise protection the token cannot provide. |
| E06 Receipts | Repeat insert/modify/delete/rename with identical ID/payload; race two sessions; reuse ID with another payload; lose HTTP response after commit. | Exactly one mutation within the supported transaction boundary; stable replay result; mismatch rejection; no second write after response loss. Verify receipt visibility/permissions and ID scoping. |
| E07 Commit boundaries | Trigger explicit Commit, implicit Codeunit.Run behavior where applicable, and errors before/after commit; test candidate CommitBehavior strategies. | Persisted mutation and receipt state at every failure point. Identify paths incompatible with atomic receipts. Do not silently suppress commits or claim not-applied when partial effects remain. |
| E08 Receipt lifetime | Expire receipts, replay old IDs, restore a fixture database, and repeat a previously used request. | Defined retry window and restoration/expiry behavior. Ensure old requests are not represented as indefinitely deduplicated. |
| E09 Pagination | Use duplicate sort values, composite keys, ascending/descending order, special characters, and empty values. Page with 1, exact boundary, and larger limits. | All static records exactly once in deterministic order. Reject target/query/token mismatches. With concurrent insertion/deletion/key changes, document actual behavior without promising a snapshot. |
| E10 Metadata | Discover fields added by an extension, noncontiguous enum ordinals, option members, obsolete fields, global tables, and simple/conditional relations. | IDs/types/keys accurate; no ordinal-index confusion; unavailable relation details reported explicitly. Refresh after install/upgrade/uninstall and container restoration. |
| E11 Scalar round trips | Round-trip all agreed types, precision boundaries, Unicode, empty values, closing dates, time fractions, and UTC timestamps under differing language/region settings. | Exact invariant encodings, preserved precision, type-appropriate clearing, rejected null/overflow, and no locale-dependent Format fallback. Verify Code normalization. |
| E12 Permissions | Use identities with limited R/I/M/D rights, security filters, and no related-table write permission. Replay receipts across identities. | No elevation or security-filter bypass; appropriate failure without credential leakage. Check rename and FlowField side effects separately. |
| E13 Ordered validation | Instrument field/table triggers; apply dependent fields in different orders, omitted values, explicit clears, and failures. | Supplied order preserved, initialization semantics confirmed, expected triggers run, requested persisted values returned, and errors do not trigger weaker retries. |
| E14 Special tables/content | Request virtual/system tables, unsupported AL types, BLOB/Media/MediaSet descriptors, and company-independent tables. | Capabilities and limitations explicit; unsupported writes rejected, no silent coercion, no claim every table has ordinary physical-record semantics. |

## Toolset integration regression gates

- Disabled configuration exposes no data tools, loads no data client, makes no data requests, and leaves ordinary initialization unchanged.
- Provisioning-only and tools-only configurations behave independently; tools-only uninitialized targets produce corrective instructions.
- Two windows/workspaces and concurrent agents remain bound to their requested target and company.
- Install absent app, upgrade older app, retain compatible newer app, and reject incompatible app without downgrade.
- Recreate/restore target and resolve fresh installed state, connection identity, and schema state.
- Tool settings follow existing discovery/restart behavior; disabled calls are rejected as well as omitted from tool lists.
- No credentials in arguments, responses, diagnostic logs, or receipt payloads.
- Package manifest and bundled app agree; ordinary data operations use HTTP rather than a terminal operation per call.

## Result ledger

| Target | Compile | Runtime experiments | Outcome |
| --- | --- | --- | --- |
| BC23 | Baseline test run succeeded (user confirmation); compiler details not captured | Initial six-test batch; detailed report unavailable | Partial evidence; no full compatibility claim |
| BC24 | Not run | Not run | Pending |
| BC25 | Not run | Not run | Pending |
| BC26 | Not run | Not run | Pending |
| BC27.0 | Not run | Not run | Pending |
| BC27.1 | Build/deployment completed for test run | Initial batch 6/6 passed; Application 27.1.41698.41776 | Partial E02/E03/E05/E13 only |

Reconciled 2026-10-15 from `feature/platform-test-suites` / `documentation/PlatformTestSuitesPlan.md`:

- Six fixture tests cover composite rename identity/trigger behavior, field validation order, FlowFilter calculation, typed and generic Sum FlowField validation without persisted write-through in these fixtures, and child writes leaving the parent version unchanged. These results do not establish general FlowField writability or safe concurrency.
- The BC23 baseline run was confirmed successful by the user after the MCP connection reset; do not invent exact runtime versions or detailed result counts.
- Live work must use an Extension Development Host and dedicated BC Data containers. The regular VS Code installation was restored to stable 1.10.0 after an experimental VSIX affected other projects. Recovery of the other project's tests has not been confirmed here.
- Next gate: E01 unbound-action transport on BC23 and BC27.1. No service endpoint has yet been deployed or exercised over HTTP.

### Historical run notes
Run update 2026-10-08:

- Created dedicated `bcdata-compat-23` from on-prem W1 application artifact 23.18.32409.0 (platform 23.0.32309.0). Toolset reported completion and Test Toolkit import. The name exceeds Toolset's 15-character recommendation, which must be checked if connection resolution later fails.
- Created dedicated `bcdata27compat` from on-prem W1 application artifact 27.1.41698.41776 (platform 27.0.41766.0). Toolset reported completion and Test Toolkit import. A local, ignored seed workspace selected the 27.1 artifact without changing the companion/test app's BC23 baseline manifests.
- `bc_dev_toolset_invoke_tests` targeted the BC23 container but stopped at **Build workspace apps** with AL1022: Microsoft Application and System packages compatible with 23.0.0.0 were absent from the package cache. No AL tests ran, and the BC27.1 test run was not attempted. The AL extension must download the missing symbols for both app folders before repeating Toolset tests.
- Container creation logged repeated "Unable to create session ... (cannot use WinRm)" messages while reporting successful app imports and overall completion. Runtime connection and test execution remain unverified.
- The BC23 create-container operation also called `Test-Path` with a null `licenseFile` setting and reported "Value cannot be null", then warned that the empty license file was missing and continued. It warned that `bcdata-compat-23` exceeds the recommended 15-character container name. The license check is being fixed separately on branch `fix/container-empty-license`; the name warning remains a configuration observation.
- The computer-use native pipe was unavailable when trying to invoke the installed AL extension's symbol-download command. Global-source symbol download failed for this workspace. The test app now depends on Microsoft `Library Assert` 23.0.0.0, which Toolset recognizes as a Test app, and the local settings contain Dev and Test targets for the existing BC23 container. Both AL folders now have launch configurations pointing at that container for `AL: Download Symbols`. No direct compiler, Docker, or BcContainerHelper fallback was used after the Toolset test failure. The two local target entries are aliases for one physical container; Toolset's create-container operation currently rejects duplicate container values, so do not recreate this container from these settings without resolving that limitation.

For every run, append exact versions, experiment IDs, command/tool result references, assertions, and failures. Keep compile, publish, and runtime outcomes separate. A documentation check is not an executed compatibility experiment.

## Earlier MCP binding diagnosis (resolved)

The MCP connection issue below was resolved by resuming Codex from the Toolset repository working directory. The live session now exposes seven `bc_dev_toolset_*` operations. The current execution prerequisite is the missing Microsoft Application/System symbols described above.

Diagnosis update 2026-10-08: A read-only query of Codex's local thread metadata confirms thread `01a110e4-bb32-7613-8ab9-db05c8f215a0` retains cwd `C:\Projekti\DAM-PAV\BC-Data-MCP`. That directory has been deleted. The current VS Code Codex log repeatedly reports ENOENT watching that exact thread root and records the Toolset bridge initialization error. The configured installed Toolset version is now 1.10.0; `.codex/verify-mcp-binding.cjs` still passes initialization and seven-tool discovery from the correct Toolset root. Thus the visible VS Code workspace and persisted conversation root differ. No evidence implicates developing Toolset's own source or mixed workspace folders. The failed MCP process's own cwd has not been directly captured.

The installed Codex CLI documents an explicit session ID and `-C/--cd` for resume. Supported recovery preserving this conversation is `codex resume 01a110e4-bb32-7613-8ab9-db05c8f215a0 -C C:\Projekti\DAM-PAV\BC-Dev-Toolset`. This must start an interactive client; it has not been executed from inside the active agent. Verify the resumed session's root and live MCP tool inventory before any container operation. Do not edit the live Codex database or recreate the deleted folder to hide the mismatch.

Update 2026-10-06: Manifests now target BC23/runtime 12.0. `al/BCData.Tests/src/Tests/BCDataRecordRefTests.Codeunit.al` contains six initial tests covering parts of E02, E03, E05, and E13. Fixture tables use fresh GUID identities and rollback transactions. No tests have been compiled or executed; all result-ledger entries remain pending. The user-added BCQuality repository supplied testing and field-classification guidance. Development ranges 50100-50149 (companion) and 50200-50299 (tests) need availability checks on selected targets before deployment.

The agent session still exposes no BC Dev Toolset workspace/build/test MCP tools. The repository now contains AL experiment sources and a multi-root workspace, but configured experiment targets and runtime tooling remain unresolved. No compile, publish, container mutation, or runtime test was attempted.

To continue runtime work, make the BC Dev Toolset extension and its MCP integration available for a dedicated AL experiment workspace with BC23 and BC27.1 container targets. Enable the required workspace/build/deploy/test tools and restart the MCP client as needed. Confirm the workspace context before invoking AL operations. This does not require adding product data-access code before the experiments establish its behavior.

Read-only MCP diagnostics on 2026-10-06 confirmed a Codex server entry pointing to installed Toolset 1.9.12 and a live extension-host bridge owning `BC-Dev-Toolset`. Calling the installed bridge-discovery helper found that workspace successfully, but rejected this conversation's original `BC-Data-MCP` working directory because no live bridge owns it. This is evidence of a possible stale startup-directory binding, not proof of the active client's startup error. The session tool inventory still contains no `bc_dev_toolset_*` tools. Reconnect from the Toolset workspace and inspect MCP startup diagnostics if discovery still fails; do not weaken workspace ownership checks.

Follow-up protocol diagnosis: launched the configured installed MCP server from `BC-Dev-Toolset` with its configured environment and sent only `initialize`, `notifications/initialized`, and `tools/list`. Initialization succeeded and discovery returned seven tools: get_workspace, get_operation_status, answer_operation_prompt, new_docker_container, ensure_containers, add_test_toolkit_to_bc_container, and invoke_tests (all with the `bc_dev_toolset_` prefix). No business/container operation was called. The build_all_apps tool was not in that enabled list.

The current VS Code window's Codex log records actual Toolset initialization failures at 16:01:45 and 16:02:51 local time, with JSON-RPC -32603: "Workspace tool settings require the BC Dev Toolset VS Code bridge." Meanwhile, a shell call without a workdir override still resolves to `C:\Projekti\DAM-PAV\BC-Data-MCP`. The installed server discovers its bridge using `process.cwd()`. These observations support a client execution-directory mismatch despite the correct visible workspace; the failed MCP process's own cwd was not directly captured. Mixed AL/non-AL workspace folders are not the failure demonstrated by these checks. Correct the client's effective working directory and reconnect MCP; no reason was found to reinstall Toolset, remove workspace folders, hard-code a global bridge, or weaken ownership validation.
