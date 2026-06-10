//! the Dagger backend: connects to a Dagger engine, warms a base image once per
//! session, and materialises each request into a content-addressed container
//! chain. all `dagger_sdk` usage is contained in this module.

use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use dagger_sdk::core::gql_client::GraphQlExtension;
use dagger_sdk::core::graphql_client::GraphQLError;
use dagger_sdk::errors::DaggerError;
use dagger_sdk::{
    Config, Container, ContainerWithExecOpts, ContainerWithNewFileOpts, DaggerConn, ReturnType,
    connect_opts,
};
use tokio::sync::{OnceCell, mpsc, oneshot};
use tracing::Span;

use crate::backend::{ArtifactRequest, Backend, RunRequest, SandboxBackend};
use crate::session::{self, CHANNEL_CAPACITY, SessionHandle, SessionMsg};
use crate::supervisor::{
    ARCHESTRA_RUN_PY, SUPERVISOR_PATH, parse_supervisor_output, supervised_argv,
};
use crate::validation::{
    SKILL_SANDBOX_HOME, SKILL_SANDBOX_ROOT, SKILL_SANDBOX_USER, format_artifact_error, shell_quote,
    skill_root_path, validate_artifact_path, validate_cwd, validate_snapshot_file_path,
};
use crate::{
    ArtifactBytes, CommandExecution, EngineFault, ReplayInputFile, ReplayStep, Result,
    SandboxError, SnapshotFile,
};

/// debian + python + uv + node + npm + common cli, warmed once per process.
/// override with `ARCHESTRA_DAGGER_RUNTIME_IMAGE` for a custom debian-based base.
pub const DEFAULT_BASE_IMAGE: &str = "ghcr.io/astral-sh/uv:0.9.17-python3.12-bookworm-slim";

/// layered on top of the base on first warm; the toolbelt every sandbox can rely on.
pub const DEFAULT_APT_PACKAGES: &[&str] = &[
    "bash",
    "coreutils",
    "curl",
    "git",
    "jq",
    "ca-certificates",
    "build-essential",
    "nodejs",
    "npm",
];

/// venv pre-baked into the warm base, owned by the sandbox user; reused by every
/// `python3` command so per-call uv installs are layered on (fast) instead of
/// recreated (slow). MUST stay at the uv project's default location
/// (`{SKILL_SANDBOX_HOME}/.venv`): `uv add` targets the project venv while
/// `python3` follows `VIRTUAL_ENV`/PATH, so a different path would silently
/// split the two interpreters.
const DEFAULT_VENV_DIR: &str = "/home/sandbox/.venv";
const DEFAULT_PYTHON_REQUIREMENTS: &[&str] = &["numpy", "pandas", "httpx"];

const SESSION_READY_TIMEOUT: Duration = Duration::from_secs(60);
/// the dagger SDK message emitted when the engine accepted `/query` but timed
/// out waiting for this client's session attachables. see [`classify_engine_fault`].
const SESSION_ATTACHABLES_WAIT_ERROR: &str = "waiting for client session attachables";

const ARTIFACT_TOO_LARGE_EXIT_CODE: isize = 65;
const ARTIFACT_NOT_FOUND_EXIT_CODE: isize = 66;

/// shell snippet baked into the warm base: writes a `pip` shim that redirects
/// to uv and aliases `pip3`/`pip3.12` to the same shim. we `rm -f` first
/// because the upstream uv-python image ships `pip` as a symlink to `pip3`,
/// so a naive `> /usr/local/bin/pip` would follow the symlink and write to
/// `pip3` instead — and the follow-up `cp pip pip3` would refuse with
/// "are the same file". kept as a const so it shows up verbatim in build
/// logs and survives `cargo fmt`.
const PIP_SHIM_SETUP: &str = "rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12 && printf '%s\\n' '#!/bin/sh' 'echo \"error: pip is disabled in this sandbox. Use \\\"uv add --project /home/sandbox <pkg>\\\" instead.\" >&2' 'exit 1' > /usr/local/bin/pip && chmod +x /usr/local/bin/pip && ln -s pip /usr/local/bin/pip3 && ln -s pip /usr/local/bin/pip3.12";

/// minimal uv project written into the sandbox home so `uv add <pkg>` works:
/// uv refuses to add to a non-project ("No `pyproject.toml` found"), and the
/// project's default `.venv` is exactly `DEFAULT_VENV_DIR`. model installs via
/// `uv add` and skill `requirements.txt` installs (also `uv add --project … -r`)
/// therefore land in the same interpreter that `python3` resolves to.
const PYPROJECT_SETUP: &str = "printf '[project]\\nname = \"sandbox\"\\nversion = \"0.0.0\"\\nrequires-python = \">=3.12\"\\n' > pyproject.toml";

/// the Dagger engine connection plus its lazily-warmed base image. one per
/// session; cloned `DaggerConn` handles are cheap (an Arc internally).
pub(crate) struct DaggerBackend {
    client: DaggerConn,
    warm: OnceCell<Container>,
}

impl DaggerBackend {
    async fn ensure_warm(&self) -> Result<Container> {
        let container = self
            .warm
            .get_or_try_init(|| async { build_warm_base(&self.client).await })
            .await?;
        Ok(container.clone())
    }
}

impl SandboxBackend for DaggerBackend {
    #[tracing::instrument(
        name = "sandbox.run",
        skip_all,
        fields(
            cwd = %req.cwd,
            command.len = req.command.len(),
            replay.len = req.replay_steps.len(),
            timeout_s = req.timeout_seconds,
            exit_code = tracing::field::Empty,
            duration_ms = tracing::field::Empty,
            timed_out = tracing::field::Empty,
            truncated = tracing::field::Empty,
        )
    )]
    async fn run(&self, req: RunRequest) -> Result<CommandExecution> {
        // parent this span under the caller's trace (work runs in a detached
        // actor task, so the W3C traceparent is the only link back to the TS
        // span).
        attach_trace(req.traceparent.as_deref());
        validate_cwd(&req.cwd)?;

        let warm = self.ensure_warm().await?;
        let materialized = materialize(&self.client, warm, &req).await?;

        let argv = supervised_argv(&req.command, req.timeout_seconds, &req.limits);
        let executed = materialized
            .with_workdir(&req.cwd)
            .with_exec_opts(argv, any_exit_opts());

        // the supervisor caps output at the source and reports timeout / exit
        // code / per-stream truncation / command-only duration in one json
        // document on its stdout, so the only thing crossing the GraphQL
        // boundary is bounded json.
        let raw = executed.stdout().await.map_err(from_sdk)?;
        let execution = parse_supervisor_output(&raw)?;

        let span = Span::current();
        span.record("exit_code", execution.exit_code);
        span.record("duration_ms", execution.duration_ms);
        span.record("timed_out", execution.timed_out);
        span.record("truncated", execution.truncated);

        Ok(execution)
    }

    #[tracing::instrument(
        name = "sandbox.read_artifact",
        skip_all,
        fields(
            path = %req.path,
            replay.len = req.replay_steps.len(),
            size_bytes = tracing::field::Empty,
        )
    )]
    async fn read_artifact(&self, req: ArtifactRequest) -> Result<ArtifactBytes> {
        attach_trace(req.traceparent.as_deref());
        validate_artifact_path(&req.path)?;

        let warm = self.ensure_warm().await?;
        // replay must use the same cwd as the original run, otherwise commands
        // recorded with `cwd: None` materialise in the wrong directory and
        // subsequent artifact reads can't find their files. skill mounts in the
        // replay log re-apply their files and re-extend PYTHONPATH at their
        // sequence point, so module imports resolve identically to the live run.
        let run = RunRequest {
            replay_steps: req.replay_steps,
            limits: req.limits.clone(),
            command: String::new(),
            cwd: req.default_cwd,
            timeout_seconds: 0,
            traceparent: None,
        };
        let materialized = materialize(&self.client, warm, &run).await?;
        let bytes_limit = u64::from(req.limits.file_size_limit_bytes);
        let command = format!(
            "[ -e {path} ] || {{ echo 'artifact not found: {path}' >&2; exit {not_found}; }}; _s=$(stat -c '%s' {path}) && [ \"$_s\" -le {limit} ] || {{ echo 'artifact is too large' >&2; exit {too_large}; }}; base64 -w0 {path}",
            path = shell_quote(&req.path),
            limit = bytes_limit,
            not_found = ARTIFACT_NOT_FOUND_EXIT_CODE,
            too_large = ARTIFACT_TOO_LARGE_EXIT_CODE,
        );
        let encoder = materialized.with_exec_opts(
            vec!["bash".to_string(), "-c".to_string(), command],
            any_exit_opts(),
        );

        let base64_stdout = encoder.stdout().await.map_err(from_sdk)?;
        let exit_code = encoder.exit_code().await.map_err(from_sdk)?;
        let stderr = encoder.stderr().await.map_err(from_sdk)?;

        match exit_code {
            0 => {}
            ARTIFACT_NOT_FOUND_EXIT_CODE => {
                let message = format_artifact_error("failed to read artifact", &req.path, &stderr);
                return Err(SandboxError::ArtifactNotFound {
                    path: req.path,
                    message,
                });
            }
            ARTIFACT_TOO_LARGE_EXIT_CODE => {
                let message = format_artifact_error("failed to read artifact", &req.path, &stderr);
                return Err(SandboxError::ArtifactTooLarge {
                    path: req.path,
                    message,
                });
            }
            other => {
                return Err(SandboxError::Internal(format!(
                    "failed to read artifact at {}: {}",
                    req.path,
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
            .map_err(|e| SandboxError::internal(format!("failed to decode artifact bytes: {e}")))?;
        let size_bytes = data.len().min(u32::MAX as usize) as u32;
        Span::current().record("size_bytes", size_bytes);
        Ok(ArtifactBytes {
            data_base64,
            size_bytes,
        })
    }

    #[tracing::instrument(name = "sandbox.check_session", skip_all)]
    async fn check_session(&self, traceparent: Option<String>) -> Result<()> {
        attach_trace(traceparent.as_deref());
        // ensure_warm covers the engine-reachable + base-image-buildable invariant.
        let _ = self.ensure_warm().await?;
        self.client.version().await.map_err(from_sdk)?;
        Ok(())
    }

    async fn prewarm(&self) {
        let _ = self.ensure_warm().await;
    }
}

/// connect to the Dagger engine and drive the generic actor loop for the
/// connection's lifetime. this is the one place the Dagger backend is selected.
pub(crate) async fn spawn() -> Result<Arc<SessionHandle>> {
    tracing::info!("spawning dagger session");
    let (msg_tx, msg_rx) = mpsc::channel::<SessionMsg>(CHANNEL_CAPACITY);
    let (ready_tx, ready_rx) = oneshot::channel::<()>();
    let (fail_tx, fail_rx) = oneshot::channel::<SandboxError>();

    tokio::spawn(async move {
        let cfg = Config::builder()
            .workdir_path(PathBuf::from("/"))
            .load_workspace_modules(false)
            .build();
        let mut ready_tx = Some(ready_tx);
        let mut fail_tx = Some(fail_tx);
        let result = connect_opts(cfg, move |client| async move {
            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(());
            }
            let backend = Arc::new(Backend::Dagger(DaggerBackend {
                client,
                warm: OnceCell::new(),
            }));
            session::run_loop(backend, msg_rx).await;
            Ok(())
        })
        .await;
        if let Err(err) = result
            && let Some(tx) = fail_tx.take()
        {
            // a `ConnectError` is a connection/shutdown failure, never a
            // per-session attachables timeout, so it is always plain unreachable.
            let _ = tx.send(SandboxError::EngineUnreachable {
                message: err.to_string(),
                fault: EngineFault::Unreachable,
            });
        }
    });

    tokio::select! {
        ready = ready_rx => match ready {
            Ok(()) => {
                tracing::info!("dagger session ready");
                Ok(Arc::new(SessionHandle::new(msg_tx)))
            }
            Err(_) => Err(SandboxError::EngineUnreachable {
                message: "the Dagger session task exited before reporting ready".to_string(),
                fault: EngineFault::Unreachable,
            }),
        },
        failure = fail_rx => match failure {
            Ok(err) => Err(err),
            Err(_) => Err(SandboxError::EngineUnreachable {
                message: "the Dagger session failed without a diagnostic".to_string(),
                fault: EngineFault::Unreachable,
            }),
        },
        _ = tokio::time::sleep(SESSION_READY_TIMEOUT) => Err(SandboxError::EngineUnreachable {
            message: format!("the Dagger session did not become ready within {}s", SESSION_READY_TIMEOUT.as_secs()),
            fault: EngineFault::Unreachable,
        }),
    }
}

/// warm-base user-setup command: scaffold the uv project, create the venv at
/// `DEFAULT_VENV_DIR`, and seed defaults via `uv add`. runs from the home dir so
/// uv discovers the freshly written `pyproject.toml`. pure so the scaffolding
/// stays under test without a live engine.
fn warm_base_user_setup(py_requirements: &str) -> String {
    format!(
        "cd {SKILL_SANDBOX_HOME} && {PYPROJECT_SETUP} && uv venv --python python3 {DEFAULT_VENV_DIR} && uv add {py_requirements}"
    )
}

#[tracing::instrument(name = "sandbox.warm_base.build", skip_all, fields(image = tracing::field::Empty))]
async fn build_warm_base(client: &DaggerConn) -> Result<Container> {
    let image = env::var("ARCHESTRA_DAGGER_RUNTIME_IMAGE")
        .unwrap_or_else(|_| DEFAULT_BASE_IMAGE.to_string());
    tracing::Span::current().record("image", image.as_str());
    tracing::info!(%image, "building warm base image");
    let apt_packages = DEFAULT_APT_PACKAGES.join(" ");
    let py_requirements = DEFAULT_PYTHON_REQUIREMENTS.join(" ");

    // root setup: apt packages + sandbox dirs + ownership + pip shim. the shim
    // redirects any `pip` invocation to uv so the model is never tempted to
    // install into ~/.local (which the venv python won't see). `uv pip` is
    // unaffected because it's a subcommand of `uv`, not a separate binary.
    let root_setup = format!(
        "apt-get update -qq && apt-get install -y --no-install-recommends {apt_packages} && rm -rf /var/lib/apt/lists/* && mkdir -p {SKILL_SANDBOX_HOME} {SKILL_SANDBOX_ROOT} && chown -R 1000:1000 {SKILL_SANDBOX_HOME} {SKILL_SANDBOX_ROOT} && {PIP_SHIM_SETUP}"
    );
    // user setup: scaffold the uv project, create the venv, seed default
    // packages with `uv add` (same path the model uses), owned by sandbox user.
    let user_setup = warm_base_user_setup(&py_requirements);
    client
        .container()
        .from(&image)
        .with_exec(vec!["sh".to_string(), "-c".to_string(), root_setup])
        // written as root (0755) so every materialised container inherits a
        // world-readable, executable supervisor without a per-call layer.
        .with_new_file_opts(
            SUPERVISOR_PATH,
            ARCHESTRA_RUN_PY,
            ContainerWithNewFileOpts {
                permissions: Some(0o755),
                owner: None,
                expand: None,
            },
        )
        .with_user(SKILL_SANDBOX_USER)
        .with_env_variable("HOME", SKILL_SANDBOX_HOME)
        .with_env_variable("SKILL_SANDBOX_ROOT", SKILL_SANDBOX_ROOT)
        .with_env_variable("VIRTUAL_ENV", DEFAULT_VENV_DIR)
        .with_env_variable("PATH", format!("{DEFAULT_VENV_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"))
        .with_exec(vec!["sh".to_string(), "-c".to_string(), user_setup])
        .sync()
        .await
        .map_err(engine)
        .map(|id| client.load_container_from_id(id))
        .inspect(|_| tracing::info!("warm base image ready"))
        .inspect_err(|err| tracing::warn!(error = %err, "warm base image build failed"))
}

/// dagger builds one lazily-chained GraphQL query whose response nests one
/// JSON level per chained call, and the SDK's serde_json parser refuses to
/// recurse past 128 levels. resolving the chain to a container id (`sync`) and
/// re-loading it flat every `CHECKPOINT_CHAIN_LINKS` calls bounds every
/// query/response regardless of replay-log length — the same flattening the
/// warm base already gets from its `sync()` in [`build_warm_base`]. the layer
/// cache is content-addressed, so an unchanged replay prefix stays cached
/// across checkpoints.
const CHECKPOINT_CHAIN_LINKS: usize = 64;

/// chained calls appended per replayed command: `with_workdir` + `with_exec`.
const COMMAND_CHAIN_LINKS: usize = 2;
/// chained calls appended per replayed upload in [`apply_upload_file`]:
/// `with_user` + `with_new_file` + `with_exec` + `with_user`.
const UPLOAD_CHAIN_LINKS: usize = 4;
/// chained calls appended by a skill mount's chown step:
/// `with_user` + `with_exec` + `with_user`.
const SKILL_MOUNT_CHOWN_CHAIN_LINKS: usize = 3;

/// chained calls appended per skill snapshot file in [`apply_snapshot_file`].
fn snapshot_chain_links(encoding: &str) -> usize {
    match encoding {
        "utf8" => 1,
        // base64 stages the bytes with `with_new_file` then decodes via
        // `with_exec`.
        _ => 2,
    }
}

/// accumulates chained-call counts during replay and signals when the chain is
/// due for a checkpoint.
struct ChainBudget {
    links: usize,
}

impl ChainBudget {
    fn new() -> Self {
        Self { links: 0 }
    }

    /// records `links` chained calls; returns true (and restarts the count)
    /// when the accumulated chain is due for a checkpoint.
    fn charge(&mut self, links: usize) -> bool {
        self.links += links;
        if self.links >= CHECKPOINT_CHAIN_LINKS {
            self.links = 0;
            true
        } else {
            false
        }
    }
}

/// resolve the lazy chain to an id and re-load it so subsequent calls start a
/// fresh, flat query.
async fn checkpoint(client: &DaggerConn, container: Container) -> Result<Container> {
    container
        .sync()
        .await
        .map_err(from_sdk)
        .map(|id| client.load_container_from_id(id))
}

#[tracing::instrument(
    name = "sandbox.materialize",
    skip_all,
    fields(replay.len = req.replay_steps.len())
)]
async fn materialize(client: &DaggerConn, warm: Container, req: &RunRequest) -> Result<Container> {
    let mut container = warm;
    let mut budget = ChainBudget::new();

    // replay re-applies every prior step on each call (commands re-execute,
    // uploads re-write their bytes, skill mounts re-write their files and extend
    // PYTHONPATH): per-call cost is O(history). we lean on Dagger's
    // content-addressed layer cache to keep the wall-clock cost near-zero when
    // the prefix is unchanged. mounts are append-only, so activating a skill
    // mid-conversation never changes a prior layer's parent — the cache holds.
    //
    // replay steps are historical data, validated when first accepted; trusting
    // them here keeps the log replayable. Live `req.cwd` is validated at the
    // entry points; upload/mount paths and encodings are re-validated when the
    // entry is converted to a `ReplayStep`.
    let mut pythonpath_entries: Vec<String> = Vec::new();
    for (index, step) in req.replay_steps.iter().enumerate() {
        match step {
            ReplayStep::Command(entry) => {
                // each command is wrapped with its own `with_workdir` so cwd
                // switches happen via Dagger's container layer (no shell `cd`).
                let cwd = entry.cwd.as_deref().unwrap_or(&req.cwd);
                let argv = supervised_argv(&entry.command, entry.timeout_seconds, &req.limits);
                container = container
                    .with_workdir(cwd)
                    .with_exec_opts(argv, any_exit_opts());
                if budget.charge(COMMAND_CHAIN_LINKS) {
                    container = checkpoint(client, container).await?;
                }
            }
            ReplayStep::File(file) => {
                container = apply_upload_file(container, index, file)?;
                if budget.charge(UPLOAD_CHAIN_LINKS) {
                    container = checkpoint(client, container).await?;
                }
            }
            ReplayStep::SkillMount(mount) => {
                let root = skill_root_path(&mount.skill_name)?;
                for file in &mount.files {
                    container = apply_snapshot_file(container, &root, file)?;
                    // charged per file: a many-file mount must not exceed the
                    // chain budget within a single step.
                    if budget.charge(snapshot_chain_links(&file.encoding)) {
                        container = checkpoint(client, container).await?;
                    }
                }
                // chown this skill's tree; with_new_file writes as root.
                container = container
                    .with_user("root")
                    .with_exec(vec![
                        "sh".to_string(),
                        "-c".to_string(),
                        format!("chown -R {SKILL_SANDBOX_USER} {}", shell_quote(&root)),
                    ])
                    .with_user(SKILL_SANDBOX_USER);
                let mut links = SKILL_MOUNT_CHOWN_CHAIN_LINKS;
                // extend PYTHONPATH as a layer at this sequence point so commands
                // after the mount can import the skill. commands before it are
                // byte-identical to before this mount existed -> cache holds.
                if !pythonpath_entries.iter().any(|e| e == &root) {
                    pythonpath_entries.push(root);
                    container =
                        container.with_env_variable("PYTHONPATH", pythonpath_entries.join(":"));
                    links += 1;
                }
                if budget.charge(links) {
                    container = checkpoint(client, container).await?;
                }
            }
        }
    }

    Ok(container)
}

/// write an uploaded file at its absolute path. runs as root so it works even
/// when parent dirs must be created, then hands the file (and every parent dir
/// it created) to the sandbox user and removes the staged bytes.
///
/// `index` is the upload's position in the replay step list; it keys a reserved
/// `/tmp` staging path so the raw bytes never land under the user-visible
/// sandbox roots — replaying an upload can't clobber a file an earlier command
/// created next to the target. each step removes its own staged file.
fn apply_upload_file(
    container: Container,
    index: usize,
    file: &ReplayInputFile,
) -> Result<Container> {
    let temp_path = format!("/tmp/.archestra-upload-{index}");
    let decode = match file.encoding.as_str() {
        "base64" => format!(
            "base64 -d {} > {}",
            shell_quote(&temp_path),
            shell_quote(&file.path),
        ),
        "utf8" => format!("cp {} {}", shell_quote(&temp_path), shell_quote(&file.path)),
        other => {
            return Err(SandboxError::InvalidInput(format!(
                "unsupported upload encoding: {other}"
            )));
        }
    };
    // create each missing parent dir shallowest-first and chown only the ones
    // we create, so commands running as the sandbox user can write siblings in
    // a fresh upload dir. pre-existing dirs (the sandbox roots) are untouched.
    let mut create_parents = String::new();
    for dir in ancestor_dirs(&file.path) {
        let quoted = shell_quote(&dir);
        create_parents.push_str(&format!(
            "[ -d {quoted} ] || {{ mkdir {quoted} && chown {SKILL_SANDBOX_USER} {quoted}; }} && "
        ));
    }
    let script = format!(
        "{create_parents}{decode} && chown {user} {target} && rm -f {temp}",
        user = SKILL_SANDBOX_USER,
        target = shell_quote(&file.path),
        temp = shell_quote(&temp_path),
    );
    Ok(container
        .with_user("root")
        .with_new_file(&temp_path, &file.content)
        .with_exec(vec!["bash".to_string(), "-c".to_string(), script])
        .with_user(SKILL_SANDBOX_USER))
}

/// absolute parent directories of `path`, shallowest first, excluding the root
/// `/` and the file itself — e.g. `/home/sandbox/a/b.txt` yields `/home`,
/// `/home/sandbox`, `/home/sandbox/a`. assumes an absolute, traversal-free path
/// (guaranteed by `validate_upload_path` before the step is built).
fn ancestor_dirs(path: &str) -> Vec<String> {
    let components: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut acc = String::new();
    components
        .iter()
        .take(components.len().saturating_sub(1))
        .map(|component| {
            acc.push('/');
            acc.push_str(component);
            acc.clone()
        })
        .collect()
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

fn attach_trace(traceparent: Option<&str>) {
    let span = Span::current();
    crate::tracing_ctx::attach_parent(&span, traceparent);
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

/// categorise an error returned by the dagger SDK during exec evaluation. SDK
/// errors with an embedded `exit code: N` come from a container exec that
/// returned non-zero (kill-by-signal counts here too); everything else is a
/// real transport/engine failure.
/// categorise an error returned by the dagger SDK during exec evaluation. an
/// exec that returned non-zero (kill-by-signal counts here too) becomes a
/// `CommandFailed`; everything else is a real transport/engine failure, tagged
/// with the specific fault so the session layer can pick a retry policy.
fn from_sdk(err: DaggerError) -> SandboxError {
    match exec_exit_code(&err) {
        Some(exit_code) => SandboxError::CommandFailed {
            exit_code,
            message: err.to_string(),
        },
        None => SandboxError::EngineUnreachable {
            fault: classify_engine_fault(&err),
            message: err.to_string(),
        },
    }
}

/// build an engine-unreachable error from a non-exec SDK failure (warm-base
/// build), classifying the fault from the typed error.
fn engine(err: DaggerError) -> SandboxError {
    SandboxError::EngineUnreachable {
        fault: classify_engine_fault(&err),
        message: err.to_string(),
    }
}

/// the engine reports a stale-attachables timeout as a GraphQL *domain* error:
/// the query reached the engine but it gave up waiting for this client's
/// attachables. dagger ships no machine-readable code for it, so the message
/// substring is the only discriminator — but we consult it only on the typed
/// domain-error path, never on transport/build/serialize errors.
fn classify_engine_fault(err: &DaggerError) -> EngineFault {
    match err {
        DaggerError::Query(GraphQLError::DomainError { message, .. })
            if message.contains(SESSION_ATTACHABLES_WAIT_ERROR) =>
        {
            EngineFault::StaleAttachables
        }
        _ => EngineFault::Unreachable,
    }
}

/// pull a process exit code out of the engine's typed `EXEC_ERROR` extension.
/// falls back to scraping the message because signal-killed execs (e.g. SIGXFSZ
/// -> 153) can surface the code only in the message even under `ReturnType::Any`.
fn exec_exit_code(err: &DaggerError) -> Option<i32> {
    if let DaggerError::Query(GraphQLError::DomainError { fields, .. }) = err {
        let typed = fields.iter().find_map(|field| match &field.extensions {
            Some(GraphQlExtension::ExecError { exit_code, .. }) => Some(*exit_code),
            _ => None,
        });
        if typed.is_some() {
            return typed;
        }
    }
    parse_sdk_exit_code(&err.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use dagger_sdk::core::gql_client::GraphQLErrorMessage;

    /// a GraphQL domain error carrying `message` and an optional typed extension.
    fn domain_error(message: &str, extension: Option<GraphQlExtension>) -> DaggerError {
        DaggerError::Query(GraphQLError::DomainError {
            message: message.to_string(),
            fields: extension
                .map(|extension| GraphQLErrorMessage {
                    message: message.to_string(),
                    locations: None,
                    extensions: Some(extension),
                    path: None,
                })
                .into_iter()
                .collect(),
        })
    }

    fn exec_error(exit_code: i32, message: &str) -> DaggerError {
        domain_error(
            message,
            Some(GraphQlExtension::ExecError {
                cmd: Vec::new(),
                exit_code,
                stderr: String::new(),
                stdout: String::new(),
            }),
        )
    }

    #[test]
    fn from_sdk_reads_exit_code_from_typed_extension() {
        let err = exec_error(153, "process did not complete successfully");
        assert!(matches!(
            from_sdk(err),
            SandboxError::CommandFailed { exit_code: 153, .. }
        ));
    }

    #[test]
    fn from_sdk_falls_back_to_message_exit_code_without_extension() {
        // signal-killed execs can omit the extension and only embed the code.
        let err = domain_error(
            "process \"/.init bash -c …\" did not complete successfully: exit code: 153",
            None,
        );
        assert!(matches!(
            from_sdk(err),
            SandboxError::CommandFailed { exit_code: 153, .. }
        ));
    }

    #[test]
    fn from_sdk_keeps_transport_errors_as_generic_unreachable() {
        let err = DaggerError::Query(GraphQLError::HttpError("connection refused".to_string()));
        assert!(matches!(
            from_sdk(err),
            SandboxError::EngineUnreachable {
                fault: EngineFault::Unreachable,
                ..
            }
        ));
    }

    #[test]
    fn classify_engine_fault_flags_stale_attachables_only_on_domain_errors() {
        let stale = domain_error(
            "waiting for client session attachables: context deadline exceeded",
            None,
        );
        assert_eq!(classify_engine_fault(&stale), EngineFault::StaleAttachables);

        // the same phrase in a non-domain error is never treated as attachables.
        let http = DaggerError::Query(GraphQLError::HttpError(
            "waiting for client session attachables".to_string(),
        ));
        assert_eq!(classify_engine_fault(&http), EngineFault::Unreachable);

        let generic = domain_error("connection reset", None);
        assert_eq!(classify_engine_fault(&generic), EngineFault::Unreachable);
    }

    #[test]
    fn warm_base_user_setup_scaffolds_uv_project() {
        let cmd = warm_base_user_setup("numpy pandas");
        // must run in the project dir so `uv add` can discover pyproject.toml.
        assert!(cmd.starts_with("cd /home/sandbox &&"));
        assert!(cmd.contains("pyproject.toml"));
        assert!(cmd.contains("uv venv --python python3 /home/sandbox/.venv"));
        // deps seeded via the same `uv add` path the model uses.
        assert!(cmd.contains("uv add numpy pandas"));
        assert!(!cmd.contains("uv pip install"));
    }

    #[test]
    fn pip_shim_directs_to_project_scoped_uv_add() {
        // the shim is the model's only feedback when it reaches for pip; it must
        // point at a command that actually works from any cwd.
        assert!(PIP_SHIM_SETUP.contains("uv add --project /home/sandbox <pkg>"));
    }

    #[test]
    fn chain_budget_checkpoints_at_threshold_and_resets() {
        let mut budget = ChainBudget::new();
        assert!(!budget.charge(CHECKPOINT_CHAIN_LINKS - 1));
        assert!(budget.charge(1));
        // the counter restarts after a checkpoint.
        assert!(!budget.charge(CHECKPOINT_CHAIN_LINKS - 1));
        assert!(budget.charge(CHECKPOINT_CHAIN_LINKS));
    }

    #[test]
    fn chain_budget_bounds_query_depth_for_hook_heavy_replay() {
        // a hook fire appends a payload upload (4 links) + a command (2 links).
        // model a real failing replay log (33 uploads + 18 commands ≈ 168
        // links): no single query between checkpoints may approach serde_json's
        // 128-level recursion limit, however long the history grows.
        let mut budget = ChainBudget::new();
        let mut chain_depth = 0usize;
        let mut max_chain_depth = 0usize;
        let charges = std::iter::repeat_n(UPLOAD_CHAIN_LINKS, 33)
            .chain(std::iter::repeat_n(COMMAND_CHAIN_LINKS, 18));
        for links in charges {
            chain_depth += links;
            max_chain_depth = max_chain_depth.max(chain_depth);
            if budget.charge(links) {
                chain_depth = 0;
            }
        }
        assert!(max_chain_depth <= CHECKPOINT_CHAIN_LINKS + UPLOAD_CHAIN_LINKS);
    }

    #[test]
    fn snapshot_chain_links_charges_per_encoding() {
        // utf8 snapshot files chain a single with_new_file; base64 files add a
        // decode exec on top.
        assert_eq!(snapshot_chain_links("utf8"), 1);
        assert_eq!(snapshot_chain_links("base64"), 2);
    }

    #[test]
    fn ancestor_dirs_lists_parents_shallowest_first() {
        assert_eq!(
            ancestor_dirs("/home/sandbox/a/b.txt"),
            vec!["/home", "/home/sandbox", "/home/sandbox/a"]
        );
        assert_eq!(
            ancestor_dirs("/home/sandbox/input.csv"),
            vec!["/home", "/home/sandbox"]
        );
        // a file directly under root `/` has no parent dir to create.
        assert_eq!(ancestor_dirs("/file"), Vec::<String>::new());
    }
}
