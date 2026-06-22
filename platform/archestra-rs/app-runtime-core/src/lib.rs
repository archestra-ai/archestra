//! Pure app-runtime envelope logic: turning an owned app's authored HTML plus
//! per-viewer context into sandbox-ready HTML. Deterministic, side-effect-free,
//! and free of Node/NAPI/browser assumptions so the same logic backs both the
//! TypeScript backend (via the `app_runtime_rs` NAPI adapter) and a future Rust
//! companion that links this crate directly.

mod app_html;
pub mod contract;
mod diagnostics;
mod envelope;

pub use app_html::{Rejection, RejectionKind, ScanResult, scan_app_html};
pub use diagnostics::{
    DiagnosticEntry, cap_diagnostic_entries, escape_angle_brackets, format_diagnostic_entry_lines,
    merge_diagnostic_entries,
};
pub use envelope::{InlineAssets, prepare_app_envelope, prepare_app_envelope_with_assets};
