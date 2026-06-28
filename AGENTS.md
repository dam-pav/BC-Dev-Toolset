# Repository Instructions

## Scope

This repository contains the BC Dev Toolset runtime scripts and the VS Code extension that exposes those operations to developers and agents. Treat it as tooling source code, not as a consuming Business Central AL workspace.

## Development Guidance

- Prefer direct source edits, tests, and repository inspection when working on this repo.
- Do not use the BC Dev Toolset MCP server to operate on this repository unless the task is explicitly about testing the MCP integration itself.
- Keep operation metadata, VS Code command contributions, MCP tool exposure, and README documentation aligned when adding, removing, renaming, or recategorizing operations.
- Preserve the distinction between deployed-user behavior and this development environment. End-user Codex setup belongs in the extension's `Configure Codex MCP Integration` operation, not in this repo-level instruction file.

## Verification

- Run `npm run validate` from `vscode-extension` after changing extension JavaScript or package metadata.
- Run `node --check vscode-extension/mcp-server.js` after changing the MCP server.
- Validate JSON files after editing operation metadata, package contributions, schemas, or generated configuration examples.
