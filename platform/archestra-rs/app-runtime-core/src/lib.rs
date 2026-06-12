//! Pure app-runtime envelope logic: turning an owned app's authored HTML plus
//! per-viewer context into sandbox-ready HTML. Deterministic, side-effect-free,
//! and free of Node/NAPI/browser assumptions so the same logic backs both the
//! TypeScript backend (via the `app_runtime_rs` NAPI adapter) and a future Rust
//! companion that links this crate directly.

pub mod contract;
mod envelope;

pub use envelope::prepare_app_envelope;
