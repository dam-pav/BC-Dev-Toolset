# Business Central Developer's Toolset

The BC Dev Toolset extension gives Business Central developers a single command surface for common setup, container, deployment, runtime packaging, backup, test, and visualization tasks without having to run scripts manually.

For more information please refer to [the GitHub repository](https://github.com/dam-pav/BC-Dev-Toolset).

## What it does

It offers operations in functional areas:

* Development environment initialization
  * Prerequisites
  * Containers
* Backup and Restore BC data from servers and containers, to containers
* Manage local clones for multi-app workspaces
  * Handle external dependencies, licenses, certificates, server configurations, etc.
  * Create/Update launch.json configurations
  * Analyze and visually verify object ID range allocation
* Manage artifacts (app)
  * publish or unpublish apps
  * create and deploy runtime packages
* Run/Verify standard and page scripting tests

## Getting started

To start using the extension in a workspace, focus on these three operations first:

### 1. Install prerequisites

Run `BC Dev Toolset: Install prerequisites`.

Use this to prepare the workstation for the toolset. This operation is intended to install the main external requirements used by the toolkit.

### 2. Initialize workspace

Run `BC Dev Toolset: Initialize Workspace`. The PowerShell operation asks for the workspace name when a workspace file needs to be created; the opened folder name is suggested by default. MCP clients can supply `workspaceName` directly or answer the `initializeWorkspace.workspaceName` prompt. Initialization adds the workspace root under the workspace name and coordinates every discovered AL app as a workspace folder. It also adds each nested app path to `files.exclude` so it is not duplicated beneath the workspace-root view. New local settings include one `Local` container configuration for development and test app folders. Re-running initialization adds newly discovered apps and either default configuration when it is missing without replacing existing folder names, file exclusions, configurations, or an explicit test target; conflicting container names are reported and left unchanged.

This initializes your current project. You will actually do this for every project you start.

### 3. Open local settings

The defaults might work for you out-of-the-box in which case you don't need to change or add any settings. This is all optional but, if you need any of the below specifics:

Run `BC Dev Toolset: Open Local Settings (JSON)`.

This opens the developer-local settings file at `.bcdevtoolset/settings.json`. Use it to define machine-specific paths, credentials, output folders, and local environment targets.

Important local settings to review before running most operations:

- `configurations`: Defines the local Business Central environments the toolset can target. The extension creates a default `Local` container configuration automatically.
- `dependenciesPaths`: Folders containing dependency `.app` packages, or direct `.zip` file paths, used by dependency publishing operations.
- `dependenciesPath`: Deprecated legacy single folder containing dependency `.app` packages. It is still read for compatibility, but users should migrate to `dependenciesPaths`.
- `packageOutputPath`: Folder where runtime packages are written.
- `sqlBackupPath`: Set this inside each Container `configurations` entry that uses SQL backup operations. Different containers can use different folders; set the same folder on multiple Container configurations only when sharing is intentional.
- `licenseFile`: Required for license update and some runtime packaging scenarios.
- `certificateFile`: Required when creating signed runtime packages.
- `recordingsPath`: Folder containing page scripting recordings.
- `pageScriptTestResultsPath`: Folder where page script test results are stored.
- `testIsolationDisabledCodeunits`: Optional integer codeunit IDs (for example `[60990]`) for AL integration tests requiring disabled isolation. Set this in shared `settings.bcDevToolset` or local `.bcdevtoolset/settings.json`; an explicit local array replaces the shared list, and `[]` clears it. Duplicates are removed; invalid IDs are rejected before build/container preparation. Selected tests run under `130451`, all others under `130450`, with extension-scoped discovery and one combined report. This is not restricted to any Business Central version; compatibility depends on the available runner, discovery and filter capabilities. Unmatched IDs fail the run. Committed data can persist: non-isolated tests must manage setup, cleanup and recovery after failure. Page-script and AL Runner tests are unaffected.

This is it, now you can start working on your project. Explore the toolset:

Run `BC Dev Toolset: Show Operations List`.

This opens a two-step picker: choose a category first, then pick an operation from that category.

All operations are available directly as well.

Run `BC Dev Toolset: Show Help` at any time to open the full repository README in VS Code's rendered Markdown preview.

## MCP server

The extension contributes an MCP server named `BC Dev Toolset Operations` in VS Code. MCP-aware agents can use it to run BC Dev Toolset operations for the current AL workspace, such as creating containers, publishing apps, invoking tests, or showing active licenses. Agents can call `bc_dev_toolset_show_help` or read `bcdevtoolset://help/readme` to consult the full repository README when helping users explore, configure, or troubleshoot the toolset.

PowerShell-backed operations still run in the visible `BC Dev Toolset: <PowerShell executable>` terminal. This keeps long-running work, such as container creation and artifact downloads, visible while the agent waits for the operation result.

The AL test MCP operation compiles the visible transcript and JUnit data into a bounded report. Successful prerequisite output is collapsed into stage status. A failed build includes up to 20 recognized AL compiler errors and omits warnings and informational entries; when compiler errors cannot be recognized safely, it includes the complete captured build diagnostics. Failed container-preparation and test stages include their diagnostics. Test results include totals and up to 20 actionable failure details without requiring a second build or test invocation.

Some operations require confirmation before they start. If an operation asks a supported question while running, the visible terminal shows the question and the operation pauses. The agent may answer low-risk operational questions when it has enough context, but sensitive prompts and destructive user decisions still require you to choose. Operations started from the Command Palette keep the normal terminal behavior and can always be answered directly in the terminal.

MCP operations with declared inputs use a non-mutating preflight call first: omit `execute: true` to receive all relevant questions, including conditional questions, then call the same tool with `execute: true` and the named answers. Test targets resolve from the workspace baseline and configured platform, identically for humans and agents. MCP operation tools also accept a `promptAnswers` object keyed by prompt ID for conditional prompts. Calling the same operation with answers while it is waiting resumes the existing session and retains all supplied answers for later prompts; it does not restart the operation. Sensitive decisions remain in the visible terminal.

You do not need to know the MCP tool names for normal use. Ask the agent for the BC Dev Toolset action you want, and the MCP server exposes focused operation tools for the agent to choose from.

`bc_dev_toolset_ensure_containers` is enabled by default when the toolset is deployed. It checks the containers named by effective Container configurations, starts stopped containers, restarts unhealthy ones, and waits up to 120 seconds per container for readiness. An explicit `false` MCP tool setting disables its separate agent-facing tool; container-dependent operations still check readiness as part of their own execution.

### Codex

Codex does not automatically discover MCP servers contributed through the VS Code extension API. Run `BC Dev Toolset: Configure Codex MCP Integration` to add or update the `bc-dev-toolset` MCP server entry in your Codex configuration. The operation also enables automatic configuration maintenance and adds managed global Codex instructions so Codex knows to use BC Dev Toolset MCP operations in your AL workspaces. After an extension upgrade, the extension updates the versioned MCP server path on its first activation; restart Codex afterward to load the new server. You do not need to add these instructions to each AL repository.

Automatic maintenance is disabled while running an Extension Development Host so development checkouts do not replace the deployed extension path. The configure command can still be run explicitly when testing Codex integration.

Run `BC Dev Toolset: Disable Codex MCP Integration` to opt out and remove the extension-managed MCP entry and global instructions.

The Codex MCP server uses the VS Code terminal bridge belonging to the current workspace for PowerShell-backed operations. Multiple VS Code windows are supported concurrently: each extension host publishes an isolated, authenticated instance, and a Codex MCP process binds once to the live instance that owns its startup working directory. Keep the BC Dev Toolset extension active in each workspace where Codex should run operations in that window's visible terminal. A request whose workspace or bridge identity does not match is rejected instead of being routed to another window.

## Other prerequisites

The extension is a VS Code host for the BC-Dev-Toolset runtime. It installs all the required components with a single operation. For practical use, you should expect to need:

Installing BC Dev Toolset also installs the official **Microsoft AL Language** extension automatically. It is a required VS Code extension dependency and supplies the platform-specific, signed ALTool used by the build and AL test operations.

ALTool discovery checks `bin` and `bin/<platform>` in the registered AL extension, then searches only that installation for relocated executables. Candidates must launch within five seconds and advertise the AL CLI compile command. Discovery enforces path containment, skips directory links, limits enumeration to 50,000 entries, and rejects ambiguous fallback candidates. The output channel records the AL extension version and selected executable. This handles relocation; CLI changes can still require a toolset update.

The `AL compatibility` workflow runs daily, on relevant pull requests, and manually against current stable and prerelease Microsoft AL packages on Windows. It validates the extension and compiles a dependency-free fixture through `BuildAllApps.ps1`, verifying that an `.app` was produced. Run the same smoke check locally with `node vscode-extension/scripts/check-al-compatibility.js <AL-extension-installation-directory>` (requires PowerShell 7). This checks discovery and compilation, not container deployment or projects requiring external symbols. Latest and stable release packaging also run `npm run validate` before packaging.

- Windows with PowerShell available. The extension uses `pwsh` by default.
- Have access to or be an administrator on your workstation. The "Prerequisites" category operations require elevated access.
- .NET SDK 9 or 10 and MSDyn365BC.AL.Runner for the standalone `AL Runner Test` operation; the install-prerequisites operation can configure both.
- Access to any required Business Central environments, credentials, licenses, certificates, or dependency packages used by your team.

## Operations

### Workspace

- `Initialize Workspace`: Creates the baseline BC Dev Toolset workspace structure and default settings content for the current workspace.
- `Open Local Settings (JSON)`: Opens `.bcdevtoolset/settings.json` for the current workspace.
- `Clear App and translation artifacts`: Removes generated app and translation artifacts from the workspace.
- `Build all apps in the workspace`: Uses the platform-specific ALTool bundled and signed with the required Microsoft AL Language extension to compile each AL project in dependency order. The toolset does not discover or invoke the unsigned global `al` .NET tool. Every app builds against an isolated copy of its own package cache plus freshly built packages for its declared workspace dependencies, preserving project cache isolation.
- `Update launch.json files in all apps in the workspace`: Refreshes launch configurations for all apps in the workspace.

### Container

- `Check and start configured containers`: Checks distinct Container configurations, starts created or stopped containers, restarts unhealthy running containers once, and waits for a running and healthy state when a Docker health check exists. It reports missing containers without creating them. Container-dependent operations run this check automatically for existing configured containers and continue to skip missing containers where they did before. AL test tool and page script tests run the check on their selected container after creating it if needed, before restore, deployment, or test execution.
- `Create/Overwrite Docker container based on the workspace app.json application version`: Creates or recreates a development container using the common `application` version from every workspace app. Mismatched values stop the operation and are reported by app.json path. If more than one Container configuration has a non-empty `container` value, choose one configuration or process all qualified configurations; duplicate `container` values abort the operation. Manual creation exports an initial SQL backup set when `includeTestToolkit` is `true`, `targetType` is `Test`, and `sqlBackupPath` is non-empty.
- `Extract assembly probing paths from Docker container`: Extracts Service and .NET DLLs from an existing configured container into the `.netpackages` folder of each workspace app whose `app.json` target is `OnPrem`. After extraction, it adds `"./.netpackages"` to `al.assemblyProbingPaths` if that exact path is absent, preserving other paths. It writes to the selected workspace file, or to root `.vscode/settings.json` when the workspace is opened as a folder. It prefers the `Microsoft.NETCore.App.Ref` targeting pack and falls back to the `Microsoft.NETCore.App` shared runtime. If multiple containers are configured, the operation asks which one to use. The create-container operation also runs this step after building a configuration whose `autoExtractAssemblies` value is `true`. Manual extraction ignores `autoExtractAssemblies`.
- `Add Test Toolkit to existing container`: Lists the `container` values from Container configurations and adds the Business Central Test Toolkit to the selected existing container. An empty or invalid selection aborts the operation.
- `Update license files in all containers`: Applies the configured license file to container environments.
- `Update server configuration in all containers`: Applies configured server settings to container environments.

### Backup

- `Create and export SQL backup set from Docker container`: Creates SQL backup files from a Docker container environment. If more than one Container configuration has a non-empty `sqlBackupPath`, choose one container or back up all qualified containers.
- `Create and export SQL backup set from BC service SQL Server`: Creates SQL backup files from a Business Central service SQL Server environment. You will require credentials with the ability to create remote Powershell sessions to the SQL Server host.
- `Restore SQL backup set to Docker container`: Restores a saved SQL backup set into a Docker container, either through the manual operation or during automatic container initialization. If more than one Container configuration has a non-empty `sqlBackupPath`, choose which container to restore. Afterward, it reports platform/database/Microsoft application versions and, when matching same-major packages make the detected split safe to upgrade, forcibly closes active BC sessions and upgrades System Application, Base Application, and Application in dependency order with non-destructive schema synchronization.

#### Automatic administrator setup after restore

Manual restores, restores during container creation, and restores during test preparation repair administrator access in every restored tenant. Password authentication creates the configured user if missing and reapplies the configured password for existing users. Windows authentication uses the outbound network identity, including `runas /netonly`. The administrator is enabled, account expiry is cleared, and `SUPER` is granted for all companies when missing. Setup failures stop the operation without rolling back the database restore.

#### Troubleshooting administrator setup

If authentication does not match, correct the selected container configuration and target container authentication setup before retrying. For Windows authentication, ensure the target container can resolve the outbound account.

If an extension blocks CLI User table validation/events, for example because no company is selected:

1. Disable the offending app in the **source environment**, or uninstall it if disabling is unavailable or ineffective.
2. Create a **new backup**, then restore it to the target container.
3. After administrator setup completes, enable or reinstall the app in the **restored target environment**.

### Tests

- `Run AL test tool tests`: Builds all workspace apps in dependency order before preparing the test container, so a failed build stops the operation before backup restore or deployment. It then runs tests once per workspace extension. Business Central discovers codeunits whose `SubType` is `Test` by extension ID, so test suite registration in an `OnInstall` procedure is not required.
- `Run page script tests`: Runs page script test recordings and writes the results to the configured output location.
- `AL Runner Test`: A BC Dev Toolset feature based on Stefan Maron's [BusinessCentral.AL.Runner](https://github.com/StefanMaron/BusinessCentral.AL.Runner) tool. It runs without a Business Central container and passes every workspace folder that contains an `app.json` file to one `al-runner` invocation. The operation resolves the configured Container release matching the workspace application baseline and passes its exact major/minor through `--bc-version`. Compatibility runs do the same for each explicitly configured newer release in sequence. The operation reports the requested release; unlike container modes, AL Runner does not expose an independently verified installed application version. Refer to the upstream GitHub repository for its capabilities, limitations, and CLI documentation.
- Automated test operations resolve only Container configurations whose `targetType` is `Test`. Dev, Production, and unspecified roles are excluded. AL Runner also uses Test-role configurations to resolve platform versions, but does not require a test toolkit because it does not use a BC container.
- Compatibility test operations run the same test mode against every explicitly configured Container platform newer than the workspace `app.json` application baseline. They build once, execute targets sequentially, validate each container's installed Application release before restore/deployment, and report outcomes per target. A major-only target such as `23.0` accepts the latest cumulative update in BC 23; a non-zero minor such as `27.1` must match exactly. The AL Runner compatibility operation passes each configured release's exact major/minor to `--bc-version`.
- Automated testing resolves only Container configurations with `targetType: "Test"`. Dev, Production, and unspecified roles are never used. AL Runner also uses Test-role configurations to resolve platform versions, but does not require a test toolkit because it does not use a BC container.

  Windows Smart App Control or an organizational App Control policy can block an AL Runner release whose executable assemblies are not signed with a trusted certificate. The prerequisite and test operations report the corresponding Code Integrity failure but do not weaken or bypass application-control protection. Use a signed upstream release when available, or ask the device administrator to approve an appropriate policy. See Microsoft's [Smart App Control signing guidance](https://learn.microsoft.com/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control).

  AL Runner availability, application-control, and invocation failures are reported as tool failures with a clear statement that tests were not executed. The `bc_dev_toolset_al_runner_test` MCP response tells agents to suggest `bc_dev_toolset_invoke_tests` as the container-based fallback, but not to run it automatically. Genuine AL compilation and test failures are kept separate and do not receive this fallback guidance. AL Runner itself determines whether it supports the requested release.

### Publish

- `Publish dependencies from the configuration to the existing container`: Publishes dependency apps to a configured container target.
- `Publish dependencies from the configuration to test environments`: Publishes dependency apps to configured test targets.
- `Publish all apps in the workspace to Docker container`: Publishes all workspace apps to a configured container target.
- `Publish all apps in the workspace to production environments`: Publishes all workspace apps to configured production targets.
- `Publish all apps in the workspace to test environments`: Publishes all workspace apps to configured test targets.
- `Unpublish all workspace apps from Docker container`: Unpublishes workspace apps from a configured container target.
- `Unpublish all workspace apps from test environments`: Unpublishes workspace apps from configured test targets.

### Runtime

- `Create deployment runtime packages for all apps in the workspace (not compile/build validation)`: Builds deployment runtime packages for all workspace apps. This is not a substitute for ordinary AL compile/build validation.
- `Publish runtime packages (stored) to the existing container`: Publishes stored runtime packages to a configured container target.
- `Publish runtime packages (stored) to production environments`: Publishes stored runtime packages to configured production targets.
- `Publish runtime packages (stored) to test environments`: Publishes stored runtime packages to configured test targets.

### Visualization

- `Prepare object id range data for visualization`: Collects declared ranges and actual numbered AL object IDs per workspace app and object type. Source scanning ignores comments and literals, includes all conditional compilation branches, and excludes dependency caches and nested apps. Repeated IDs within an app/type count once.
- `Show object id range visualization data`: Opens the range pool chart, followed by an expandable app/type tree of contiguous occupied ID ranges (gaps excluded) and a counts matrix with app, object type, and grand totals. Prepare data again to add actual usage to older visualization files.

### Prerequisites

- `Show BcContainerHelper versions (installed and available)`: Shows the installed and available BcContainerHelper versions.
- `Install/Update Prerequisites`: Installs and updates the main prerequisites used by the toolset, including BcContainerHelper, Node.js, @microsoft/bc-replay and its matching Playwright browsers, .NET SDK 9/10, and MSDyn365BC.AL.Runner. If required Windows container features cannot be enabled, later installation steps are skipped and the operation offers to open the guarded uninstall flow.
- `Uninstall Prerequisites`: Detects Docker Engine, BC Replay, AL Runner, Node.js, Git, BcContainerHelper, and Windows container features, then asks separately before removing each component. Every prompt defaults to keeping the component installed. The shared .NET SDK is retained.
- `Install/Update Microsoft PowerShell`: Updates the Windows PowerShell installation used for the toolkit setup flow.

### MCP Configuration

- `Show MCP status`: Shows the extension MCP API, server, protocol/instance identity, bound workspace, terminal bridge, and runtime status. Authentication tokens are never displayed.
- `Configure Codex MCP integration`: Enables automatic maintenance, adds or updates the BC Dev Toolset MCP server entry in Codex configuration, and adds managed global Codex instructions.
- `Disable Codex MCP integration`: Disables automatic maintenance and removes the extension-managed Codex MCP entry and global instructions.

## Settings

The Marketplace supports a pre-release channel for this extension. If you opt in to the pre-release version in VS Code, you can receive main-branch extension updates before the next stable release.

The extension uses three settings layers:

At startup, legacy `dam-pav.bcdevtoolset` and `dam-pav.bcDevToolset` setting names are automatically migrated to `bcDevToolset` in user, workspace, and folder settings. Contents are preserved and completion is reported without a confirmation dialog. Conflicting destinations or unsaved files are left unchanged and reported.

- VS Code extension settings under `bcDevToolset.*`
- Workspace settings under `bcDevToolset` in the `.code-workspace` file
- Local settings in `.bcdevtoolset/settings.json`

### VS Code extension settings

- `bcDevToolset.toolsetPath`: Overrides the central BC-Dev-Toolset runtime location. Default: `%LOCALAPPDATA%\BC-Dev-Toolset\toolset` on Windows.
- `bcDevToolset.powershellExecutable`: PowerShell executable used to run operations. Default: `pwsh`. Operations reuse a dedicated `BC Dev Toolset: <executable>` terminal when it is already open.
- `bcDevToolset.localSettingsPath`: Workspace-relative path to the local settings file passed to operations. Default: `.bcdevtoolset/settings.json`.
- `bcDevToolset.codexMcpIntegration.enabled`: Machine-level opt-in for automatically keeping the global Codex MCP configuration synchronized with the installed extension version. The configure and disable commands manage this setting. Default: `false`.
- `bcDevToolset.shortcuts`: Shortcut mode used for container creation flows. Default: `None`.
- `bcDevToolset.hostHelperFolder`: BcContainerHelper host helper folder used by runtime operations. Default: `C:\ProgramData\BcContainerHelper`.

### Workspace settings

These are stored in the workspace file. AL settings such as `al.symbolsCountryRegion` and `al.assemblyProbingPaths` are directly under `settings`; the remaining toolset settings are under `bcDevToolset`.

- `al.symbolsCountryRegion`: Business Central artifact region. Default: `w1`.
- `al.assemblyProbingPaths`: Workspace initialization and assembly extraction add `"./.netpackages"` if that exact path is absent, preserving other entries. The path resolves from each app folder and points to the DLLs extracted for OnPrem apps. Remove older folder-level `al.assemblyProbingPaths` overrides from app `.vscode/settings.json` files to use the workspace setting.

- `selectArtifact`: Artifact selection strategy. Default: `Latest`. Another common value is `Closest`.
- `testBuildWarningsAsErrors`: Boolean, `false` by default. Set to `true` in shared workspace `bcDevToolset` settings or local `.bcdevtoolset/settings.json` to block **Run AL test tool tests** when its build emits compiler warnings. An explicit local value (including `false`) overrides the workspace setting. The operation stops before container preparation and test execution; the MCP report includes the warnings and instructs the agent to resolve them before rerunning. Standalone builds, page script tests, and AL Runner tests are unaffected.
- `configurations`: Shared target definitions for the workspace. These are useful when a team wants common environment entries available to everyone.

Each workspace `configuration` entry can contain:

- `name`: Display name of the target. Entries named `sample` are placeholders and are ignored by operations.
- `serverType`: Target type. Valid values: `Container`, `Cloud`, `OnPrem`.
- `targetType`: Intended role of the target. Valid values: `Dev`, `Test`, `Production`.
- `autoUpdateLaunchJson`: Optional override controlling whether this entry is included when launch.json files are updated, both manually and after container creation. It applies to all `serverType` values but does not change target-role routing: `Dev` entries go to apps without Microsoft Test Toolkit dependencies, and `Test` entries go to apps with those dependencies. When omitted, the effective value is `true` for entries matching the app's role.
- `server`: Business Central server name for `OnPrem`.
- `serverInstance`: Business Central server instance for `OnPrem`.
- `container`: Docker container name for `Container`. Create-container processing only includes Container configurations with a non-empty `container` value, and duplicate `container` values abort the operation.
- `multitenant`: Explicit container mode passed to `New-BcContainer` by the Create container operation. When omitted, creation infers the mode from a compatible backup set. If neither the setting nor the backup determines the mode, the parameter is omitted and BcContainerHelper decides. An explicit value has priority; creation aborts with an explanation if it conflicts with the detected `*.app.bak` or `*.database.bak` backup type. Valid only for `Container`.
- `port`: Service port for `OnPrem`.
- Container artifact type comes from workspace apps' `app.json` targets: if any app targets `OnPrem`, the container uses OnPrem artifacts; otherwise it uses Sandbox artifacts. Container launch entries use that same type. Cloud launch entries use Sandbox and are skipped for apps targeting `OnPrem`. An omitted app target defaults to `Cloud`. Existing configuration `environmentType` entries are ignored and can be removed.
- `environmentName`: Business Central environment name for `Cloud`.
- `includeTestToolkit`: Whether a container target includes the test toolkit.
- `tenant`: Tenant identifier for `Cloud` or `OnPrem`.
- `authentication`: Authentication mode. Valid values: `UserPassword`, `Windows`, `AAD`.
- `bcUser`: Business Central service user name.
- `bcPassword`: Business Central service password.
- `admin`: Obsolete fallback for `bcUser`. Use `bcUser` instead; this field will be removed in the next major release.
- `password`: Obsolete fallback for `bcPassword`. Use `bcPassword` instead; this field will be removed in the next major release.
- `network`: Optional Docker network passed to `New-BcContainer` for `Container` targets. Suggested Windows container network values include `NAT`, `transparent`, `l2bridge`, `l2tunnel`, `overlay`, and `none`; custom Docker network names are also allowed. For suggested network names, the toolset verifies that the Docker network exists with the expected driver and creates missing creatable networks, for example `docker network create -d transparent transparent`. Custom network setup is left to the user. Use a transparent network when the container should appear on the LAN with a real address.
- `hostIP`: Optional `host.containerhelper.internal` IP address passed to `New-BcContainer`.
- `updateHosts`: Optional switch controlling whether `New-BcContainer` updates the host machine's hosts file. Defaults to `true` when omitted. Valid for `Container`.
- `autoExtractAssemblies`: Boolean controlling whether assembly extraction runs automatically after this container is built. Defaults to `false` when omitted. Valid only for a `Container` when at least one workspace app's `app.json` target is `OnPrem`; the manual extraction operation ignores it.
- `autoRestoreBackup`: Boolean controlling whether container creation and Test operations automatically restore a compatible backup set from `sqlBackupPath`. Defaults to `true` when omitted; set it explicitly to `false` to disable automatic restore. Valid only for `Container`; manual restore ignores it.
- `macAddress`: Optional container MAC address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Use Docker's colon-delimited MAC address format, for example `02:42:ac:11:00:02`.
- `IP`: Optional static container IP address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Leave empty to let the selected network assign the address, for example through DHCP.
- `dns`: Optional DNS value passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. `HostDNS` adds the host DNS servers; explicit DNS server values are also allowed. Use a comma-delimited string for multiple DNS servers, for example `8.8.8.8,1.1.1.1`.
- `memoryLimit`: Optional container memory limit passed directly to `New-BcContainer`. Valid only for `Container`. Use a positive whole-number size ending in `M` or `G`, for example `16G`. When omitted or empty, BcContainerHelper chooses its default (currently `8G` for Hyper-V isolation).
- `sqlMemoryLimit`: Optional SQL Server memory limit passed directly to `New-BcContainer`. Valid only for `Container`. Use a positive whole-number size ending in `M` or `G`, or a percentage from `1%` through `100%`, for example `2G` or `25%`. When omitted or empty, BcContainerHelper chooses its default.
- `databaseUser`: Optional SQL user for database operations.
- `databasePassword`: Optional SQL password for database operations.
- `sqlBackupPath`: Folder used for SQL backup files for this configuration. Valid only for `Container`. Relative paths are resolved from the workspace root and may resolve outside the workspace; absolute local drive paths are also supported. Container backup and manual restore use the path from the selected Container configuration, while automatic restore during creation uses it only when `autoRestoreBackup` is `true`. With `includeTestToolkit` set to `true`, Test-operation creation always exports an initial backup here; manual creation exports one only when `targetType` is also `Test`. BC service SQL Server backups export into the configured Container backup folders.
- `remoteUser`: Optional PowerShell remoting user.
- `remotePassword`: Optional PowerShell remoting password.
- `serverConfiguration`: Additional Business Central server configuration entries as `KeyName` and `KeyValue` pairs.

### Local settings

These are stored in `.bcdevtoolset/settings.json` and are intended for developer-specific values.

- `licenseFile`: Path to the Business Central license file.
- `certificateFile`: Path to the certificate file used by local operations and runtime packaging.
- `packageOutputPath`: Folder where generated packages are written.
- `dependenciesPaths`: Folders containing dependency `.app` packages, or direct `.zip` file paths.
- `dependenciesPath`: Deprecated legacy single folder containing dependency app packages. It is still read for compatibility, but users should migrate to `dependenciesPaths`.
- `recordingsPath`: Folder containing page scripting recordings.
- `pageScriptTestResultsPath`: Folder where page script test results are written.
- `pageScriptTestHeaded`: Whether page script tests should run headed.
- `configurations`: Developer-local target definitions. These use the same structure as workspace `configurations` and are merged with them at runtime.

The extension adds JSON validation for `.bcdevtoolset/settings.json`, so VS Code can help you keep the local settings file in shape while editing it.

### MCP tool selection

Run **BC Dev Toolset: Configure MCP Tools** to select tools for Local, Workspace, or User settings. Workspace and User selections are stored as booleans in `"bcDevToolset": { "mcpTools": { ... } }`. Saving writes the complete selection at that scope, including values equal to the inherited setting, so each scope retains its own decision. Local entries override workspace entries, which override user defaults per tool. Restart the MCP server/client after changes.

On a fresh installation, **Get Workspace**, **Get Operation Status**, **Answer Operation Prompt**, and **Invoke AL Tests** default to enabled. Every other tool defaults to disabled. Explicit values at Local, Workspace, or User scope override the next less granular level per tool.

Local selections are stored in the top-level `mcpTools` object in `.bcdevtoolset/settings.json` (or the workspace-relative `bcDevToolset.localSettingsPath`). Local values override workspace values, then user values, per tool. In manually edited settings, omitted switches inherit the next level. Restart the MCP server/client after editing local selections.

### BC Data access

BC Data lets an MCP agent discover companies and tables, inspect schemas, read records and perform explicitly permitted record changes in your configured Business Central Dev/Test containers. The extension bundles the **BC Dev Toolset Data** companion app. Installing the extension makes the app available; you must initialize access on each target and enable the tools you want to use.

**Reserve object IDs `99100..99149` for the companion app.** Your apps and other installed extensions must steer clear of this range if you want to use BC Data. An object ID conflict can block companion installation or upgrades and prevent data access. Before initializing or enabling automatic provisioning, check all installed apps and your own object ranges, and confirm that the target license permits these IDs. The range applies to the main companion app; its development test app is not installed with this feature.

#### Set up a target

1. Configure a Container target with role Dev or Test, UserPassword authentication and an exact, unique configuration name. BC23 is the minimum supported baseline. Production and remote OnPrem targets are not supported by these data tools.
2. Configure credentials. With `bcCredential: true`, access reuses the container's existing Windows Credential Manager identity; missing stored credentials fail without falling back to plaintext. With the flag absent or false, the configured `bcUser` and `bcPassword` are used.
3. Run **BC Dev Toolset: Initialize BC Data Access**, choose from the numbered list of Dev Container configurations (shown as configuration name and container name), and confirm initialization. Test, Production, Cloud and OnPrem targets are excluded from this explicit selection; MCP callers supply the exact configuration name from the same eligible choices. It validates the bundled app, installs or upgrades the companion and checks service readiness. Initialization does not grant user permissions or enable MCP data tools. If deployment succeeds but readiness fails, investigate the reported prerequisite before retrying. Compatible equal/newer companion versions are preserved; incompatible newer versions are rejected without downgrade.
4. Grant the BC user **BCD DATA EXECUTE** (or equivalent service execution rights) and the native read permissions needed for Company, Table Metadata and the business tables being queried. FlowField reads also require access to their source tables. The companion does not elevate permissions; native security filters apply.
5. Run **BC Dev Toolset: Configure MCP Tools**, enable the desired data tools and restart the MCP client. All data tools default to disabled. Use connection discovery and readiness to verify the selected target before reading business data.

The six read-only tools are `bc_dev_toolset_data_list_connections`, `bc_dev_toolset_data_list_companies`, `bc_dev_toolset_data_get_readiness`, `bc_dev_toolset_data_find_tables`, `bc_dev_toolset_data_get_table_schema` and `bc_dev_toolset_data_read_records`. Connection discovery is offline; other calls require the companion and its published `BCDData` service. Record calls require an explicit company. Connection IDs are the exact configuration names; duplicate names across shared and local settings are rejected.

For automatic companion maintenance, set `"bcData": { "provisioningEnabled": true }` on each desired Dev/Test Container configuration. Container creation/start and test preparation then maintain the companion. This defaults to false and is independent of tool selection. Turning it off preserves the installed app. Explicit initialization remains available without automatic maintenance. Data calls themselves do not install apps.

The default endpoint is `http://<container>:7048/BC/ODataV4`, tenant `default`. Optional per-container settings such as `"bcData": { "baseUrl": "https://container:7048/BC/ODataV4", "tenant": "default" }` override it. Stored-credential endpoints must use the configured container hostname. TLS uses normal certificate validation; live HTTPS qualification is pending. Credentials and endpoints cannot be supplied as tool arguments.

#### Enable record changes

Enable `bc_dev_toolset_data_mutate_records` in **Configure MCP Tools** and allow operations on each target. Set `"bcData": { "allowedAllMutationOperations": true }` to permit insert, modify, rename and delete. This boolean defaults to false; when true it takes priority over `allowedMutationOperations`, whose value is ignored. When false or omitted, use the list to allow a subset, for example `"bcData": { "allowedMutationOperations": ["insert", "modify", "rename"] }`; an omitted or empty list permits no writes, and adding `"delete"` permits deletion. The override requires a JSON boolean, not a string. Each call specifies exactly one operation on one record; the tool switch and native BC permissions are still required.

Writes require companion 0.1.10.0 mutation protocol 1, published `BCDDataWrite`, **BCD DATA WRITE** (or equivalent grants) and the user's native business/related-table permissions. Initialization does not assign these rights. **BCD DATA EXECUTE** only grants read-service execution. A readiness mutation capability describes server support, not permission to write.

Insert and modify accept ordered field assignments. Modify, rename and delete require the record's SystemId and exact string `expectedVersion` from a read; rename also requires the complete primary key in key order. Native validation and triggers run. Decimal and BigInteger values are strings. Null, system/content assignments and unqualified FlowField writes are rejected. Generic tools cannot read or change the companion's internal receipt table.

Each write call has a bounded receipt scope and may retry the identical request once after uncertain transport. An unknown outcome requires reconciliation with the target record: repeating the MCP tool call creates a new command and can apply a second change. A failed scope closure does not undo a successful write. Receipt guarantees cover the database transaction and uninterrupted history, not external trigger effects or database restore/copy.

#### Read limits and connection changes

Reads support ordinary physical application tables, native filters, selected FlowFields and primary-key ascending pagination. A page contains at most 100 rows and 50 selected fields. BLOB/Media values return descriptors; unsupported table or scalar types fail explicitly. Pages are not snapshots, and a record's row version does not cover changes to FlowField dependencies. Reduce the selected fields or page size if a response exceeds the companion's size limit.

Continuation tokens expire after 30 minutes and are bound to the target, company, query and extension-host session. Settings changes and extension-host reloads invalidate them. Reload the extension host after external app/container changes. Stored credentials are resolved afresh, so password rotation and removal are observed without a persistent credential cache.

See the [BC Data design](../documentation/BCDataDesign.md) and [compatibility evidence and qualification limits](../documentation/BCDataCompatibilityExperiments.md) for details.
