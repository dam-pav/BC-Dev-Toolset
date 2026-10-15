# BC Data AL compatibility and regression tests

This folder is the source root reserved for the separate AL test app. Open `../../BC-Dev-Toolset.code-workspace` to work on it alongside the companion app and VS Code extension.

Implement the [compatibility experiments](../../documentation/BCDataCompatibilityExperiments.md) using isolated fixture tables and AL test codeunits. Run against configured development containers, starting with BC23 and BC27.1. Record exact versions and observed results; compilation alone is not runtime verification.

The manifest fixes app ID `0f2cdb66-8275-41a6-a145-f07d77d0f825`, runtime 12.0, and platform/application baseline 23.0.0.0. Development objects use 50200-50299; verify range availability in the target before publishing. The first six test procedures live in codeunit 50200, with isolated fixture tables 50200-50202. They test platform behavior directly and use Microsoft's Library Assert for assertions. This dependency also identifies the project as a Test app for Toolset launch configuration generation. Add the companion dependency when tests exercise its public contract. Do not bundle the test app for normal BC Data initialization.

The first batch covers composite GUID/integer rename and its trigger, ordered FieldRef validation, filtered FlowField calculation, typed and generic Sum write-through candidates, and parent rowversion after a child change. The write-through candidates intentionally assert a hypothesis: a failure is experimental evidence, not justification to remove FlowField support. Subsequent experiments must distinguish other write paths and unsupported formulas.

All six tests explicitly use AutoRollback and fresh GUID fixture identities. Run with Toolset's AL test runner, preserving its isolation behavior. TestPermissions is Disabled for these platform-semantic probes only; they make no permission-enforcement claims. E12 needs separate restricted-identity tests. No cross-session concurrency or HTTP behavior is proved by this batch.

Compilation and runtime execution are pending because no Toolset build/test MCP tools are exposed in the current session. Do not read source preparation as compatibility certification.

BCQuality guidance consulted directly from the workspace's external BCQuality repository: `microsoft/knowledge/testing/test-feature-scenario-tags.md`, `test-one-when-per-test.md`, `use-generateguid-for-unique-test-fixture-values.md`, `testisolation-belongs-on-the-test-runner.md`, `transactionmodel-attribute-governs-test-transactions.md`, and `microsoft/knowledge/privacy/flowfield-flowfilter-classification-systemmetadata.md`. These informed test structure, GUID identities, transaction handling, and field classification; this is not a claim of a completed BCQuality review.

HTTP interruption, concurrency between independent sessions, MCP routing, and extension lifecycle also require integration tests outside an ordinary sequential AL test codeunit.
