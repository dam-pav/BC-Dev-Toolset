# Repository Instructions

## Filesystem Path Safety

- Treat paths originating from users, workspace settings, environment variables, operation arguments, or callbacks as untrusted.
- Before filesystem access, resolve and normalize an untrusted path and verify with `path.relative` that it is equal to or contained by an explicitly authorized root. Reject paths that escape the root; do not rely on normalization alone.
- Construct internal paths from a trusted root plus fixed path segments whenever possible. Avoid generic helpers that pass unchecked path parameters directly to `fs.readFileSync`, `fs.writeFileSync`, `fs.statSync`, or similar APIs.
- Do not use filesystem paths or file metadata merely to produce cache keys, versions, or identifiers. Prefer an explicit reviewed revision constant, a UUID, or a hash of non-sensitive canonical data. For the MCP tool surface, increment `mcpServerDefinitionRevision` whenever tools or schemas change.
- When a filesystem path is intentionally configurable and cannot be confined to one root, validate it at the configuration boundary and pass a validated path object or clearly named validated value to filesystem code.
- If static analysis still flags a validated filesystem sink, use the analyzer's narrow inline suppression only on that sink, with an adjacent comment stating the authorization and containment guarantees. Never suppress an unvalidated path flow.
