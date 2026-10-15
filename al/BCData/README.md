# BC Data companion AL app

This folder is the source root reserved for the companion app bundled with BC Dev Toolset. Open `../../BC-Dev-Toolset.code-workspace` to work on the extension, app, and tests together.

The app will provide agent-facing schema discovery and generic BC table operations. BC23 is the minimum compatibility baseline, with initial support required through BC27.1. It must not depend on consuming developers' project apps.

See the [agreed design](../../documentation/BCDataDesign.md) and [compatibility experiments](../../documentation/BCDataCompatibilityExperiments.md).

The manifest now fixes app ID `0f92aea5-4cc0-459b-ae98-ca9e5c2b0304`, runtime 12.0, and platform/application baseline 23.0.0.0. Development objects are reserved in 50100-50149; confirm availability under the target container's license and installed apps before deployment. This project has no service objects yet: first establish platform semantics in the independent test app. Keep developer credentials, launch settings, downloaded symbols, and generated packages out of source control.

The separately located `../BCData.Tests` app contains verification fixtures and regression tests and is not part of the production companion app.
