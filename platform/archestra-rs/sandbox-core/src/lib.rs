use std::fmt;

use serde::{Deserialize, Serialize};

mod backend;
mod backends;
mod session;
mod supervisor;
pub mod telemetry;
mod tracing_ctx;
mod validation;

use crate::validation::{
    skill_root_path, validate_artifact_path, validate_cwd, validate_file_encoding,
    validate_snapshot_file_path, validate_upload_path,
};

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

/// a file written into the sandbox during replay. unlike [`SnapshotFile`]
/// (relative to a skill root), `path` is absolute and bounded to the sandbox
/// roots — uploads can target the home dir as well as a skill root.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ReplayInputFile {
    pub path: String,
    pub encoding: String,
    pub content: String,
}

/// a skill mounted into the sandbox at its replay sequence point. `files` are
/// the skill's snapshotted files (`path` relative to the skill root); the
/// materialize layer writes them under `/skills/<skill_name>` and extends
/// PYTHONPATH at this point. mounts are append-only, so a mount never changes a
/// prior layer's parent chain (the Dagger layer cache stays warm).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ReplaySkillMount {
    #[cfg_attr(feature = "napi", napi(js_name = "skillName"))]
    pub skill_name: String,
    pub files: Vec<SnapshotFile>,
}

/// a single ordered replay step crossing the NAPI boundary. exactly one of
/// `command` / `file` / `skill_mount` is populated, keyed by `kind`
/// (`"command"` | `"file"` | `"skill_mount"`); the core converts it into the
/// internal [`ReplayStep`] enum at the entry point, where invalid combinations
/// are rejected.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ReplayEntry {
    pub kind: String,
    pub command: Option<ReplayCommand>,
    pub file: Option<ReplayInputFile>,
    #[cfg_attr(feature = "napi", napi(js_name = "skillMount"))]
    pub skill_mount: Option<ReplaySkillMount>,
}

/// internal, fully-typed replay step. constructed only via
/// [`replay_entry_to_step`] so a `ReplayStep::File` always carries a validated
/// path and encoding — the materialize layer can trust it without re-checking.
#[derive(Clone, Debug)]
pub(crate) enum ReplayStep {
    Command(ReplayCommand),
    File(ReplayInputFile),
    SkillMount(ReplaySkillMount),
}

fn replay_entries_to_steps(entries: Vec<ReplayEntry>) -> Result<Vec<ReplayStep>> {
    entries.into_iter().map(replay_entry_to_step).collect()
}

fn replay_entry_to_step(entry: ReplayEntry) -> Result<ReplayStep> {
    match entry.kind.as_str() {
        "command" => entry.command.map(ReplayStep::Command).ok_or_else(|| {
            SandboxError::InvalidInput(
                "replay entry with kind=command is missing its command".to_string(),
            )
        }),
        "file" => {
            let file = entry.file.ok_or_else(|| {
                SandboxError::InvalidInput(
                    "replay entry with kind=file is missing its file".to_string(),
                )
            })?;
            validate_upload_path(&file.path)?;
            validate_file_encoding(&file.encoding)?;
            Ok(ReplayStep::File(file))
        }
        "skill_mount" => {
            let mount = entry.skill_mount.ok_or_else(|| {
                SandboxError::InvalidInput(
                    "replay entry with kind=skill_mount is missing its skillMount".to_string(),
                )
            })?;
            // skill name must form a valid root, and every file must be a
            // traversal-free skill-relative path with a known encoding.
            skill_root_path(&mount.skill_name)?;
            for file in &mount.files {
                validate_snapshot_file_path(&file.path)?;
                validate_file_encoding(&file.encoding)?;
            }
            Ok(ReplayStep::SkillMount(mount))
        }
        other => Err(SandboxError::InvalidInput(format!(
            "unknown replay entry kind: {other:?}"
        ))),
    }
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
    #[cfg_attr(feature = "napi", napi(js_name = "replayEntries"))]
    pub replay_entries: Vec<ReplayEntry>,
    pub limits: Limits,
    pub command: String,
    pub cwd: String,
    #[cfg_attr(feature = "napi", napi(js_name = "timeoutSeconds"))]
    pub timeout_seconds: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactInput {
    pub traceparent: Option<String>,
    #[cfg_attr(feature = "napi", napi(js_name = "replayEntries"))]
    pub replay_entries: Vec<ReplayEntry>,
    pub limits: Limits,
    pub path: String,
    /// the cwd a replayed entry with `cwd: None` should default to. matches
    /// the sandbox's stored `defaultCwd`, so artifact extraction replays in
    /// the same directory as the original commands.
    #[cfg_attr(feature = "napi", napi(js_name = "defaultCwd"))]
    pub default_cwd: String,
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
    let replay_steps = replay_entries_to_steps(input.replay_entries)?;
    let req = backend::RunRequest {
        replay_steps,
        limits: input.limits,
        command: input.command,
        cwd: input.cwd,
        timeout_seconds: input.timeout_seconds,
        traceparent,
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
    let replay_steps = replay_entries_to_steps(input.replay_entries)?;
    let req = backend::ArtifactRequest {
        replay_steps,
        limits: input.limits,
        path: input.path,
        default_cwd: input.default_cwd,
        traceparent,
    };
    session::submit(move |reply| session::SessionMsg::ReadArtifact {
        req: req.clone(),
        reply,
    })
    .await
}
