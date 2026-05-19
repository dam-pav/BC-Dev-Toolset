# Manual VS Code Extension Distribution

This is the manual distribution path before publishing the extension through the VS Code Marketplace.

## Build The VSIX

From the repository root:

```powershell
cd vscode-extension
npm run validate
npm run package
```

The package command creates:

```text
vscode-extension/bc-dev-toolset-<version>.vsix
```

The generated VSIX is a release artifact. It is intentionally ignored by Git and should be attached to a GitHub release or distributed through another download location.

## Install The VSIX

From VS Code:

1. Run `Extensions: Install from VSIX...`.
2. Select `bc-dev-toolset-<version>.vsix`.
3. Reload VS Code if prompted.

Or from a terminal:

```powershell
code --install-extension .\bc-dev-toolset-<version>.vsix
```

## First Workspace Setup

After installing the extension:

1. Open a Business Central `.code-workspace`.
2. Run `BC Dev Toolset: Install/Update Toolset`.
3. Run `BC Dev Toolset: Configure Workspace`.
4. Review `.bcdevtoolset/settings.json`.

The extension installs the runtime toolset into `%LOCALAPPDATA%\BC-Dev-Toolset\toolset` by default. Workspace-local settings are stored in `.bcdevtoolset/settings.json` beside the active `.code-workspace` file.

## Manual Release Checklist

Before sharing a VSIX:

1. Update `vscode-extension/package.json` version.
2. Run `npm run validate`.
3. Run `npm run package`.
4. Install the generated VSIX into a clean VS Code profile or another machine.
5. Verify `Install/Update Toolset`, `Configure Workspace`, `Open Local Settings (JSON)`, and `Show Operations List`.
6. Attach the VSIX to a GitHub release.
