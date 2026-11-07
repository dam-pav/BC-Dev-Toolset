# AL semantic navigation investigation (#152)

Investigation date: 2026-11-02. Scope: feasibility and integration design; no production MCP tools are introduced.

## Decision

Defer implementation of a toolset-managed standalone LSP service or provider bridge until existing agent support has been tested with AL. Copilot already supplies relevant client/tool support; whether BC Dev Toolset needs an adapter depends on the target agent environment. Start with the resume checklist below.

If a gap remains for Codex or other MCP clients, prefer evaluating a small, read-only VS Code language-provider bridge in an Extension Development Host. The extension already requires Microsoft AL Language and a workspace-specific VS Code bridge. Reusing that host should avoid another server, duplicate indexing, and a second copy of unsaved documents. This is an architectural recommendation, not a measured performance comparison.

A standalone service remains useful if a concrete headless consumer emerges or the provider bridge cannot resolve the required cross-project tasks. Do not ship diagnostics or rename based on this investigation. Keep the existing build and test operations authoritative.

## Agent access findings and resume point

Recorded 2026-11-02 after reviewing the agent products' documentation. These findings revise the initial assumption that every agent needs a new adapter. Product capabilities can change; recheck them when resuming #152.

Starting `launchlspserver` alone does not register agent tools. It serves LSP JSON-RPC over the process's stdin/stdout. A client must own that connection, initialize it, synchronize documents, and translate agent actions into supported LSP requests. An agent environment with a built-in LSP client can provide this already. An MCP-only client needs an adapter for LSP navigation. LSP and MCP are distinct protocols even though both use JSON-RPC.

| Agent environment | Established support | Remaining AL-specific question |
| --- | --- | --- |
| Copilot CLI | Built-in configurable LSP client; documented operations include definition, references, hover, document/workspace symbols, rename, implementation, and call hierarchy. Repository configuration is `.github/lsp.json`; user configuration is `~/.copilot/lsp-config.json`. Copilot starts relevant configured servers and chooses operations. | Can its configuration launch the signed bundled ALTool with the correct workspace, caches, and assemblies, and does it negotiate the capabilities actually advertised by AL? No compatibility test was performed. |
| Copilot in VS Code | Built-in Usages tool combines references, implementation, and definition. Tool names and availability depend on the selected agent harness. | Does the available tool correctly use the active AL providers across the required projects and dependencies? This does not establish generic standalone-LSP configuration or access to every LSP operation. |
| Codex CLI / IDE | Official OpenAI documentation establishes MCP connections shared across clients. No documented arbitrary-LSP registration mechanism was found in the reviewed documentation. | Verify the installed version's actual tools and current official documentation. Absence of a documented setting does not prove that every Codex variant lacks internal language intelligence. For predictable external tools, MCP remains the verified route. |
| Microsoft AL MCP server | `altool launchmcpserver` supplies an agent-ready MCP surface including symbol search and diagnostics. | Its documented surface is not a complete LSP navigation adapter: definition, references, and hover are not listed as individual tools. Test whether its existing symbol tools satisfy the actual tasks before adding overlapping tools. |

The VS Code extension host runs extensions; the Microsoft AL extension provides editor language support. A separate agent runtime decides which tools the model can invoke. Sharing the editor does not by itself grant an arbitrary agent access to every language provider. Copilot's built-in navigation tools are an existing example of that agent-facing access.

Sources for these conclusions:

- [GitHub: using LSP servers with Copilot CLI](https://docs.github.com/en/copilot/concepts/customizations/lsp-servers).
- [GitHub: configuring Copilot CLI LSP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/add-lsp-servers).
- [VS Code: workspace tools, including Usages](https://code.visualstudio.com/docs/agents/reference/workspace-context).
- [VS Code: tool names and harness-dependent availability](https://code.visualstudio.com/docs/agents/reference/tools-reference).
- [Official OpenAI documentation: Codex MCP support](https://learn.chatgpt.com/docs/extend/mcp).
- [Microsoft: AL agent tools and AL MCP surface](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/al-agent-tools/al-agent-tools-overview).

### Resume checklist

1. Record current AL extension, ALTool, VS Code, Copilot, and Codex versions. Recheck the documentation and actual agent tool inventories. Do not start by implementing a bridge.
2. Test Copilot CLI's native LSP support with the signed AL-extension ALTool and an isolated project configuration. Let the client start and own the process; a server started in an unrelated terminal does not expose its stdio connection to the client. Reuse the fixtures and expected locations below, then qualify real projects with existing symbols. Do not replace the user's global configuration.
3. Test Copilot in VS Code with its available Usages/navigation tools and the active Microsoft AL extension. Inspect actual tool calls and results rather than assuming that opening the workspace enables every operation.
4. Check Microsoft's AL MCP server against the representative symbol/navigation tasks. Configure only an isolated development binding for experiments; retain existing BC Dev Toolset build/test behavior.
5. Determine the remaining Codex/MCP-client gap explicitly: which of definition, references, hover, and document symbols cannot already be obtained reliably? Compare with available packaged-symbol and BC Code Intelligence tools.
6. If existing support covers the tasks, document configuration and decline duplicate implementation. If a material gap remains, evaluate the provider bridge described below. Choose standalone LSP hosting only for a demonstrated need such as headless use or missing provider behavior.

No Copilot configuration, Codex binding, production tools, or additional integration has been created. The only live evidence remains the direct ALTool protocol probes documented below. The next session should begin at step 1, not assume that Copilot/AL interoperability has already been demonstrated.

## Sources and evidence boundaries

- [Issue #152](https://github.com/dam-pav/BC-Dev-Toolset/issues/152).
- [Microsoft ALTool reference, AL LSP section](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-al-tool#al-lsp).
- [VS Code provider commands](https://code.visualstudio.com/api/references/commands).
- [LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
- Local source: `vscode-extension/al-tool-discovery.js`, `path-security.js`, `extension.js` (`getValidatedBundledAlToolPath`, `getMcpWorkspaceContext`, `getMcpWorkspaceSettings`), and `mcp-server.js`.

Documentation describes stdio LSP hosting, project-folder arguments and workspace-file configuration. Local observations below take precedence for the tested binary. Published feature descriptions are not a compatibility guarantee.

## Verified version and command line

| Item                       | Observed result                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Platform                   | Windows, local VS Code AL installation                                                      |
| Installed AL extension     | `ms-dynamics-smb.al` 30.0.2863738, reported by `code --list-extensions --show-versions` |
| Executable                 | That installation's `bin/altool.exe`, selected with the repository's `discoverAlTool`   |
| Authenticode               | Valid; signer Microsoft Corporation                                                         |
| `--version`              | `30.0.43.45776+9c432ef3dff6a3c4df683465da5f5c539f6a8bf1`                                  |
| `launchlspserver --help` | Command present; accepts zero or more positional project directories                        |
| Version command difference | `version` is rejected; `--version` succeeds                                             |

Only this installed version was exercised. The first version containing the command, older supported AL extension versions, macOS, Linux, and the version selected by a particular running extension host remain unqualified. Do not introduce a minimum-version promise from the documentation's example extension path. A future implementation must obtain the active extension through `vscode.extensions.getExtension('ms-dynamics-smb.al')`, reuse discovery, and probe LSP support separately: compile support alone is insufficient.

The installed command advertises these relevant options:

```text
launchlspserver [<projects>...]
  --workspacefile <workspacefile>
  --settingspath <settingspath>
  --packagecachepath <packagecachepath>
  -a, --assemblyprobingpath, --assemblyprobingpaths <assemblyprobingpaths>
  --ruleset <ruleset>
  --codeanalyzers <codeanalyzers>
  --logfile <logfile>
  --loglevel <loglevel>
  --nolog
  --disableTelemetry, --disabletelemetry
```

Help also lists environment, telemetry-level, debug, and output options. Their behavior was not exercised. Use a subprocess argument array with the signed bundled executable, never a shell command or the global `al` alias.

## Minimal protocol experiment

Two short-lived clients spawned the installed executable with `launchlspserver`, explicit project paths, `--nolog`, and `--disabletelemetry`. They used UTF-8 JSON-RPC messages framed with byte-counted `Content-Length` headers, requested UTF-16 positions, initialized the session, and opened AL documents. Fixtures were confined to the ignored `.vscode/development-user-data/lsp-investigation` directory. No packages were built, installed, downloaded, or deployed. No MCP binding or shared runtime was changed.

This was a direct executable feasibility probe, not an Extension Development Host integration test. No provider bridge or development MCP server was launched. The proposed integration comparison still needs the checked-in launch configuration and an isolated development binding.

### Fixtures and reproduction

The single-project fixture had an `app.json` with a unique ID, publisher `BC Dev Toolset`, version `1.0.0.0`, runtime `17.0`, and ID range 50100–50109. `Probe.al` contained:

```al
codeunit 50100 "LSP Probe"
{
    procedure Ping(): Integer
    begin
        exit(42);
    end;
}
```

The two-project fixture used the same manifest fields with distinct IDs and names `Probe Base` and `Probe Consumer`. Consumer declared Base's ID, name, publisher, and version in `dependencies`. Base used the code above with object name `Probe Base`; Consumer contained:

```al
codeunit 50101 "Probe Consumer"
{
    procedure RunProbe()
    var
        Base: Codeunit "Probe Base";
    begin
        Base.Ping();
    end;
}
```

Neither fixture supplied platform/application symbol packages. Both emitted a missing-package-cache warning on stderr. These results demonstrate simple source navigation, not complete Business Central semantic resolution.

To reproduce the protocol sequence with an LSP client:

1. Authorize an isolated fixture root, create the manifests and files above, and discover the reviewed installed ALTool. Check its signature, `--version`, and `launchlspserver --help`.
2. Spawn with one or both project directories as separate arguments. Initialize with the first project's `rootUri`, both `workspaceFolders` for the multi-project case, and `general.positionEncodings: ["utf-16"]`. Send `initialized`, then `didOpen` for every queried document, version 1, language ID `al`, full text.
3. Single project: request document symbols, hover and definition at zero-based line 2, character 15. Multi-project: request definition at Consumer line 6, character 14, then references at Base line 2, character 15 with `includeDeclaration: true`.
4. Send a full-text `didChange`, Base version 2, changing `Ping` to `Pong` only in memory. Request Base document symbols again. Leave the file unchanged on disk.
5. Request `shutdown`, await the response, notify `exit`, and ensure the child exits. Keep a hard watchdog and kill only the owned child if it hangs.

### Advertised capabilities

| Capability                                      | Initialize response                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Definition, references, hover, document symbols | Enabled                                                               |
| Completion, signature help, document highlights | Enabled                                                               |
| Workspace symbols                               | Enabled, `resolveProvider: false`                                   |
| Rename, document/range formatting, folding      | Enabled; mutation features were not exercised                         |
| Code actions, implementation                    | Disabled                                                              |
| Type hierarchy, inlay hints                     | Disabled despite endpoint names appearing in stderr registration logs |
| Document synchronization                        | `textDocumentSync: 1` (full text)                                   |
| Position encoding                               | Not explicitly returned; LSP default is UTF-16                        |
| Pull diagnostics                                | No `diagnosticProvider` advertised                                  |

Negotiate from the initialize response, not documentation or registration logs. No diagnostics notification was observed during these short probes. An intentional unsupported `textDocument/diagnostic` request received no response within 15 seconds; the client terminated that session. This does not establish that every form of diagnostics is unavailable, but it rules out relying on pull diagnostics for this version without further evidence.

### Observed outcomes and latency

One run per fixture, sequential requests, rounded wall-clock milliseconds. Initialization includes process startup; request times include transport and any first-use work. These are smoke measurements, not percentiles or production benchmarks.

| Task                                 |    Single project | Two projects | Correctness evidence                                                        |
| ------------------------------------ | ----------------: | -----------: | --------------------------------------------------------------------------- |
| Spawn through initialize response    |            514 ms |       460 ms | Valid capability response                                                   |
| Document symbols                     |            646 ms |           — | Codeunit and `Ping(): Integer` returned                                   |
| Hover on procedure                   |             27 ms |           — | `procedure Ping(): Integer` signature returned                            |
| Definition                           |              6 ms |       658 ms | Local declaration; cross-project Consumer call resolved to Base declaration |
| References, including declaration    |                — |       101 ms | Exactly Base declaration and Consumer call returned                         |
| Symbols after unsaved full-text edit |                — |        45 ms | Returned `Pong(): Integer` while disk still contained `Ping`            |
| Shutdown response                    |                — |         2 ms | Null result, followed by exit notification; client process completed        |
| Unsupported pull diagnostics         | Timed out at 15 s |           — | No response; owned process terminated                                       |

Concrete benefits: locating the target procedure across two source projects and enumerating its call sites require fewer file reads than inspecting text matches manually. Hover provided a signature without reading the whole file. Unsaved symbol updates worked in the next request. Text search remains useful for strings, comments, configuration, and recovery when semantic context is incomplete.

Limits: this experiment did not check ambiguous names, negative accessibility, `internalsVisibleTo`, transitive `propagateDependencies`, external package definitions, analyzer diagnostics, or cross-project invalidation after edits. It did not measure CPU, memory, payload limits, large-workspace indexing, repeated latency, or agent task completion. Those benefits and costs remain unmeasured. Missing-symbol warnings must be exposed as degraded context even when some navigation succeeds.

## Integration alternatives

| Concern              | Standalone client                                                | VS Code provider bridge                                                                      |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Existing toolset fit | Another child/session owner behind the existing MCP bridge       | Extend the authenticated workspace bridge already required by the toolset                    |
| Unsaved buffers      | Mirror open/change/close events and versions into another server | Query providers against the current `TextDocument`                                         |
| Configuration        | Reconstruct resource-scoped settings and project graph           | Reuse the active AL extension's workspace state                                              |
| Headless use         | Possible, with independent lifecycle and configuration           | Requires the matching VS Code extension host                                                 |
| Failures             | Protocol, process, indexing, and workspace failure modes         | Provider availability, timeouts, and stale provider state                                    |
| Indexing cost        | Potential duplicate AL process/index; not measured               | Expected reuse of editor service; not measured                                               |
| Diagnostics          | No pull support established in tested version                    | `vscode.languages.getDiagnostics(uri)` provides a snapshot; freshness still needs evidence |

Provider commands for the first experiment: `vscode.executeDefinitionProvider`, `vscode.executeReferenceProvider`, `vscode.executeHoverProvider`, and `vscode.executeDocumentSymbolProvider`. These are public VS Code APIs; AL-specific correctness and cancellation behavior require live qualification. Do not expose a generic command-execution tool.

Compiled `.app` symbol tools remain useful when source is unavailable and for inspecting packaged dependency APIs. Semantic source navigation can resolve call sites and unsaved changes that a packaged snapshot cannot describe. BC Code Intelligence was not available for a measured comparison here; no superiority claim is justified. Compare its actual available symbol/navigation facilities before committing to overlapping production tools.

## Configuration and lifecycle requirements

The current workspace context returns workspace folders and assembly settings, but `getMcpWorkspaceSettings` does not return package-cache, ruleset, or analyzer settings and uses workspace-wide `getConfiguration('al')`. It is insufficient as the complete configuration contract for a standalone service. Resolve those settings per project/resource, retaining project cache isolation and relative-path bases used by existing builds. Do not flatten every project's package cache into a shared cache.

The installed help supports workspace and settings files. Microsoft documents layered configuration; relative-path bases, conflicting scopes, multiple cache arguments, and initialization overrides need fixture tests against each qualified binary. Passing a workspace file also grants its folder entries and settings paths to the child: parse and authorize every referenced root before launch. Account for ancestor settings autodiscovery rather than silently importing configuration outside the authorized context. Missing symbols should produce an explicit degraded-context result, not trigger downloads or a build.

If standalone hosting is later justified, require:

- One owner per workspace host and configuration revision. Initialize once, negotiate capabilities, then synchronize open buffers before serving requests. Restart when project membership or relevant configuration changes.
- Monotonic document versions and full-text changes for the tested server. Include versions in results; invalidate pending results when a document changes. Serialize synchronization before dependent requests.
- Bounded requests, cancellation via `$/cancelRequest`, and stale-response rejection. A client timeout need not cancel provider/server work. Ignore late replies and restart only with bounded backoff when necessary.
- A byte-correct, size-limited JSON-RPC parser. Handle partial/coalesced frames and bounded server requests without mixing stderr into stdout.
- Bounded, redacted stderr logging to the output channel. Diagnostics may contain source and local paths. Keep log files, if enabled, inside a dedicated authorized development/session root.
- Graceful shutdown/exit on host disposal, watchdog escalation for the owned process, and no orphan server after workspace closure or reload. Exercise crash and restart behavior.

## Proposed read-only contract and path boundary

An initial experiment should provide four fixed operations: definition, references, hover, and document symbols. Diagnostics is a later, conditional snapshot operation with its source and freshness limits stated. Completion, hierarchy, and rename stay out of this first surface.

Accept a workspace project identifier, a project-relative document path, zero-based UTF-16 position where applicable, and a bounded result limit. Return normalized locations, document version, context/degradation status, truncation status, and structured errors such as `provider_unavailable`, `unsupported`, `timeout`, `stale_document`, and `outside_allowed_roots`. Start with at most 100 locations and 64 KiB serialized output; make omissions explicit. Hover text and source snippets are untrusted content, never executable instructions.

Resolve and normalize incoming paths, then check `path.relative` containment in an authorized project root. Resolve real paths and recheck physical containment to prevent symlink/junction escapes. Authorize workspace roots separately; reject sibling-prefix tricks, traversal, non-file input URIs, and implicit ancestor scans. Apply these checks before opening a document, not only when returning its location.

Filter every returned URI and `LocationLink` target independently. Workspace membership does not authorize arbitrary external source access. Dependency roots require explicit, validated configuration; default to a package/symbol identifier and an omitted-location reason for outside-root definitions. Do not read external files just to format results. Virtual AL dependency URIs need a provider-specific, explicitly authorized design; never convert them blindly to filesystem paths. Apply the same boundary to hover links, diagnostic related locations, and snippets.

## Scoped follow-up and acceptance tests

First complete the existing-support checks in the resume checklist. If they establish a material agent-access gap, implement a development-only provider-bridge experiment with an isolated workspace MCP binding and the checked-in Extension Development Host launch configuration. Do not install a development VSIX or change the global MCP binding. Production tools should follow only after the experiment establishes value.

Required qualification:

1. One real single-project workspace and a multi-root base/test/extension workspace with existing symbol packages. Test package-cache and assembly paths per project, missing-symbol behavior, and explicit workspace-file configuration.
2. Assertions for overloaded/same-name procedures, comments/string false positives, cross-project definitions/references, `internalsVisibleTo`, and `propagateDependencies`. Verify expected locations against fixtures, not just nonempty results.
3. Unsaved edits, rapid version changes during requests, save/close/reopen, dependency changes, and external file changes. Return stale status when freshness cannot be established.
4. Security tests for traversal, sibling-prefix roots, junction escapes, outside-root and virtual returned URIs, malicious hover content, and oversized/truncated results.
5. Timeouts, cancellation with late completion, unavailable providers, host reload, concurrent calls, and workspace closure. If standalone hosting is revisited, add framing, server-request, malformed-output, crash, restart, and orphan-process tests.
6. Compare the same navigation tasks using text search, available packaged-symbol/BC Code Intelligence tools, provider bridge, and standalone LSP. Record correctness, agent file reads/tool calls, cold startup, warm p50/p95 latency, peak memory/CPU, response bytes, and freshness after edits. Use repeated runs and record extension/tool versions.

Proceed to a production provider bridge only if those tasks show a useful gain without freshness or authorization regressions. Revisit standalone hosting only for a measured bridge gap or a headless requirement. Any production MCP addition must align operation metadata, command contributions, schemas, tool settings, README documentation, and an explicit increment of `mcpServerDefinitionRevision` as applicable.

## Delivery status

The initial feasibility investigation and agent-access review are documented: the bundled signed executable was verified, minimal read-only single/cross-project navigation and unsaved synchronization were demonstrated, and capability/diagnostic limitations were recorded. Existing Copilot support changes the immediate next step to interoperability testing before any adapter implementation. Copilot/AL compatibility, the current Codex capability inventory, the version matrix, and the full Extension Development Host comparison remain follow-up qualification, not completed implementation or release claims.
