# Hybrid VS Code Extension Plan

## Goal

Promote BC-Dev-Toolset from a workspace-copied PowerShell toolkit into a hybrid model:

- PowerShell remains the core implementation.
- A VS Code extension becomes the user-facing orchestration layer.
- The toolset is installed once in a central user location and reused by all workspaces.
- Workspace configuration is clearer, layered, and not limited to `.code-workspace` or extension settings.
- Existing operations are exposed as command palette commands.

## Guiding Principles

- Keep the PowerShell codebase as the source of truth for Business Central behavior.
- Make VS Code responsible for discovery, installation, configuration UX, command registration, and process execution.
- Avoid duplicating operation logic in TypeScript.
- Keep terminal execution available for users who prefer or need the current script workflow.
- Introduce changes incrementally so existing project setups continue to work during migration.

## Target Architecture

### PowerShell Core

The PowerShell repository continues to contain:

- `operations/*.ps1`
- `common/*.ps1`
- backup, restore, publish, test, launch, container, and visualization logic

The main change is to give the scripts an explicit workspace context instead of assuming the toolset folder is inside or beside the workspace.

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

Scope: shared workspace configuration, suitable for source control.

Examples under `settings.dam-pav.bcdevtoolset`:

- country
- app folder conventions
- shared environments without secrets
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
- Preserve current behavior when no explicit workspace path is provided.
- Add a stable operation bridge script, for example `Invoke-BcDevToolsetOperation.ps1`.
- Make operation execution possible without relying on the toolset folder being inside the workspace.

Acceptance criteria:

- A script can run an operation against an arbitrary workspace path.
- Existing workspace-copied installations are not broken.

### Phase 2: Extract Operation Metadata

Deliverables:

- Add `operations/operations.json`.
- Keep operation titles and order aligned with the current menu.

Acceptance criteria:

- Adding a new operation requires updating metadata, not hardcoded menu arrays.
- Metadata contains stable operation IDs usable by VS Code.

### Phase 3: Introduce Layered Configuration

Deliverables:

- Keep shared project/workspace attributes in `.code-workspace` under `settings.dam-pav.bcdevtoolset`.
- Add support for `.bcdevtoolset/settings.json`.
- Locate `.bcdevtoolset/settings.json` beside the active `.code-workspace` file and do not require or force it to be a workspace folder.
- Merge configuration in a predictable order.
- Continue reading existing `settings.json` and `.code-workspace` configuration during transition.

Suggested merge order:

1. Built-in defaults
2. `.code-workspace` settings
3. legacy `settings.json`
4. `.bcdevtoolset/settings.json`
5. secrets resolved at runtime

Acceptance criteria:

- Existing workspaces continue to work.
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

- `BC Dev Toolset: Install/Update Toolset`
- `BC Dev Toolset: Configure Workspace`
- `BC Dev Toolset: Show Operations List`
- `BC Dev Toolset: Create/Overwrite Docker Container`
- `BC Dev Toolset: Update launch.json`
- `BC Dev Toolset: Backup Container Databases`
- `BC Dev Toolset: Restore Container Databases`
- `BC Dev Toolset: Publish Apps to Docker`
- `BC Dev Toolset: Run Tests`

Acceptance criteria:

- A workspace without a copied `BC-Dev-Toolset` folder can run an operation.
- Commands show meaningful errors when PowerShell, Git, Docker, or the toolset install is missing.
- Users can still inspect full PowerShell output in the terminal.

### Phase 5: Workspace Configuration UX

Deliverables:

- Add command to initialize `.bcdevtoolset` files.
- Add command to open project configuration.
- Add command to open local configuration.
- Add command to migrate legacy `settings.json` values.
- Add validation diagnostics or status messages for missing paths and invalid environment definitions.

Acceptance criteria:

- A developer can set up a new workspace from VS Code without manually copying the repository.
- Local-only values are kept out of source control.
- Migration does not delete legacy configuration.

### Phase 6: Polish and Distribution

Deliverables:

- Add README section for extension workflow.
- Add migration guide from copied-toolset workflow.
- Add extension packaging configuration.
- Decide whether the extension bundles a toolset release or always installs from Git.
- Add basic automated tests for operation metadata parsing and command construction.

Acceptance criteria:

- Extension can be packaged locally.
- A fresh developer machine can install the extension, install the toolset, configure a workspace, and run a basic operation.
- Existing script-first users retain a supported path.

## Compatibility Strategy

During transition, support both modes:

- Legacy mode: toolset folder copied into or beside a workspace.
- Hybrid mode: central toolset install controlled by the VS Code extension.

Deprecation should be gradual. The copied-toolset workflow can remain documented as a manual or advanced mode until the extension path is proven.

## Open Decisions

- Should the extension live in this repository or a separate repository?
- Should the central toolset install be a Git clone, downloaded release archive, or bundled extension asset?
- Should operation commands be registered individually, or should most operations go through a single `Show Operations List` picker?
- Should non-interactive operation mode be introduced immediately, or only after the command palette MVP?
- How much configuration validation belongs in TypeScript versus PowerShell?
- Which existing workspace settings should eventually move to local-only configuration or SecretStorage?

## Suggested First Milestone

Build the smallest useful hybrid slice:

1. Add explicit workspace path support to PowerShell context initialization.
2. Add `operations/operations.json`.
3. Add `Invoke-BcDevToolsetOperation.ps1`.
4. Scaffold the VS Code extension.
5. Register `BC Dev Toolset: Show Operations List`.
6. Execute one existing operation from the command palette against a workspace that does not contain a copied toolset folder.

This milestone proves the architecture without forcing a full configuration migration up front.
