//! Thin NAPI adapter over `image_core`. Receives JS buffers/numbers, offloads the
//! decode/resize/re-encode work to the libuv threadpool, and converts a panic
//! into a structured JS error. No product logic lives here — deleting this layer
//! must not delete the core logic. The `#[napi(object)]` shapes live here (not in
//! the core) to keep the core free of Node/NAPI assumptions.

use std::any::Any;

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

/// A shrunk image produced by `shrinkImageToFit`. `bytes` is guaranteed to be at
/// most the requested `maxBytes`; `contentType` is `"image/png"` or
/// `"image/jpeg"`.
#[napi(object)]
pub struct ShrunkImage {
    pub bytes: Buffer,
    pub content_type: String,
}

/// Decode/resize/re-encode work for one image, run on the libuv threadpool so the
/// JS event loop is never blocked by a large image. The buffer is copied out on
/// the JS thread before `compute` runs, so nothing here touches a JS handle.
pub struct ShrinkImageTask {
    input: Vec<u8>,
    max_bytes: usize,
    max_dimension: u32,
}

impl Task for ShrinkImageTask {
    type Output = Option<image_core::ShrunkImage>;
    type JsValue = Option<ShrunkImage>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let input = std::mem::take(&mut self.input);
        let targets = image_core::ShrinkTargets {
            max_bytes: self.max_bytes,
            max_dimension: self.max_dimension,
        };
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            image_core::shrink_image_to_fit(&input, targets)
        }))
        .map_err(panic_to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.map(|shrunk| ShrunkImage {
            bytes: shrunk.bytes.into(),
            content_type: shrunk.content_type,
        }))
    }
}

/// Downscale an oversized image so it fits both a byte budget (`maxBytes`, a
/// model's inline-image limit) and a longest-edge pixel cap (`maxDimension`),
/// off the JS thread. Resolves to `null` when the input cannot be decoded (or is
/// a decompression bomb) or cannot be made to fit. Prefers lossless PNG, falling
/// back to JPEG and progressive downscaling.
#[napi(
    js_name = "shrinkImageToFit",
    ts_return_type = "Promise<ShrunkImage | null>"
)]
pub fn shrink_image_to_fit(
    input: Buffer,
    max_bytes: u32,
    max_dimension: u32,
) -> AsyncTask<ShrinkImageTask> {
    AsyncTask::new(ShrinkImageTask {
        input: input.to_vec(),
        max_bytes: max_bytes as usize,
        max_dimension,
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
