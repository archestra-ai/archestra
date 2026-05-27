use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use napi_derive::napi;

use sandbox_core as core;

#[napi(js_name = "checkDaggerSession")]
pub async fn check_dagger_session(
    input: Option<core::CheckDaggerSessionInput>,
) -> napi::Result<()> {
    let input = input.unwrap_or_default();
    catch_core(core::check_dagger_session(input)).await
}

#[napi(js_name = "checkCodeRuntimeSession")]
pub async fn check_code_runtime_session(
    input: core::CheckCodeRuntimeSessionInput,
) -> napi::Result<()> {
    catch_core(core::check_code_runtime_session(input)).await
}

#[napi(js_name = "runSandboxCommand")]
pub async fn run_sandbox_command(
    input: core::RunSandboxCommandInput,
) -> napi::Result<core::CommandExecution> {
    catch_core(core::run_sandbox_command(input)).await
}

#[napi(js_name = "readSandboxArtifact")]
pub async fn read_sandbox_artifact(
    input: core::ReadSandboxArtifactInput,
) -> napi::Result<core::ArtifactBytes> {
    catch_core(core::read_sandbox_artifact(input)).await
}

#[napi(js_name = "runCodeRuntime")]
pub async fn run_code_runtime(input: core::RunCodeInput) -> napi::Result<core::CodeRun> {
    catch_core(core::run_code_runtime(input)).await
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
    match payload.downcast_ref::<&'static str>() {
        Some(message) => message,
        None => match payload.downcast_ref::<String>() {
            Some(message) => message.as_str(),
            None => "unknown panic payload",
        },
    }
}

fn to_napi_error(error: core::SandboxError) -> napi::Error {
    let payload = serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    });
    napi::Error::new(napi::Status::GenericFailure, payload.to_string())
}
