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

Run `BC Dev Toolset: Initialize Workspace`. The PowerShell operation asks for the workspace name when a workspace file needs to be created; the opened folder name is suggested by default. MCP clients can supply `workspaceName` directly or answer the `initializeWorkspace.workspaceName` prompt.

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

This is it, now you can start working on your project. Explore the toolset:

Run `BC Dev Toolset: Show Operations List`.

This opens a two-step picker: choose a category first, then pick an operation from that category.

All operations are available directly as well.

## MCP server

The extension contributes an MCP server named `BC Dev Toolset Operations` in VS Code. MCP-aware agents can use it to run BC Dev Toolset operations for the current AL workspace, such as creating containers, publishing apps, invoking tests, or showing active licenses.

PowerShell-backed operations still run in the visible `BC Dev Toolset: <PowerShell executable>` terminal. This keeps long-running work, such as container creation and artifact downloads, visible while the agent waits for the operation result.

Some operations require confirmation before they start. If an operation asks a supported question while running, the visible terminal shows the question and the operation pauses. The agent may answer low-risk operational questions when it has enough context, but sensitive prompts and destructive user decisions still require you to choose. Operations started from the Command Palette keep the normal terminal behavior and can always be answered directly in the terminal.

MCP operation tools also accept a `promptAnswers` object keyed by prompt ID. Agents can use it to pre-supply known answers when the decision is already clear. Test operations expose `testContainerSelection`, `executeTestsInContainer`, and `pullFullArtifact` inputs and automatically pre-supply routine defaults; container backup operations expose `containerSelection` for the target container choice.

You do not need to know the MCP tool names for normal use. Ask the agent for the BC Dev Toolset action you want, and the MCP server exposes focused operation tools for the agent to choose from.

### Codex

Codex does not automatically discover MCP servers contributed through the VS Code extension API. Run `BC Dev Toolset: Configure Codex MCP Integration` to add or update the `bc-dev-toolset` MCP server entry in your Codex configuration. The operation also enables automatic configuration maintenance and adds managed global Codex instructions so Codex knows to use BC Dev Toolset MCP operations in your AL workspaces. After an extension upgrade, the extension updates the versioned MCP server path on its first activation; restart Codex afterward to load the new server. You do not need to add these instructions to each AL repository.

Automatic maintenance is disabled while running an Extension Development Host so development checkouts do not replace the deployed extension path. The configure command can still be run explicitly when testing Codex integration.

Run `BC Dev Toolset: Disable Codex MCP Integration` to opt out and remove the extension-managed MCP entry and global instructions.

The Codex MCP server uses the VS Code terminal bridge belonging to the current workspace for PowerShell-backed operations. Multiple VS Code windows are supported concurrently: each extension host publishes an isolated, authenticated instance, and a Codex MCP process binds once to the live instance that owns its startup working directory. Keep the BC Dev Toolset extension active in each workspace where Codex should run operations in that window's visible terminal. A request whose workspace or bridge identity does not match is rejected instead of being routed to another window.

## Other prerequisites

The extension is a VS Code host for the BC-Dev-Toolset runtime. It installs all the required components with a single operation. For practical use, you should expect to need:

- Windows with PowerShell available. The extension uses `pwsh` by default.
- Have access to or be an administrator on your workstation. The "Prerequisites" category operations require elevated access.
- Access to any required Business Central environments, credentials, licenses, certificates, or dependency packages used by your team.

## Operations

### Workspace

- `Initialize Workspace`: Creates the baseline BC Dev Toolset workspace structure and default settings content for the current workspace.
- `Open Local Settings (JSON)`: Opens `.bcdevtoolset/settings.json` for the current workspace.
- `Clear App and translation artifacts`: Removes generated app and translation artifacts from the workspace.
- `Update launch.json files in all apps in the workspace`: Refreshes launch configurations for all apps in the workspace.

### Container

- `Create/Overwrite Docker container based on the workspace app.json application version`: Creates or recreates a development container using the common `application` version from every workspace app. Mismatched values stop the operation and are reported by app.json path. If more than one Container configuration has a non-empty `container` value, choose one configuration or process all qualified configurations; duplicate `container` values abort the operation.
- `Extract assembly probing paths from Docker container`: Extracts Service and .NET assemblies from an existing configured container. It prefers the `Microsoft.NETCore.App.Ref` targeting pack and falls back to the `Microsoft.NETCore.App` shared runtime. If multiple containers are configured, the operation asks which one to use. The create-container operation also runs this step after building a configuration whose `autoExtractAssemblies` value is `true`. Extraction requires `assemblyProbingPathsRoot` and at least one workspace app targeting `OnPrem`; manual extraction ignores `autoExtractAssemblies`.
- `Update license files in all containers`: Applies the configured license file to container environments.
- `Update server configuration in all containers`: Applies configured server settings to container environments.

### Backup

- `Create and export SQL backup set from Docker container`: Creates SQL backup files from a Docker container environment. If more than one Container configuration has a non-empty `sqlBackupPath`, choose one container or back up all qualified containers.
- `Create and export SQL backup set from BC service SQL Server`: Creates SQL backup files from a Business Central service SQL Server environment. You will require credentials with the ability to create remote Powershell sessions to the SQL Server host.
- `Restore SQL backup set to Docker container`: Restores a saved SQL backup set into a Docker container. If more than one Container configuration has a non-empty `sqlBackupPath`, choose which container to restore.

### Tests

- `Run AL test tool tests`: Runs Business Central AL test tool tests.
- `Run page script tests`: Runs page script test recordings and writes the results to the configured output location.

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

- `Prepare object id range data for visualization`: Builds object ID range data for the current workspace.
- `Show object id range visualization data`: Opens the generated object ID range visualization output.

### Prerequisites

- `Show BcContainerHelper versions (installed and available)`: Shows the installed and available BcContainerHelper versions.
- `Install/Update Prerequisites`: Installs and updates the main prerequisites used by the toolset, including BcContainerHelper, Node.js, and @microsoft/bc-replay.
- `Install/Update Microsoft PowerShell`: Updates the Windows PowerShell installation used for the toolkit setup flow.

### MCP Configuration

- `Show MCP status`: Shows the extension MCP API, server, protocol/instance identity, bound workspace, terminal bridge, and runtime status. Authentication tokens are never displayed.
- `Configure Codex MCP integration`: Enables automatic maintenance, adds or updates the BC Dev Toolset MCP server entry in Codex configuration, and adds managed global Codex instructions.
- `Disable Codex MCP integration`: Disables automatic maintenance and removes the extension-managed Codex MCP entry and global instructions.

## Settings

The Marketplace supports a pre-release channel for this extension. If you opt in to the pre-release version in VS Code, you can receive main-branch extension updates before the next stable release.

The extension uses three settings layers:

- VS Code extension settings under `bcDevToolset.*`
- Workspace settings under `dam-pav.bcdevtoolset` in the `.code-workspace` file
- Local settings in `.bcdevtoolset/settings.json`

### VS Code extension settings

- `bcDevToolset.toolsetPath`: Overrides the central BC-Dev-Toolset runtime location. Default: `%LOCALAPPDATA%\BC-Dev-Toolset\toolset` on Windows.
- `bcDevToolset.powershellExecutable`: PowerShell executable used to run operations. Default: `pwsh`. Operations reuse a dedicated `BC Dev Toolset: <executable>` terminal when it is already open.
- `bcDevToolset.localSettingsPath`: Workspace-relative path to the local settings file passed to operations. Default: `.bcdevtoolset/settings.json`.
- `bcDevToolset.codexMcpIntegration.enabled`: Machine-level opt-in for automatically keeping the global Codex MCP configuration synchronized with the installed extension version. The configure and disable commands manage this setting. Default: `false`.
- `bcDevToolset.shortcuts`: Shortcut mode used for container creation flows. Default: `None`.
- `bcDevToolset.hostHelperFolder`: BcContainerHelper host helper folder used by runtime operations. Default: `C:\ProgramData\BcContainerHelper`.

### Workspace settings

These are stored in the workspace file under `dam-pav.bcdevtoolset`.

- `country`: Business Central artifact country code. Default: `w1`.
- `selectArtifact`: Artifact selection strategy. Default: `Closest`. Common values are `Closest` and `Latest`.
- `executeTestsInContainerName`: Optional container name used by Test operations. If empty and only one Dev Container configuration exists, tests run there without backup restore or app deployment. If empty, or if the value is not found and multiple Dev Container configurations exist, Test operations ask which configured container to use. If the selected container is missing, it is created and an initial SQL backup set is exported before tests continue.
- `configurations`: Shared target definitions for the workspace. These are useful when a team wants common environment entries available to everyone.

Each workspace `configuration` entry can contain:

- `name`: Display name of the target. Entries named `sample` are placeholders and are ignored by operations.
- `serverType`: Target type. Valid values: `Container`, `Cloud`, `OnPrem`.
- `targetType`: Intended role of the target. Valid values: `Dev`, `Test`, `Production`.
- `autoUpdateLaunchJson`: Optional override controlling whether this entry is included when launch.json files are updated, both manually and after container creation. It applies to all `serverType` values. When omitted, the effective value is `true` for `Dev` targets and `false` otherwise.
- `server`: Business Central server name for `OnPrem`.
- `serverInstance`: Business Central server instance for `OnPrem`.
- `container`: Docker container name for `Container`. Create-container processing only includes Container configurations with a non-empty `container` value, and duplicate `container` values abort the operation.
- `port`: Service port for `OnPrem`.
- `environmentType`: Environment kind. Valid values: `Sandbox`, `OnPrem`.
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
- `autoExtractAssemblies`: Boolean controlling whether assembly extraction runs automatically after this container is built. Defaults to `false`. Valid only for `Container`; the manual extraction operation ignores it.
- `autoRestoreBackup`: Boolean controlling whether container creation tries to initialize the container from a compatible backup set in `sqlBackupPath`. Defaults to `false`. Valid only for `Container`; manual restore ignores it.
- `macAddress`: Optional container MAC address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Use Docker's colon-delimited MAC address format, for example `02:42:ac:11:00:02`.
- `IP`: Optional static container IP address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Leave empty to let the selected network assign the address, for example through DHCP.
- `dns`: Optional DNS value passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. `HostDNS` adds the host DNS servers; explicit DNS server values are also allowed. Use a comma-delimited string for multiple DNS servers, for example `8.8.8.8,1.1.1.1`.
- `databaseUser`: Optional SQL user for database operations.
- `databasePassword`: Optional SQL password for database operations.
- `sqlBackupPath`: Folder used for SQL backup files for this configuration. Valid only for `Container`; container backup and manual restore use the path from the selected Container configuration, while new-container initialization uses it only when `autoRestoreBackup` is `true`. BC service SQL Server backups export into the configured Container backup folders.
- `remoteUser`: Optional PowerShell remoting user.
- `remotePassword`: Optional PowerShell remoting password.
- `serverConfiguration`: Additional Business Central server configuration entries as `KeyName` and `KeyValue` pairs.

### Local settings

These are stored in `.bcdevtoolset/settings.json` and are intended for developer-specific values.

- `licenseFile`: Path to the Business Central license file.
- `certificateFile`: Path to the certificate file used by local operations and runtime packaging.
- `packageOutputPath`: Folder where generated packages are written.
- `assemblyProbingPathsRoot`: Host folder where container Service and .NET assemblies are extracted for workspaces containing an `OnPrem` app. The extraction prefers the `Microsoft.NETCore.App.Ref` targeting pack and falls back to the `Microsoft.NETCore.App` shared runtime when necessary. Relative values are resolved from the workspace root; each container receives separate `Service` and `DotNet` subfolders. Their absolute paths are added only to the `.vscode/settings.json` files of apps that target `OnPrem`.
- `dependenciesPaths`: Folders containing dependency `.app` packages, or direct `.zip` file paths.
- `dependenciesPath`: Deprecated legacy single folder containing dependency app packages. It is still read for compatibility, but users should migrate to `dependenciesPaths`.
- `recordingsPath`: Folder containing page scripting recordings.
- `pageScriptTestResultsPath`: Folder where page script test results are written.
- `pageScriptTestHeaded`: Whether page script tests should run headed.
- `configurations`: Developer-local target definitions. These use the same structure as workspace `configurations` and are merged with them at runtime.

The extension adds JSON validation for `.bcdevtoolset/settings.json`, so VS Code can help you keep the local settings file in shape while editing it.
