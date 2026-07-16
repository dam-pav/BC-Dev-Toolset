# Repository Instructions

## Scope

This repository contains the BC Dev Toolset runtime scripts and the VS Code extension that exposes those operations to developers and agents. Treat it as tooling source code, not as a consuming Business Central AL workspace.

## Development Guidance

- Prefer direct source edits, tests, and repository inspection when working on this repo.
- Do not use the BC Dev Toolset MCP server to operate on this repository unless the task is explicitly about testing the MCP integration itself.
- Keep operation metadata, VS Code command contributions, MCP tool exposure, and README documentation aligned when adding, removing, renaming, or recategorizing operations.
- Preserve the distinction between deployed-user behavior and this development environment. End-user Codex setup belongs in the extension's `Configure Codex MCP Integration` operation, not in this repo-level instruction file.

## Filesystem Path Safety

- Treat paths originating from users, workspace settings, environment variables, operation arguments, or callbacks as untrusted.
- Before filesystem access, resolve and normalize an untrusted path and verify with `path.relative` that it is equal to or contained by an explicitly authorized root. Reject paths that escape the root; do not rely on normalization alone.
- Construct internal paths from a trusted root plus fixed path segments whenever possible. Avoid generic helpers that pass unchecked path parameters directly to `fs.readFileSync`, `fs.writeFileSync`, `fs.statSync`, or similar APIs.
- Do not use filesystem paths or file metadata merely to produce cache keys, versions, or identifiers. Prefer an explicit reviewed revision constant, a UUID, or a hash of non-sensitive canonical data. For the MCP tool surface, increment `mcpServerDefinitionRevision` whenever tools or schemas change.
- When a filesystem path is intentionally configurable and cannot be confined to one root, validate it at the configuration boundary and pass a validated path object or clearly named validated value to filesystem code.

## Verification

- Run `npm run validate` from `vscode-extension` after changing extension JavaScript or package metadata.
- Run `node --check vscode-extension/mcp-server.js` after changing the MCP server.
- Validate JSON files after editing operation metadata, package contributions, schemas, or generated configuration examples.
