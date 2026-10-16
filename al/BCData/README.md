# BC Data companion AL app

This folder is the source root reserved for the companion app bundled with BC Dev Toolset. Open `../../BC-Dev-Toolset.code-workspace` to work on the extension, app, and tests together.

The app will provide agent-facing schema discovery and generic BC table operations. BC23 is the minimum compatibility baseline, with initial support required through BC27.1. It must not depend on consuming developers' project apps.

See the [agreed design](../../documentation/BCDataDesign.md) and [compatibility experiments](../../documentation/BCDataCompatibilityExperiments.md).

The manifest fixes app ID `0f92aea5-4cc0-459b-ae98-ca9e5c2b0304`, runtime 12.0, and platform/application baseline 23.0.0.0. Development objects are reserved in 50100-50149; confirm availability under the target container's license and installed apps before deployment. Keep developer credentials, launch settings, downloaded symbols, and generated packages out of source control.

Version 0.1.5.0 implements read-only contract 1: readiness, company discovery, table search, runtime schema discovery, and selected-field record reads. Install/upgrade registers codeunit 50100 as `BCDData`, rejecting an existing service owned by another object. `BCD DATA EXECUTE` grants service execution only; callers still need their own table permissions. Connection-level readiness and company discovery work before selecting a company; record reads require explicit company context.

Reads support ordinary physical application tables, primary-key ascending pagination, normal filters and FlowFilters. Pages contain at most 100 rows and 50 selected fields, SystemId and string rowversion. Decimal and BigInteger values are invariant strings; enum/option values use ordinals. Text, Code, Integer, Boolean and Guid are supported. Date/time and other unqualified scalar types fail explicitly. BLOB/Media return descriptors only. Relations and obsolescence details are explicitly unavailable. Responses exceeding 262,144 AL characters fail with guidance to reduce the selection. Pagination is not a snapshot, and parent rowversion does not cover FlowField dependencies.

The Node client uses bounded HTTP/1.0 connection-close transport to avoid the reproduced HTTP.sys chunked-response failure. It captures the target per call, checks capabilities, and binds continuation tokens to the target revision, company, query and extension-host client session for 30 minutes. Six opt-in read-only MCP tools resolve configured Dev/Test containers through the workspace bridge, including Windows Credential Manager identities without plaintext fallback. Initialize BC Data Access deploys/verifies the bundled app explicitly; optional per-container provisioning maintains it during container preparation without exposing tools. Mutations remain disabled until their semantics and concurrency experiments pass.

After building this app through Toolset MCP, `npm run prepare:runtime` from `vscode-extension` stages the validated ordinary app and compatibility manifest for bundling. This is separate from BC deployment runtime packages. Stale compiled sources, wrong app identity/version and unexpected dependencies/object ranges block packaging; the test app is not bundled.

Callers need Company table read access for discovery and company identity in responses, Table Metadata read access for table checks, read access to the selected table, and read access to a selected FlowField's source tables. The execution permission set does not grant these rights. Selecting only stored fields does not calculate unselected FlowFields. Record reads use Filtered security-filter mode, including pagination look-ahead and FlowField calculation. Separate session-local tests and real-user HTTP fixtures cover the read permission boundaries; mutation permissions remain unqualified.

The separately located `../BCData.Tests` app contains verification fixtures and regression tests and is not part of the production companion app.

Ordinary-record search and selected FlowField calculation normalize the measured untranslated AL error DB:ClientReadDenied to BCD_PERMISSION_DENIED, preserving the original BC message. The client reports permission_denied across BC23/BC27.1 HTTP status differences, redacts credentials, and retains valid JSON authorization-error context. Other native errors remain generic unless separately qualified; no English permission-word matching or automatic retry is used.
