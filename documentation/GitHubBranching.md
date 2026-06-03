# GitHub Branching and Release Flow

## Branches

- `development`: day-to-day integration branch.
- `main`: latest functionality channel. Changes land by pull request and receive a build version bump.
- `stable`: released channel. Updated only by the stable major/minor release workflows.

## Required GitHub Rules

Configure branch rulesets or branch protection in GitHub:

- Protect `main`.
- Require pull requests before merging into `main`.
- Require approval from code owners before merging into `main`.
- Require branches to be up to date before merging into `main`; this prevents two open PRs from merging with the same build version.
- Block direct pushes to `main`.
- Protect `stable`.
- Block direct pushes to `stable`.
- Allow the release deploy key to bypass push restrictions for the stable release workflows.

Configure a repository secret named `RELEASE_PR_TOKEN` for the stable major/minor release workflows. The secret must contain a fine-grained personal access token or GitHub App token that can create pull requests and read/write repository contents. The default `GITHUB_TOKEN` is not sufficient for opening these release pull requests when repository or organization policy blocks GitHub Actions from creating pull requests.

## Workflow Naming

Workflows prefixed with `Auto -` are automatic or internal continuation workflows and should not be started manually. Workflows without that prefix are intended for manual use when they expose `workflow_dispatch`.

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

- check out `main`;
- bump the release version on a `release/vX.Y.Z` branch;
- generate `documentation/releases/vX.Y.Z.md` as a release note proposal;
- open a draft pull request targeting `main`.

The release note proposal must be manually reviewed, edited as needed, and approved through the release pull request before publication. When the release pull request is ready, mark it ready for review and merge it after approval.

`.github/workflows/publish-stable-release.yml` runs after a merged pull request from a `release/vX.Y.Z` branch. The publish workflow:

- verifies that `vscode-extension/package.json` contains `X.Y.Z`;
- verifies that `documentation/releases/vX.Y.Z.md` exists;
- packages the stable VSIX asset;
- pushes the released commit to `stable`;
- creates the `vX.Y.Z` tag;
- creates the GitHub Release using the approved release notes file;
- publishes the stable VSIX to the VS Code Marketplace;
- dispatches the `latest-extension.yml` workflow so that workflow can bump `main` to the next pre-release version.

The major release workflow bumps to the next major version, resetting minor and build to `0`.
Example: if `main` is `1.4.2`, the major release workflow creates `2.0.0`.

The minor release workflow bumps to the next minor version, resetting build to `0`.
Example: if `main` is `1.4.2`, the minor release workflow creates `1.5.0`.

## Marketplace Versioning

The Marketplace version is expected to match the committed `vscode-extension/package.json` version.

Use one of these publish paths:

- the stable major/minor release workflows, which open release pull requests with generated release notes, followed by the publish workflow after the release pull request is approved and merged;
- the `Latest extension package` workflow, which bumps `main` to the next pre-release version when dispatched from a stable release workflow and publishes the latest pre-release VSIX whenever that bump lands on `main`;
- the `Marketplace publish` workflow, which publishes the current repo version after verifying an explicit `expected_version` input.

Do not use `vsce publish patch`, `vsce publish minor`, or `vsce publish major` for this repository. Those commands can make Marketplace versioning drift away from Git history.
