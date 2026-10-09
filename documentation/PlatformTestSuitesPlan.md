# Platform-based test suites

Branch: `feature/platform-test-suites`. Started 2026-10-09.

## Agreed contract

- One Container configuration per intended BC version. Add only `platform`; no compatibility opt-in flag.
- Omitted platform inherits the workspace baseline. Baseline targets serve development; explicitly newer targets form the compatibility matrix. Older targets are ineligible.
- Remove `executeTestsInContainerName`, including defaults, schemas, migration, and MCP assumptions.
- Humans and agents use the same resolver and operation pipeline. Development resolves one target (or asks on ambiguity); compatibility executes every eligible newer target.
- Container test operations build before container access, then prepare, deploy dependencies and built apps, and test. Selection never disables deployment.
- AL tests, page-script tests, and AL Runner use the same platform selection policy. AL Runner does not need a running container.
- App manifests retain their minimum supported version. Configured release versions are provisioning intent; actual application and internal platform versions are separate facts.
- Existing container version mismatches fail clearly; never silently recreate or substitute a version.

## Execution and acceptance

Each phase follows: inspect/review existing behavior; develop; run behavioral regression tests and required repository validation; review the resulting diff; update this ledger; commit only that accepted phase. Acceptance means the documented checks pass and review finds no unresolved correctness issue. Live integration acceptance requires actual operation evidence, not mocks. No release, merge, or marketplace publication is implied.

### Phase 0 — Isolate and review

Create an isolated worktree so uncommitted BC Data experiments remain intact. Record the plan and inspect the three operation paths, configuration migration, MCP inputs, and packaging. Verify baseline tests.

### Phase 1 — Correct test preparation

Remove the deployment bypass. Ensure both container modes build before Docker access, preparation, restore, or deployment. A failed build must prevent all container side effects. Preserve explicit restore policy. Regression tests must exercise one candidate with an unset legacy setting and verify fresh app deployment and stage ordering.

### Phase 2 — Version contract and target resolution

Implement a pure shared resolver with numeric version parsing, inherited baseline, deterministic ordering, eligibility diagnostics, and development ambiguity handling. Establish BC release versus internal platform semantics and supported AL Runner precision from evidence before committing the contract. Add Container-only `platform` to both schemas and artifact creation. Test invalid inputs, boundary versions, equal/newer/older targets, and workspace baseline consistency.

### Phase 3 — Remove legacy selection and fix launch routing

Remove `executeTestsInContainerName` everywhere; migrate persisted settings using existing migration infrastructure. Integrate shared selection into all three development modes and MCP preflight. Generate usable Dev/Test app launch entries without duplicate container configurations or new flags. Test migration preservation/idempotence, one/zero/multiple candidates, and human/MCP parity.

### Phase 4 — Compatibility operations and reports

Add compatibility counterparts for the three modes and keep operation metadata, command contributions, MCP schemas, help, and revision constants aligned. Iterate newer targets sequentially with isolated build artifacts/caches where required; record per-target actual versions and outcomes. Validate existing containers before mutations. AL Runner must reject unsupported target precision instead of substituting. Test partial failures, mode parity, and reports.

### Phase 5 — Integration and BC Data adoption

Run full validation and final source review. Make the changed extension available in a suitable development host before exercising its MCP operations. Update BC Data's local configuration to one BC23 target and one BC27.1 target, remove obsolete seed setup only after replacement works, and verify launch generation. Run development and compatibility experiments through Toolset MCP; record compile, deployment, and runtime evidence independently. Stop and report an actual integration blocker rather than bypassing Toolset.

## Review ledger

- Phase 0: isolated worktree created from `041d8e6`; BC Data worktree preserved. Initial review confirmed selection-dependent deployment bypass, page-script tests lacking a build step, and AL Runner currently selecting only an application major. Baseline npm run validate passed: 212 passed, 1 skipped (Windows file-symlink capability), 0 failures. Phase 0 accepted.
- Phases 1–5: pending.

