use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use napi_derive::napi;

use sandbox_core as core;

#[napi(js_name = "checkSession")]
pub async fn check_session(input: Option<core::CheckSessionInput>) -> napi::Result<()> {
    core::telemetry::init();
    let input = input.unwrap_or_default();
    catch_core(core::check_session(input)).await
}

#[napi(js_name = "runSandbox")]
pub async fn run_sandbox(input: core::RunSandboxInput) -> napi::Result<core::CommandExecution> {
    core::telemetry::init();
    catch_core(core::run_sandbox(input)).await
}

#[napi(js_name = "readArtifact")]
pub async fn read_artifact(input: core::ReadArtifactInput) -> napi::Result<core::ArtifactBytes> {
    core::telemetry::init();
    catch_core(core::read_artifact(input)).await
}

/// force-flush pending OTLP traces/logs. the backend calls this on graceful
/// shutdown so the final batch isn't lost. intentionally sync: the blocking
/// flush runs on the JS thread while the batch-export tasks drain on the tokio
/// runtime — calling it from inside the runtime (an async fn) would deadlock.
#[napi(js_name = "flushTelemetry")]
pub fn flush_telemetry() {
    core::telemetry::flush();
}

#[cfg(feature = "test-helpers")]
#[napi(js_name = "__testPanic")]
pub fn test_panic() -> napi::Result<()> {
    std::panic::catch_unwind(|| {
        panic!("sandbox-rs panic smoke test");
    })
    .map_err(panic_to_napi_error)
}

async fn catch_core<T, Fut>(future: Fut) -> napi::Result<T>
where
    Fut: Future<Output = core::Result<T>>,
{
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(to_napi_error(error)),
        Err(payload) => Err(panic_to_napi_error(payload)),
    }
}

fn panic_to_napi_error(payload: Box<dyn Any + Send>) -> napi::Error {
    to_napi_error(core::SandboxError::Internal(format!(
        "rust panic: {}",
        panic_payload_message(payload.as_ref())
    )))
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

fn to_napi_error(error: core::SandboxError) -> napi::Error {
    let payload = serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    });
    napi::Error::new(napi::Status::GenericFailure, payload.to_string())
}
