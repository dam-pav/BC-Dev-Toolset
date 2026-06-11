# VS Code Extension Distribution

`vscode-extension/package.json` is the source of truth for the extension version. The VS Code Marketplace should only receive a VSIX built from that committed version.

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

## Publish To Marketplace

For stable releases, use the stable major/minor release workflows. Those workflows open a draft release pull request with a generated release note proposal in `documentation/releases/vX.Y.Z.md`. After the notes are reviewed, edited as needed, approved, and merged, the publish workflow creates the GitHub Release from that approved markdown file and publishes the VSIX to the VS Code Marketplace.

Use the `Marketplace publish` GitHub Actions workflow only when manually publishing the current repository version to the VS Code Marketplace outside the stable release PR flow.

1. Confirm `vscode-extension/package.json` contains the version you want to publish.
2. Run `npm run validate` from `vscode-extension`.
3. Start the `Marketplace publish` workflow from GitHub Actions.
4. Enter the same version as `expected_version`.

The workflow packages a VSIX from the committed repository version and publishes that VSIX. It fails if `expected_version` does not match `vscode-extension/package.json`.

Avoid `vsce publish patch`, `vsce publish minor`, and `vsce publish major` for this repository. Those commands can bump the Marketplace/package version outside the committed repo flow. If publishing locally is unavoidable, run this from `vscode-extension` so Marketplace uses the version already committed in `package.json`:

```powershell
npm run publish:marketplace -- --pat <VSCE_PAT>
```

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
2. Run `BC Dev Toolset: Initialize Workspace`.
3. Review `.bcdevtoolset/settings.json`.
4. Review the `bcDevToolset.*` extension settings if you need to override `shortcuts` or `hostHelperFolder`.

The extension installs the bundled runtime toolset into `%LOCALAPPDATA%\BC-Dev-Toolset\toolset` by default. Workspace-local settings are stored in `.bcdevtoolset/settings.json` beside the active `.code-workspace` file.

## Manual VSIX Release Checklist

Before sharing a VSIX:

1. Update `vscode-extension/package.json` version.
2. Run `npm run validate`.
3. Run `npm run package`.
4. Install the generated VSIX into a clean VS Code profile or another machine.
5. Verify `Initialize Workspace`, `Open Local Settings (JSON)`, and `Show Operations List`.
6. Attach the VSIX to a GitHub release.
