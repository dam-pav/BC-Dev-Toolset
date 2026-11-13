# Configurable curated skill source

- Objective: Maintain a future user-selected GitHub skill source checkout and expose its skills through personal Codex adapters, alongside BCQuality.
- Acceptance: machine-scoped User URL/path settings; empty configuration disables maintenance; clone and safe fast-forward updates; `skills/<name>/SKILL.md` discovery; owned adapters in `~/.agents/skills`; preserve user modifications and other integrations; safe paths, failure diagnostics and locks; aligned commands, metadata and documentation.
- Plan revision: 1. One cohesive phase; repository does not yet exist, so no real checkout or personal skill activation can be performed now.
- Current phase: 1, pushed. Overall status: complete.
- Next action: once the source repository exists, configure its URL and dedicated clone path in User settings. Draft PR awaits normal repository review/merge.

## Phase 1: Configurable source maintenance and registration

- Scope: new standalone integration reusing existing filesystem/locking helpers, URL/path settings, update/status commands, operations and docs.
- Dependencies: existing BCQuality integration; Node/Git. No live repository dependency for isolated tests.
- Test formulation: test_design supplied acceptance scenarios for lifecycle, checkout, discovery, ownership, path safety, failures and dispatch. Executable regression tests delegated to test_design.
- Implementation: integration completed core maintenance/lifecycle; main completed extension wiring, metadata, runtime revision and documentation.
- Validation: independent verification passed JSON parsing and git diff --check. First full npm run validate failed: 563 tests, 560 passed, 2 failed, 1 skipped. Fixed missing parent configuration defaults and updated runtime revision test to 75. Final npm run validate passed: 572 total, 571 passed, 0 failed, 1 existing skip (file symlinks unavailable). Final independent targeted rerun passed 37/37 after one additional regression was appended. No production extension installation or global settings changes.
- Review: independent verification phase and post-push overall reviews passed with no unresolved findings. Repairs cover remote bootstrap, preserved primary/cleanup/pull diagnostics, uncertain side-effect state and failed refresh command result despite cached content. Retained-content claims occur only after successful revalidation.
- Commit: 0fbdb93 (Add configurable curated skill source maintenance).
- Push: origin/main rejected with GH013, changes must be made through a pull request. Remote main unchanged. Recovery completed: implementation commit pushed to origin/feature/curated-skills-source, upstream configured.
- Draft pull request: https://github.com/dam-pav/BC-Dev-Toolset/pull/180. Final bookkeeping is recorded separately from the implementation commit.

## Evidence and limitations

- Initial working tree clean, branch main, upstream origin https://github.com/dam-pav/BC-Dev-Toolset.git.
- Only root AGENTS.md found; runtime is generated/ignored.
- A repository-wide rg search encountered an existing invalid ignore glob; subsequent discovery used --no-ignore. No source writes occurred during discovery.
- Actual activation awaits creation of the repository and setting its URL/path; defaults must remain empty.
