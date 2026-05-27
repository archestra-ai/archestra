use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use base64::Engine;
use dagger_sdk::{Config, Container, ContainerWithExecOpts, DaggerConn, ReturnType, connect_opts};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tracing::Span;

mod tracing_ctx;

const SKILL_SANDBOX_ROOT: &str = "/skills";
const SKILL_SANDBOX_HOME: &str = "/home/sandbox";
const SKILL_SANDBOX_USER: &str = "1000:1000";
const TIMEOUT_EXIT_CODE: i32 = 124;
const CODE_RUNTIME_WORKDIR: &str = "/tmp";
const CODE_RUNTIME_SCRIPT_FILE: &str = "main.py";
const CODE_RUNTIME_RUNNER_FILE: &str = "runner.py";
const CODE_RUNTIME_RESULT_FILE: &str = "/tmp/result.json";
const CODE_RUNTIME_VENV_DIR: &str = "/tmp/.venv";
const CODE_RUNTIME_VENV_PYTHON: &str = "/tmp/.venv/bin/python";
const CODE_RUNTIME_NON_ROOT_USER: &str = "1000:1000";
const CODE_RUNTIME_DEFAULT_REQUIREMENTS: [&str; 3] = ["numpy", "pandas", "httpx"];
const ARTIFACT_TOO_LARGE_EXIT_CODE: isize = 65;
const ARTIFACT_NOT_FOUND_EXIT_CODE: isize = 66;

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

    fn engine(error: impl fmt::Display) -> Self {
        Self::EngineUnreachable(error.to_string())
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EngineUnreachable(message) => write!(f, "{message}"),
            Self::ArtifactTooLarge { message, .. } => write!(f, "{message}"),
            Self::ArtifactNotFound { message, .. } => write!(f, "{message}"),
            Self::InvalidInput(message) => write!(f, "{message}"),
            Self::Internal(message) => write!(f, "{message}"),
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
pub struct CheckDaggerSessionInput {
    pub traceparent: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct CheckCodeRuntimeSessionInput {
    pub traceparent: Option<String>,
    pub image: String,
}

// The cross-language contract intentionally sends the full sandbox recipe with
// each request: image, packages, snapshots, replay log, and the command/read
// operation. That keeps the N-API layer stateless and maps directly to a future
// daemon endpoint. If request size or replay latency becomes the bottleneck, the
// next contract should split this into create/cache-by-recipe-hash + exec/read.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct RunSandboxCommandInput {
    pub traceparent: Option<String>,
    pub image: String,
    #[cfg_attr(feature = "napi", napi(js_name = "defaultCwd"))]
    pub default_cwd: String,
    #[cfg_attr(feature = "napi", napi(js_name = "aptPackages"))]
    pub apt_packages: Vec<String>,
    pub snapshots: Vec<SnapshotFile>,
    #[cfg_attr(feature = "napi", napi(js_name = "replayCommands"))]
    pub replay_commands: Vec<ReplayCommand>,
    pub limits: Limits,
    pub command: String,
    pub cwd: String,
    #[cfg_attr(feature = "napi", napi(js_name = "timeoutSeconds"))]
    pub timeout_seconds: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct ReadSandboxArtifactInput {
    pub traceparent: Option<String>,
    pub image: String,
    #[cfg_attr(feature = "napi", napi(js_name = "defaultCwd"))]
    pub default_cwd: String,
    #[cfg_attr(feature = "napi", napi(js_name = "aptPackages"))]
    pub apt_packages: Vec<String>,
    pub snapshots: Vec<SnapshotFile>,
    #[cfg_attr(feature = "napi", napi(js_name = "replayCommands"))]
    pub replay_commands: Vec<ReplayCommand>,
    pub limits: Limits,
    pub path: String,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct CodeRuntimeLimits {
    #[cfg_attr(feature = "napi", napi(js_name = "maxOutputBytes"))]
    pub max_output_bytes: u32,
    #[cfg_attr(feature = "napi", napi(js_name = "maxCpuSeconds"))]
    pub max_cpu_seconds: u32,
    #[cfg_attr(feature = "napi", napi(js_name = "maxMemoryBytes"))]
    pub max_memory_bytes: u32,
    #[cfg_attr(feature = "napi", napi(js_name = "maxProcesses"))]
    pub max_processes: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct RunCodeInput {
    pub traceparent: Option<String>,
    pub image: String,
    #[cfg_attr(feature = "napi", napi(js_name = "runnerScript"))]
    pub runner_script: String,
    pub code: String,
    pub requirements: Vec<String>,
    #[cfg_attr(feature = "napi", napi(js_name = "timeoutSeconds"))]
    pub timeout_seconds: u32,
    pub limits: CodeRuntimeLimits,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[serde(rename_all = "camelCase")]
pub struct CodeRun {
    pub stdout: String,
    pub stderr: String,
    #[cfg_attr(feature = "napi", napi(js_name = "exitCode"))]
    pub exit_code: i32,
    #[cfg_attr(feature = "napi", napi(js_name = "timedOut"))]
    pub timed_out: bool,
    pub truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturedCodeRun {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    truncated: bool,
}

#[derive(Clone)]
struct SandboxSpec {
    image: String,
    default_cwd: String,
    apt_packages: Vec<String>,
    snapshots: Vec<SnapshotFile>,
    replay_commands: Vec<ReplayCommand>,
    limits: Limits,
}

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn check_dagger_session(input: CheckDaggerSessionInput) -> Result<()> {
    with_dagger(input.traceparent.as_deref(), |client| async move {
        client
            .container()
            .from("alpine:latest")
            .sync()
            .await
            .map_err(SandboxError::engine)?;
        Ok(())
    })
    .await
}

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn check_code_runtime_session(input: CheckCodeRuntimeSessionInput) -> Result<()> {
    with_dagger(input.traceparent.as_deref(), move |client| async move {
        warm_code_runtime_base(build_code_runtime_base(&client, &input.image))
            .sync()
            .await
            .map_err(SandboxError::engine)?;
        Ok(())
    })
    .await
}

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn run_sandbox_command(input: RunSandboxCommandInput) -> Result<CommandExecution> {
    let traceparent = input.traceparent.clone();
    let spec = SandboxSpec::from(&input);
    let command = input.command;
    let cwd = input.cwd;
    let timeout_seconds = input.timeout_seconds;
    validate_apt_packages(&spec.apt_packages)?;

    with_dagger(traceparent.as_deref(), move |client| async move {
        let started = Instant::now();
        let materialized = materialize_with_replay(&client, &spec).await?;
        let wrapped = wrap_with_timeout(&command, &cwd, timeout_seconds, &spec.limits);
        let executed = materialized.with_exec_opts(
            vec!["bash".to_string(), "-c".to_string(), wrapped],
            any_exit_opts(),
        );

        let stdout_raw = executed.stdout().await.map_err(SandboxError::engine)?;
        let stderr_raw = executed.stderr().await.map_err(SandboxError::engine)?;
        let exit_code = executed.exit_code().await.map_err(SandboxError::engine)? as i32;
        let stdout = truncate_output(&stdout_raw, output_limit(&spec.limits));
        let stderr = truncate_output(&stderr_raw, output_limit(&spec.limits));

        Ok(CommandExecution {
            stdout: stdout.value,
            stderr: stderr.value,
            exit_code,
            duration_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
            timed_out: exit_code == TIMEOUT_EXIT_CODE,
            truncated: stdout.truncated || stderr.truncated,
        })
    })
    .await
}

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn read_sandbox_artifact(input: ReadSandboxArtifactInput) -> Result<ArtifactBytes> {
    let traceparent = input.traceparent.clone();
    let spec = SandboxSpec::from(&input);
    let path = input.path;
    validate_apt_packages(&spec.apt_packages)?;
    validate_artifact_path(&path)?;

    with_dagger(traceparent.as_deref(), move |client| async move {
        let materialized = materialize_with_replay(&client, &spec).await?;
        let bytes_limit = u64::from(spec.limits.file_size_limit_bytes);
        let command = format!(
            "[ -e {path} ] || {{ echo \"artifact not found: {path}\" >&2; exit {not_found}; }}; _s=$(stat -c '%s' {path}) && [ \"$_s\" -le {limit} ] || {{ echo \"artifact is too large ($_s bytes > {limit})\" >&2; exit {too_large}; }}; base64 -w0 {path}",
            path = shell_quote(&path),
            limit = bytes_limit,
            not_found = ARTIFACT_NOT_FOUND_EXIT_CODE,
            too_large = ARTIFACT_TOO_LARGE_EXIT_CODE,
        );
        let encoder = materialized.with_exec_opts(
            vec!["bash".to_string(), "-c".to_string(), command],
            any_exit_opts(),
        );
        let base64_stdout = encoder.stdout().await.map_err(SandboxError::engine)?;
        let exit_code = encoder.exit_code().await.map_err(SandboxError::engine)?;
        let stderr = encoder.stderr().await.map_err(SandboxError::engine)?;
        match exit_code {
            0 => {}
            ARTIFACT_NOT_FOUND_EXIT_CODE => {
                let message = format_artifact_error("failed to read artifact", &path, &stderr);
                return Err(SandboxError::ArtifactNotFound { path, message });
            }
            ARTIFACT_TOO_LARGE_EXIT_CODE => {
                let message = format_artifact_error("failed to read artifact", &path, &stderr);
                return Err(SandboxError::ArtifactTooLarge { path, message });
            }
            other => {
                return Err(SandboxError::Internal(format!(
                    "failed to read artifact at {}: {}",
                    path,
                    if stderr.trim().is_empty() {
                        format!("exit {other}")
                    } else {
                        stderr.trim().to_string()
                    }
                )));
            }
        }
        let data_base64 = base64_stdout.trim().to_string();
        let data = base64::engine::general_purpose::STANDARD
            .decode(&data_base64)
            .map_err(|error| {
                SandboxError::internal(format!("failed to decode artifact bytes: {error}"))
            })?;
        let size_bytes = data.len().min(u32::MAX as usize) as u32;
        Ok(ArtifactBytes {
            data_base64,
            size_bytes,
        })
    })
    .await
}

#[tracing::instrument(skip_all, fields(traceparent = input.traceparent.as_deref()))]
pub async fn run_code_runtime(input: RunCodeInput) -> Result<CodeRun> {
    let traceparent = input.traceparent.clone();
    with_dagger(traceparent.as_deref(), move |client| async move {
        let mut container = warm_code_runtime_base(build_code_runtime_base(&client, &input.image));

        if !input.requirements.is_empty() {
            let mut args = vec![
                "uv".to_string(),
                "pip".to_string(),
                "install".to_string(),
                "--python".to_string(),
                CODE_RUNTIME_VENV_PYTHON.to_string(),
            ];
            args.extend(input.requirements.iter().cloned());
            let installed = container.with_exec_opts(args, any_exit_opts());
            let exit_code = installed.exit_code().await.map_err(SandboxError::engine)? as i32;
            if exit_code != 0 {
                return Ok(captured_install_failure(
                    exit_code,
                    &installed.stderr().await.map_err(SandboxError::engine)?,
                    input.limits.max_output_bytes as usize,
                ));
            }
            container = installed;
        }

        let runner_args = build_code_runner_args(&input);
        let executed = container
            .with_new_file(
                format!("{CODE_RUNTIME_WORKDIR}/{CODE_RUNTIME_RUNNER_FILE}"),
                input.runner_script,
            )
            .with_new_file(
                format!("{CODE_RUNTIME_WORKDIR}/{CODE_RUNTIME_SCRIPT_FILE}"),
                input.code,
            )
            .with_exec_opts(runner_args, any_exit_opts());

        let raw = executed
            .file(CODE_RUNTIME_RESULT_FILE)
            .contents()
            .await
            .map_err(SandboxError::engine)?;
        let decoded: CapturedCodeRun = serde_json::from_str(&raw).map_err(|error| {
            SandboxError::internal(format!("the code runtime returned invalid JSON: {error}"))
        })?;
        Ok(CodeRun {
            stdout: decoded.stdout,
            stderr: decoded.stderr,
            exit_code: decoded.exit_code,
            timed_out: decoded.timed_out,
            truncated: decoded.truncated,
        })
    })
    .await
}
fn build_code_runtime_base(client: &DaggerConn, image: &str) -> Container {
    client
        .container()
        .from(image)
        .with_workdir(CODE_RUNTIME_WORKDIR)
        .with_user(CODE_RUNTIME_NON_ROOT_USER)
        .with_env_variable("HOME", CODE_RUNTIME_WORKDIR)
}

fn warm_code_runtime_base(container: Container) -> Container {
    container
        .with_exec(vec!["uv", "venv", CODE_RUNTIME_VENV_DIR])
        .with_exec(
            ["uv", "pip", "install", "--python", CODE_RUNTIME_VENV_PYTHON]
                .into_iter()
                .chain(CODE_RUNTIME_DEFAULT_REQUIREMENTS)
                .map(String::from)
                .collect::<Vec<_>>(),
        )
}

fn build_code_runner_args(input: &RunCodeInput) -> Vec<String> {
    vec![
        "python3".to_string(),
        format!("{CODE_RUNTIME_WORKDIR}/{CODE_RUNTIME_RUNNER_FILE}"),
        input.timeout_seconds.to_string(),
        input.limits.max_output_bytes.to_string(),
        input.limits.max_cpu_seconds.to_string(),
        input.limits.max_memory_bytes.to_string(),
        input.limits.max_processes.to_string(),
        CODE_RUNTIME_RESULT_FILE.to_string(),
        CODE_RUNTIME_WORKDIR.to_string(),
        CODE_RUNTIME_VENV_PYTHON.to_string(),
        CODE_RUNTIME_SCRIPT_FILE.to_string(),
    ]
}

fn captured_install_failure(exit_code: i32, stderr: &str, output_limit: usize) -> CodeRun {
    let truncated = stderr.len() > output_limit;
    let stderr = if truncated {
        let mut end = output_limit;
        while !stderr.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n...[output truncated]", &stderr[..end])
    } else {
        stderr.to_string()
    };
    CodeRun {
        stdout: String::new(),
        stderr,
        exit_code,
        timed_out: false,
        truncated,
    }
}

async fn materialize_with_replay(client: &DaggerConn, spec: &SandboxSpec) -> Result<Container> {
    let mut container = materialize(client, spec)?;
    for entry in &spec.replay_commands {
        let cwd = entry.cwd.as_deref().unwrap_or(&spec.default_cwd);
        let wrapped = wrap_with_timeout(&entry.command, cwd, entry.timeout_seconds, &spec.limits);
        container = container.with_exec_opts(
            vec!["bash".to_string(), "-c".to_string(), wrapped],
            any_exit_opts(),
        );
    }
    Ok(container)
}

fn materialize(client: &DaggerConn, spec: &SandboxSpec) -> Result<Container> {
    if spec.snapshots.is_empty() {
        return Err(SandboxError::InvalidInput(
            "sandbox has no file snapshots - recreate the sandbox".to_string(),
        ));
    }

    let mut container = build_base_container(client, spec);
    let mut by_skill: BTreeMap<String, Vec<&SnapshotFile>> = BTreeMap::new();
    for file in &spec.snapshots {
        by_skill
            .entry(file.skill_name.clone())
            .or_default()
            .push(file);
    }

    for (skill_name, files) in by_skill {
        let root = skill_root_path(&skill_name)?;
        for file in files {
            container = apply_snapshot_file(container, &root, file)?;
        }
    }

    Ok(container
        .with_user("root")
        .with_exec(vec![
            "sh".to_string(),
            "-c".to_string(),
            format!("chown -R {SKILL_SANDBOX_USER} {SKILL_SANDBOX_ROOT}"),
        ])
        .with_user(SKILL_SANDBOX_USER))
}

fn build_base_container(client: &DaggerConn, spec: &SandboxSpec) -> Container {
    let packages = spec.apt_packages.join(" ");
    client
        .container()
        .from(&spec.image)
        .with_exec(vec![
            "sh".to_string(),
            "-c".to_string(),
            format!(
                "apt-get update -qq && apt-get install -y --no-install-recommends {packages} && rm -rf /var/lib/apt/lists/* && mkdir -p {SKILL_SANDBOX_HOME} {SKILL_SANDBOX_ROOT} && chown 1000:1000 {SKILL_SANDBOX_HOME} {SKILL_SANDBOX_ROOT}"
            ),
        ])
        .with_user(SKILL_SANDBOX_USER)
        .with_env_variable("HOME", SKILL_SANDBOX_HOME)
        .with_env_variable("SKILL_SANDBOX_ROOT", SKILL_SANDBOX_ROOT)
        .with_workdir(&spec.default_cwd)
}

fn apply_snapshot_file(container: Container, root: &str, file: &SnapshotFile) -> Result<Container> {
    validate_snapshot_file_path(&file.path)?;
    let target = format!("{root}/{}", file.path);
    match file.encoding.as_str() {
        "utf8" => Ok(container.with_new_file(target, &file.content)),
        "base64" => {
            let temp_path = format!("{target}.b64");
            let parent_dir = target
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or(root);
            Ok(container
                .with_new_file(&temp_path, &file.content)
                .with_exec(vec![
                    "bash".to_string(),
                    "-c".to_string(),
                    format!(
                        "mkdir -p {} && base64 -d {} > {} && rm {}",
                        shell_quote(parent_dir),
                        shell_quote(&temp_path),
                        shell_quote(&target),
                        shell_quote(&temp_path),
                    ),
                ]))
        }
        other => Err(SandboxError::InvalidInput(format!(
            "unsupported snapshot encoding: {other}"
        ))),
    }
}

async fn with_dagger<T, F, Fut>(traceparent: Option<&str>, dagger: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(DaggerConn) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T>> + Send + 'static,
{
    let span = Span::current();
    tracing_ctx::attach_parent(&span, traceparent);

    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(std::sync::Mutex::new(Some(sender)));
    let cfg = Config::builder()
        .workdir_path(PathBuf::from("/"))
        .load_workspace_modules(false)
        .build();

    connect_opts(cfg, move |client| async move {
        let value = dagger(client).await;
        if let Ok(mut guard) = sender.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(value);
            }
        }
        Ok(())
    })
    .await
    .map_err(SandboxError::engine)?;

    receiver
        .await
        .map_err(|_| SandboxError::internal("Dagger session closed without a result"))
        .and_then(std::convert::identity)
}

fn any_exit_opts<'a>() -> ContainerWithExecOpts<'a> {
    ContainerWithExecOpts {
        expect: Some(ReturnType::Any),
        expand: None,
        experimental_privileged_nesting: None,
        insecure_root_capabilities: None,
        no_init: None,
        redirect_stderr: None,
        redirect_stdin: None,
        redirect_stdout: None,
        stdin: None,
        use_entrypoint: None,
    }
}

fn wrap_with_timeout(command: &str, cwd: &str, timeout_seconds: u32, limits: &Limits) -> String {
    let file_limit_blocks = u64::from(limits.file_size_limit_bytes).div_ceil(512);
    let memory_kilobytes = u64::from(limits.memory_bytes).div_ceil(1024);
    let output_head_bytes = output_limit(limits) + 1;
    format!(
        "cd {} && _d=$(mktemp -d) || {{ echo 'mktemp failed' >&2; exit 1; }}; ulimit -f {} 2>/dev/null; ulimit -t {} 2>/dev/null; ulimit -v {} 2>/dev/null; ulimit -u {} 2>/dev/null; timeout --signal=KILL {}s bash -c {} >\"$_d/o\" 2>\"$_d/e\"; _x=$?; head -c {} \"$_d/o\"; head -c {} \"$_d/e\" >&2; rm -rf \"$_d\"; exit $_x",
        shell_quote(cwd),
        file_limit_blocks,
        limits.cpu_seconds,
        memory_kilobytes,
        limits.max_processes,
        timeout_seconds,
        shell_quote(command),
        output_head_bytes,
        output_head_bytes,
    )
}

struct TruncatedOutput {
    value: String,
    truncated: bool,
}

fn truncate_output(raw: &str, limit: usize) -> TruncatedOutput {
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

fn validate_snapshot_file_path(path: &str) -> Result<()> {
    match path {
        _ if path.starts_with('/') || path.split('/').any(|segment| segment == "..") => Err(
            SandboxError::InvalidInput(format!("invalid snapshot file path: {path:?}")),
        ),
        _ => Ok(()),
    }
}

fn validate_artifact_path(path: &str) -> Result<()> {
    match path {
        _ if path.contains('\0') || path.split('/').any(|segment| segment == "..") => Err(
            SandboxError::InvalidInput(format!("invalid artifact path: {path:?}")),
        ),
        _ if path.starts_with('/') => {
            let allowed = [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME]
                .iter()
                .any(|root| path == *root || path.starts_with(&format!("{root}/")));
            match allowed {
                true => Ok(()),
                false => Err(SandboxError::InvalidInput(format!(
                    "artifact path must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {path:?}"
                ))),
            }
        }
        _ => Ok(()),
    }
}

fn validate_apt_packages(packages: &[String]) -> Result<()> {
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

fn format_artifact_error(prefix: &str, path: &str, stderr: &str) -> String {
    match stderr.trim() {
        "" => format!("{prefix} at {path}: unknown error"),
        detail => format!("{prefix} at {path}: {detail}"),
    }
}

fn skill_root_path(skill_name: &str) -> Result<String> {
    match skill_name {
        _ if skill_name.contains('/') || skill_name.contains("..") => Err(
            SandboxError::InvalidInput(format!("invalid skill name: {skill_name:?}")),
        ),
        _ => Ok(format!("{SKILL_SANDBOX_ROOT}/{skill_name}")),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn output_limit(limits: &Limits) -> usize {
    limits.output_bytes_limit as usize
}

impl From<&RunSandboxCommandInput> for SandboxSpec {
    fn from(input: &RunSandboxCommandInput) -> Self {
        Self {
            image: input.image.clone(),
            default_cwd: input.default_cwd.clone(),
            apt_packages: input.apt_packages.clone(),
            snapshots: input.snapshots.clone(),
            replay_commands: input.replay_commands.clone(),
            limits: input.limits.clone(),
        }
    }
}

impl From<&ReadSandboxArtifactInput> for SandboxSpec {
    fn from(input: &ReadSandboxArtifactInput) -> Self {
        Self {
            image: input.image.clone(),
            default_cwd: input.default_cwd.clone(),
            apt_packages: input.apt_packages.clone(),
            snapshots: input.snapshots.clone(),
            replay_commands: input.replay_commands.clone(),
            limits: input.limits.clone(),
        }
    }
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
        assert!(wrapped.contains("'python --version'"));
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
}
