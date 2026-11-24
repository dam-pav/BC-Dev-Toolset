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

Unsupported helper layouts, an already active diagnostic wrapper, target
mismatches and a missing helper module stop with reviewed compatibility guidance
before SQL restoration. Restore preparation may already have stopped the BC
service; reconcile its state and the helper/diagnostic configuration before an
explicitly approved retry. These rejections preserve failure status and remove
hooks owned by the rejected invocation without removing a pre-existing wrapper.

Diagnostic backup verification returns a structured result across the container
boundary. A failed native verification retains its exit code and explicitly
reports that SQL restore and database removal were not attempted; missing sqlcmd
and verification-setup failures also stop at that boundary. Backend error text is
excluded from these reviewed diagnostics. The stopped-service caveat still
applies, and a successful verification continues into the one planned restore.

## Restore behavior under test

Single-tenant SQL restores (one `database` backup entry) use Windows PowerShell
inside the container by default. The Container setting
`restoreUseWindowsPowerShell: false` explicitly retains the helper's runtime
selection. Multitenant restores retain helper selection regardless of this
setting. The override temporarily sets BcContainerHelper's `usePwshForBc24` to
false across preparation, SQL restoration and post-restore verification, and
restores the original value in `finally`, including on failure. It changes neither
the host shell nor other operations and never retries a destructive restore.
Before applying that override, Toolset resolves the helper restore command so a
fresh operation process can load BcContainerHelper. It uses that command's owning
module configuration rather than a caller-side variable. Missing commands,
unexpected ownership and incompatible runtime configuration fail before BC
service stop or SQL restoration; earlier target startup and backup staging may
already have completed. Explicit opt-out and multitenant restores retain helper
runtime selection without this early initialization requirement.

Modern BC27+ capability discovery and application upgrade execution explicitly
select container PowerShell 7 in a fresh process, independently of the temporary
Windows PowerShell override used for SQL restore. Both verify the selected process
is PowerShell Core 7 or later without a remoting session before administration
commands or app writes. Missing invocation parameters or an unavailable/incompatible
process fail with recovery guidance; Toolset does not retry using another runtime.
The SQL runtime option still resets in `finally`. This modern administration
runtime selection is covered by isolated regression fixtures, not a live restore
qualification of every BC version.

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

Manual restores and automatic restores before tests validate a configured workspace
`licenseFile` before stopping the service or restoring SQL. It must be an accessible,
nonempty local file no larger than 16 MB. URLs, network/device and provider paths,
wildcards and parent traversal are rejected. After SQL restore and service start,
Toolset imports that license into `NavDatabase` and restarts the BC service before
tenant and application verification. License content is transported to an owned
temporary file under `C:\Run\my`, which is removed in `finally`; cleanup failures
also fail the operation and report how to reconcile the file and service state.

An omitted `licenseFile` preserves the existing license behavior. A generic
exception code does not establish a licensing cause. Modern discovery diagnostics
identify the failed query stage and numeric status and direct inspection of the
service, actual tenant mounts, administration tools and event diagnostics without
inferring license expiration. Container-side discovery and license-import errors
return bounded status records instead of exposing backend exception text. Failed
import, restart or verification stops administrator repair and never retries SQL
restoration.

BC27 removed the legacy `Set-NAVApplication -ApplicationVersion` parameter
([Microsoft cmdlet changes](https://learn.microsoft.com/en-us/powershell/business-central/cmdlets-changes?view=businesscentral-ps-27)).
BC23–26 retain a separate legacy database application-version assessment and
upgrade workflow. BC27 and later use actual platform, tenancy and mounted-tenant
metadata and affirmative `TenantSpecificProperties`/`IsInstalled` app metadata.
Published but uninstalled versions cannot establish an installed version. Modern
assessment does not read or write the legacy database `ApplicationVersion`.

The modern assessment reports **Aligned**, **Viable** or **Blocked**, with observed
installed/media versions and specific prerequisite failures. It includes System
Application, Business Foundation, Base Application, Application, installed
Microsoft components and the required dependency closure. Each package is matched
by GUID, name, publisher and version; dependency minimum versions and ordering
come from the actual package metadata. Different component target versions are
permitted when their dependencies are coherent; satellite app version numbers
are independent of the BC platform version. Core apps must remain on the same BC
major, and no component downgrade is performed. For example, installed
27.0.38460.40242 with compatible 27.13.57301.0 media is a viable forward upgrade,
subject to complete metadata, supported tenant state and command capabilities.

Native NAV metadata can represent the logical `application` dependency as a zero
GUID with name `Application` and publisher `Microsoft`. Toolset resolves only that
specific reference to the unique actual Application media package identity. Other
zero app identities remain invalid, and minimum-version and cycle checks still
apply. The original dependency representation is retained for package-drift
checks; synchronization and upgrades always use actual nonzero app GUIDs. See the
[Application package model](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-application-app-file).

All mounted tenants are assessed before application writes. Only selected tenants
are synchronized and upgraded; container creation without a tenant selection uses
all mounted tenants. Missing, conflicting, ambiguous or cyclic dependencies,
unsafe media paths, unsupported administration parameters and unready tenant
states block app writes. Multitenant upgrades additionally require an existing
mount permitting application-database writes; Toolset does not remount a tenant
or change its credentials. `Sync-NAVTenant -Mode Sync -Force -Confirm:$false` runs
before package publication, with actual `Force` and `Confirm` capabilities checked
before writes. This keeps the operation unattended without selecting `ForceSync`.
A platform-conversion or tenant-sync prerequisite stops at its own failure
boundary. A synchronization failure may leave partial tenant synchronization, but
package publication, extension repair and app upgrades have not started. When the
actual exception is a null-reference exception, diagnostics retain that bounded
classification and numeric status without claiming that its underlying cause or
the effect of these flags is known; the numeric code alone does not establish it.

Viable upgrades publish required packages once, recompile affected unchanged
extensions using capability-checked `Repair-NAVApp` and restart the service when
repairs run, then synchronize and install or upgrade apps in dependency order.
Progress uses authored `START`, `COMPLETED` and `FAILED` display messages with the
active tenant or app, shared-catalog scope, item counts and elapsed time. A start
message is emitted before each blocking validation, catalog query, publication,
tenant/app synchronization, repair, restart, installation, data upgrade and
post-upgrade verification step. Messages use the helper's display stream and do
not add objects to the structured success/failure result. Failed steps do not
print completion or start dependent work.

Assessment labels the installed server version as **platform** and reports a
media version only when an actual package under `C:\Applications` supplies it.
An affected retained database extension is labeled as a repair of its installed
version with no media target selected; its media package version is null. This
neither claims that the container media contains that extension nor changes the
extension's version during repair. Catalog targets already published are shown
as reused rather than newly published.

Known runtime packages or unavailable source require a compatible package through
a supported manual upgrade instead of repair. A shared repair that would affect
an unselected tenant blocks the automatic upgrade. Old publications are retained:
both single-tenant and multitenant in-place restores use explicit tenant-scoped
`Start-NAVAppDataUpgrade`/`Install-NAVApp` calls with the app GUID and version.
Toolset does not rely on bulk `Start-NAVDataUpgrade` to replace apps whose old
versions remain published, and does not globally unpublish those old versions.

Installed targets, actual tenancy/mount identities, operational tenant states and
unchanged unselected installed versions are verified after writes. Administrator
repair runs only after verification succeeds. Publication, extension compilation
or data-upgrade failures can leave partial work; reviewed diagnostics identify the
failed stage and numeric status, stop dependent work and require reconciliation
before an explicitly approved retry. Viability is a supported action plan, not a
guarantee that extension compilation or upgrade code will succeed.

The workflow follows the
[BC27 update procedure](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/upgrade/upgrading-cumulative-update-v27),
the [BC28 update procedure](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/upgrade/upgrading-cumulative-update-v28)
and the tenant-scoped
[app data-upgrade command](https://learn.microsoft.com/en-us/powershell/module/microsoft.businesscentral.apps.management/start-navappdataupgrade?view=businesscentral-ps-27).
Later majors are gated by their actual metadata and command capabilities; synthetic
regression coverage does not establish live compatibility for every future release.

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
