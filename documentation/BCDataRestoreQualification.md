# BC Data restore qualification: prepared protocol

Status: pending actual SQL backup/restore. Expiry-aware counter scopes are implemented as test fixtures; a restore can rewind both receipt and generation state and is not certified by the expiry tests.

## Execution boundary

Use the Extension Development Host and its local BCData.Development.code-workspace MCP binding. Start with `BC23 Baseline` / `bcdata23test`; repeat on `BC27.1` / `bcdata271` only after the first target is recovered and checked. No unrelated container, regular VS Code installation or global MCP binding is part of this experiment.

Use the direct Toolset MCP backup/restore operations. Their two exposure switches are enabled only in the ignored local development workspace; after the development-host/binding refresh on 2026-10-19 both tools are exposed and workspace discovery verifies the development binding. The restore operation metadata in [operations.json](../operations/operations.json) marks `backup.restoreBackupSet` as `agentAllowed: false`: the user must confirm the concrete backup set in the Toolset terminal. General autonomous-work authorization does not answer that prompt. Do not bypass it with direct Docker/BcContainerHelper/script restoration.

## Prepare a reviewable backup set before requesting restore confirmation

1. Verify the development binding, exact target configuration/container, primary company ID, installed companion/test versions and native user identity. Use only the dedicated Test target.
2. Configure a fresh ignored backup directory under `.bcdevtoolset/e08-restore/<dedicated-container>/<new-namespace-guid>`. Verify containment within the repository and refuse existing files/collisions. Select this exact configuration through the Toolset backup operation; preserve its database/file manifest and completion report.
3. Run `al/BCData.Tests/integration/Invoke-E08Restore.ps1 -Target 'BC23 Baseline' -Phase Prepare`. Test app 0.1.24.0 adds `PrepareRestoreForTest` with a fixed server-issued 24-hour laboratory window and owner-checked `InspectScopeForTest`. Normal Prepare retains its 60-second window. Neither action accepts caller-issued timestamps/epochs. The harness captures two owned scopes, their run/request IDs, server epoch/deadline and principal outside the database; one scope is deliberately expired before backup. This longer duration is not a production retry-period decision.
4. Back up after scope creation but before applying the +4 request. Record database names/roles, backup filenames, target container and completion evidence. No restore approval is needed while only preparing/read-checking the backup.
5. Run the harness with `-Phase Apply` after the successful backup. It applies the active counter request once, captures the exact result, total=4, applyCount=1 and receiptCount=1, and checks exact replay. These are fixture records only.
6. Invoke the Toolset restore preflight for the exact target and prepared backup directory. Review the actual file-to-database mapping. The user-only terminal confirmation is the final step before replacing matching application/tenant databases.

## Assertions after the confirmed restore

- Verify service availability, original company ID, installed fixture version and target identity before continuing.
- Inspect the restored scope epoch/deadline, counter and receipt. A pre-mutation snapshot is expected to remove the completed receipt and rewind the counter. Record actual behavior rather than assuming it.
- An active epoch restored together with a missing receipt is a separate hazard from normal expiry. The current fixture alone has no outside-database recovery generation. Do not describe a repeat as an exact replay or automatically resend an uncertain real mutation. Any deliberately repeated counter request is an explicit negative control on fixture data, with exact result/counter evidence.
- Define and implement recovery-generation invalidation outside the restored state, or explicitly restrict the supported retry contract after restoration, before claiming this case safe. Known Toolset restores can provide an invalidation hook; unannounced external restores need separate detection/contract treatment.
- Separately test an expired restored scope against current server time. It must reject old/new request IDs without mutation even if restored receipts are absent. This does not establish the within-window guarantee.
- Verify independently authenticated receipt/scoped access after restoration and preserve original native permission errors.

Use `-Phase AfterRestore` only after confirmed Toolset restoration. This deliberately repeats the active fixture request as a negative control, after asserting unchanged company/principal/epoch/deadline, a still-active window and rewound total/apply/receipt counts of zero. It records a changed result ID and one fresh +4 execution rather than claiming replay. It also checks that the scope already expired in the backup rejects both old/new IDs after receipt purge. A counter of 4 after restoring its pre-mutation snapshot is expected for re-execution; the earlier no-restore receipt-deletion control instead reached 8. No repeated business request is involved.

The phases are deliberately separate. SQL backup/restore are never launched by this harness. `AfterRestore` must fail if invoked against the still-applied database. Credential-free state/evidence are `.bcdevtoolset/e08-restore-<dedicated-container>-{state,evidence}.json`; interrupted work preserves state. Do not blindly rerun a phase after an uncertain request result. `-Phase Cleanup` removes/checks the two GUID-owned scopes and receipts; it neither restores SQL nor deletes backups. Native restricted-user scoped qualification remains separate.

## Cleanup and evidence

Clean only the captured GUID-owned scope/receipt/target/barrier records and verify absence. Verify the original company ID and other containers remain intact. Preserve credential-free operation reports, timestamps, exact versions, scope metadata and observed outcomes. Backup files stay ignored and are never committed/pushed. Remove only the owned namespace backup directory after containment/ownership checks and when evidence no longer depends on it.

This protocol is preparation, not an executed restore experiment. Production writes remain disabled.

## Prepared BC23 set on 2026-10-19

Both targets built/deployed test app 0.1.24.0 and passed 83/83 AL tests: BC23 session `5a042397-a507-490a-bbeb-81b3fab264f3` (3.771s, application 23.18.32409.0), BC27.1 session `16325b66-b647-4eef-a2bf-6ef4b264470c` (4.482s, application 27.1.41698.41776). Initial BC23 attempts exposed test transaction rollback and an overly strict timestamp boundary; the final test commits setup before expected errors and tolerates one second of storage/clock precision around the fixed 24-hour lifetime.

BC23 preparation completed at 10:03:33 UTC with original company `60e6cf2f-2e0d-f011-9af3-7c1e52339238`. Toolset SQL export completed successfully at 12:05:13 Europe/Ljubljana (10:05:13 UTC). The fresh ignored set is `.bcdevtoolset/e08-restore/bcdata23test/da26903c-9168-4c8a-9eec-1ecdb0a6f952`; its sole file `bcdata23test.CRONUS.database.bak` is 605224960 bytes and maps to database CRONUS, role database. At 10:05:48.616 UTC the active fixture applied once: total=4, applyCount=1, receiptCount=1, pendingCount=0; identical replay returned the exact stored result. A deliberate premature AfterRestore call failed at `require-restored-zero-counter` before any repeat, proving the still-applied state cannot qualify restoration.

The backup operation's general initialization unexpectedly started existing `bcdata23` (previously exited/unhealthy); no backup or restore targeted it. For restoration, ignored `.bcdevtoolset/e08-restore-settings.json` contains only the BC23 Baseline/bcdata23test configuration and this exact backup path, preventing the operation's Ensure-ConfiguredContainers step from considering the other configurations. No global binding or regular VS Code installation was changed.

BC27.1 ran only a non-restore harness smoke check: Prepare/Apply, expected premature AfterRestore refusal, Cleanup at 10:05:32.990 UTC. No BC27 SQL backup or restore took place; its original company `d93b9724-28b9-f011-af5e-6045bdac9691` was preserved and both smoke scopes/receipts were verified absent. Harness event names denote phases, not proof that a SQL backup occurred. The BC23 state and backup remain available for the pending user-only restore decision. Successful post-restore negative control and cleanup have not yet been observed.
