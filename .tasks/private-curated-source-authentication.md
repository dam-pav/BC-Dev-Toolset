# Private curated source authentication

- Objective: Enable explicit, secure authentication for a private curated GitHub skill source.
- Plan revision: 1, explicitly approved by the user's "proceed" response.
- Status: phase 1 ready-to-commit; implementation, validation and independent phase review complete.
- Context: Git runners currently disable interactive authentication; existing Git credential helpers or SSH authentication may work, but the extension has no token management UI.
- Verified task branch: feature/curated-skills-source, worktree C:/Projekti/DAM-PAV/BC-Dev-Toolset; existing open PR #180. Origin upstream is the same feature branch. Initial tree contains only this task record.
- Environment: existing Node/Git and isolated test fixtures; no production extension installation or real credential writes planned.
- Commit authorization: plan approved; the current skill separately requires confirmation of the staged/tested commit. No task-scoped autonomy grant was requested.

## Phase 1: Private-source authentication

- Add human-only Configure/Remove Curated Skills Access Token commands in Curated Skills, plus read-only repository access validation.
- Store tokens in VS Code ExtensionContext.secrets, keyed to the canonical repository identity. No token-valued setting, URL, generated adapter, log or MCP argument.
- Deliver stored credentials only to the configured HTTPS Git operation through a bounded private credential channel; never command-line arguments or persistent Git configuration. Keep SSH and existing Git authentication usable when no toolset token is configured; an explicitly configured token failure must not silently switch identities.
- Preserve failed outcomes, safe stage/status diagnostics and known/unknown side-effect reporting. Access validation must not clone/update or register adapters.
- Test authentication source selection, private-source clone/update, token replacement/removal and URL changes, no secret leakage, expiry/denial/unavailable storage failures, no fallback after explicit token rejection and cleanup of temporary channels/resources.
- Align operation metadata, contributions, documentation and runtime revision; keep human credential setup outside MCP.
- Use delegated test formulation/implementation, independent validation/review, npm run validate and JSON checks, then commit/push and overall review.
- Delegation: auth_design formulated canonical identity/storage selection, private transport, no leakage/fallback, dependency prevention and read-only access tests; implements auth module/core integration and transport tests. token_ui formulated masked prompt/cancellation/races/storage failure/dev-host/access-check tests and implements UI/lifecycle with isolated tests. auth_verify independently reviews security and will validate. Main owns metadata/docs/dispatcher/existing regression alignment.
- Credential channel: process-local exact canonical HTTPS URL-scoped Git header, secret on network child environment only; redirects, credential helpers, inherited tracing/config overrides and submodule recursion disabled for explicit-token network calls. Private clone/fetch do not execute worktree checkout/merge with secret-bearing environment. No token file or persistent Git config.
- UI validation: token_ui reports 15/15 isolated UI regressions passed; arbitrary backend error codes are omitted using known-status whitelists. No real credential changes.
- Core validation: auth_design reports 40/40 transport and existing integration tests passed, including real isolated Git clone/fetch/merge and URL/header matching checks. Shared URL/path validators extracted to avoid circular imports. No real credentials or external repositories used.
- Independent validation/review: auth_verify passed 84/84 focused checks; JSON parsing and diff checks passed. First full npm run validate failed: 610 tests, 607 passed, 1 failed, 1 cancelled, 1 existing skip. The two unchanged credential/settings timeout files passed 24/24 on focused rerun, with previously slow checks completing in 4.9 seconds and 73 milliseconds. Bounded full rerun will use npm run validate -- --test-concurrency=4 without changing assertions/timeouts. No production side effects, isolated fixtures only.
- Review repairs completed: secret-free URL rewrite preflight, case-insensitive environment sanitization, preserved safe stage/status diagnostics and accurate SSH/LFS scope documentation. Actual Git fixture confirms no token/header persistence in .git/config.
- Final review repairs completed: explicit Git Trace2 environment targets set to 0 (global trace2 config cannot reactivate logging); UUID sentinel probe verifies runtime environment configuration support before supplying a token; safe timeout causes survive capability wrappers; UI and transport diagnostics whitelist known status codes. Direct real-Git trace/config regression and unsupported-channel fail-closed regression added; auth suite passed 19/19 and UI suite 15/15.
- Final independent validation: npm run validate -- --test-concurrency=4 passed, 615 total, 614 passed, 0 failed/cancelled, 1 existing platform skip. Final focused checks passed 89/89; edited JSON and diff checks passed. Independent phase review passed with no unresolved findings. No production JS changed after the validated snapshot; final Git prerequisite documentation reviewed.
- Proposed commit: Add secure authentication for private curated skill sources.
- Intended commit branch and push destination: feature/curated-skills-source -> origin/feature/curated-skills-source, existing PR #180.
- Staged scope: repository-scoped SecretStorage token commands, read-only access check, bounded/redacted Git transport, shared validation, metadata/docs and regression tests. No real credentials stored and no production extension installed.
- Commit confirmation: explicitly approved by the user's "commit" response to the presented staged change, message, branch and push destination. This approval covers this commit only.
- Next action: commit/push the approved change, then perform independent overall review.
