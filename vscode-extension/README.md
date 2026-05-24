# BC Dev Toolset VS Code Extension

This is the thin VS Code host for the PowerShell-based BC-Dev-Toolset.

The extension does not reimplement Business Central logic. It locates a central toolset installation, reads `operations/operations.json`, and runs operations through `Invoke-BcDevToolsetOperation.ps1`.

## Manual Installation

Install a packaged `.vsix` from VS Code:

1. Open VS Code.
2. Run `Extensions: Install from VSIX...` from the Command Palette.
3. Select `bc-dev-toolset-<version>.vsix`.
4. Open a Business Central workspace.
5. Run `BC Dev Toolset: Install/Update Toolset`.
6. Run `BC Dev Toolset: Configure Workspace`.

The install/update command creates or updates the central sparse checkout in `%LOCALAPPDATA%\BC-Dev-Toolset\toolset` by default. It installs from the `stable` branch unless `bcDevToolset.repositoryRef` is set to `latest`, which tracks `main`. Workspace-local configuration is stored beside the active `.code-workspace` file in `.bcdevtoolset/settings.json`.

## Commands

- `BC Dev Toolset: Install/Update Toolset`
- `BC Dev Toolset: Configure Workspace`
- `BC Dev Toolset: Open Local Settings (JSON)`
- `BC Dev Toolset: Show Operations List`
- `BC Dev Toolset: Show object id range visualization data`
- Individual operation commands under the `BC Dev Toolset:` prefix

## Settings

- `bcDevToolset.toolsetPath`
- `bcDevToolset.repositoryRef`
- `bcDevToolset.powershellExecutable`
- `bcDevToolset.localSettingsPath`

## Central Toolset Install

`BC Dev Toolset: Install/Update Toolset` uses a sparse Git checkout. The central runtime install contains only:

- `Invoke-BcDevToolsetOperation.ps1`
- `common/`
- `operations/`
- `visualization/`

`bcDevToolset.repositoryRef` selects the update channel:

- `stable`: install/update from the `stable` branch. This is the default for packaged VSIX users.
- `latest`: install/update from the `main` branch.

## Development

Open the `vscode-extension` folder in VS Code and run the extension host. When the extension runs in development mode from a full BC-Dev-Toolset clone, it uses the repository root as the toolset path automatically. In that mode, `BC Dev Toolset: Install/Update Toolset` does not run sparse checkout commands against the development clone.

The extension is plain JavaScript and does not require a build step.

Validate the extension entry point:

```powershell
npm run validate
```

Package a VSIX for manual distribution:

```powershell
npm run package
```

This produces `bc-dev-toolset-<version>.vsix` in the `vscode-extension` folder.
