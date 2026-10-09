# Platform-based test suites

Branch: `feature/platform-test-suites`. Started 2026-10-09.

## Agreed contract

- One Container configuration per intended BC version. Add only `platform`; no compatibility opt-in flag.
- Omitted platform inherits the workspace baseline. Baseline targets serve development; explicitly newer targets form the compatibility matrix. Older targets are ineligible.
- Remove `executeTestsInContainerName`, including defaults, schemas, migration, and MCP assumptions.
- Humans and agents use the same resolver and operation pipeline. Development resolves one target (or asks on ambiguity); compatibility executes every eligible newer target.
- Container test operations build before container access, then prepare, deploy dependencies and built apps, and test. Selection never disables deployment.
- AL tests, page-script tests, and AL Runner use the same platform selection policy. AL Runner does not need a running container.
- App manifests retain their minimum supported version. A Container configuration's `platform` is the BC application release used for artifact provisioning; actual application and internal platform versions are separate facts.
- Existing container version mismatches fail clearly; never silently recreate or substitute a version.

## Execution and acceptance

Each phase follows: inspect/review existing behavior; develop; run behavioral regression tests and required repository validation; review the resulting diff; update this ledger; commit only that accepted phase. Acceptance means the documented checks pass and review finds no unresolved correctness issue. Live integration acceptance requires actual operation evidence, not mocks. No release, merge, or marketplace publication is implied.

### Phase 0 — Isolate and review

Create an isolated worktree so uncommitted BC Data experiments remain intact. Record the plan and inspect the three operation paths, configuration migration, MCP inputs, and packaging. Verify baseline tests.

### Phase 1 — Correct test preparation

Remove the deployment bypass. Ensure both container modes build before Docker access, preparation, restore, or deployment. A failed build must prevent all container side effects. Preserve explicit restore policy. Regression tests must exercise one candidate with an unset legacy setting and verify fresh app deployment and stage ordering.

### Phase 2 — Version contract and target resolution

Implement a pure shared resolver with numeric version parsing, inherited baseline, deterministic ordering, eligibility diagnostics, and development ambiguity handling. Establish BC release versus internal platform semantics and supported AL Runner precision from evidence before committing the contract. Add Container-only `platform` to both schemas and artifact creation. Test invalid inputs, boundary versions, equal/newer/older targets, and workspace baseline consistency.

Phase 2 review decision: `platform` identifies the Business Central application release passed to container artifact selection, while `app.json.application` remains the workspace minimum. The resolver normalizes release versions to four numeric components, inherits the baseline when omitted, selects equal-baseline configs for development, and explicitly newer configs for compatibility. Lower versions are excluded; duplicate normalized targets fail with a correction message. Container creation also rejects an explicitly configured release below the workspace minimum. Omitted values preserve current provisioning behavior.

### Phase 3 — Remove legacy selection and fix launch routing

Remove `executeTestsInContainerName` everywhere; migrate persisted settings using existing migration infrastructure. Integrate shared selection into all three development modes and MCP preflight. Generate usable Dev/Test app launch entries without duplicate container configurations or new flags. Test migration preservation/idempotence, one/zero/multiple candidates, and human/MCP parity.

Phase 3 review decision: development selects exactly the unique resolved baseline config. The same resolver is used by AL test-tool, page-script, and AL Runner; the latter does not require the test toolkit but still uses a configured Container platform as its version target. Old named-target settings are removed on startup from user, workspace, folder, and local settings; a test confirms migration preserves other values and is idempotent. Initialization uses one Local configuration, and toolkit-enabled configs produce role-specific launch entries in both Dev and Test app folders. Accepted and committed as `7722d15`. Full npm run validate passed: 218 passed, 1 skipped, 0 failures.

### Phase 4 — Compatibility operations and reports

Add compatibility counterparts for the three modes and keep operation metadata, command contributions, MCP schemas, help, and revision constants aligned. Iterate newer targets sequentially with isolated build artifacts/caches where required; record per-target actual versions and outcomes. Validate existing containers before mutations. AL Runner must reject unsupported target precision instead of substituting. Test partial failures, mode parity, and reports.

### Phase 5 — Integration and BC Data adoption

Run full validation and final source review. Make the changed extension available in a suitable development host before exercising its MCP operations. Update BC Data's local configuration to one BC23 target and one BC27.1 target, remove obsolete seed setup only after replacement works, and verify launch generation. Run development and compatibility experiments through Toolset MCP; record compile, deployment, and runtime evidence independently. Stop and report an actual integration blocker rather than bypassing Toolset.

## Review ledger

- Phase 0: isolated worktree created from `041d8e6`; BC Data worktree preserved. Initial review confirmed selection-dependent deployment bypass, page-script tests lacking a build step, and AL Runner currently selecting only an application major. Baseline npm run validate passed: 212 passed, 1 skipped (Windows file-symlink capability), 0 failures. Phase 0 accepted.
- Phase 1: accepted and committed as `1f30378`. Regression test proves build precedes Docker access, single-candidate target deploys, and a failed build stops before container side effects. Full npm run validate passed: 213 passed, 1 skipped, 0 failures.
- Phase 2: accepted after review and committed as `836635f`. Shared numeric resolver, Container-only `platform` schema, and container artifact selection implemented. AL Runner release precision is passed explicitly to `--bc-version`. Full npm run validate passed: 216 passed, 1 skipped, 0 failures.
- Phase 3: accepted and committed as `7722d15`.
- Phase 4 review decision: all three compatibility operations resolve every explicitly newer platform in numeric order and execute sequentially. Container modes build once, validate installed Microsoft Application versions before backup restore or publish, and report each target's configured and actual Application version; a major-only target such as `23.0` accepts cumulative updates in major 23, while a non-zero minor such as `27.1` must match exactly. Page-script compatibility results are isolated under `BC-<release>` folders. AL Runner receives each configured major/minor through `--bc-version`; its report labels this as requested because that mode has no independent installed-version probe. Test failures are collected per target while subsequent targets continue. `npm run validate` passed: 221 passed, 1 skipped, 0 failures; `git diff --check` passed. Live container/AL Runner evidence remains Phase 5.
- Phase 4: accepted after source review; commit hash recorded after commit.
- Phase 5: pending live MCP/container integration and BC Data adoption.
