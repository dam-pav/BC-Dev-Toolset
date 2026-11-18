# Issue 184: normal container app upgrades

- Issue: https://github.com/dam-pav/BC-Dev-Toolset/issues/184
- Objective: normal container publishing installs absent apps and upgrades older installed versions without uninstalling or losing extension data.
- Plan revision: 1, approved by user response `ok` on 2026-11-17.
- Overall status: complete; current phase: pushed and reviewed; next action: none within requested implementation scope.
- Repository/worktree: `C:/Projekti/DAM-PAV/BC-Dev-Toolset`.
- Proposed base: `origin/main`, inspected at `8e14885`.
- Verified task branch: `dam-pav/issue184`, checked out at the same commit; reused after approval.
- Intended push destination: `origin/dam-pav/issue184`; upstream not yet configured.
- Working tree was clean before this record was created.
- Environment: PowerShell, Node, npm and GitHub CLI available. Automated checks passed. User's Extension Development Host supplied live verification on dedicated `CoreUpgradeTest` (details below). No live operations executed by this agent.

## Skill routing

Task context: implement issue 184 in the tooling source repository; available inputs are repository source, issue reproduction and repository instructions.

Dispatch: `skills/phased-development/SKILL.md` at task start; `skills/tooling-policy/SKILL.md` at phase step governed by phased-development, both from `C:/Projekti/SICOM/_code/Skills`. AL workflow is excluded because this deliverable changes tooling source rather than publishing a consuming AL app. Issue-derived titles are excluded until a relevant PR/merge task applies.

The configured installed phased-development skill was missing; the current skill was found through the curated-source router. Read-only searches encountered an invalid existing ignore glob and a nonexistent `tests` directory; discovery was repeated with `--no-ignore` and the actual `vscode-extension/test` directory. No target side effects occurred.

## Phase 1: correct and verify normal container publication

Scope:

1. Have a subagent formulate regression tests from the issue criteria.
2. Delegate the normal Container publishing fix and executable regression coverage. Preserve development-endpoint behavior and selected-target isolation. Use the BcContainerHelper install/upgrade contract after verifying it; do not uninstall existing apps.
3. Cover fresh install, older-version upgrade, same-version republish, mixed unchanged/upgrade batch, target isolation and unchanged development endpoint behavior. Cover publishing failures with actionable diagnostics, failed status, uncertain/partial deployment state, no dependent continuation, retries or duplicate writes.
4. Run focused PowerShell/Node checks and relevant publishing regressions through an independent tester. Run the repository validation suite where applicable. Inspect the diff against failure-handling and filesystem safety instructions.
5. Obtain independent review and repair any findings. Stage only intended files; present the concrete commit for confirmation, then commit and push after approval.
6. Run independent overall review after pushing.

Acceptance criteria: absent apps install; older versions use the platform upgrade path; same-version and mixed batches avoid erroneous installation/downgrade; selected targets and development endpoint behavior remain intact; failures retain failed status and explain uncertain side effects safely.

Validation limitation: mocked transport tests cannot prove real platform Upgrade trigger execution or seeded-data preservation. Verify dedicated BC 26 integration prerequisites before dependent live checks. If unavailable, record the blocker and recovery action; do not claim live validation passed or advance a required validation gate.

Dependencies: explicit plan approval; verified BcContainerHelper behavior; test runtime availability; dedicated target and baseline/upgrade fixture for live data/trigger validation.

Status: pushed and reviewed. Test formulation, implementation, automated independent tests, phase review and review reconciliation passed. User-supplied live verification confirms upgrade, replacement-record preservation, completion tags and repeat-publication skipping. Approved commit, push and independent overall review complete.

## Approvals and evidence

- Plan approval: user response `ok` after presentation of revision 1; branch and clean tree rechecked.
- Commit confirmation: user response `commit` on 2026-11-18 to the presented six-file commit and push proposal. Covers this commit only; no task-scoped autonomy grant.
- Tests: focused checks, actual-helper mocked contract, independent automated suite and user-supplied live checks passed within issue scope; old-ID retention failed and physical copy mechanism unavailable (explicit limitations below).
- Commit: `aa2d59156c3c116da391e1ca2b01b298a313034b` (`fix: upgrade installed apps during normal container publishing`), created 2026-11-18 after explicit confirmation.
- Push: `git push --set-upstream origin dam-pav/issue184`, exit 0; upstream established. `git ls-remote --heads origin dam-pav/issue184` confirmed the same full SHA.
- Independent overall review: `test_design` reviewed committed `aa2d591` against issue 184, tests/live evidence, failure-handling and path-safety requirements; passed with no unresolved implementation findings. Original-ID and physical-copy limitations remain explicit. No additional code changes or PR work required for this scope.

## Phase evidence

- Test formulation delegated to `test_design` (read-only).
- Installed BcContainerHelper 6.1.19 source inspected at `AppHandling/Publish-NavContainerApp.ps1`: both install/upgrade switches select the platform operation through ExtensionDataVersion; `ignoreIfAppExists` skips installed equal/newer published versions. Development endpoint uses a separate helper branch.
- No `bc_dev_toolset_*` tools are exposed in this session. Live integration prerequisites remain unverified; no containers have been inspected or changed.
- Test formulation completed by `test_design`: fresh/older/equal/newer cases, dependency-ordered mixed batch, selected-target roles, unchanged Dev credentials/switches, terminating/nonterminating failures and launcher red heading/nonzero exit. Simulated identity/upgrade markers must not be reported as platform verification.
- Implementation delegated to `implementation`, owning `common/PublishApps.ps1` and publishing/launcher regression files. Main owns README and task record. No Git mutations delegated.
- Actual installed-helper scriptblock contract validation delegated to `test_design` with mocked NAV commands only; no live helper/container calls.
- Actual helper contract check passed (PowerShell 7.7.0, exit 0): AST-extracted BcContainerHelper 6.1.19 inner scriptblock produced Publish/Sync/Install for absent apps, Publish/Sync/Start-NavAppDataUpgrade for older versions, no calls for synced equal/newer installed versions, and only the older app upgraded in a mixed batch. All NAV commands were capture-only mocks; nested process execution was blocked. Initial parameter-count validation failed before scriptblock execution, then corrected extraction passed. This proves helper decision logic against mock metadata, not real BC data preservation or AL trigger execution.
- Live fixture and development-host MCP connection requested from user while automated work continues. Local configuration names alone do not establish ownership or readiness. Live data/Upgrade-trigger validation remains pending.
- User replied: `I will open an extension development host with a suitable context`. Waiting for that context/tools; latest tool discovery still exposes no `bc_dev_toolset_*` operations. Continue automated checks and review independently.
- Implementation integrated: normal-only upgrade/ignore switches and shared publishing failure boundary; README explains lifecycle and uncertain deployment state. New PowerShell fixture plus Node registration and launcher tests cover approved scenarios.
- Implementer checks passed: new PowerShell fixture, focused Node suite (73/73), `git diff --check`. Initial fixture scope collisions were corrected before the passing rerun; no product failure was hidden.
- Independent tests by `independent_test` passed: direct PowerShell fixture exit 0; `node --test test/publishing-selection.test.js test/operation-messages.test.js` from `vscode-extension`: 73/73 passed, zero skipped/failed, exit 0; `npm run validate` from `vscode-extension`: 634 total, 632 passed, 2 skipped, zero failed/cancelled, exit 0, including all syntax checks; final `git diff --check` exit 0. No target changes or edits by tester.
- Independent phase diff review by `test_design`: no implementation findings; failure handling, filesystem containment and regressions assessed. Review notes the pending independent test results and required live data/trigger validation. Stale status summaries in this record corrected.
- Main assessed the final diff against repository failure-handling/path-safety rules and independent passing checks. No new MCP schema/tool/operation metadata, filesystem sink or deployment fallback was introduced. Only task-record status text changed after the automated checks.

## User-supplied live evidence (2026-11-17)

User supplied development-host `publishApps` output from the Core workspace using this Toolset source root, selected configuration/container `CoreUpgradeTest`, BcContainerHelper 6.1.19 and PowerShell 7.7.0. The container was started from exited/unhealthy to running/healthy by the supported operation. Test apps were excluded.

Relevant output:

```text
Payroll version 26.0.0.50 is already published
Synchronizing Payroll on tenant default
Upgrading Payroll on tenant default
App Sicom d.o.o._Payroll_26.0.0.50.app successfully published
Data Editor version 26.0.0.0 is already published
Data Editor version 26.0.0.0 is already installed
App Sicom d.o.o._Data Editor_26.0.0.0.app successfully published
!!!!     DONE     !!!!
```

This establishes observed successful normal publishing through the platform upgrade path for Payroll and skipping an unchanged Data Editor in the same batch. The prior issue's published-but-not-installed package was handled without an install refusal. This is user-supplied evidence, not an operation executed by this agent; no independent exit-code envelope or installed-app query was supplied.

The initial log did not contain post-upgrade data/marker or repeat-publication results. The user subsequently supplied this verification summary, reporting independent development-host review confirmed it:

| Check | Reported result |
| --- | --- |
| Payroll 26.0.0.50 installed | Passed |
| 23 replacement records: keys, SystemIds and all 180 captured values | Passed |
| Upgrade lifecycle, replacement availability and 25 completion tags | Passed |
| Repeat publishing skips Payroll and Data Editor without install/upgrade/downgrade | Passed |
| Container, data, rowversions and tags preserved | Passed |
| Seeded rows retained at old IDs | Failed: 0/23 |
| Exact physical copy mechanism | Unavailable |

Interpretation is limited to observed outcomes: replacement records preserve all captured identities/values and upgrade completion evidence is present. Rows were not retained at old IDs; this is not recast as a passing assertion. The exact physical copying mechanism is unproven. Issue 184 requires additive platform upgrade and preserved extension data, not simultaneous copies at original and replacement table IDs or proof of physical storage internals. No application migration code is changed by this tooling fix. Do not claim original-table retention, a particular migration implementation, or raw-artifact inspection by this agent.

Independent phase reviewer `test_design` reconciled the new live evidence: no new code findings; phase can proceed to explicit commit confirmation. Old-ID retention requirements, if any, require separate application-level acceptance criteria. Current session exposes no `bc_dev_toolset_*` tools; all live results above are user-supplied, with no manual fallback or direct target inspection by this agent.

## Resume prerequisites and gates

- User-supplied live verification is complete within issue scope, subject to the explicit old-ID and physical-mechanism limitations. No more live target mutation is needed for this phase.
- Proposed commit: `fix: upgrade installed apps during normal container publishing`. Branch: `dam-pav/issue184`; intended push: `origin/dam-pav/issue184` (establish upstream on first push).
- Staging scope: only the intended six files (source, README, three test files and this task record). Explicit confirmation received as recorded above; afterward commit/push and complete independent overall review. Branch, staged scope and staged whitespace check reverified on 2026-11-18; no unstaged changes preceded this approval bookkeeping update.
- Implementation commit and push completed as recorded above. User response `commir` on 2026-11-18 authorizes committing the disclosed remaining task-record update; proposed subject: `docs: finalize issue 184 task record`, same branch and upstream. Report this bookkeeping commit's resulting hash/push in the final response without another self-referential record update. This agent started no live side effects; the user's live operation started CoreUpgradeTest and successfully published/upgraded Payroll, with unchanged Data Editor skipped.
