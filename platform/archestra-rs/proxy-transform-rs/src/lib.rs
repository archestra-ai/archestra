//! Thin NAPI adapter over `proxy_transform_core`. Receives the tool-result batch
//! as owned Rust data on the JS thread, offloads the unwrap/parse/TOON-encode
//! work to the libuv threadpool, and converts a panic into a structured JS
//! error. No product logic lives here — deleting this layer must not delete the
//! core logic. The `#[napi(object)]` DTO shapes live in the core behind its
//! `napi` feature (sandbox-core pattern), so the generated `index.d.ts` mirrors
//! the core types exactly.

use std::any::Any;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

use proxy_transform_core as core;

/// Unwrap/parse/TOON-encode work for one batch of tool results, run on the libuv
/// threadpool so the JS event loop is never blocked by a large payload. The
/// items are converted to owned Rust data on the JS thread before `compute`
/// runs, so nothing here touches a JS handle.
pub struct ToonEncodeTask {
    items: Vec<core::ToonEncodeItem>,
    count: Option<core::BeforeSource>,
}

impl Task for ToonEncodeTask {
    type Output = Vec<core::ToonEncodeResult>;
    type JsValue = Vec<core::ToonEncodeResult>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let items = std::mem::take(&mut self.items);
        let count = self.count;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            core::toon_encode_tool_results(items, count)
        }))
        .map_err(panic_to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Transform a batch of tool results off the JS thread: optionally unwrap the
/// `[{"type":"text","text":...}]` client wrapper, parse the JSON, and encode it
/// as TOON (spec v3). Results are positional — same length and order as
/// `items`; content that is not parseable JSON yields `encoded: null` (the
/// caller keeps the original payload).
///
/// `beforeSource` selects the fused cl100k token counting: pass it to have the
/// off-thread pass populate `beforeTokens`/`encodedTokens` (`Normalized` for
/// most adapters, `Raw` for Gemini), or omit it to skip counting (Anthropic and
/// Bedrock tokenize with their own tokenizer).
#[napi(
    js_name = "toonEncodeToolResults",
    ts_return_type = "Promise<Array<ToonEncodeResult>>"
)]
pub fn toon_encode_tool_results(
    items: Vec<core::ToonEncodeItem>,
    before_source: Option<core::BeforeSource>,
) -> AsyncTask<ToonEncodeTask> {
    AsyncTask::new(ToonEncodeTask {
        items,
        count: before_source,
    })
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
