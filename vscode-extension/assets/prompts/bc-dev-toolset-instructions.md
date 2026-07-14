# BC Dev Toolset MCP Instructions

## Business Central Development Operations

When working with Business Central AL projects, use the **BC Dev Toolset** MCP server tools (`bc_dev_toolset_*`) for environment management tasks. Do not run Docker commands, BcContainerHelper cmdlets, or PowerShell scripts directly when a matching MCP tool exists.

### Available Operations

| Category | Operations |
|----------|-----------|
| **Container** | `bc_dev_toolset_new_docker_container` — Create/overwrite Docker container |
| **Container** | `bc_dev_toolset_show_active_licenses` — Show active container licenses |
| **Container** | `bc_dev_toolset_update_launch_json` — Update launch.json files |
| **Publishing** | `bc_dev_toolset_publish_apps2_docker` — Publish apps to Docker |
| **Publishing** | `bc_dev_toolset_publish_apps2_test` — Publish apps to test environments |
| **Publishing** | `bc_dev_toolset_publish_apps2_production` — Publish apps to production |
| **Publishing** | `bc_dev_toolset_publish_dependencies2_docker` — Publish dependencies to Docker |
| **Publishing** | `bc_dev_toolset_publish_dependencies2_test` — Publish dependencies to test |
| **Publishing** | `bc_dev_toolset_publish_runtime_apps2_docker` — Publish runtime packages to Docker |
| **Publishing** | `bc_dev_toolset_publish_runtime_apps2_test` — Publish runtime packages to test |
| **Publishing** | `bc_dev_toolset_publish_runtime_apps2_production` — Publish runtime packages to production |
| **Publishing** | `bc_dev_toolset_unpublish_docker_apps` — Unpublish apps from Docker |
| **Publishing** | `bc_dev_toolset_unpublish_test_apps` — Unpublish apps from test |
| **Testing** | `bc_dev_toolset_invoke_tests` — Run AL test tool tests |
| **Testing** | `bc_dev_toolset_invoke_page_script_tests` — Run page script tests |
| **Backups** | `bc_dev_toolset_backup_bc_container_databases` — Backup Docker container databases |
| **Backups** | `bc_dev_toolset_backup_bc_service_databases` — Backup BC service databases |
| **Backups** | `bc_dev_toolset_restore_bc_container_databases` — Restore databases to container |
| **Prerequisites** | `bc_dev_toolset_init_prerequisites` — Install/update prerequisites |
| **Prerequisites** | `bc_dev_toolset_update_power_shell` — Update Microsoft PowerShell |
| **Runtime** | `bc_dev_toolset_create_runtime_package` — Create deployment runtime packages |
| **Workspace** | `bc_dev_toolset_clear_app_artifacts` — Clear app and translation artifacts |
| **Workspace** | `bc_dev_toolset_show_bc_container_helper_versions` — Show BcContainerHelper versions |
| **Configuration** | `bc_dev_toolset_update_bc_license_container` — Update license files |
| **Configuration** | `bc_dev_toolset_update_bc_container_server_configuration` — Update server configuration |

### Rules

1. **Always prefer MCP tools** — If a `bc_dev_toolset_*` tool exists for the requested operation, call it instead of running manual commands.
2. **Do not duplicate operations** — Do not manually inspect Docker containers, run BcContainerHelper cmdlets, or invoke PowerShell scripts directly when an MCP tool is available.
3. **Runtime packages** — Use `bc_dev_toolset_create_runtime_package` only when the user explicitly asks for runtime packages. Do not use it as a substitute for AL compile/build/validation.
4. **Compile/build requests** — Use a matching compile/build MCP tool when one exists. If no matching tool is available, normal AL CLI compilation with the discovered workspace settings is appropriate.
5. **Terminal bridge** — PowerShell-backed MCP operations require the BC Dev Toolset VS Code extension terminal bridge. If the MCP tool reports the bridge is unavailable, tell the user to start or reload the VS Code extension host.
6. **Prompt answers** — If an operation returns `waiting_for_input`, call `bc_dev_toolset_answer_operation_prompt` with the returned `sessionId`. If the answer is already known before starting an operation, pass it in the operation tool's `promptAnswers` object keyed by prompt ID. For test operations, prefer the explicit `testContainerSelection`, `executeTestsInContainer`, and `pullFullArtifact` inputs. For container backup operations, prefer `containerSelection`.
7. **PowerShell fallback** — Manual PowerShell/terminal commands are appropriate only for work not covered by a `bc_dev_toolset_*` MCP tool, for reading local files, and for normal codebase maintenance.
