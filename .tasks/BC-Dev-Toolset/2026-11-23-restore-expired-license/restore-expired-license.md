# Restore with an expired database license

- Objective: remedy the reported post-restore application discovery failure and misleading generic diagnostic.
- Plan revision: 1, approved by user message "proceed" on 2026-11-23.
- Current phase: ready-to-commit. Overall status: implementation tested and independently reviewed; commit/push approved. Next action: commit, push and perform final overall review.
- Repository/worktree: C:/Projekti/DAM-PAV/BC-Dev-Toolset.
- Verified branch: fix/restore-expired-license; created from main; working tree clean before this record.
- Intended base: main. Intended task branch: fix/restore-expired-license.
- Intended push destination: origin, same task branch.
- Approval evidence: user "proceed" approves plan revision 1. Commit approval: required separately; no task autonomy grant.
- Environment: node and pwsh available; production container untouched. No live restore authorized or planned.

## Evidence

The supplied DRI transcript shows Restore-DatabasesInBcContainer returned, followed by Get-NAVAppInfo reporting an expired program license. The runtime option was reset. Application compatibility and administrator access remain unverified.

common/BackupMgt.ps1 starts the BC service and discovers application versions after SQL restore without importing the workspace license. Its discovery catch forwards only Exception to New-BcRestoreFailure, which generally substitutes unknown-cause guidance. WorkspaceMgt.ps1 already contains configured-license handling for container creation and a separate license update operation.

The installed phased-development skill path was absent. The same named skill was discovered and read at C:/Projekti/SICOM/_code/Skills/skills/phased-development/SKILL.md through the curated-source adapter.

## Phase 1 — license restoration and failure reporting

- Scope: validate an explicitly configured workspace license before destructive restore; import it into the restored target at the appropriate point before license-dependent verification; preserve useful, reviewed licensing failure guidance across the container boundary without leaking arbitrary backend text.
- Acceptance: configured-license handling precedes version discovery; unavailable/invalid license configuration stops before SQL changes; failed import or discovery stops dependent work; no automatic SQL retry; runtime settings reset; no false success.
- No configured license: retain compatibility with existing workflows, report actionable guidance on license-related discovery failures, and do not invent or download a replacement license.
- Tests: independent subagent formulates regressions for expired license, configured-license ordering, absent license, import failure, nonterminating errors, transport-safe diagnostics, preserved failure status, no administrator repair after failure, no duplicate SQL restore, and runtime cleanup. Include launcher red heading/plain guidance checks where applicable.
- Implementation: delegate bounded changes after plan approval; main agent integrates.
- Validation: targeted restore and launcher tests, PowerShell parse checks, required extension validation if its JavaScript/metadata changes; independent phase review and repair loop.
- Commit/push: stage reviewed phase changes; request separate commit confirmation; commit and push to task branch after approval.
- Final: independent overall review; report evidence and any remaining limitations.
- Phase status: ready-to-commit. Tests and independent phase review passed. Commit/push approved; overall post-push review pending.



## Implementation and validation evidence

- Implementation agent completed BackupMgt.ps1, TestMgt.ps1, and SQLRestoreDiagnostics.md. PowerShell parser and git diff --check passed in its checks.
- License import uses a Toolset-owned container script with bounded byte payload, fixed temporary root plus generated filename, explicit import/restart error handling, finally cleanup and bounded returned status. It does not rely on the helper license-import function that lacks inner terminating-error handling.
- Test author initial run: node --test vscode-extension/test/restore-license.test.js, 15 passed; omitted-settings and multitenant additions still pending independent validation.
- Independent verifier/reviewer started targeted and required validation; results pending.
- Production DRI container and deployed runtime untouched; no live SQL restore or installation attempted.
## Independent review and repair loop

- Initial independent targeted run: 155/155 passed across restore-license, restore-modern-versions, restore-windows-powershell, restore-diagnostics, operation-messages and backup-mgt tests (42.1 seconds). PowerShell parsing and diff whitespace checks passed.
- Finding 1 accepted: bounded import failure lost its known staging/import/restart step. Repair adds allowlisted failure-stage transport and stage-specific reviewed guidance; regression coverage expanded to preserve primary stage/status with secondary cleanup failure.
- Finding 2 accepted: validation diagnostic claimed no restore preparation even though outer workflows may already have started the target and staged backups. Repair states exact absence of service stop/SQL work and explicitly acknowledges prior startup/staging.
- Coverage improvement: verify actual test initializer forwards workspace license settings, in addition to manual/auto wrapper propagation.
- Full validation and final independent review pending repaired integration.
- Expanded author regression run: 24/24 passed (16.2 seconds), including actual Initialize-TestExecutionContainer setting propagation and failure preventing dependent publishing.
- Finding 3 accepted: if the configured license becomes unreadable after preflight while SQL restores, host payload read fails before remote import begins. Repair records that known host-read stage and exact no-import/no-restart state rather than reporting uncertain installation side effects. A delete-during-SQL regression is being added before final validation.

- All three review repairs implemented. Test author final regression run: 25/25 passed (15.9 seconds). Independent final targeted/full checks started against stable files.
- Final independent targeted suite: 164/164 passed (43.4 seconds), including all 25 new regressions. Final PowerShell parse and git diff --check passed.
- Independent final source/test review: all three diagnostic findings resolved; no remaining substantive source, path-safety or failure-handling findings. Full npm run validate running; commit/push still not started.


## Commit approval gate

- Final required check: npm run validate from vscode-extension exited 0; 680 tests total, 678 passed, 2 skipped, 0 failed (59.9 seconds). Its JavaScript syntax checks and test-preparation wrapper passed.
- Independent phase review passed with no unresolved findings. Main agent reviewed the integrated diff against AGENTS.md, including failure semantics, diagnostics, resource cleanup and filesystem path boundaries.
- Intended commit: Fix configured license handling after SQL restore.
- Staged scope: BackupMgt.ps1, TestMgt.ps1, SQLRestoreDiagnostics.md, restore-license.test.js, and this task record only.
- Branch: fix/restore-expired-license. Intended push: origin/fix/restore-expired-license.
- Commit confirmation: user explicitly instructed "commit and push" on 2026-11-23, approving the presented staged change, message and destination. No commit hash or push result exists yet.
- Final overall review remains pending until the phase is committed/pushed.
- Limitation: validation uses mocked container boundaries; no live container restore, runtime installation, packaging or deployment was attempted.

