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

Run `BC Dev Toolset: Initialize Workspace`.

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
- `sqlBackupPath`: Folder used by backup and restore operations.
- `licenseFile`: Required for license update and some runtime packaging scenarios.
- `certificateFile`: Required when creating signed runtime packages.
- `recordingsPath`: Folder containing page scripting recordings.
- `pageScriptTestResultsPath`: Folder where page script test results are stored.

This is it, now you can start working on your project. Explore the toolset:

Run `BC Dev Toolset: Show Operations List`.

This opens a two-step picker: choose a category first, then pick an operation from that category.

All operations are available directly as well.

## MCP server

The extension contributes an MCP server named `BC Dev Toolset Operations` in VS Code. Agents such as GitHub Copilot can use it to run BC Dev Toolset operations without asking you to know script names or operation IDs.

The server exposes direct operation tools named with the `bc_dev_toolset_` prefix, for example:

- `bc_dev_toolset_show_active_licenses`
- `bc_dev_toolset_new_docker_container`
- `bc_dev_toolset_invoke_tests`
- `bc_dev_toolset_publish_apps2_docker`

PowerShell-backed operations are always run through the visible `BC Dev Toolset: <PowerShell executable>` terminal. This keeps long-running work, such as container creation and artifact downloads, visible while it runs. The MCP result is captured from the same terminal execution and returned to the agent when the operation finishes.

Operations marked as requiring confirmation must be called with `confirm: true`. Some scripts can still ask interactive questions in the terminal; answer them there while the operation is running.

Generic MCP tools for listing and running operation IDs are hidden by default to keep agent tool selection focused on the direct `bc_dev_toolset_*` tools.

### Codex

Codex does not automatically discover MCP servers contributed through the VS Code extension API. Run `BC Dev Toolset: Configure Codex MCP Integration` to add or update the `bc-dev-toolset` MCP server entry in the user's Codex `config.toml`. The operation also adds a managed section to the user's active global Codex instructions file (`AGENTS.override.md` if that active override exists, otherwise `AGENTS.md`) so Codex knows to prefer the `bc_dev_toolset_*` tools for BC Dev Toolset operations in any AL workspace. This file is a Codex instruction file under the user's Codex home; it is not loaded by VS Code and it does not have to exist in each consuming repository.

The Codex MCP server uses the same VS Code terminal bridge for PowerShell-backed operations. Keep the BC Dev Toolset extension active in VS Code when you want Codex to run operations in the visible terminal and read the captured results.

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

- `Create/Overwrite Docker container based on the first app.json found in the workspace`: Creates or recreates a development container using the workspace app metadata.
- `Update license files in all containers`: Applies the configured license file to container environments.
- `Update server configuration in all containers`: Applies configured server settings to container environments.

### Backup

- `Create and export SQL backup set from Docker container`: Creates SQL backup files from a Docker container environment.
- `Create and export SQL backup set from BC service SQL Server`: Creates SQL backup files from a Business Central service SQL Server environment. You will require credentials with the ability to create remote Powershell sessions to the SQL Server host.
- `Restore SQL backup set to Docker container`: Restores a saved SQL backup set into a Docker container.

### Tests

- `Run tests in all containers`: Runs tests across configured container targets.
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

- `Create runtime packages for all apps in the workspace`: Builds runtime packages for all workspace apps.
- `Publish runtime packages (stored) to the existing container`: Publishes stored runtime packages to a configured container target.
- `Publish runtime packages (stored) to production environments`: Publishes stored runtime packages to configured production targets.
- `Publish runtime packages (stored) to test environments`: Publishes stored runtime packages to configured test targets.

### Visualization

- `Prepare object id range data for visualization`: Builds object ID range data for the current workspace.
- `Show object id range visualization data`: Opens the generated object ID range visualization output.

### Prerequisites

- `Show BcContainerHelper versions (installed and available)`: Shows the installed and available BcContainerHelper versions.
- `Install/Update Prerequisites`: Installs and updates the main prerequisites used by the toolset, including BcContainerHelper.
- `Install/Update Microsoft PowerShell`: Updates the Windows PowerShell installation used for the toolkit setup flow.

### MCP Configuration

- `Show MCP status`: Shows the extension MCP API, server, terminal bridge, and runtime status.
- `Configure Codex MCP integration`: Adds or updates the BC Dev Toolset MCP server entry in Codex configuration and adds managed global Codex instructions.

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
- `bcDevToolset.shortcuts`: Shortcut mode used for container creation flows. Default: `None`.
- `bcDevToolset.hostHelperFolder`: BcContainerHelper host helper folder used by runtime operations. Default: `C:\ProgramData\BcContainerHelper`.

### Workspace settings

These are stored in the workspace file under `dam-pav.bcdevtoolset`.

- `country`: Business Central artifact country code. Default: `w1`.
- `selectArtifact`: Artifact selection strategy. Default: `Closest`. Common values are `Closest` and `Latest`.
- `configurations`: Shared target definitions for the workspace. These are useful when a team wants common environment entries available to everyone.

Each workspace `configuration` entry can contain:

- `name`: Display name of the target. Entries named `sample` are placeholders and are ignored by operations.
- `serverType`: Target type. Valid values: `Container`, `Cloud`, `OnPrem`.
- `targetType`: Intended role of the target. Valid values: `Dev`, `Test`, `Production`.
- `server`: Business Central server name for `OnPrem`.
- `serverInstance`: Business Central server instance for `OnPrem`.
- `container`: Docker container name for `Container`.
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
- `macAddress`: Optional container MAC address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Use Docker's colon-delimited MAC address format, for example `02:42:ac:11:00:02`.
- `IP`: Optional static container IP address passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. Leave empty to let the selected network assign the address, for example through DHCP.
- `dns`: Optional DNS value passed to `New-BcContainer`. Valid when `serverType` is `Container` and `network` is `transparent`. `HostDNS` adds the host DNS servers; explicit DNS server values are also allowed. Use a comma-delimited string for multiple DNS servers, for example `8.8.8.8,1.1.1.1`.
- `databaseUser`: Optional SQL user for database operations.
- `databasePassword`: Optional SQL password for database operations.
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
- `sqlBackupPath`: Folder used for SQL backup files.
- `configurations`: Developer-local target definitions. These use the same structure as workspace `configurations` and are merged with them at runtime.

The extension adds JSON validation for `.bcdevtoolset/settings.json`, so VS Code can help you keep the local settings file in shape while editing it.
