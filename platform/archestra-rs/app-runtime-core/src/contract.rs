//! The fixed strings the platform stamps into served app HTML.
//!
//! `APP_SDK_PATH` / `APP_BASE_CSS_PATH` are also declared in the TypeScript
//! backend (`services/apps/app-sdk-injection.ts`), which registers the Fastify
//! routes that actually serve those assets. The injected `<script src>` /
//! `<link href>` here must match those routes byte-for-byte or the served app
//! would request a 404. The coupling is intentionally duplicated (the route
//! table is registered synchronously at startup, before this native module is
//! lazily loaded) and pinned by the envelope table tests, which assert the
//! exact injected markup.

/// Path the backend serves the Apps SDK on.
pub const APP_SDK_PATH: &str = "/_sandbox/archestra-app-sdk.js";

/// Path the backend serves the platform baseline stylesheet on.
pub const APP_BASE_CSS_PATH: &str = "/_sandbox/archestra-app-base.css";

/// Marker attribute on the injected baseline-stylesheet `<link>`.
pub const APP_BASE_CSS_MARKER: &str = "data-archestra-app-base-css";

/// Marker attribute on the injected per-viewer bootstrap `<script>`.
pub const APP_BOOTSTRAP_MARKER: &str = "data-archestra-app-bootstrap";

/// Marker attribute on the injected SDK `<script src>`.
pub const APP_SDK_MARKER: &str = "data-archestra-app-sdk";

/// Inline global the bootstrap defines and the static SDK file reads at parse
/// time, so the cached SDK file itself stays viewer-independent.
pub const APP_CONTEXT_GLOBAL: &str = "__ARCHESTRA_APP_CONTEXT__";
