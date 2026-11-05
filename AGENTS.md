# Repository Instructions

## Applying These Instructions

- Before editing, read this file and any applicable nested `AGENTS.md` or `AGENTS.override.md` files. Treat their requirements as acceptance criteria for the change.
- Inspect every tool result, including exit status and partial output. A failed tool call does not authorize a fallback that these instructions prohibit. Stop dependent work and explain the failed operation, safe known cause or unknown cause, side-effect state, and concrete recovery action.
- Before reporting completion, review the diff against the applicable instructions, especially Expected Failure Handling and Filesystem Path Safety. Passing tests alone does not establish compliance.
- When the user identifies a discrepancy, add regression coverage for the incorrect behavior wherever applicable. Assert the required behavior, including actionable diagnostics and preserved failure status; a test that merely accepts the current implementation is insufficient.

## Scope

This repository contains the BC Dev Toolset runtime scripts and the VS Code extension that exposes those operations to developers and agents. Treat it as tooling source code, not as a consuming Business Central AL workspace.

## Development Guidance

- Prefer direct source edits, tests, and repository inspection when working on this repo.
- Run development builds only in an Extension Development Host using the checked-in launch configuration. Do not install development VSIX packages into the regular VS Code environment or replace its shared runtime. Any production-installation experiment requires explicit user authorization.
- Keep development MCP bindings local to the development workspace; do not replace the user's global binding with a development server. Use dedicated containers for live tests.
- Do not use the BC Dev Toolset MCP server to operate on this repository unless the task is explicitly about testing the MCP integration itself.
- Keep operation metadata, VS Code command contributions, MCP tool exposure, and README documentation aligned when adding, removing, renaming, or recategorizing operations.
- Preserve the distinction between deployed-user behavior and this development environment. End-user Codex setup belongs in the extension's `Configure Codex MCP Integration` operation, not in this repo-level instruction file.

## Expected Failure Handling

- Design every workflow to handle foreseeable failures explicitly. This applies throughout the repository, especially to PowerShell scripts, and also to extension code, MCP tools, external processes and service integrations. Expected failures must not reach users as raw exceptions or stack traces.
- Handle failures at the boundary that can explain them: identify the failed operation and stage, report a safe reason and relevant status/error code when available, and provide concrete recovery steps. Distinguish known causes from unknown causes; do not guess from arbitrary exception text. Keep credentials, tokens and sensitive backend payloads out of diagnostics.
- For expected PowerShell operation failures with reviewed, toolset-authored diagnostics, use `New-BcExpectedFailure` from `common/PublishingDiagnostics.ps1`. The operation launcher renders a red failure heading and plain recovery guidance, then exits with failure status, without PowerShell source-line/exception decoration. This must visibly communicate an execution problem requiring attention without presenting it as a Toolset crash. Never mark arbitrary backend exception text as safe. Cover the heading color, displayed message and failed status in regression tests.
- Preserve failure semantics: stop dependent work, return a failed result or nonzero exit status, and never print completion or success after a failed step. Graceful handling must not silently swallow errors or turn failure into success. Clean up owned resources in `finally` blocks or equivalent disposal paths.
- In PowerShell, use `try`/`catch` around fallible workflow boundaries and `-ErrorAction Stop` where nonterminating cmdlet errors must fail the step. Check native process exit codes explicitly. Do not use `SilentlyContinue` to hide a workflow failure; reserve it for genuinely optional probes whose absence is handled explicitly.
- Report whether side effects were not started, completed, partially completed or remain unknown. After an uncertain write/deployment outcome, explain how to inspect or reconcile the target before retrying. Retry only when the operation's semantics establish that it is safe, with bounded attempts; do not silently switch targets, credentials or deployment methods.
- Reuse shared failure-handling helpers across workflows with the same failure modes. Add regression tests for expected failure paths, including nonterminating PowerShell errors where applicable, actionable diagnostics, preservation of failure status, cleanup and prevention of unintended continuation or duplicate side effects.

## Filesystem Path Safety

- Treat paths originating from users, workspace settings, environment variables, operation arguments, or callbacks as untrusted.
- Before filesystem access, resolve and normalize an untrusted path and verify with `path.relative` that it is equal to or contained by an explicitly authorized root. Reject paths that escape the root; do not rely on normalization alone.
- Construct internal paths from a trusted root plus fixed path segments whenever possible. Avoid generic helpers that pass unchecked path parameters directly to `fs.readFileSync`, `fs.writeFileSync`, `fs.statSync`, or similar APIs.
- Do not use filesystem paths or file metadata merely to produce cache keys, versions, or identifiers. Prefer an explicit reviewed revision constant, a UUID, or a hash of non-sensitive canonical data. For the MCP tool surface, increment `mcpServerDefinitionRevision` whenever tools or schemas change.
- When a filesystem path is intentionally configurable and cannot be confined to one root, validate it at the configuration boundary and pass a validated path object or clearly named validated value to filesystem code.
- If static analysis still flags a validated filesystem sink, use the analyzer's narrow inline suppression only on that sink, with an adjacent comment stating the authorization and containment guarantees. Never suppress an unvalidated path flow.

## Verification

- Run `npm run validate` from `vscode-extension` after changing extension JavaScript or package metadata.
- Run `node --check vscode-extension/mcp-server.js` after changing the MCP server.
- Validate JSON files after editing operation metadata, package contributions, schemas, or generated configuration examples.

## Code Review Rules

- Flag catch blocks that replace a known, safely reportable failure cause or status with a generic message. Require operation/stage context and concrete recovery steps while keeping credentials and sensitive backend payloads out of diagnostics.
- Flag continuation, success reporting, prohibited fallbacks, or automatic retries after failed or uncertain operations. Require preserved failure status, explicit side-effect state, and cleanup of owned resources.
- For changed failure paths, require tests that verify useful diagnostics, failure propagation, cleanup, and prevention of dependent work or duplicate side effects, as applicable.
