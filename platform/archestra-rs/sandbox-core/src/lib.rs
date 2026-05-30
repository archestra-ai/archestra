use std::fmt;

use serde::{Deserialize, Serialize};

mod runtime;
mod session;
pub mod telemetry;
mod tracing_ctx;

pub use session::{DEFAULT_APT_PACKAGES, DEFAULT_BASE_IMAGE};

pub(crate) const SKILL_SANDBOX_ROOT: &str = "/skills";
pub(crate) const SKILL_SANDBOX_HOME: &str = "/home/sandbox";
pub(crate) const SKILL_SANDBOX_USER: &str = "1000:1000";
/// path of the command supervisor injected into the warm base via `with_new_file`.
/// it runs each user command under cpu/memory rlimits and a wall-clock timeout,
/// caps output, and emits a structured json result (see `ARCHESTRA_RUN_PY`).
pub(crate) const SUPERVISOR_PATH: &str = "/usr/local/bin/archestra_run";
pub(crate) const ARTIFACT_TOO_LARGE_EXIT_CODE: isize = 65;
pub(crate) const ARTIFACT_NOT_FOUND_EXIT_CODE: isize = 66;

pub type Result<T> = std::result::Result<T, SandboxError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxError {
    EngineUnreachable(String),
    /// A command inside the materialised chain returned non-zero exit and the
    /// dagger SDK refused to honour `expect=Any` (typical for signal-killed
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

impl SandboxError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::EngineUnreachable(_) => "ARCHESTRA_ENGINE_UNREACHABLE",
            Self::CommandFailed { .. } => "ARCHESTRA_COMMAND_FAILED",
            Self::ArtifactTooLarge { .. } => "ARCHESTRA_ARTIFACT_TOO_LARGE",
            Self::ArtifactNotFound { .. } => "ARCHESTRA_ARTIFACT_NOT_FOUND",
            Self::InvalidInput(_) => "ARCHESTRA_INVALID_INPUT",
            Self::Internal(_) => "ARCHESTRA_INTERNAL",
        }
    }

    pub(crate) fn engine(error: impl fmt::Display) -> Self {
        Self::EngineUnreachable(error.to_string())
    }

    /// Categorise an error returned by the dagger SDK during exec evaluation.
    /// SDK errors with an embedded `exit code: N` come from a container exec
    /// that returned non-zero (kill-by-signal counts here too); everything
    /// else is a real transport/engine failure.
    pub(crate) fn from_sdk(error: impl fmt::Display) -> Self {
        let message = error.to_string();
        match parse_sdk_exit_code(&message) {
            Some(exit_code) => Self::CommandFailed { exit_code, message },
            None => Self::EngineUnreachable(message),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

fn parse_sdk_exit_code(message: &str) -> Option<i32> {
    const NEEDLE: &str = "exit code: ";
    let idx = message.find(NEEDLE)?;
    let rest = &message[idx + NEEDLE.len()..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EngineUnreachable(message)
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
    session::submit(move |reply| session::SessionMsg::CheckSession { traceparent, reply }).await
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
    session::submit(move |reply| session::SessionMsg::Run {
        req: session::RunRequest {
            snapshots: input.snapshots,
            replay_commands: input.replay_commands,
            limits: input.limits,
            command: input.command,
            cwd: input.cwd,
            timeout_seconds: input.timeout_seconds,
            traceparent,
            pythonpath: input.pythonpath,
        },
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
    session::submit(move |reply| session::SessionMsg::ReadArtifact {
        req: session::ArtifactRequest {
            snapshots: input.snapshots,
            replay_commands: input.replay_commands,
            limits: input.limits,
            path: input.path,
            default_cwd: input.default_cwd,
            traceparent,
            pythonpath: input.pythonpath,
        },
        reply,
    })
    .await
}

// ============================================================================
// helpers (used by runtime.rs + tests)
// ============================================================================

/// build the argv that runs `command` under the in-container supervisor
/// (`SUPERVISOR_PATH`). the supervisor sets cpu/memory rlimits, enforces the
/// wall-clock timeout by SIGKILLing the whole process group, caps each output
/// stream at `output_bytes_limit` bytes, and prints a json result on stdout.
/// the command itself is handed to `bash -c` so shell syntax still works; cwd
/// is applied separately via `Container::with_workdir`.
pub(crate) fn supervised_argv(command: &str, timeout_seconds: u32, limits: &Limits) -> Vec<String> {
    vec![
        "python3".to_string(),
        SUPERVISOR_PATH.to_string(),
        "--timeout".to_string(),
        timeout_seconds.to_string(),
        "--cpu".to_string(),
        limits.cpu_seconds.to_string(),
        "--mem".to_string(),
        limits.memory_bytes.to_string(),
        "--out-cap".to_string(),
        limits.output_bytes_limit.to_string(),
        "--".to_string(),
        "bash".to_string(),
        "-c".to_string(),
        command.to_string(),
    ]
}

pub(crate) fn validate_snapshot_file_path(path: &str) -> Result<()> {
    match path {
        _ if path.starts_with('/') || path.split('/').any(|segment| segment == "..") => Err(
            SandboxError::InvalidInput(format!("invalid snapshot file path: {path:?}")),
        ),
        _ => Ok(()),
    }
}

pub(crate) fn validate_artifact_path(path: &str) -> Result<()> {
    if path.contains('\0') || path.split('/').any(|segment| segment == "..") {
        return Err(SandboxError::InvalidInput(format!(
            "invalid artifact path: {path:?}"
        )));
    }
    if path
        .chars()
        .any(|ch| matches!(ch, '"' | '$' | '`' | '\\' | '\n' | '\r'))
    {
        return Err(SandboxError::InvalidInput(format!(
            "invalid artifact path: {path:?}"
        )));
    }
    if path.starts_with('/') {
        let allowed = [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME]
            .iter()
            .any(|root| path == *root || path.starts_with(&format!("{root}/")));
        if !allowed {
            return Err(SandboxError::InvalidInput(format!(
                "artifact path must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {path:?}"
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_pythonpath(pythonpath: &str) -> Result<()> {
    // PYTHONPATH is passed straight to `with_env_variable`, but the model can
    // smuggle additional roots via `:` separators; bound each entry to the
    // sandbox-allowed roots so it can't escape into `/etc` etc.
    if pythonpath.is_empty() {
        return Err(SandboxError::InvalidInput(
            "pythonpath must not be empty".to_string(),
        ));
    }
    for entry in pythonpath.split(':') {
        if entry.is_empty()
            || entry.contains('\0')
            || entry.split('/').any(|segment| segment == "..")
        {
            return Err(SandboxError::InvalidInput(format!(
                "invalid pythonpath entry: {entry:?}"
            )));
        }
        if !entry.starts_with('/') {
            return Err(SandboxError::InvalidInput(format!(
                "pythonpath entries must be absolute: {entry:?}"
            )));
        }
        let allowed = [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME]
            .iter()
            .any(|root| entry == *root || entry.starts_with(&format!("{root}/")));
        if !allowed {
            return Err(SandboxError::InvalidInput(format!(
                "pythonpath entries must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {entry:?}"
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_cwd(cwd: &str) -> Result<()> {
    if cwd.contains('\0') || cwd.split('/').any(|segment| segment == "..") {
        return Err(SandboxError::InvalidInput(format!("invalid cwd: {cwd:?}")));
    }
    if !cwd.starts_with('/') {
        return Err(SandboxError::InvalidInput(format!(
            "cwd must be an absolute path: {cwd:?}"
        )));
    }
    let allowed = [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME]
        .iter()
        .any(|root| cwd == *root || cwd.starts_with(&format!("{root}/")));
    if !allowed {
        return Err(SandboxError::InvalidInput(format!(
            "cwd must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {cwd:?}"
        )));
    }
    Ok(())
}

pub(crate) fn format_artifact_error(prefix: &str, path: &str, stderr: &str) -> String {
    match stderr.trim() {
        "" => format!("{prefix} at {path}: unknown error"),
        detail => format!("{prefix} at {path}: {detail}"),
    }
}

pub(crate) fn skill_root_path(skill_name: &str) -> Result<String> {
    match skill_name {
        _ if skill_name.contains('/') || skill_name.contains("..") => Err(
            SandboxError::InvalidInput(format!("invalid skill name: {skill_name:?}")),
        ),
        _ => Ok(format!("{SKILL_SANDBOX_ROOT}/{skill_name}")),
    }
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_single_quotes_and_escapes_quotes() {
        assert_eq!(shell_quote("simple"), "'simple'");
        assert_eq!(shell_quote("a 'b' c"), "'a '\\''b'\\'' c'");
    }

    #[test]
    fn snapshot_path_validation_rejects_traversal_and_absolute_paths() {
        assert!(validate_snapshot_file_path("scripts/run.sh").is_ok());
        assert!(validate_snapshot_file_path("/etc/passwd").is_err());
        assert!(validate_snapshot_file_path("../etc/passwd").is_err());
        assert!(validate_snapshot_file_path("a/../../etc/passwd").is_err());
    }

    #[test]
    fn supervised_argv_builds_supervisor_invocation() {
        let argv = supervised_argv(
            "python --version",
            30,
            &Limits {
                output_bytes_limit: 1024,
                file_size_limit_bytes: 16 * 1024 * 1024,
                cpu_seconds: 30,
                memory_bytes: 1024 * 1024 * 1024,
            },
        );
        assert_eq!(argv[0], "python3");
        assert_eq!(argv[1], SUPERVISOR_PATH);
        // limits are passed as explicit flags, not baked into a shell string.
        assert!(argv.contains(&"--timeout".to_string()));
        assert!(argv.contains(&"30".to_string()));
        assert!(argv.contains(&"--out-cap".to_string()));
        assert!(argv.contains(&"1024".to_string()));
        // the command is handed verbatim to `bash -c` after the `--` separator.
        let sep = argv
            .iter()
            .position(|a| a == "--")
            .expect("missing separator");
        assert_eq!(&argv[sep + 1..], ["bash", "-c", "python --version"]);
    }

    #[test]
    fn from_sdk_parses_exit_code_into_command_failed() {
        let err = SandboxError::from_sdk(
            "process \"/.init bash -c …\" did not complete successfully: exit code: 153",
        );
        assert!(matches!(
            err,
            SandboxError::CommandFailed { exit_code: 153, .. }
        ));
        // a plain transport error stays as EngineUnreachable
        let err = SandboxError::from_sdk("connection refused");
        assert!(matches!(err, SandboxError::EngineUnreachable(_)));
    }

    #[test]
    fn validate_artifact_path_rejects_shell_metacharacters() {
        assert!(validate_artifact_path("/skills/alpha/result.txt").is_ok());
        assert!(validate_artifact_path("/skills/alpha/foo\"bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo$bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo`bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo\\bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo\nbar").is_err());
    }

    #[test]
    fn validate_pythonpath_enforces_sandbox_roots() {
        assert!(validate_pythonpath("/skills/alpha").is_ok());
        assert!(validate_pythonpath("/skills/alpha:/home/sandbox/lib").is_ok());
        assert!(validate_pythonpath("/home/sandbox").is_ok());
        assert!(validate_pythonpath("").is_err());
        assert!(validate_pythonpath("/etc").is_err());
        assert!(validate_pythonpath("relative/path").is_err());
        assert!(validate_pythonpath("/skills/../etc").is_err());
        assert!(validate_pythonpath("/skills/alpha:").is_err());
        assert!(validate_pythonpath("/skills/alpha:/etc").is_err());
    }

    #[test]
    fn validate_cwd_enforces_sandbox_roots() {
        assert!(validate_cwd("/skills/alpha").is_ok());
        assert!(validate_cwd("/home/sandbox").is_ok());
        assert!(validate_cwd("/home/sandbox/work").is_ok());
        assert!(validate_cwd("/etc").is_err());
        assert!(validate_cwd("/proc/self").is_err());
        assert!(validate_cwd("relative/path").is_err());
        assert!(validate_cwd("/skills/../etc").is_err());
    }
}
