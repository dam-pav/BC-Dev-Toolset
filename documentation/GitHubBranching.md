# GitHub Branching and Release Flow

## Branches

- `development`: day-to-day integration branch.
- `main`: latest functionality channel. Changes land by pull request and receive a build version bump.
- `stable`: released channel. Updated only by the stable major/minor release workflows.

## Required GitHub Rules

Configure branch rulesets or branch protection in GitHub:

- Protect `main`.
- Require pull requests before merging into `main`.
- Require branches to be up to date before merging into `main`; this prevents two open PRs from merging with the same build version.
- Block direct pushes to `main`.
- Protect `stable`.
- Block direct pushes to `stable`.
- Allow the release deploy key to bypass push restrictions for the stable release workflows.

## Main Build Version Flow

`.github/workflows/main-build-version.yml` runs for pull requests targeting `main`.

The workflow:

- reads the current version from `origin/main:vscode-extension/package.json`;
- bumps the PR branch to the next build version;
- commits the changed `vscode-extension/package.json` back to the PR branch.

Example: if `main` is `1.3.0`, a PR targeting `main` is bumped to `1.3.1`.

## Stable Release Flows

`.github/workflows/stable-major-release.yml` and `.github/workflows/stable-minor-release.yml` are manually started from GitHub Actions.

Both workflows:

- checks out `main`;
- commits the release bump;
- pushes the same commit to `main` and `stable`;
- creates a `vX.Y.Z` tag;
- attaches the stable VSIX asset to the GitHub Release;
- publishes the stable VSIX to the VS Code Marketplace.

The major release workflow bumps to the next major version, resetting minor and build to `0`.
Example: if `main` is `1.4.2`, the major release workflow creates `2.0.0`.

The minor release workflow bumps to the next minor version, resetting build to `0`.
Example: if `main` is `1.4.2`, the minor release workflow creates `1.5.0`.

## Marketplace Versioning

The Marketplace version is expected to match the committed `vscode-extension/package.json` version.

Use one of these publish paths:

- the stable major/minor release workflows, which bump the repo version and publish the stable VSIX with bundled runtime assets;
- the `Marketplace publish` workflow, which publishes the current repo version after verifying an explicit `expected_version` input.

Do not use `vsce publish patch`, `vsce publish minor`, or `vsce publish major` for this repository. Those commands can make Marketplace versioning drift away from Git history.
