use std::fmt;

use serde::{Deserialize, Serialize};

mod backend;
mod backends;
mod session;
mod supervisor;
pub mod telemetry;
mod tracing_ctx;
mod validation;

use crate::validation::{validate_artifact_path, validate_cwd, validate_pythonpath};

pub use backends::dagger::{DEFAULT_APT_PACKAGES, DEFAULT_BASE_IMAGE};

pub type Result<T> = std::result::Result<T, SandboxError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxError {
    /// an engine/transport-level failure. `fault` refines *how* the session
    /// broke so the session layer can choose a retry policy without inspecting
    /// the message text.
    EngineUnreachable {
        message: String,
        fault: EngineFault,
    },
    /// A command inside the materialised chain returned non-zero exit and the
    /// backend refused to honour "any exit code" (typical for signal-killed
    /// processes, e.g. SIGXFSZ → exit 153). Distinct from `EngineUnreachable`
    /// so adapters can surface "command exited N" instead of "engine down".
    CommandFailed {
        exit_code: i32,
        message: String,
    },
    ArtifactTooLarge {
        path: String,
        message: String,
    },
    ArtifactNotFound {
        path: String,
        message: String,
    },
    InvalidInput(String),
    Internal(String),
}

/// refines an [`SandboxError::EngineUnreachable`] with the specific way the
/// engine session broke. backends classify the fault at their error boundary;
/// the session layer matches on it instead of grepping the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineFault {
    /// a generic transport/engine failure: unreachable, timed out, or an error
    /// we can't refine further.
    Unreachable,
    /// the engine accepted `/query` but couldn't find this client's session
    /// attachables. the query never ran, so a fresh session recovers it safely
    /// even for command-executing operations.
    StaleAttachables,
}

impl SandboxError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::EngineUnreachable { .. } => "ARCHESTRA_ENGINE_UNREACHABLE",
            Self::CommandFailed { .. } => "ARCHESTRA_COMMAND_FAILED",
            Self::ArtifactTooLarge { .. } => "ARCHESTRA_ARTIFACT_TOO_LARGE",
            Self::ArtifactNotFound { .. } => "ARCHESTRA_ARTIFACT_NOT_FOUND",
            Self::InvalidInput(_) => "ARCHESTRA_INVALID_INPUT",
            Self::Internal(_) => "ARCHESTRA_INTERNAL",
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EngineUnreachable { message, .. }
            | Self::CommandFailed { message, .. }
            | Self::ArtifactTooLarge { message, .. }
            | Self::ArtifactNotFound { message, .. }
            | Self::InvalidInput(message)
            | Self::Internal(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SandboxError {}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    #[cfg_attr(feature = "napi", napi(js_name = "skillName"))]
    pub skill_name: String,
    pub path: String,
    pub encoding: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ReplayCommand {
    pub command: String,
    pub cwd: Option<String>,
    #[cfg_attr(feature = "napi", napi(js_name = "timeoutSeconds"))]
    pub timeout_seconds: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[cfg_attr(feature = "napi", napi(js_name = "outputBytesLimit"))]
    pub output_bytes_limit: u32,
    #[cfg_attr(feature = "napi", napi(js_name = "fileSizeLimitBytes"))]
    pub file_size_limit_bytes: u32,
    #[cfg_attr(feature = "napi", napi(js_name = "cpuSeconds"))]
    pub cpu_seconds: u32,
    #[cfg_attr(feature = "napi", napi(js_name = "memoryBytes"))]
    pub memory_bytes: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct CheckSessionInput {
    pub traceparent: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct RunSandboxInput {
    pub traceparent: Option<String>,
    pub snapshots: Vec<SnapshotFile>,
    #[cfg_attr(feature = "napi", napi(js_name = "replayCommands"))]
    pub replay_commands: Vec<ReplayCommand>,
    pub limits: Limits,
    pub command: String,
    pub cwd: String,
    #[cfg_attr(feature = "napi", napi(js_name = "timeoutSeconds"))]
    pub timeout_seconds: u32,
    /// PYTHONPATH applied to the materialized container. Lets skill modules
    /// (`/skills/<name>`) resolve via `import` from any cwd.
    pub pythonpath: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactInput {
    pub traceparent: Option<String>,
    pub snapshots: Vec<SnapshotFile>,
    #[cfg_attr(feature = "napi", napi(js_name = "replayCommands"))]
    pub replay_commands: Vec<ReplayCommand>,
    pub limits: Limits,
    pub path: String,
    /// the cwd a replayed entry with `cwd: None` should default to. matches
    /// the sandbox's stored `defaultCwd`, so artifact extraction replays in
    /// the same directory as the original commands.
    #[cfg_attr(feature = "napi", napi(js_name = "defaultCwd"))]
    pub default_cwd: String,
    /// PYTHONPATH applied during the replay used to read the artifact. Should
    /// match what was set on the original runs so imports resolve identically.
    pub pythonpath: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct CommandExecution {
    pub stdout: String,
    pub stderr: String,
    #[cfg_attr(feature = "napi", napi(js_name = "exitCode"))]
    pub exit_code: i32,
    #[cfg_attr(feature = "napi", napi(js_name = "durationMs"))]
    pub duration_ms: u32,
    #[cfg_attr(feature = "napi", napi(js_name = "timedOut"))]
    pub timed_out: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBytes {
    #[cfg_attr(feature = "napi", napi(js_name = "dataBase64"))]
    pub data_base64: String,
    #[cfg_attr(feature = "napi", napi(js_name = "sizeBytes"))]
    pub size_bytes: u32,
}

#[tracing::instrument(name = "sandbox.check_session.request", skip_all)]
pub async fn check_session(input: CheckSessionInput) -> Result<()> {
    let span = tracing::Span::current();
    tracing_ctx::attach_parent(&span, input.traceparent.as_deref());
    let traceparent = tracing_ctx::current_traceparent(&span).or(input.traceparent);
    session::submit(move |reply| session::SessionMsg::CheckSession {
        traceparent: traceparent.clone(),
        reply,
    })
    .await
}

#[tracing::instrument(
    name = "sandbox.run.request",
    skip_all,
    fields(cwd = %input.cwd, command.len = input.command.len())
)]
pub async fn run_sandbox(input: RunSandboxInput) -> Result<CommandExecution> {
    let span = tracing::Span::current();
    tracing_ctx::attach_parent(&span, input.traceparent.as_deref());
    // forward this request span as the work span's parent so the detached work
    // nests under it; fall back to the caller traceparent when otel is inactive.
    let traceparent = tracing_ctx::current_traceparent(&span).or_else(|| input.traceparent.clone());
    validate_cwd(&input.cwd)?;
    if let Some(pp) = input.pythonpath.as_deref() {
        validate_pythonpath(pp)?;
    }
    let req = backend::RunRequest {
        snapshots: input.snapshots,
        replay_commands: input.replay_commands,
        limits: input.limits,
        command: input.command,
        cwd: input.cwd,
        timeout_seconds: input.timeout_seconds,
        traceparent,
        pythonpath: input.pythonpath,
    };
    session::submit(move |reply| session::SessionMsg::Run {
        req: req.clone(),
        reply,
    })
    .await
}

#[tracing::instrument(name = "sandbox.read_artifact.request", skip_all, fields(path = %input.path))]
pub async fn read_artifact(input: ReadArtifactInput) -> Result<ArtifactBytes> {
    let span = tracing::Span::current();
    tracing_ctx::attach_parent(&span, input.traceparent.as_deref());
    let traceparent = tracing_ctx::current_traceparent(&span).or_else(|| input.traceparent.clone());
    validate_artifact_path(&input.path)?;
    validate_cwd(&input.default_cwd)?;
    if let Some(pp) = input.pythonpath.as_deref() {
        validate_pythonpath(pp)?;
    }
    let req = backend::ArtifactRequest {
        snapshots: input.snapshots,
        replay_commands: input.replay_commands,
        limits: input.limits,
        path: input.path,
        default_cwd: input.default_cwd,
        traceparent,
        pythonpath: input.pythonpath,
    };
    session::submit(move |reply| session::SessionMsg::ReadArtifact {
        req: req.clone(),
        reply,
    })
    .await
}
