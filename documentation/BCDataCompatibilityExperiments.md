# BC Data compatibility experiments

Status (2026-10-15): the expanded nine-test AL batch built, deployed, and passed on BC23 and BC27.1 through the verified Development Host. E01's larger-payload failure was reproduced and isolated to ASP.NET Core 8 HTTP.sys unbuffered chunked-response writing in this container environment, with an independent server reproduction. BC27.1's full E01 HTTP assertions subsequently passed using gzip and HTTP/1.0. The default failing path is not fixed or certified; E01 remains open. The dedicated container was recovered after diagnosis. Older entries below are historical.
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
| BC23 | Expanded batch build/deployment succeeded; Application 23.18.32409.0 | 9/9 AL tests; E01 HTTP small/large/error checks passed | Partial evidence; no full compatibility claim |
| BC24 | Not run | Not run | Pending |
| BC25 | Not run | Not run | Pending |
| BC26 | Not run | Not run | Pending |
| BC27.0 | Not run | Not run | Pending |
| BC27.1 | Expanded batch build/deployment succeeded; Application 27.1.41698.41776 | 9/9 AL tests; E01 small/error HTTP checks passed, large-payload transport failed | Partial E01/E02/E03/E05/E13; no full compatibility claim |

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

### Resumption 2026-10-15

The fixture/design baseline was committed as `e5b788e`; the platform-test infrastructure and development isolation safeguards were merged into `feature/bc-data` as `5947bdb`. Post-merge `npm run validate`: 225 passed, 1 skipped, 0 failures. MCP server syntax and manifest/workspace JSON validation passed. These are repository checks, not new AL runtime experiments.

A local `BCData.Development.code-workspace` was prepared and opened using `--extensionDevelopmentPath=<repository>/vscode-extension` and `--user-data-dir=<repository>/.vscode/development-user-data`. It enables the build and compatibility-test tools. The file is excluded locally and uses the existing dedicated BC Data target settings. No development VSIX was installed and no global MCP settings were changed.

Before E01, reconnect the agent to the Development Host and verify `bc_dev_toolset_get_workspace` reports `BCData.Development.code-workspace`. The original session continued reporting `BC-Dev-Toolset.code-workspace`, so no build, deployment, or container test was started from it. E01 still needs a minimal published codeunit probe and HTTP evidence; selecting this transport is not yet an accepted implementation decision.

### E01 preparation and binding verification 2026-10-15

- `bc_dev_toolset_get_workspace({})` succeeded with `source: vscode`, workspace file `BCData.Development.code-workspace`, active project `al/BCData`, and manifest `al/BCData/app.json`. The workspace root is `C:\Projekti\DAM-PAV\BC-Dev-Toolset`; the returned assembly probing setting is `./.netpackages`. This resolves the preceding workspace-binding gate. No global MCP binding or installed extension was changed.
- The returned local settings select dedicated containers `bcdata23` (BC23 Dev), `bcdata23test` (BC23 Baseline Test), and `bcdata271` (BC27.1 Test). All use `UserPassword`, with restore disabled. These are configuration facts, not freshly measured runtime versions.
- Added normal fixture codeunit 50210 `BCD Transport Probe` to the separate test app. `Echo(inputJson: Text): Text` returns fixture revision, company, exact input Text, and parsed JSON; `Fail(inputJson: Text): Text` raises the fixed marker `BCD_E01_DELIBERATE_ERROR` without echoing input. There are no record mutations or permission elevation in this codeunit.
- Packaged `E01Transport.WebService.xml` registers the fixture as `BCDCompatibilityE01`. Registration through this XML has not been verified on either target. The companion app remains without service objects.
- Added test codeunit 50201 with three AutoRollback tests for exact Text/nested JSON types/company, the deliberate error, and malformed JSON rejection. These are source-level preparations and have not been compiled or run. They do not prove HTTP behavior or permissions.
- `bc_dev_toolset_invoke_tests({})` preflight returned `isError: true`: **"MCP tool call requires approval, but approval policy is never"**. No operation session, compiler diagnostics, build, deployment, or runtime test results were returned. No compatibility operation or manual fallback was attempted. Corrective action: enable the requested Toolset MCP operation in the agent session's approval policy, reconnect if necessary, and verify the development binding again before execution. This error does not establish that the VS Code terminal bridge is unavailable.

Next execution sequence:

1. Run Toolset baseline tests and compatibility tests from the verified Development Host, preserving the BC23 manifest baseline. Capture build and deployment outcomes separately from the expected nine AL test results per target. Do not claim nine passed until returned reports confirm them.
2. Confirm packaged service registration, then use direct HTTP against each dedicated Test target. Following [Microsoft's unbound-action format](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-creating-and-interacting-with-odatav4-unbound-action), send `POST <ODataV4 base>/BCDCompatibilityE01_Echo?company=<encoded company>` with `Content-Type: application/json` and an outer object whose `inputJson` property contains JSON Text. Exercise Unicode, escaping, empty strings, number/boolean/null values, nested structures, and a larger payload. Compare both the exact returned `inputJson` and parsed `payload`, and assert the requested company.
3. Call `BCDCompatibilityE01_Fail` with the same parameter envelope and record the actual HTTP status and error body containing the fixed marker. Exercise malformed inner JSON and authentication failure separately. Do not assume custom status-code control or infer HTTP outcomes from AL assertions.
4. Record credential-free request/response envelopes, observed authentication mode, exact application/platform/compiler/localization/fixture versions, and actual payload sizes/results. E01 remains open until both BC23 and BC27.1 have this evidence.

### E01 execution retry 2026-10-15

The user requested a retry. `bc_dev_toolset_get_workspace({})` again reported `BCData.Development.code-workspace` with `al/BCData` active. Toolset preflight then succeeded; the earlier approval-policy blocker was resolved. Both operations used `executeTestsInContainer: true`, `clearTranslationFiles: false`, `clearAppFiles: false`, and `pullFullArtifact: false` after preflight. No manual build/deployment fallback was used.

| Operation / target | Session reference | Build | Prepare/deploy | AL runtime |
| --- | --- | --- | --- | --- |
| `bc_dev_toolset_invoke_tests` / `bcdata23test` | `839d82ad-8a70-4b7d-982d-dbe0ba6fc1b1` | Succeeded | Succeeded | 9 passed, 0 failed/skipped; 0.201 s; Application 23.18.32409.0 |
| `bc_dev_toolset_invoke_compatibility_tests` / `bcdata271` | `b4500bda-7993-436f-90fd-fd5fbd42bc12` | Succeeded | Succeeded | 9 passed, 0 failed/skipped; 0.362 s; Application 27.1.41698.41776 |

Both returned exit code 0 and tested two applications. Tests were discovered in test codeunits `50200|50201`, using runner 130450 with Codeunit isolation. No codeunit used Disabled isolation. The first six tests remain limited to the earlier E02/E03/E05/E13 hypotheses; the three added tests cover AL-only E01 behavior.

Direct HTTP was exercised with `al/BCData.Tests/integration/Invoke-E01Transport.ps1` using PowerShell 7 and .NET HttpClient. It accepts only the two dedicated Test target names, validates their expected container/authentication settings, disables proxies and redirects, and keeps credentials out of results. Existing local settings supply HTTP Basic credentials; the observed company is `CRONUS International Ltd.`, tenant `default`. Each request has a 30-second full-response timeout. The fixture is revision `1`, test app manifest version `0.1.0.0`, BC23/runtime 12.0 baseline.

| HTTP assertion | BC23 | BC27.1 |
| --- | --- | --- |
| Anonymous `GET /BC/ODataV4/$metadata?tenant=default` | 401 | 401 |
| Authenticated company discovery | 200 | 200 |
| `BCDCompatibilityE01_Echo`: 195 UTF-8 request bytes; Unicode, escaping, empty Text, number, boolean, null, array | 200; exact Text, parsed payload, and company assertions passed | 200; same assertions passed |
| Echo: 65,536-character value, 65,568 UTF-8 request bytes | 200; 131,323 UTF-8 response bytes; exact round trip passed | No full response under the 30-second limit; underlying `SocketException`; recorded status `0` means no HTTP status, not an HTTP response |
| `BCDCompatibilityE01_Fail` | 400; `Application_DialogException`, deliberate marker | 400; same code/marker |
| Echo with malformed inner JSON | 400; `Application_DialogException`, invalid-JSON marker | 400; same code/marker |

The successful Echo action calls establish packaged service registration on both targets. Requests use `POST http://<dedicated host>:7048/BC/ODataV4/BCDCompatibilityE01_<action>?tenant=default&company=CRONUS%20International%20Ltd.`, `Content-Type: application/json; charset=utf-8`, and an outer `{"inputJson":"<JSON Text>"}` object. Responses use `{"@odata.context":"<base>/$metadata#Edm.String","value":"<JSON Text>"}`. Error bodies use `{"error":{"code":"Application_DialogException","message":"<fixed marker>  CorrelationId:  <id>."}}`; neither error echoed the synthetic private-input marker. No custom HTTP status control was attempted.

Credential-free exact envelopes are retained locally in `.bcdevtoolset/e01-http-bc23.json` and `.bcdevtoolset/e01-http-bc271.json` (ignored experiment artifacts). The latter explicitly reports `passed: false`. The initial PowerShell web-request adapter encountered a PowerShell 7 response API mismatch, then stalled; it was replaced with bounded HttpClient requests. An authenticated full metadata request also stalled on BC27.1 and was excluded from the final action-focused harness; no metadata compatibility claim follows.

Remaining E01 gate: investigate the BC27.1 larger-payload connection failure, without assuming an AL payload limit or server rejection from a connection failure. The probe has no mutation effects. Capture the actual internal platform, compiler version, and localization, which the operation reports above did not include. Only one company was tested; cross-company routing and wrong-credential/restricted-user behavior remain unverified. Do not treat these results as complete compatibility certification or as acceptance of the candidate production transport. E04 and later experiments remain pending.

### E01 instrumented diagnosis 2026-10-15

The user requested repeat measurements and a cause analysis, including the possibility of a transient failure. The development workspace binding was reverified. No AL source or installed application was changed during this diagnosis.

The original HTTP adapter used `ResponseContentRead` and retained only the deepest exception. It therefore discarded headers and partial body data if the response failed to complete. Its `status: 0` did **not** establish that the server sent no HTTP status. This evidence-loss discrepancy is corrected: shared `integration/E01Http.ps1` uses `ResponseHeadersRead`, reads the body under an explicit cancellation token, and retains status, header timing, elapsed time, received byte count, framing, cancellation state, and exception chain/type/HRESULT/socket codes. It records no credentials or arbitrary exception messages. `Invoke-E01Transport.ps1` now requires both `completed: true` and the expected HTTP status. Two offline regression assertions in `Test-E01Http.ps1` passed: partial-body socket reset retains HTTP 200 and bytes already read, and partial-body timeout retains HTTP 200 while identifying client cancellation.

`Measure-E01Transport.ps1 -Target 'BC27.1' -Repeats 2` appended request evidence to ignored local `.bcdevtoolset/e01-transport-measurements.jsonl`:

| Request, first repetition | Headers | Completion | Evidence |
| --- | --- | --- | --- |
| Echo, 64-character value; 96 request bytes | 200 in 33 ms | Complete in 35 ms | 376 response bytes |
| Fail, 65,536-character value; 65,568 request bytes | 400 in 31 ms | Complete in 33 ms | 140 bytes; expected deliberate-error response; large input accepted and AL invoked |
| Echo, same 65,568 request bytes | **200 in 39 ms** | **Incomplete after 30,039 ms** | **82,734 body bytes received**, chunked response, `application/json; odata.metadata=minimal; odata.streaming=true`; client cancellation requested |
| Authenticated metadata GET | No headers within 30,012 ms | Incomplete | No response bytes; client cancellation requested |

The incomplete Echo's exception chain is `MethodInvocationException -> TaskCanceledException -> IOException -> SocketException`, with socket `OperationAborted`, native error **995**. This identifies a local cancelled read at the deadline, rather than a server-reported request rejection or an independently established peer reset. It does not by itself identify the underlying reason why response delivery stopped.

The second repetition's small Echo, large Fail, large Echo, and metadata calls all failed before headers at approximately 30 seconds. Server Application log event **705** contemporaneously reported OData throttling/cancellation, **5 running** requests and **6-8 waiting** requests. Read-only configuration inspection showed `ODataMaxConcurrentRequestsPerUser=5`, `ODataV4MaxConcurrentRequests=5`, queue sizes 95, `ODataServicesOperationTimeout=00:08:00`, and `ODataMaxBodySize=350` MB. Thus the later small-request failures are explained by occupied request slots and queuing; they cannot be treated as independent large-payload threshold measurements. Which requests remained active, and why they failed to release their slots, are not yet proven.

Read-only container diagnostics were used only where no matching Toolset diagnostic operation was exposed. Both dedicated containers use Hyper-V isolation, `mcr.microsoft.com/businesscentral:ltsc2025`, and **8 GiB** configured memory. BC27.1 reported Windows `10.0.26100.32860`. A sample showed BC27.1 CPU 0.14% and memory 4.365 GiB. A managed thread-stack snapshot showed idle thread-pool workers rather than synchronous AL execution or clear CPU/thread-pool starvation. This snapshot cannot reveal all suspended async request state and is not proof of a particular HTTP stack bug.

Credential-redacted server event evidence is in `.bcdevtoolset/e01-bc271-events.json`; stack-only evidence is `.bcdevtoolset/e01-bc271-stacks.txt`. Microsoft's `dotnet-stack` 8.0.547301 was installed locally under ignored `.bcdevtoolset/diagnostic-tools` and copied only to `bcdata271`'s dedicated `my/e01-diagnostic-tools` folder. No memory dump or shared Toolset runtime replacement was made. Relevant server errors 701 included the intentional fixture errors; they are not evidence that Echo failed inside AL.

A framing/60-second comparison could not pass company discovery after the request slots became occupied, so **buffered/gzip/connection-close/HTTP 1.0 outcomes have not been measured**. A container-loopback comparison is prepared in `Measure-E01Loopback.ps1` but has not run. To obtain a clean baseline, a restart of only the dedicated BC service was attempted after preserving evidence. It remained in `STOP_PENDING` beyond its 30-second wait hint; termination of the identity-verified server process did not clear that state in the next status query. A dedicated `docker restart --time 10 bcdata271` and subsequent read-only Docker status query were still pending at the last observation. No other container, Docker service, or host was restarted. Host `hcsdiag list` was denied because the session lacks Administrator/Hyper-V Administrators privileges. Elevated host compute evidence was requested from the user before deeper intervention.

Current conclusion: the initial failure is a **partially delivered HTTP 200 response that does not finish before client cancellation**, followed by **server OData slot exhaustion**. It is not supported to label this an AL Text size limit or a 64 KiB upload rejection. The exact originating cause remains unconfirmed until the dedicated container can be recovered and host-versus-loopback/framing tests can run. A similar symptom is reported in [Microsoft's container issue tracker](https://github.com/microsoft/navcontainerhelper/issues/4174), but that report is not a diagnosis of this environment; the older [issue 3397](https://github.com/microsoft/navcontainerhelper/issues/3397) involved different resource/isolation changes, which were not applied here.

### E01 isolated reproduction and recovery 2026-10-15

This section supersedes the preceding unresolved/pending state. The user supplied elevated `hcsdiag list` output confirming the dedicated container was still Running, then performed a targeted `hcsdiag kill` of its ID. The already pending Docker restart completed, and the BC service returned to Running. No other container or host service was restarted. The container received a new IP and its hostname mapping was verified to match it.

The same Echo request succeeded twice over container loopback, with exact input assertions: **131,320 response bytes in 52 ms and 29 ms**. This demonstrates that this BC27.1 instance can process and serialize the payload. Raw results: `.bcdevtoolset/e01-loopback.json`.

On the clean host path, the same 65,568-byte request produced these results (all responses initially HTTP 200):

| Variant | Result | Response framing / evidence |
| --- | --- | --- |
| Default HTTP/1.1 | Incomplete at 15,046 ms; 84,000 bytes | Chunked; cancellation requested |
| `Accept: application/json;odata.streaming=false` | Incomplete at 14,994 ms; 84,000 bytes | Still HTTP chunked; OData streaming preference is not HTTP.sys kernel buffering |
| Gzip accepted/decompressed by HttpClient | Complete in 61 ms; 131,320 decoded bytes | Chunked compressed response |
| `Connection: close`, HTTP/1.1 | Incomplete at 15,006 ms; 82,715 bytes | Still chunked |
| HTTP/1.0 | Complete in 48 ms; 131,320 bytes | No Transfer-Encoding; body terminated by connection close |

An independent client comparison (`Measure-E01Curl.ps1`, credentials through stdin only) reproduced HTTP/1.1 failures twice: HTTP 200, **82,734 bytes**, curl exit 28, about 15.006/15.008 seconds. Between them, curl HTTP/1.0 completed an exact round trip in **43.5 ms**, 131,320 bytes. After five deliberately stalled requests occupied the five request slots, the last HTTP/1.0 attempt received no headers; that queued attempt is not a contradictory framing result. Evidence: `.bcdevtoolset/e01-curl-measurements.jsonl` and the framing records in `.bcdevtoolset/e01-transport-measurements.jsonl`.

The container's TCP snapshot showed retransmissions and a kernel-owned port-7048 socket in CLOSE_WAIT; that snapshot alone cannot assign the fault to networking. To isolate BC and the server implementation, two independent controls were executed inside the same container, serving only synthetic bytes:

1. `Start-E01HttpControl.ps1`: ordinary .NET HttpListener/HTTP.sys with fixed-length and chunked responses, plus raw TCP with valid HTTP/1.1 chunk framing. **All three delivered the full 131,320 bytes**, in 63/10/5 ms. Thus ordinary TCP transfer and ordinary HTTP.sys chunk framing can work in this environment.
2. `HttpSysControl/HttpSysControl.csproj`: standalone ASP.NET Core 8 HTTP.sys, without BC, OData, authentication, or database access. BC's runtime configuration also targets `Microsoft.NETCore.App`/`Microsoft.AspNetCore.App` 8.0; the container's installed 8.x runtime is **8.0.15**. The control serves fixed-length, chunked single-write, async multi-write, sync multi-write, and streamed JSON responses. With `EnableKernelResponseBuffering=false`, only fixed-length completed. Chunked cases all received HTTP 200 but stalled: single-write 131,238 bytes; async/sync multi-write 7,139 bytes; JSON 131,246 bytes, each cancelled at roughly 10 seconds. With **only `EnableKernelResponseBuffering=true` changed**, all five cases completed: fixed/single/async/sync returned 131,320 bytes in **64/11/5/4 ms**, and JSON returned 131,322 bytes in **19 ms**. Both builds succeeded; the final build had no warnings. Evidence: `.bcdevtoolset/e01-http-controls.json`, `.bcdevtoolset/e01-aspnet-controls.json`, and `.bcdevtoolset/e01-aspnet-buffered-controls.json`.

**Diagnosis:** a repeatable failure of the **unbuffered ASP.NET Core 8 HTTP.sys chunked-response write path on this Hyper-V/container environment**, followed by occupied BC OData request slots. It is reproducible after a clean restart, across HttpClient and curl, and independently of BC/AL. Enabling kernel response buffering removes the failure in the independent reproducer. The precise native/managed implementation defect or responsible Windows/.NET patch is not established; this evidence supports a component/mode diagnosis, not a claim that all BC27.1 installations are affected. [Microsoft documents the HTTP.sys kernel-buffering option](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/httpsys#support-for-kernel-mode-response-buffering); the controlled reproduction, rather than that documentation, establishes its effect here. No exposed BC OData/HTTP.sys buffering setting was found in the selected configuration query; `BufferedInsertEnabled` concerns database inserts and was not changed.

After preserving the reproduction, a second targeted container restart was requested to remove all deliberately stalled BC requests and temporary synthetic servers. The user again performed the necessary elevated `hcsdiag kill`; the pending restart returned successfully and the BC service returned to Running. The final full E01 HTTP harness passed on BC27.1 with **both** explicit `-ResponseMode gzip` and `-ResponseMode http10`: anonymous 401, authenticated company discovery 200, exact Unicode/typed and large Echo round trips 200, and expected deliberate/malformed-JSON errors 400. The large Echo completed in **45 ms with gzip** and **32 ms with HTTP/1.0**, with 131,320 decoded bytes in each case. Exact evidence: `.bcdevtoolset/e01-http-bc271-gzip.json` and `.bcdevtoolset/e01-http-bc271-http10.json`; original default-path failure evidence is retained separately.

These are demonstrated variants for this fixture, not an adopted production transport policy. Gzip success on highly compressible `x` data does not prove arbitrary large compressed responses are safe. No BC application, server buffering/concurrency configuration, shared Toolset runtime, or global MCP binding was modified. E01's default uncompressed HTTP/1.1 failure and the remaining company/identity/version/localization evidence still need resolution before closing the gate.

### Read-only foundation and native transport qualification 2026-10-16

Development proceeded with a bounded native Node HTTP/1.0 connection-close transport (`vscode-extension/bc-data-http10.js`), avoiding the failing chunked mode without server configuration changes or a helper process per call. It accepts fixed-length or EOF-framed identity responses, rejects transfer encodings/compression/redirects, validates TLS certificates normally, and enforces deadlines and size limits. Partial failures retain status and byte count; there is no automatic retry. HTTPS and other authentication modes remain unqualified; the current resolver accepts UserPassword only.

Companion and test app **0.1.3.0** implement/test read-only contract 1: readiness, companies, table name/caption search, installed field/key/enum discovery and selected-field reads. Reads include SystemId, string rowversion, invariant decimal/BigInteger strings, enum/option ordinals, normal filters and FlowFilters, and ascending primary-key pages. Date/time and other unqualified scalar values fail explicitly; BLOB/Media are descriptors only. Relations/obsolescence details are explicitly unavailable. Limits: 100 rows, 50 selected fields, 262,144 AL response characters. Pagination is not a snapshot; rowversion does not cover FlowField dependencies. Search by numeric table ID and additional sorting remain future work.

The internal client captures immutable connection context, checks contract/capabilities per call, requires explicit company for schema/record calls, and signs continuation tokens scoped to target revision, principal, tenant, company and query. Tokens expire after 30 minutes and do not survive a client session restart. A future Toolset resolver must advance its explicit connection revision after recreation/restoration or relevant app publication. No public data MCP tools or provisioning settings were added in this slice; disabled connections make no data requests. Mutations are not implemented or advertised.

Install/upgrade registration refuses a `BCDData` service owned by another object. The execute permission set does not grant business-table permissions; restricted-identity behavior still needs E12. During HTTP qualification, a JSON 404 `Internal_RecordNotFound` was traced to `Serialize` looking up the empty company name during connection-level readiness, **not a missing service registration**. Version 0.1.3 allows company-free readiness/company discovery and still requires company context for reads. The client now distinguishes this record-not-found error from missing initialization. Live company bootstrap covers the correction.

Final Toolset MCP runs used the verified `BCData.Development.code-workspace` Extension Development Host, with the existing package cache and assembly probing context. Build, deployment and all **17 AL tests passed on each target**:

| Target | Actual application | Session | Tests / duration |
| --- | --- | --- | --- |
| BC23 Baseline | 23.18.32409.0 | `fbb65269-1028-49d9-a03d-580e5064b79e` | 17/17, 0.075 s |
| BC27.1 | 27.1.41698.41776 | `1b7cdd04-15b8-4ee4-83db-2489c99e7078` | 17/17, 0.314 s |

The batch includes the prior nine platform/E01 tests and eight companion tests. An initial 16/17 run exposed an incorrect post-`asserterror` expectation in the registration test: AL rolls back its temporary conflict setup. The assertion was corrected and the full batch rerun. The Microsoft Store PowerShell update interrupted an earlier operation; after the user reloaded the development host, the binding was reverified before the final runs.

`integration/Verify-BCDataClient.cjs` then exercised the actual native transport/client on both deployed targets, including company bootstrap, readiness, Currency schema with installed extension fields/noncontiguous enum ordinal, existing Currency reads and distinct continuation rows. E01 echoes contained 64 KiB and 256 KiB of random bytes encoded as base64 plus Unicode, escaping and JSON types, with exact text and parsed payload equality:

| Target | Random source bytes | Request bytes | Response bytes | Elapsed |
| --- | ---: | ---: | ---: | ---: |
| BC23 | 65,536 | 87,570 | 175,409 | 33 ms |
| BC23 | 262,144 | 349,714 | 699,697 | 76 ms |
| BC27.1 | 65,536 | 87,570 | 175,406 | 62 ms |
| BC27.1 | 262,144 | 349,714 | 699,694 | 61 ms |

Credential-free evidence: `.bcdevtoolset/bc-data-client-qualification.json`. The echo is a test-service payload, not evidence that the companion permits responses above its stated cap. This qualifies the selected HTTP/1.0 remedy for these targets and poorly compressible payloads; it neither repairs nor reruns the failing HTTP/1.1 path. The precise underlying Windows/.NET defect remains unidentified.

Extension `npm run validate` passed: **245 tests, 244 passed, one skipped, zero failures**, including transport framing/limits/cancellation and client disabled behavior, capability checks, cursor binding/expiry, concurrent target capture, query capture and error classification. Log: `.bcdevtoolset/bc-data-npm-validation.log`. App manifests parse as JSON. No shared runtime, production installation or global MCP binding was changed.

Next development stage: integrate the read-only client with Toolset target resolution and explicit provisioning/exposure scopes, then register and test the read-only MCP surface. Keep write operations gated on E04/E06/E07, finish scalar/localization and restricted-permission qualification, and test intervening BC versions before claiming the full support range.

### Read-only MCP integration 2026-10-16

The read-only foundation was committed as `0806f2a` and pushed to `origin/feature/bc-data`. Development then added six `bc_data_*` tools: list connections, list companies, get readiness, find tables, get table schema and read records. Each has an individual default-off switch in both shared/local settings schemas and Configure MCP Tools. MCP definition revision is **35**. These are direct data handlers, not new PowerShell operations, and introduce no operation commands or data mutation tools.

MCP validates inputs and forwards them through the authenticated, identity-checked workspace bridge. The extension host rechecks current switches and lazily loads the data client. Credentials stay inside that host; neither tool arguments nor bridge results contain them. Shared/local configuration arrays append using Toolset semantics, exact unique names identify connections, and ambiguous names are rejected. Only Container targets with Dev/Test role are currently accepted. UserPassword credentials use existing bcUser/bcPassword. bcCredential=true fails explicitly with no plaintext fallback; a stored-credential adapter remains pending. Optional container bcData.baseUrl/bcData.tenant configure custom endpoints; endpoints cannot be supplied as tool inputs.

Connection discovery is offline and reports readiness as not_checked. Calls never install or upgrade apps. Settings changes, extension-host reload, scripted Toolset operation starts and observed MCP operation completion invalidate the extension-host client/cursors. External lifecycle changes require host reload. No schema cache or background connection checks were introduced. Automatic provisioning, bundled app packaging, stored credentials and restricted-identity E12 remain unfinished.

After the user reloaded the Extension Development Host, `bc_dev_toolset_get_workspace` again confirmed `BCData.Development.code-workspace`. All six new tools were exposed through the actual development MCP binding, with opt-in switches set only in that ignored development workspace. Live calls used **BC23 Baseline/bcdata23test** and **BC27.1/bcdata271**, leaving the separate Dev container unqueried:

| Assertion through actual MCP tools | BC23 | BC27.1 |
| --- | --- | --- |
| Company discovery before company selection | one company | one company |
| Readiness | contract 1, app 0.1.3.0, mutations disabled | contract 1, app 0.1.3.0, mutations disabled |
| Currency table search, page size 3 | passed | passed |
| Currency schema | 52 fields; extension field 50203 and enum ordinal 50242 visible | same |
| Currency selected fields 1,4,5, page size 1 | SystemId and string version returned | same |
| Follow continuation | different SystemId | different SystemId |

Sending the BC23 continuation token to BC27.1 returned structured **invalid_cursor**, with correlation ID and not_applied outcome, before a BC request. No AL code changed in this integration step; the prior 17/17 runtime results on each version still cover companion 0.1.3.0.

Final extension validation: **254 tests, 253 passed, one skipped, zero failures**, including nine new runtime/MCP tests. These exercise disabled behavior without client import, offline/redacted connection discovery, ambiguous IDs, stored-credential fail-closed behavior, rejected credentials/endpoints/write/oversized arguments, captured concurrent targets, cursor invalidation, error redaction, actual MCP-process bridge routing and mismatched workspace rejection. `node --check vscode-extension/mcp-server.js` and `git diff --check` passed. Validation log: `.bcdevtoolset/bc-data-mcp-validation.log`. The remaining work is explicit provisioning/packaging, stored-credential reuse and the open semantic/permission/support-range experiments; this is not a production release or a claim of complete BC Data support.

### Companion bundling and initialization development 2026-10-16

The development binding was verified again before building through `bc_dev_toolset_build_all_apps`. Both apps compiled successfully with AL compiler 18.1.43.24897 from Microsoft AL extension 18.1.2842859; no direct compiler fallback was used. Companion version remains 0.1.3.0; no AL source changed in this stage.

`bc-data/compatibility.json` is now the reviewed bundling specification. `npm run prepare:runtime` validates the existing Toolset-built companion's embedded NAVX manifest and AL sources against the checkout, rejects stale/wrong/dependent packages, computes SHA-256 integrity and stages only `BCData.app` plus manifests under runtime/bc-data. It does not compile an app or create a BC deployment runtime package. Generated artifacts remain ignored. Runtime synchronization includes the companion directory; revision advances to 32. Staging preparation succeeded locally without installing a VSIX or replacing the shared runtime.

The new default-off `bc_dev_toolset_initialize_bc_data` operation/command selects one exact unique Dev/Test Container configuration, confirms initialization, validates the bundled artifact, uses ordinary tenant app deployment for absent/older companions and verifies advertised contract/capabilities over HTTP/1.0. Equal/newer compatible versions are preserved; incompatible newer versions fail readiness without downgrade. There is no forced schema synchronization, uninstall or container creation. Provisioning uses the existing Toolset credential resolver; read-only stored-credential support remains pending. Tool exposure stays separate and no tool switches are changed by initialization. MCP definition revision is 36.

Per-container bcData.provisioningEnabled defaults to false. Enabled targets reconcile during container creation/start and test preparation; disabled targets perform no companion package, credential, app-state or HTTP checks. Disabling maintenance preserves installed state. Explicit initialization is independent of this automatic-maintenance flag. Deployment may already have occurred if subsequent readiness fails; failure is not proof that no state changed and there is no automatic retry.

Verification so far: **262 tests, 261 passed, one skipped, zero failures**, including seven provisioning/package tests and an isolated runtime-copy regression. These exercise absent/older/equal/newer behavior, disabled no-op, invalid/production targets, incompatible contracts, package checksum/identity/path rejection, actual synthetic HTTP/1.0 readiness and metadata/schema/command alignment. `node --check vscode-extension/mcp-server.js` and `git diff --check` passed. Log: `.bcdevtoolset/bc-data-initialization-validation.log`. Live initialization verification awaits the requested development-host reload; no live deployment success is claimed by this entry.

Deployment API behavior was checked against the primary [Get-NavContainerAppInfo source](https://github.com/microsoft/navcontainerhelper/blob/main/AppHandling/Get-NavContainerAppInfo.ps1) and [Publish-NavContainerApp source](https://github.com/microsoft/navcontainerhelper/blob/main/AppHandling/Publish-NavContainerApp.ps1). These references informed parameter use; they do not replace runtime qualification on the dedicated targets.

### Initialization live verification after development-host reload 2026-10-16

The user reloaded the Extension Development Host; workspace verification confirmed the development binding and exposed `bc_dev_toolset_initialize_bc_data`. Explicit initialization succeeded on **BC23 Baseline/bcdata23test** and **BC27.1/bcdata271**, preserving installed 0.1.3.0 and verifying contract 1 through HTTP/1.0. Tool switches were not changed.

The separate dedicated **BC23/bcdata23** target initially failed app-state enumeration because it was stopped. Toolset `ensureContainers` reported exited/unhealthy, started only that target and left the two healthy targets running. A subsequent initialization published/synchronized/upgraded its existing older companion successfully, then failed the final HTTP readiness check. This is an observed example of deployment completing before verification fails, not a rolled-back upgrade.

Read-only diagnostics showed the hostname initially resolving to **172.26.5.142**, while the current hosts entry and a narrow Docker IP query both reported **172.26.4.109**. No exposed Toolset operation provided that IP diagnostic; the query read only network metadata and did not perform deployment/recovery. Resolution later converged to 172.26.4.109 without a DNS flush, host-file edit or further deployment. MCP company discovery then succeeded, and repeating initialization preserved installed 0.1.3.0 and passed readiness. These observations point to transient stale name resolution after startup as the cause of the zero-response connectivity failure; no HTTP.sys large-payload failure was reproduced. The absent-app installation path is covered by mocked regression tests, while live evidence here proves upgrade and equal-version preservation, not a clean install onto an app-free container.

Automatic provisioning was temporarily enabled only on the two dedicated Test configurations. Both test runs logged successful contract-1 companion reconciliation and then passed 17/17 AL tests (initial sessions `a1674dd6-4ef5-4d2f-b377-5e232765164f`, BC23 0.089 s; `674d5285-f040-47dd-b974-8f78746ffef2`, BC27.1 0.309 s). Review found that the container-readiness hook could reconcile before test platform validation. Test preparation now defers that hook until after platform verification and any restore, with a regression test. BC23 rerun session **`fef08eb8-095d-4ddc-bfdb-403ec62c4d0d`** passed 17/17 in 0.103 s, with transcript order explicitly confirming platform verification, restore decision, then companion reconciliation.

The final BC27.1 rerun, session **`6fe44d45-b05a-44be-a632-f3a059d7979b`**, passed **17/17** in 0.146 s and confirmed the same corrected preparation order. Both temporary provisioning flags were restored to their original state after verification. A subsequent read-only MCP company call on BC27.1 succeeded. Actual applications remain 23.18.32409.0 and 27.1.41698.41776; companion remains 0.1.3.0.

Final extension validation after the ordering guard and stale-source packaging regression: **264 tests, 263 passed, one skipped, zero failures**. The new source-freshness test synthesizes a valid NAVX package, accepts its current source and rejects a later source edit without a version change. No AL compiler is invoked by packaging tests. Native package/source checks, runtime-copy isolation, initialization behavior and settings-schema alignment remain covered. Staging includes only the companion, not the test app. No development VSIX was installed, no shared runtime was replaced and no global MCP binding was changed. Clean-install and container-creation maintenance paths still need dedicated live qualification; read-only stored credentials, restricted permissions and remaining semantics/support-range gates remain open.

### Stored credentials for read-only MCP calls 2026-10-16

Read-only data calls now honor `bcCredential: true` using the existing Toolset Windows Credential Manager identity and native CredentialStore reader. Plaintext fields are ignored in this mode. The extension host lazily starts one private PowerShell helper and reuses it across targets/calls; requests/replies use anonymous pipes, not the operation terminal or MCP bridge. Each resolution reads the current stored value, without a persistent credential cache. Missing values return structured credential_missing; helper failures return credential_unavailable and do not retry or fall back. Plaintext, offline discovery and disabled paths do not start the worker.

The worker accepts only bounded container-name/UUID requests and bounded credential/fixed-error replies, supports at most 16 pending resolutions and has a 10-second deadline. Invalid output, worker exit and disposal reject pending requests. No arbitrary credential target, filesystem path, command or native-store mutation is accepted by this protocol. Stored endpoint overrides must retain the configured container hostname; otherwise the request fails before reading credentials. Captured URL/tenant/revision remain stable while awaiting the native value. Settings/lifecycle invalidation and extension shutdown dispose the helper. Runtime revision advances to **33**; MCP tool schemas are unchanged.

Final validation before live qualification: **275 tests, 274 passed, one skipped, zero failures**, log `.bcdevtoolset/bc-data-credentials-validation.log`. Coverage includes lazy worker reuse, reversed concurrent reply order, bounded/invalid replies, missing entries, timeouts/exits/disposal, no credential leakage, endpoint identity binding, target capture and no plaintext fallback. A real Windows test created only a random synthetic native entry, verified Unicode, password rotation and removal through the same helper process, then cleaned it up. This is native behavior evidence, not just a mocked store.

After the user reloaded the Extension Development Host, workspace verification again confirmed BCData.Development.code-workspace. The integration fixture added temporary stored/missing-credential configuration aliases for only bcdata23test and bcdata271. Existing native entries were never overwritten; for this run both entries were absent and temporary stored copies were created from the already configured dedicated test credentials. Original configurations were retained unchanged. The aliases deliberately contained wrong plaintext credentials.

Actual MCP company discovery, contract readiness, Currency schema discovery and selected-field reads with distinct continuation rows all passed on **both BC23 and BC27.1**, app **0.1.3.0**, using these stored aliases. Each schema had 52 fields. Concurrent calls across both targets and subsequent repeated reads used **one** actual credential-helper process. Both random missing-credential aliases returned **credential_missing/not_applied**, without DNS/HTTP fallback; a valid stored call still succeeded afterward. No credentials appeared in MCP inputs/results or diagnostic output.

Cleanup removed all four aliases and both test-created native entries, preserved the original three target configurations and removed the metadata-only fixture state file. A separate native-reader check confirmed both temporary entries were absent, and the extension helper count returned to zero after settings invalidation. No BC user password or permission was changed. The companion AL source did not change, so prior 17/17 AL results on each platform remain applicable; this stage qualifies the additional authentication path through actual BC reads, not restricted-identity E12 or new mutation semantics. Clean-install/container-creation paths, HTTPS, intervening BC versions, restricted permissions and remaining scalar/write gates remain open.
