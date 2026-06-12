//! Thin NAPI adapter over `app_runtime_core`. Receives JS strings, calls the
//! pure core, and converts a panic into a structured JS error. No product logic
//! lives here — deleting this layer must not delete the envelope logic.

use std::any::Any;

use napi_derive::napi;

/// Inject the platform baseline stylesheet, per-viewer bootstrap, and Apps SDK
/// into an owned app's HTML. `contextJson` is the caller-serialized per-viewer
/// context (identity + assigned-tool descriptors); see the core crate for the
/// trust boundary on its byte format.
#[napi(js_name = "prepareAppEnvelope")]
pub fn prepare_app_envelope(html: String, context_json: String) -> napi::Result<String> {
    std::panic::catch_unwind(|| app_runtime_core::prepare_app_envelope(&html, &context_json))
        .map_err(panic_to_napi_error)
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
