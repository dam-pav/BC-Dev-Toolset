# Hybrid VS Code Extension Plan

## Goal

Promote BC-Dev-Toolset from its former workspace-copied PowerShell toolkit model into a VS Code extension-managed model:

- PowerShell remains the core implementation.
- A VS Code extension becomes the user-facing orchestration layer.
- The toolset is installed once in a central user location and reused by all workspaces.
- Workspace configuration is clearer, layered, and not limited to `.code-workspace` or extension settings.
- Existing operations are exposed as command palette commands.

## Guiding Principles

- Keep the PowerShell codebase as the source of truth for Business Central behavior.
- Make VS Code responsible for discovery, installation, configuration UX, command registration, and process execution.
- Avoid duplicating operation logic in TypeScript.
- Isolate dependencies on external Business Central tooling so BcContainerHelper-backed operations can be migrated or supplemented as Microsoft expands ALTool.
- Keep terminal execution available for users who prefer or need the current script workflow.
- Commit to the VS Code extension workflow as the supported path and avoid preserving repository-copied legacy behavior as a product requirement.

## Target Architecture

### PowerShell Core

The PowerShell repository continues to contain:

- `operations/*.ps1`
- `common/*.ps1`
- backup, restore, publish, test, launch, container, and visualization logic

The main change is to give the scripts an explicit workspace context instead of assuming the toolset folder is inside or beside the workspace.

PowerShell operations should also make external tool usage explicit. Today, many container, artifact, publish, test, and environment operations depend on BcContainerHelper. Microsoft is expanding ALTool and the AL Development Tools package as command-line tooling for AL compilation, packaging, workspace automation, and related developer workflows. The toolset should therefore avoid hiding BcContainerHelper calls deep inside unrelated code paths where possible, so future ALTool-backed implementations can be introduced operation by operation.

Example future entry point:

```powershell
.\Invoke-BcDevToolsetOperation.ps1 `
  -Operation "newContainer" `
  -WorkspacePath "C:\Projects\MyWorkspace" `
  -WorkspaceFile "MyWorkspace.code-workspace" `
  -LocalSettingsPath "C:\Projects\MyWorkspace\.bcdevtoolset\settings.json"
```

### VS Code Extension

The extension handles:

- Installing or updating the central toolset copy.
- Locating the active workspace.
- Creating and editing workspace configuration files.
- Registering command palette commands.
- Starting PowerShell operations in a VS Code terminal or task.
- Storing secrets through VS Code SecretStorage.

### Central Installation

Default central install location:

```text
%LOCALAPPDATA%\BC-Dev-Toolset\toolset
```

The path should be configurable through VS Code user settings.

## External Tooling Watch: BcContainerHelper And ALTool

BcContainerHelper is still a major runtime dependency for several current operations, especially Docker/container and artifact-oriented flows. However, Microsoft is actively expanding ALTool and the AL Development Tools package for command-line AL development automation. The project should treat this as a strategic migration risk.

Current ALTool capabilities documented by Microsoft include:

- compiling AL packages;
- creating symbol packages;
- reading package manifests;
- resolving supported runtime versions;
- workspace-related commands through the AL Development Tools package;
- AL MCP server launch support through newer tooling.

Implications for BC-Dev-Toolset:

- Keep BcContainerHelper integration behind clear PowerShell functions or operation boundaries.
- Add tool capability detection rather than assuming one fixed provider.
- Prefer provider-neutral operation names such as `publishApps`, `createRuntimePackage`, or `compileWorkspace`; avoid exposing implementation-specific names unless the operation is inherently container-specific.
- Track which operations are candidates for ALTool migration and which are still container-only.
- Keep the VS Code extension orchestration layer independent from the specific backend tool, passing operation intent to PowerShell rather than hardcoding BcContainerHelper or ALTool behavior in TypeScript.
- Revisit settings names where they expose BcContainerHelper-specific assumptions, for example helper folders, artifact selection, and container-only environment fields.

Suggested provider model:

```text
Operation intent -> PowerShell operation -> Tool provider
                                      -> BcContainerHelper
                                      -> ALTool
                                      -> direct PowerShell / REST / Docker
```

Initial provider strategy:

- Keep BcContainerHelper as the default provider for existing container operations.
- Introduce ALTool detection and version reporting once ALTool usage becomes actionable.
- Add ALTool-backed implementations first for compile/package/manifest/runtime-version scenarios, where ALTool has the clearest fit.
- Do not remove BcContainerHelper workflows until replacement coverage is verified against real BC development workspaces.

## Configuration Model

Use layered configuration rather than putting all setup into one place.

### VS Code User Settings

Scope: developer machine.

Examples:

- central toolset path
- PowerShell executable path
- update channel or repository URL
- default command execution mode
- preferred terminal profile

### Workspace Configuration

Suggested path:

```text
*.code-workspace
```

Scope: workspace-specific configuration, suitable for source control when it contains no secrets.

Examples under `settings.dam-pav.bcdevtoolset`:

- country
- app folder conventions
- workspace environments without secrets
- team-agreed defaults
- artifact selection behavior

### Local Project Configuration

Suggested path:

```text
.bcdevtoolset/settings.json
```

Scope: developer-local project configuration, normally ignored by Git.

The `.bcdevtoolset` folder is created in the same directory as the `.code-workspace` file that the extension is configuring. If multiple `.code-workspace` files live in that directory, they intentionally share the same local `.bcdevtoolset/settings.json` file.

The `.bcdevtoolset` folder is not automatically added to any VS Code workspace. Users may add it manually if they want to edit the file from the Explorer, but workspace membership must not affect command behavior.

Examples:

- `licenseFile`
- `certificateFile`
- `packageOutputPath`
- `dependenciesPath`
- `recordingsPath`
- `pageScriptTestResultsPath`
- `sqlBackupPath`
- personal container names
- local BC service targets

### Secrets

Use VS Code SecretStorage for:

- passwords
- database credentials
- remote credentials
- service authentication data

Do not store secrets in tracked JSON files.

## Operation Metadata

Keep the operation list in a metadata file.

Suggested path:

```text
operations/operations.json
```

Example:

```json
[
  {
    "id": "newContainer",
    "title": "Create/Overwrite Docker container",
    "script": "operations/NewDockerContainer.ps1",
    "category": "Container",
    "requiresConfirmation": true
  }
]
```

This metadata should power:

- the VS Code command palette
- direct operation execution through `Invoke-BcDevToolsetOperation.ps1`

## Phased Implementation

### Phase 1: Prepare the PowerShell Boundary

Deliverables:

- Add explicit workspace context parameters to context initialization.
- Add a stable operation bridge script, for example `Invoke-BcDevToolsetOperation.ps1`.
- Make operation execution possible without relying on the toolset folder being inside the workspace.

Acceptance criteria:

- A script can run an operation against an arbitrary workspace path.
- Operations are invoked through the central toolset runtime or the extension development checkout, not through workspace-copied toolset folders.

### Phase 2: Extract Operation Metadata

Deliverables:

- Add `operations/operations.json`.
- Keep operation titles and order aligned with the current menu.

Acceptance criteria:

- Adding a new operation requires updating metadata, not hardcoded menu arrays.
- Metadata contains stable operation IDs usable by VS Code.

### Phase 3: Introduce Layered Configuration

Deliverables:

- Keep workspace-specific attributes in `.code-workspace` under `settings.dam-pav.bcdevtoolset`.
- Add support for `.bcdevtoolset/settings.json`.
- Locate `.bcdevtoolset/settings.json` beside the active `.code-workspace` file and do not require or force it to be a workspace folder.
- Merge configuration in a predictable order.
- Read `.code-workspace` and `.bcdevtoolset/settings.json` as the supported configuration sources.

Suggested merge order:

1. Built-in defaults
2. `.code-workspace` settings
3. `.bcdevtoolset/settings.json`
4. secrets resolved at runtime

Acceptance criteria:

- New workspaces can be configured without copying the toolset repository.
- Local machine paths can stay outside tracked workspace files.

### Phase 4: Scaffold the VS Code Extension

Deliverables:

- Create extension project.
- Add extension settings.
- Add install/update command for the central toolset.
- Add command for selecting or validating the active toolset install.
- Add commands generated from `operations/operations.json`.
- Execute PowerShell operations in a VS Code terminal.

Initial command palette surface:

- Automatic central toolset runtime sync after extension updates
- `BC Dev Toolset: Initialize Workspace`
- `BC Dev Toolset: Show Operations List`
- `BC Dev Toolset: Create/Overwrite Docker Container`
- `BC Dev Toolset: Update launch.json`
- `BC Dev Toolset: Backup Container Databases`
- `BC Dev Toolset: Restore Container Databases`
- `BC Dev Toolset: Publish Apps to Docker`
- `BC Dev Toolset: Run Tests`

Acceptance criteria:

- A workspace runs operations through the extension-managed central toolset runtime.
- Commands show meaningful errors when PowerShell, Git, Docker, or the toolset install is missing.
- Users can still inspect full PowerShell output in the terminal.

### Phase 5: Workspace Configuration UX

Deliverables:

- Add command to initialize `.bcdevtoolset` files.
- Add command to open project configuration.
- Add command to open local configuration.
- Add validation diagnostics or status messages for missing paths and invalid environment definitions.

Acceptance criteria:

- A developer can set up a new workspace from VS Code without manually copying the repository.
- Local-only values are kept out of source control.

### Phase 6: Polish and Distribution

Deliverables:

- Add README section for extension workflow.
- Add setup guide for the extension-managed central runtime workflow.
- Add extension packaging configuration.
- Decide whether the extension bundles a toolset release or always installs from Git.
- Add basic automated tests for operation metadata parsing and command construction.

Acceptance criteria:

- Extension can be packaged locally.
- A fresh developer machine can install the extension, install the toolset, configure a workspace, and run a basic operation.
- Script execution remains available through the central operation bridge for advanced use, but the extension-managed runtime is the supported installation model.

### Phase 7: External Tooling Compatibility And ALTool Migration Tracking

Deliverables:

- Add a documented inventory of operations that call BcContainerHelper directly or indirectly.
- Add a lightweight provider capability report command, for example:
  - installed BcContainerHelper version
  - available BcContainerHelper version
  - ALTool executable path
  - ALTool version
  - supported ALTool commands
- Classify operations as:
  - BcContainerHelper-only
  - ALTool candidate
  - ALTool-ready
  - provider-neutral
- Add an abstraction boundary for operations where ALTool can realistically replace or supplement BcContainerHelper.
- Add documentation explaining the supported provider matrix.
- Review Microsoft ALTool documentation and release notes periodically before extension releases.

Acceptance criteria:

- Users can see which external tools the installed toolset will use.
- New ALTool-backed functionality can be added without rewriting the VS Code extension command model.
- BcContainerHelper-dependent operations remain supported while alternatives are evaluated.
- The project has an explicit migration checklist before any BcContainerHelper dependency is deprecated.

## Compatibility Strategy

The repository no longer supports legacy workspace-copied mode as a product path. The supported model is:

- The VS Code extension is the user-facing entry point.
- The toolset runtime is installed and updated centrally by the extension.
- Workspaces contain project files and configuration only, not a copied `BC-Dev-Toolset` runtime folder.
- PowerShell remains the implementation layer, but scripts are invoked through the central operation bridge with explicit workspace context.
- Manual script execution is acceptable for troubleshooting and advanced automation only when it targets the central runtime and passes explicit workspace context.

Design and documentation should not optimize for copied-toolset compatibility. If legacy fallback behavior remains in scripts temporarily, treat it as implementation residue to remove or simplify once the extension path covers the needed workflows.

## Open Decisions

- Should the extension live in this repository or a separate repository?
- Central runtime deployment uses bundled VSIX assets copied from the installed extension package.
- Should operation commands be registered individually, or should most operations go through a single `Show Operations List` picker?
- Should non-interactive operation mode be introduced immediately, or only after the command palette MVP?
- How much configuration validation belongs in TypeScript versus PowerShell?
- Which existing workspace settings should eventually move to local-only configuration or SecretStorage?
- Which operations should be migrated to ALTool first as its command surface grows?
- Should the toolset expose a provider setting, for example `Auto`, `BcContainerHelper`, or `ALTool`, or should provider selection remain internal per operation?
- What minimum ALTool version should be required before relying on workspace or packaging commands?
- Which BcContainerHelper-specific settings should be renamed or wrapped before they become compatibility debt?

## Suggested First Milestone

Build the smallest useful hybrid slice:

1. Add explicit workspace path support to PowerShell context initialization.
2. Add `operations/operations.json`.
3. Add `Invoke-BcDevToolsetOperation.ps1`.
4. Scaffold the VS Code extension.
5. Register `BC Dev Toolset: Show Operations List`.
6. Execute one existing operation from the command palette against a workspace that does not contain a copied toolset folder.

This milestone proves the committed extension-managed runtime architecture without preserving copied-toolset workflow requirements.

## Suggested Tooling Watch Milestone

Add the smallest useful ALTool awareness slice:

1. Inventory current BcContainerHelper usage by operation.
2. Add ALTool path/version detection.
3. Extend the existing BcContainerHelper versions operation or add a new provider diagnostics operation.
4. Mark operation metadata with optional provider hints.
5. Document which operations are not yet ALTool candidates.

This milestone does not replace BcContainerHelper. It makes the dependency visible and creates a controlled path for future migration.
