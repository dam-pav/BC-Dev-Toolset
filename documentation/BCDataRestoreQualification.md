# BC Data restore qualification: prepared protocol

Status: pending actual SQL backup/restore. Expiry-aware counter scopes are implemented as test fixtures; a restore can rewind both receipt and generation state and is not certified by the expiry tests.

## Execution boundary

Use the Extension Development Host and its local BCData.Development.code-workspace MCP binding. Start with `BC23 Baseline` / `bcdata23test`; repeat on `BC27.1` / `bcdata271` only after the first target is recovered and checked. No unrelated container, regular VS Code installation or global MCP binding is part of this experiment.

Use the direct Toolset MCP backup/restore operations. Their two exposure switches are enabled only in the ignored local development workspace; the current running MCP binding has not exposed them yet and needs a development-host/binding refresh. The restore operation metadata in [operations.json](../operations/operations.json) marks `backup.restoreBackupSet` as `agentAllowed: false`: the user must confirm the concrete backup set in the Toolset terminal. General autonomous-work authorization does not answer that prompt. Do not bypass it with direct Docker/BcContainerHelper/script restoration.

## Prepare a reviewable backup set before requesting restore confirmation

1. Verify the development binding, exact target configuration/container, primary company ID, installed companion/test versions and native user identity. Use only the dedicated Test target.
2. Configure a fresh ignored backup directory under `.bcdevtoolset/e08-restore/<dedicated-container>/<new-namespace-guid>`. Verify containment within the repository and refuse existing files/collisions. Select this exact configuration through the Toolset backup operation; preserve its database/file manifest and completion report.
3. Prepare one owned counter scope and capture its run ID, server epoch/deadline and one future request ID outside the database. The current fixed 60-second fixture window is unsuitable for a potentially slow restore: add and verify an explicit test-only longer-window preparation action before the within-window experiment. Do not silently extend production retry periods or accept caller-issued timestamps.
4. Back up after scope creation but before applying the +4 request. Record database names/roles, backup filenames, target container and completion evidence. No restore approval is needed while only preparing/read-checking the backup.
5. Apply the counter request once and capture the exact result, total=4, applyCount=1 and receiptCount=1. These are fixture records only.
6. Invoke the Toolset restore preflight for the exact target and prepared backup directory. Review the actual file-to-database mapping. The user-only terminal confirmation is the final step before replacing matching application/tenant databases.

## Assertions after the confirmed restore

- Verify service availability, original company ID, installed fixture version and target identity before continuing.
- Inspect the restored scope epoch/deadline, counter and receipt. A pre-mutation snapshot is expected to remove the completed receipt and rewind the counter. Record actual behavior rather than assuming it.
- An active epoch restored together with a missing receipt is a separate hazard from normal expiry. The current fixture alone has no outside-database recovery generation. Do not describe a repeat as an exact replay or automatically resend an uncertain real mutation. Any deliberately repeated counter request is an explicit negative control on fixture data, with exact result/counter evidence.
- Define and implement recovery-generation invalidation outside the restored state, or explicitly restrict the supported retry contract after restoration, before claiming this case safe. Known Toolset restores can provide an invalidation hook; unannounced external restores need separate detection/contract treatment.
- Separately test an expired restored scope against current server time. It must reject old/new request IDs without mutation even if restored receipts are absent. This does not establish the within-window guarantee.
- Verify independently authenticated receipt/scoped access after restoration and preserve original native permission errors.

## Cleanup and evidence

Clean only the captured GUID-owned scope/receipt/target/barrier records and verify absence. Verify the original company ID and other containers remain intact. Preserve credential-free operation reports, timestamps, exact versions, scope metadata and observed outcomes. Backup files stay ignored and are never committed/pushed. Remove only the owned namespace backup directory after containment/ownership checks and when evidence no longer depends on it.

This protocol is preparation, not an executed restore experiment. Production writes remain disabled.
