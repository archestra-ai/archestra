//! Thin NAPI adapter over `app_runtime_core`. Receives JS strings/objects, calls
//! the pure core, and converts a panic into a structured JS error. No product
//! logic lives here — deleting this layer must not delete the core logic. The
//! `#[napi(object)]` shapes live here (not in the core) to keep the core free of
//! Node/NAPI assumptions.

use std::any::Any;

use app_runtime_core as core;
use napi_derive::napi;

/// Trusted, platform-built assets the connector embeds directly into the
/// resource when serving a strict foreign host (claude.ai) whose sandbox CSP
/// refuses cross-origin `<script src>`/`<link href>`. Omitted keeps the linked
/// form (Archestra's own render).
#[napi(object)]
pub struct InlineAssets {
    /// ext-apps guest bundle as an IIFE publishing the View SDK on
    /// `window.__ARCHESTRA_EXT_APPS__`.
    pub ext_apps_global: String,
    /// The Apps SDK microframework (same bytes served at the SDK path).
    pub shim: String,
    /// The platform baseline stylesheet (same bytes served at the CSS path).
    pub base_css: String,
}

/// Inject the platform CSP, baseline stylesheet, per-viewer bootstrap, and Apps
/// SDK into an owned app's HTML. `contextJson` is the caller-serialized
/// per-viewer context (identity + assigned-tool descriptors). `baseOrigin`
/// prefixes the served asset URLs so they resolve in a foreign host's
/// opaque-origin iframe (empty keeps them path-relative); `csp` is the pinned
/// Content-Security-Policy injected as a `<meta>` (empty omits it). When
/// `inlineAssets` is provided the stylesheet and SDK are embedded in the
/// document instead of linked (`baseOrigin` is then unused for assets). See the
/// core crate for the trust boundary on these inputs.
#[napi(js_name = "prepareAppEnvelope")]
pub fn prepare_app_envelope(
    html: String,
    context_json: String,
    base_origin: String,
    csp: String,
    inline_assets: Option<InlineAssets>,
) -> napi::Result<String> {
    std::panic::catch_unwind(|| {
        let inline = inline_assets.as_ref().map(|a| core::InlineAssets {
            ext_apps_global: &a.ext_apps_global,
            shim: &a.shim,
            base_css: &a.base_css,
        });
        core::prepare_app_envelope_with_assets(&html, &context_json, &base_origin, &csp, inline)
    })
    .map_err(panic_to_napi_error)
}

/// Scan authored app HTML for save-time policy violations. Returns a rejection
/// (the first disqualifying construct) plus soft warnings; the caller turns a
/// rejection into the user-facing `ApiError` message.
#[napi(js_name = "scanAppHtml")]
pub fn scan_app_html(html: String) -> napi::Result<AppHtmlScanResult> {
    std::panic::catch_unwind(|| {
        let result = core::scan_app_html(&html);
        AppHtmlScanResult {
            rejection: result.rejection.map(|rejection| AppHtmlRejection {
                kind: rejection_kind_str(&rejection.kind).to_string(),
                offender: rejection.offender,
            }),
            warnings: result.warnings,
        }
    })
    .map_err(panic_to_napi_error)
}

/// Escape `<`/`>` in untrusted diagnostic text so it cannot break out of the
/// `<app-render-diagnostics>` delimiter block.
#[napi(js_name = "escapeAngleBrackets")]
pub fn escape_angle_brackets(text: String) -> napi::Result<String> {
    std::panic::catch_unwind(|| core::escape_angle_brackets(&text)).map_err(panic_to_napi_error)
}

/// Clamp the entry count, sanitize each type, and truncate each message.
#[napi(js_name = "capDiagnosticEntries")]
pub fn cap_diagnostic_entries(
    entries: Vec<AppDiagnosticEntry>,
    max_entries: u32,
    max_message_len: u32,
) -> napi::Result<Vec<AppDiagnosticEntry>> {
    std::panic::catch_unwind(move || {
        let core_entries: Vec<core::DiagnosticEntry> = entries.into_iter().map(into_core).collect();
        core::cap_diagnostic_entries(
            &core_entries,
            max_entries as usize,
            max_message_len as usize,
        )
        .into_iter()
        .map(from_core)
        .collect()
    })
    .map_err(panic_to_napi_error)
}

/// Union and dedup two already-capped entry lists, capping the total.
#[napi(js_name = "mergeDiagnosticEntries")]
pub fn merge_diagnostic_entries(
    existing: Vec<AppDiagnosticEntry>,
    incoming: Vec<AppDiagnosticEntry>,
    max_entries: u32,
    dedup_prefix_len: u32,
) -> napi::Result<Vec<AppDiagnosticEntry>> {
    std::panic::catch_unwind(move || {
        let core_existing: Vec<core::DiagnosticEntry> =
            existing.into_iter().map(into_core).collect();
        let core_incoming: Vec<core::DiagnosticEntry> =
            incoming.into_iter().map(into_core).collect();
        core::merge_diagnostic_entries(
            &core_existing,
            &core_incoming,
            max_entries as usize,
            dedup_prefix_len as usize,
        )
        .into_iter()
        .map(from_core)
        .collect()
    })
    .map_err(panic_to_napi_error)
}

/// Render entries as `- [type] message` lines (sanitized, escaped, truncated).
/// Emits only the inner lines; the caller wraps them in the delimiter block.
#[napi(js_name = "formatDiagnosticEntryLines")]
pub fn format_diagnostic_entry_lines(
    entries: Vec<AppDiagnosticEntry>,
    max_entries: u32,
    max_message_len: u32,
) -> napi::Result<String> {
    std::panic::catch_unwind(move || {
        let core_entries: Vec<core::DiagnosticEntry> = entries.into_iter().map(into_core).collect();
        core::format_diagnostic_entry_lines(
            &core_entries,
            max_entries as usize,
            max_message_len as usize,
        )
    })
    .map_err(panic_to_napi_error)
}

#[napi(object)]
pub struct AppDiagnosticEntry {
    #[napi(js_name = "type")]
    pub type_: String,
    pub message: String,
}

#[napi(object)]
pub struct AppHtmlRejection {
    /// Stable discriminant: `sdk_bootstrap` | `platform_script_src` |
    /// `platform_base_css` | `unparseable`.
    pub kind: String,
    pub offender: String,
}

#[napi(object)]
pub struct AppHtmlScanResult {
    pub rejection: Option<AppHtmlRejection>,
    pub warnings: Vec<String>,
}

fn into_core(entry: AppDiagnosticEntry) -> core::DiagnosticEntry {
    core::DiagnosticEntry {
        kind: entry.type_,
        message: entry.message,
    }
}

fn from_core(entry: core::DiagnosticEntry) -> AppDiagnosticEntry {
    AppDiagnosticEntry {
        type_: entry.kind,
        message: entry.message,
    }
}

fn rejection_kind_str(kind: &core::RejectionKind) -> &'static str {
    match kind {
        core::RejectionKind::SdkBootstrap => "sdk_bootstrap",
        core::RejectionKind::PlatformScriptSrc => "platform_script_src",
        core::RejectionKind::PlatformBaseCss => "platform_base_css",
        core::RejectionKind::Unparseable => "unparseable",
    }
}

fn panic_to_napi_error(payload: Box<dyn Any + Send>) -> napi::Error {
    let body = serde_json::json!({
        "code": "ARCHESTRA_INTERNAL",
        "message": format!("rust panic: {}", panic_payload_message(payload.as_ref())),
    });
    napi::Error::new(napi::Status::GenericFailure, body.to_string())
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return s;
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.as_str();
    }
    "unknown panic payload"
}
