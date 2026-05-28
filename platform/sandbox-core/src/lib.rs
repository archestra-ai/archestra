use std::fmt;

use serde::{Deserialize, Serialize};

mod runtime;
mod session;
mod tracing_ctx;

pub use session::{DEFAULT_APT_PACKAGES, DEFAULT_BASE_IMAGE};

pub(crate) const SKILL_SANDBOX_ROOT: &str = "/skills";
pub(crate) const SKILL_SANDBOX_HOME: &str = "/home/sandbox";
pub(crate) const SKILL_SANDBOX_USER: &str = "1000:1000";
pub(crate) const TIMEOUT_EXIT_CODE: i32 = 124;
pub(crate) const ARTIFACT_TOO_LARGE_EXIT_CODE: isize = 65;
pub(crate) const ARTIFACT_NOT_FOUND_EXIT_CODE: isize = 66;
// wrap_with_timeout remaps a user script's literal exit 124 to this sentinel so
// the outer process can distinguish "timeout(1) fired" (true 124) from a script
// that simply exited 124. A user script that explicitly exits 222 will be
// reported as exit 124 (not-timed-out) — acceptable tradeoff.
pub(crate) const USER_EXIT_124_REMAP: i32 = 222;

pub type Result<T> = std::result::Result<T, SandboxError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxError {
    EngineUnreachable(String),
    ArtifactTooLarge { path: String, message: String },
    ArtifactNotFound { path: String, message: String },
    InvalidInput(String),
    Internal(String),
}

impl SandboxError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::EngineUnreachable(_) => "ARCHESTRA_ENGINE_UNREACHABLE",
            Self::ArtifactTooLarge { .. } => "ARCHESTRA_ARTIFACT_TOO_LARGE",
            Self::ArtifactNotFound { .. } => "ARCHESTRA_ARTIFACT_NOT_FOUND",
            Self::InvalidInput(_) => "ARCHESTRA_INVALID_INPUT",
            Self::Internal(_) => "ARCHESTRA_INTERNAL",
        }
    }

    pub(crate) fn engine(error: impl fmt::Display) -> Self {
        Self::EngineUnreachable(error.to_string())
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EngineUnreachable(message)
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
    #[cfg_attr(feature = "napi", napi(js_name = "maxProcesses"))]
    pub max_processes: u32,
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
    /// optional debian packages to install on top of the warm base before this run.
    #[cfg_attr(feature = "napi", napi(js_name = "extraAptPackages"))]
    pub extra_apt_packages: Vec<String>,
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
    #[cfg_attr(feature = "napi", napi(js_name = "extraAptPackages"))]
    pub extra_apt_packages: Vec<String>,
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

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn check_session(input: CheckSessionInput) -> Result<()> {
    session::submit(|reply| session::SessionMsg::CheckSession {
        traceparent: input.traceparent,
        reply,
    })
    .await
}

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn run_sandbox(input: RunSandboxInput) -> Result<CommandExecution> {
    let traceparent = input.traceparent.clone();
    validate_apt_packages(&input.extra_apt_packages)?;
    validate_cwd(&input.cwd)?;
    session::submit(move |reply| session::SessionMsg::Run {
        req: session::RunRequest {
            snapshots: input.snapshots,
            replay_commands: input.replay_commands,
            limits: input.limits,
            command: input.command,
            cwd: input.cwd,
            timeout_seconds: input.timeout_seconds,
            extra_apt_packages: input.extra_apt_packages,
            traceparent,
        },
        reply,
    })
    .await
}

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn read_artifact(input: ReadArtifactInput) -> Result<ArtifactBytes> {
    let traceparent = input.traceparent.clone();
    validate_apt_packages(&input.extra_apt_packages)?;
    validate_artifact_path(&input.path)?;
    session::submit(move |reply| session::SessionMsg::ReadArtifact {
        req: session::ArtifactRequest {
            snapshots: input.snapshots,
            replay_commands: input.replay_commands,
            limits: input.limits,
            path: input.path,
            extra_apt_packages: input.extra_apt_packages,
            traceparent,
        },
        reply,
    })
    .await
}

// ============================================================================
// helpers (used by runtime.rs + tests)
// ============================================================================

pub(crate) fn wrap_with_timeout(
    command: &str,
    cwd: &str,
    timeout_seconds: u32,
    limits: &Limits,
) -> String {
    let file_limit_blocks = u64::from(limits.file_size_limit_bytes).div_ceil(512);
    let memory_kilobytes = u64::from(limits.memory_bytes).div_ceil(1024);
    let output_head_bytes = (limits.output_bytes_limit as usize) + 1;
    let user_wrapped = format!(
        "{}; _i=$?; if [ $_i -eq {} ]; then exit {}; else exit $_i; fi",
        command, TIMEOUT_EXIT_CODE, USER_EXIT_124_REMAP,
    );
    format!(
        "cd {} && _d=$(mktemp -d) || {{ echo 'mktemp failed' >&2; exit 1; }}; ulimit -f {} 2>/dev/null; ulimit -t {} 2>/dev/null; ulimit -v {} 2>/dev/null; ulimit -u {} 2>/dev/null; timeout --signal=KILL {}s bash -c {} >\"$_d/o\" 2>\"$_d/e\"; _x=$?; head -c {} \"$_d/o\"; head -c {} \"$_d/e\" >&2; rm -rf \"$_d\"; exit $_x",
        shell_quote(cwd),
        file_limit_blocks,
        limits.cpu_seconds,
        memory_kilobytes,
        limits.max_processes,
        timeout_seconds,
        shell_quote(&user_wrapped),
        output_head_bytes,
        output_head_bytes,
    )
}

pub(crate) struct TruncatedOutput {
    pub value: String,
    pub truncated: bool,
}

pub(crate) fn truncate_output(raw: &str, limit: usize) -> TruncatedOutput {
    if raw.len() <= limit {
        return TruncatedOutput {
            value: raw.to_string(),
            truncated: false,
        };
    }
    let mut end = limit;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    TruncatedOutput {
        value: format!("{}\n...[output truncated]", &raw[..end]),
        truncated: true,
    }
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

pub(crate) fn validate_apt_packages(packages: &[String]) -> Result<()> {
    packages
        .iter()
        .try_for_each(|package| validate_apt_package_name(package))
}

fn validate_apt_package_name(package: &str) -> Result<()> {
    match package {
        "" => Err(SandboxError::InvalidInput(
            "apt package name must be non-empty".to_string(),
        )),
        _ if package.chars().all(is_valid_apt_package_char) => Ok(()),
        _ => Err(SandboxError::InvalidInput(format!(
            "invalid apt package name: {package:?}"
        ))),
    }
}

fn is_valid_apt_package_char(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '+' | '-')
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
    fn apt_package_validation_rejects_shell_metacharacters() {
        assert!(validate_apt_package_name("ca-certificates").is_ok());
        assert!(validate_apt_package_name("libssl3").is_ok());
        assert!(validate_apt_package_name("bash;curl").is_err());
        assert!(validate_apt_package_name("curl evil").is_err());
        assert!(validate_apt_package_name("").is_err());
    }

    #[test]
    fn wrap_uses_timeout_and_preserves_exit_code() {
        let wrapped = wrap_with_timeout(
            "python --version",
            "/skills/alpha",
            30,
            &Limits {
                output_bytes_limit: 1024,
                file_size_limit_bytes: 16 * 1024 * 1024,
                cpu_seconds: 30,
                memory_bytes: 1024 * 1024 * 1024,
                max_processes: 256,
            },
        );
        assert!(wrapped.contains("cd '/skills/alpha'"));
        assert!(wrapped.contains("timeout --signal=KILL 30s"));
        assert!(wrapped.contains("python --version"));
        assert!(wrapped.contains("if [ $_i -eq 124 ]; then exit 222"));
        assert!(wrapped.contains("head -c 1025"));
        assert!(wrapped.contains("exit $_x"));
    }

    #[test]
    fn truncate_marks_oversized_output() {
        let result = truncate_output("0123456789", 5);
        assert!(result.truncated);
        assert!(result.value.starts_with("01234"));
        assert!(result.value.contains("output truncated"));
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
