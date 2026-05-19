# BC Dev Toolset VS Code Extension

This is the first thin VS Code host for the PowerShell-based BC-Dev-Toolset.

The extension does not reimplement Business Central logic. It locates a central toolset installation, reads `operations/operations.json`, and runs operations through `Invoke-BcDevToolsetOperation.ps1`.

## Commands

- `BC Dev Toolset: Install/Update Toolset`
- `BC Dev Toolset: Configure Workspace`
- `BC Dev Toolset: Show Operations List`

## Settings

- `bcDevToolset.toolsetPath`
- `bcDevToolset.repositoryUrl`
- `bcDevToolset.powershellExecutable`
- `bcDevToolset.localSettingsPath`

## Development

Open the `vscode-extension` folder in VS Code and run the extension host. The extension is plain JavaScript and does not require a build step.
