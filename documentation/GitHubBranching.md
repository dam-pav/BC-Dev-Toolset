# GitHub Branching and Release Flow

## Branches

- `development`: day-to-day integration branch.
- `main`: latest functionality channel. Changes land by pull request and receive a minor version bump.
- `stable`: released channel. Updated only by the stable release workflow.

## Required GitHub Rules

Configure branch rulesets or branch protection in GitHub:

- Protect `main`.
- Require pull requests before merging into `main`.
- Require branches to be up to date before merging into `main`; this prevents two open PRs from merging with the same minor version.
- Block direct pushes to `main`.
- Protect `stable`.
- Block direct pushes to `stable`.
- Allow GitHub Actions to bypass push restrictions for the `Stable release` workflow, or replace `secrets.GITHUB_TOKEN` in `.github/workflows/stable-release.yml` with a fine-scoped release token that is allowed to update `main`, `stable`, and tags.

## Main Minor Version Flow

`.github/workflows/main-minor-version.yml` runs for pull requests targeting `main`.

The workflow:

- reads the current version from `origin/main:vscode-extension/package.json`;
- bumps the PR branch to the next minor version, resetting patch to `0`;
- commits the changed `vscode-extension/package.json` back to the PR branch.

Example: if `main` is `1.3.0`, a PR targeting `main` is bumped to `1.4.0`.

## Stable Release Flow

`.github/workflows/stable-release.yml` is manually started from GitHub Actions.

The workflow:

- checks out `main`;
- bumps `vscode-extension/package.json` to the next major version, resetting minor and patch to `0`;
- commits the release bump;
- pushes the same commit to `main` and `stable`;
- creates a `vX.0.0` tag.

Example: if `main` is `1.4.0`, the release workflow creates `2.0.0` and promotes that exact commit to both `main` and `stable`.
