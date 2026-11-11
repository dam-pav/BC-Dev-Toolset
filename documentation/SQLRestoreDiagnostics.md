# SQL backup/restore diagnostics and testing report

This tool is for backup/restore diagnostics only; it is not a production operation or a prerequisite for normal backup and restore workflows.

## Diagnostic inspection

Enable `bc_dev_toolset_inspect_restore_environment` with **Configure MCP Tools**
to inspect exactly one Container configuration through an isolated local settings
file. This operation never starts containers or writes SQL. It reports immutable
container identity and state; running containers also return PowerShell/.NET,
administration modules, loaded assembly locations, services and database state.

Use restoreInspectionMode State on the selected configuration for identity/state
only, or Database for a Windows PowerShell database/service inspection without
resolver experiments. Database is the default; Full explicitly opts in to resolver
experiments and probes both container shells.

For an explicitly approved investigation, set `restoreDiagnostics: true` on the
selected Container configuration. Restore temporarily wraps the loaded helper in
memory and captures bounded assembly/module information and structured failure
stacks in the actual container runspace, before database removal and
`New-NAVDatabase`. Installed helper files are unchanged; hooks are removed in
`finally`. Unexpected helper command boundaries stop before SQL restoration.
`BC_RESTORE_DIAGNOSTIC` records contain base64 JSON, excluding exception messages,
arguments and credentials. Decode them from the local operation transcript.
Diagnostics are opt-in, can affect timing, and do not repair or retry a failed
restore. Reconcile database and service state before any further attempt.

## Restore behavior under test

Single-tenant SQL restores (one `database` backup entry) use Windows PowerShell
inside the container by default. The Container setting
`restoreUseWindowsPowerShell: false` explicitly retains the helper's runtime
selection. Multitenant restores retain helper selection regardless of this
setting. The override temporarily sets BcContainerHelper's `usePwshForBc24` to
false across preparation, SQL restoration and post-restore verification, and
restores the original value in `finally`, including on failure. It changes neither
the host shell nor other operations and never retries a destructive restore.

## Recorded testing results

The recorded Sandbox restore matrix is complete for BC23–BC29 with
BcContainerHelper 6.1.19: all 14 single-tenant and multitenant workflows passed
across several runs and recorded builds through 11 November 2026. This was not
one fresh fourteen-case batch. Each newly tested case used its own verified fresh
backup and one planned restore; no failed destructive restore was automatically
retried. Artifact type and tenancy are independent.

| BC | Recorded application artifact version | Single-tenant workflow | Multitenant workflow |
| --- | --- | --- | --- |
| 23 | 23.5.16502.31399 | Passed | Passed |
| 24 | 24.5.23489.42600 | Passed | Passed |
| 25 | 25.5.30849.50175 | Passed | Passed |
| 26 | 26.5.38752.57862 | Passed | Passed |
| 27 | 27.5.46862.57885 | Passed | Passed |
| 28 | 28.5.54151.57967 | Passed | Passed |
| 29 | 29.1.57326.57968 | Passed | Passed |

The final missing-case batch passed BC26 single-tenant and BC23–27 multitenant.
BC26 used the same Latest build that previously stalled during preparation; no
older-build control was used. Its actual `New-NAVDatabase` runtime was container
Windows PowerShell 5.1.26100.33438 / CLR 4.0.30319.42000, while the host remained
PowerShell 7.6.9 / .NET 10.0.14. BC28 single-tenant also passed a fresh
uninstrumented restore with the runtime setting omitted. BC29 single-tenant
explicitly set `restoreUseWindowsPowerShell: false`; diagnostics measured
container PowerShell 7.6.6 / .NET 10.0.12 at `New-NAVDatabase`. Multitenant restores
were uninstrumented and retained helper selection; their SQL-command runtime was
not measured. These results establish a container-level workaround and recorded
compatibility, without proving an upstream dependency-resolution fix or host
terminal contamination. Desktop lock state was not measured, so its role in
earlier preparation failures is unknown.

## Application verification

BC27 removed the legacy `Set-NAVApplication -ApplicationVersion` parameter
([Microsoft cmdlet changes](https://learn.microsoft.com/en-us/powershell/business-central/cmdlets-changes?view=businesscentral-ps-27)).
For BC27 and later, Toolset verifies each restored tenant's installed Microsoft
System Application, Base Application and Application versions against the
corresponding container packages and the platform major. It requires exactly one
installation per app, valid versions and one matching package version; no version
is inferred from media or artifact URLs. Missing, ambiguous or incompatible
versions stop the workflow before administrator repair. Application splits in
BC27 and later require compatible media or a supported application upgrade;
Toolset does not run its legacy automatic upgrade routine on these versions.
See Microsoft's [BC27 upgrade procedure](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/upgrade/upgrade-unmodified-application-to-v27).
BC23–26 retain legacy database application-version checks and upgrade behavior.
SQL restoration alone is never reported as complete workflow success. Recorded
checks include application compatibility, administrator SUPER repair,
authenticated native API access, database/service state and helper-option reset.
Later cases also demonstrated business-data restoration using distinctive markers
that were deleted and confirmed absent before restore. BC25's initial API HTTP503
stopped work before any marker write, backup or restore; read-only readiness and
the same healthy container identity were reconciled before its first write and
one planned restore. Failed receipts remain preserved separately from success.
All selected targets were independently verified stopped after each batch.

## Evidence and limitations

The combined evidence is recorded in `RESTORE_RESULTS.md` and `summary.json` under
the consuming test workspace's `.bcdevtoolset/restore-investigation/` directory:
`missing-bc23-bc27-20261111-73ff6e61` references the earlier
`default-restore-20261109-da3a9723` and `retry-bc28-bc29-20261111-c82b2c33` runs.
Sanitized transcripts, backup hashes, marker receipts and stopped-state inventories
support the results. Private settings and raw captures can contain credentials
and must remain outside shared reports.

Stock multitenant coverage exercised the mounted default tenant and restored the
application, default and unmounted template databases. Extra custom mounted
tenants, OnPrem artifacts, external-origin backups and browser UI login remain
untested. Template database SQL state was not independently queried. These
recorded results do not establish universal runtime compatibility.

## Captured-output privacy

From runtime revision 70, captured MCP operation output omits BcContainerHelper
Docker command lines and
credential argument continuations, including encrypted-password and key-file
arguments. Failure causes, native exit codes and failed/timeout status remain
visible. This filtering also applies to appended capture errors and timeout
output; the original local terminal and native transcripts can still contain
sensitive helper arguments.
