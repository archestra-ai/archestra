//! the Dagger backend: connects to a Dagger engine, warms a base image once per
//! session, and materialises each request into a content-addressed container
//! chain. all `dagger_sdk` usage is contained in this module.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use dagger_sdk::core::DAGGER_ENGINE_VERSION;
use dagger_sdk::core::connect_params::ConnectParams;
use dagger_sdk::core::downloader::Downloader;
use dagger_sdk::core::gql_client::GraphQlExtension;
use dagger_sdk::core::graphql_client::{DefaultGraphQLClient, GraphQLError};
use dagger_sdk::errors::{ConnectError, DaggerError};
use dagger_sdk::{
    Config, Container, ContainerWithExecOpts, ContainerWithNewFileOpts, DaggerConn, Query,
    ReturnType,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{OnceCell, broadcast, mpsc, oneshot};
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
    RuntimeTarget, SandboxError, SnapshotFile,
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
    "unzip",
    "zip",
];

/// venv pre-baked into the warm base, owned by the sandbox user; reused by every
/// `python3` command so per-call uv installs are layered on (fast) instead of
/// recreated (slow). MUST stay at the uv project's default location
/// (`{SKILL_SANDBOX_HOME}/.venv`): `uv add` targets the project venv while
/// `python3` follows `VIRTUAL_ENV`/PATH, so a different path would silently
/// split the two interpreters.
const DEFAULT_VENV_DIR: &str = "/home/sandbox/.venv";
const DEFAULT_PYTHON_REQUIREMENTS: &[&str] = &["numpy", "pandas", "httpx"];
/// provenance marker written by `sandbox_base/Dockerfile`; prebuilt mode verifies
/// it so a mis-set `ARCHESTRA_DAGGER_RUNTIME_IMAGE` fails fast here instead of
/// downstream.
const SANDBOX_BASE_MARKER: &str = "/etc/archestra-sandbox-base";

/// Dagger CLI env vars on the connect path, named to avoid typos in this
/// tenant-isolation-sensitive routing. `DAGGER_RUNNER_HOST_ENV` is set on the
/// spawned `dagger session` child only (never the parent) to pin a
/// per-environment engine; `DAGGER_CLI_BIN_ENV` overrides the CLI binary path.
const DAGGER_RUNNER_HOST_ENV: &str = "_EXPERIMENTAL_DAGGER_RUNNER_HOST";
const DAGGER_CLI_BIN_ENV: &str = "_EXPERIMENTAL_DAGGER_CLI_BIN";

const SESSION_READY_TIMEOUT: Duration = Duration::from_secs(60);
/// How often an idle session pings the engine to keep its `kube-pod://` attachable
/// channel warm. The channel was observed going half-open after minutes of idle;
/// 30s stays well inside that. A Dagger transport concern, so it lives here rather
/// than in the backend-agnostic session actor.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
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

/// The Dagger runner host for a runtime target: `Default` -> `None` (use the
/// process-default engine), an environment -> its engine's `kube-pod://` address.
/// `environment_id` / `namespace` were validated (UUID / RFC1123 label) at the
/// NAPI boundary, so the formatted address needs no escaping. The pod name and
/// container MUST match the engine StatefulSet the TS dagger-environment-runtime
/// manager creates (`daggerEngineDeploymentName` + the `dagger-engine` container).
fn runtime_target_host(target: &RuntimeTarget) -> Option<String> {
    match target {
        RuntimeTarget::Default => None,
        RuntimeTarget::Environment {
            environment_id,
            namespace,
        } => Some(format!(
            "kube-pod://dagger-engine-{environment_id}-0?namespace={namespace}&container=dagger-engine"
        )),
    }
}

/// The `dagger session` CLI arguments, pinned to the protocol dagger-sdk 0.21
/// speaks. Kept pure so a test asserts the exact vector — an SDK bump that
/// changed it would then fail loudly rather than silently break the handshake.
fn session_args(workdir: &Path) -> Vec<String> {
    vec![
        "session".to_string(),
        "--workdir".to_string(),
        workdir.to_string_lossy().into_owned(),
        "--label".to_string(),
        "dagger.io/sdk.name:rust".to_string(),
        "--label".to_string(),
        format!("dagger.io/sdk.version:{DAGGER_ENGINE_VERSION}"),
    ]
}

/// Build the `dagger session` child command. The per-environment runner host is
/// set on **this child only** (never the parent process env); `None` leaves it
/// unset so the child inherits the parent's default engine.
fn build_session_command(cli: &Path, workdir: &Path, runner_host: Option<&str>) -> Command {
    let mut cmd = Command::new(cli);
    cmd.args(session_args(workdir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Reap the child if the connect future is dropped — the readiness-timeout
        // path aborts `connect_task` before `proc.shutdown()` can run, so without
        // this a hung `dagger session` would outlive its connect attempt.
        .kill_on_drop(true);
    if let Some(host) = runner_host {
        cmd.env(DAGGER_RUNNER_HOST_ENV, host);
    }
    cmd
}

/// Owns the spawned `dagger session` CLI child and the broadcast that stops our
/// stdout/stderr reader tasks. Replaces the SDK's `DaggerSessionProc`, whose
/// `shutdown()` only awaits the child's *voluntary* exit (it sends no signal and
/// never closes stdin), so it blocks forever on a reconnect-looping child —
/// leaving an orphaned session hammering the engine. We own the child and
/// force-kill it instead. `Query.proc` is left `None`: it is a pure keep-alive
/// the SDK plumbs through clones, never the transport (that is `graphql_client`).
struct SessionProc {
    child: Child,
    shutdown: broadcast::Sender<()>,
}

impl SessionProc {
    fn subscribe_shutdown(&self) -> broadcast::Receiver<()> {
        self.shutdown.subscribe()
    }

    /// Stop the reader tasks, then forcibly SIGKILL and reap the child. Bounded,
    /// unlike the SDK's wait-for-voluntary-exit teardown. Consumes `self` so the
    /// child has exactly one owner. On the connect-abort path this is never
    /// reached; `kill_on_drop(true)` reaps the dropped child there instead.
    async fn shutdown(mut self) {
        let _ = self.shutdown.send(());
        // `kill()` is SIGKILL + reap. If the child already exited, `start_kill`
        // errors before the internal wait, so reap explicitly to avoid a zombie.
        if let Err(err) = self.child.kill().await {
            tracing::debug!(error = %err, "dagger session child kill errored; reaping");
            let _ = self.child.wait().await;
        }
    }
}

impl From<Child> for SessionProc {
    fn from(child: Child) -> Self {
        let (shutdown, _) = broadcast::channel::<()>(1);
        Self { child, shutdown }
    }
}

/// Spawn the `dagger session` CLI child and read its `ConnectParams` handshake —
/// a faithful reimplementation of dagger-sdk's private `CliSession::get_conn`,
/// pinned to `=0.21.5`. The ordering is load-bearing: take stdout/stderr off the
/// child, build the session handle (which owns the shutdown broadcast — there is
/// no `Drop`), then drain both pipes in background tasks until teardown, parsing
/// the first JSON line as `ConnectParams`.
async fn spawn_and_read_connect_params(
    mut cmd: Command,
) -> eyre::Result<(ConnectParams, SessionProc)> {
    let mut child = cmd.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| eyre::eyre!("could not acquire stdout from the dagger session"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| eyre::eyre!("could not acquire stderr from the dagger session"))?;
    let session: SessionProc = child.into();

    let (sender, receiver) = oneshot::channel::<ConnectParams>();
    let mut sender = Some(sender);
    let mut stdout_shutdown = session.subscribe_shutdown();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => match serde_json::from_str::<ConnectParams>(&line) {
                        // first parseable line wins; the sender is consumed so we
                        // keep draining stdout but never send twice.
                        Ok(conn) => if let Some(tx) = sender.take() {
                            let _ = tx.send(conn);
                        },
                        Err(_) => tracing::debug!(line, "dagger session stdout"),
                    },
                    Ok(None) | Err(_) => break,
                },
                _ = stdout_shutdown.recv() => break,
            }
        }
    });

    let mut stderr_shutdown = session.subscribe_shutdown();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => tracing::debug!(line, "dagger session stderr"),
                    Ok(None) | Err(_) => break,
                },
                _ = stderr_shutdown.recv() => break,
            }
        }
    });

    let conn = receiver
        .await
        .map_err(|_| eyre::eyre!("the dagger session exited before reporting connect params"))?;
    Ok((conn, session))
}

/// Connect to a Dagger engine and drive `f` for the connection's lifetime,
/// setting the runner host on the spawned CLI **child** only — never the parent
/// process env. `runner_host = None` lets the child inherit the parent's default
/// host. This owns the thin glue `dagger_sdk::connect_opts` would run (pinned to
/// `=0.21.5`), so a per-environment host is bound to one child at spawn instead
/// of mutated into process-global, non-synchronized state.
async fn connect_target<F, Fut>(
    cfg: Config,
    runner_host: Option<&str>,
    f: F,
) -> std::result::Result<(), ConnectError>
where
    F: FnOnce(DaggerConn) -> Fut,
    Fut: std::future::Future<Output = eyre::Result<()>>,
{
    let cli = match env::var(DAGGER_CLI_BIN_ENV) {
        Ok(path) => PathBuf::from(path),
        Err(_) => Downloader::new(DAGGER_ENGINE_VERSION.into())
            .get_cli()
            .await
            .map_err(|e| ConnectError::FailedToConnect(e.into()))?,
    };
    let workdir =
        std::fs::canonicalize("/").map_err(|e| ConnectError::FailedToConnect(e.into()))?;

    let cmd = build_session_command(&cli, &workdir, runner_host);

    let (conn, proc) = spawn_and_read_connect_params(cmd)
        .await
        .map_err(ConnectError::FailedToConnect)?;

    // `proc: None` — we own the CLI child via `proc` and shut it down ourselves;
    // the field is only an SDK keep-alive, never the transport.
    let client = Query {
        proc: None,
        selection: Default::default(),
        graphql_client: Arc::new(DefaultGraphQLClient::new(&conn, &cfg)),
    };

    // Keep the attachable channel warm across idle gaps so the next request doesn't
    // meet a half-open channel. A failing ping is only logged — a dead channel is
    // recovered reactively when the next request respawns.
    let keepalive = spawn_channel_keepalive(client.clone(), proc.subscribe_shutdown());

    let outcome = f(client).await;
    // Force-kill the child on teardown (success and error alike) to release the
    // engine session and reader tasks. Unlike the SDK's `shutdown()`, this never
    // blocks on a reconnect-looping child. The readiness-timeout abort path never
    // reaches this line; `kill_on_drop(true)` reaps the dropped child there.
    proc.shutdown().await;
    keepalive.abort();
    outcome.map_err(ConnectError::DaggerContext)
}

/// Background task that pings the engine on `KEEPALIVE_INTERVAL` to keep an idle
/// session's attachable channel warm. `version()` is the cheapest query that
/// still exercises the channel.
fn spawn_channel_keepalive(
    client: DaggerConn,
    shutdown: broadcast::Receiver<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(keepalive_loop(KEEPALIVE_INTERVAL, shutdown, move || {
        let client = client.clone();
        async move {
            if let Err(err) = client.version().await {
                tracing::warn!(error = %err, "dagger session keepalive ping failed");
            }
        }
    }))
}

/// Tick `ping` every `interval` until the shutdown broadcast fires. The transport
/// ping is injected so the loop's control flow is testable without a live engine.
async fn keepalive_loop<F, Fut>(
    interval: Duration,
    mut shutdown: broadcast::Receiver<()>,
    mut ping: F,
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // the first tick fires immediately; skip it so a freshly-connected session
    // isn't pinged before it has had a chance to go idle.
    tick.tick().await;
    loop {
        tokio::select! {
            _ = shutdown.recv() => break,
            _ = tick.tick() => ping().await,
        }
    }
}

/// connect to the Dagger engine and drive the generic actor loop for the
/// connection's lifetime. this is the one place the Dagger backend is selected.
///
/// `target` selects the engine: `Default` uses the process-default runner host,
/// an environment its own `kube-pod://…` (resolved here so that address never
/// crosses the generic API). The host is set on the spawned CLI child only, so
/// distinct environments connect concurrently with no process-global env mutation.
pub(crate) async fn spawn(target: RuntimeTarget) -> Result<Arc<SessionHandle>> {
    tracing::info!(target = ?target, "spawning dagger session");
    let (msg_tx, msg_rx) = mpsc::channel::<SessionMsg>(CHANNEL_CAPACITY);
    let (ready_tx, ready_rx) = oneshot::channel::<()>();
    let (fail_tx, fail_rx) = oneshot::channel::<SandboxError>();

    let runner_host = runtime_target_host(&target);

    let connect_task = tokio::spawn(async move {
        let cfg = Config::builder()
            .workdir_path(PathBuf::from("/"))
            .load_workspace_modules(false)
            .build();
        let mut ready_tx = Some(ready_tx);
        let mut fail_tx = Some(fail_tx);
        let result = connect_target(cfg, runner_host.as_deref(), move |client| async move {
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

    let outcome = tokio::select! {
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
    };
    // On timeout or failure, abort the connect task so a stuck or half-open
    // session can't linger; on success it is the session actor loop and stays.
    if outcome.is_err() {
        connect_task.abort();
    }
    outcome
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

/// The root-level setup exec, run before `with_user` drops to the sandbox user.
/// A pre-baked image only verifies its provenance marker (no network); a plain
/// base runs the apt toolbelt + sandbox dirs + pip shim.
fn warm_base_root_setup(prebuilt: bool) -> String {
    match prebuilt {
        // Skipping the apt/uv setup is only safe if the image really is the baked
        // base. Verify its provenance marker so a mis-set runtime image fails here
        // with a clear message rather than producing a container that breaks
        // downstream — and with no network fallback under restricted egress.
        true => format!(
            "test -f {SANDBOX_BASE_MARKER} || (echo 'error: ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT=true but {SANDBOX_BASE_MARKER} is absent; the runtime image is not the baked sandbox base' >&2; exit 1)"
        ),
        // apt packages + sandbox dirs + ownership + pip shim. the shim redirects
        // any `pip` invocation to uv so the model is never tempted to install into
        // ~/.local (which the venv python won't see). `uv pip` is unaffected
        // because it's a subcommand of `uv`, not a separate binary.
        false => {
            let apt_packages = DEFAULT_APT_PACKAGES.join(" ");
            format!(
                "apt-get update -qq && apt-get install -y --no-install-recommends {apt_packages} && rm -rf /var/lib/apt/lists/* && mkdir -p {SKILL_SANDBOX_HOME} {SKILL_SANDBOX_ROOT} && chown -R 1000:1000 {SKILL_SANDBOX_HOME} {SKILL_SANDBOX_ROOT} && {PIP_SHIM_SETUP}"
            )
        }
    }
}

/// The user-level setup exec, run after `with_user`. A pre-baked image already
/// has the uv project + venv, so there is nothing to do; a plain base scaffolds
/// the project and seeds the default packages.
fn warm_base_user_setup_exec(prebuilt: bool) -> Option<String> {
    match prebuilt {
        true => None,
        false => Some(warm_base_user_setup(&DEFAULT_PYTHON_REQUIREMENTS.join(" "))),
    }
}

/// The base is treated as pre-baked only on an exact `"true"`; anything else
/// (unset, empty, `"1"`, `"True"`) falls back to building from a stock image,
/// because skipping the toolchain build on a non-baked image yields a broken
/// container with no network fallback under restricted egress.
fn base_prebuilt_from_env(value: Option<String>) -> bool {
    value.as_deref() == Some("true")
}

#[tracing::instrument(name = "sandbox.warm_base.build", skip_all, fields(image = tracing::field::Empty))]
async fn build_warm_base(client: &DaggerConn) -> Result<Container> {
    let image = env::var("ARCHESTRA_DAGGER_RUNTIME_IMAGE")
        .unwrap_or_else(|_| DEFAULT_BASE_IMAGE.to_string());
    // When the base image is pre-baked (the `sandbox-base` image already contains
    // the apt toolbelt + uv project + venv), skip the apt/uv build execs — those
    // are the steps that hit ghcr.io/debian/pypi at runtime and get starved by a
    // restrictive egress policy. Only the supervisor + env/user are layered on
    // (no network), so a cold restricted engine works without warming first.
    let prebuilt = base_prebuilt_from_env(env::var("ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT").ok());
    tracing::Span::current().record("image", image.as_str());
    tracing::info!(%image, prebuilt, "building warm base image");

    let mut container = client
        .container()
        .from(&image)
        // exactly one root-level exec: provenance check (prebuilt) or apt/uv setup.
        .with_exec(vec![
            "sh".to_string(),
            "-c".to_string(),
            warm_base_root_setup(prebuilt),
        ])
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
        .with_env_variable("PATH", format!("{DEFAULT_VENV_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"));

    // user setup runs as the sandbox user; a prebuilt base already has the venv.
    if let Some(user_setup) = warm_base_user_setup_exec(prebuilt) {
        container = container.with_exec(vec!["sh".to_string(), "-c".to_string(), user_setup]);
    }

    container
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
        // base64 runs the decode as root: `with_user` + `with_new_file` +
        // `with_exec` + `with_user`.
        _ => 4,
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
            // decode as root: `with_new_file` stages the temp bytes root-owned
            // (and creates the skill dir tree root-owned), so the redirect must
            // run as root too. the per-mount `chown -R` below hands the tree back
            // to the sandbox user once every file in the mount is written.
            Ok(container
                .with_user("root")
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
                ])
                .with_user(SKILL_SANDBOX_USER))
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

/// recover an engine fault from a *panic* payload. dagger-sdk 0.21.5 `unwrap()`s
/// GraphQL errors inside generated lazy-arg resolvers (`gen.rs` `into_id().unwrap()`),
/// which resolve during exec evaluation — so a stale-attachables timeout reaches
/// us as a panic rather than a typed `DaggerError`, bypassing [`from_sdk`] /
/// [`classify_engine_fault`]. the panic message still embeds the engine's text,
/// enough to route it back onto the existing stale-attachables respawn path
/// instead of wedging the session.
///
/// the match is intentionally as narrow as the typed path: *only* the
/// attachables timeout maps to a fault. the engine emits that text when it gave
/// up waiting for the client's attachables *before* running the query, so a
/// command-executing `run` can be retried safely (nothing ran). a generic
/// transport panic carries no fault and stays a fatal `Internal`, preserving the
/// session layer's mid-flight non-retry guard for `run` / `read_artifact`.
pub(crate) fn engine_fault_from_panic(message: &str) -> Option<EngineFault> {
    message
        .contains(SESSION_ATTACHABLES_WAIT_ERROR)
        .then_some(EngineFault::StaleAttachables)
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
    use std::ffi::OsStr;

    use super::*;
    use dagger_sdk::core::gql_client::GraphQLErrorMessage;

    #[test]
    fn dagger_session_args_match_the_pinned_protocol() {
        assert_eq!(
            session_args(Path::new("/")),
            vec![
                "session".to_string(),
                "--workdir".to_string(),
                "/".to_string(),
                "--label".to_string(),
                "dagger.io/sdk.name:rust".to_string(),
                "--label".to_string(),
                "dagger.io/sdk.version:0.21.5".to_string(),
            ]
        );
    }

    #[test]
    fn connect_params_parse_from_a_session_stdout_line() {
        let conn: ConnectParams =
            serde_json::from_str(r#"{"port":12345,"session_token":"tok"}"#).unwrap();
        assert_eq!(conn.port, 12345);
        assert_eq!(conn.session_token, "tok");
    }

    #[test]
    fn session_command_pins_runner_host_on_the_child_only_for_environments() {
        let cli = Path::new("/usr/local/bin/dagger");
        let host = "kube-pod://dagger-engine-env-a-0?namespace=ns&container=dagger-engine";

        // an environment target pins the runner host on the child command, never
        // the parent process env — the tenant-isolation boundary this fix exists for.
        let env_cmd = build_session_command(cli, Path::new("/"), Some(host));
        let runner_override = env_cmd
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(DAGGER_RUNNER_HOST_ENV));
        assert_eq!(
            runner_override,
            Some((OsStr::new(DAGGER_RUNNER_HOST_ENV), Some(OsStr::new(host))))
        );

        // the default target sets no override, so the child inherits the parent's
        // default engine rather than a host a sibling environment pinned.
        let default_cmd = build_session_command(cli, Path::new("/"), None);
        assert!(
            default_cmd
                .as_std()
                .get_envs()
                .all(|(key, _)| key != OsStr::new(DAGGER_RUNNER_HOST_ENV))
        );
    }

    /// Write a throwaway executable shell script that stands in for the
    /// `dagger session` CLI; it ignores the appended `session_args`. Linux-only,
    /// matching the sandbox runtime's target.
    #[cfg(target_os = "linux")]
    fn write_fake_session(body: &str) -> PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "dagger-fake-session-{}-{unique}.sh",
            std::process::id(),
        ));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        file.set_permissions(std::fs::Permissions::from_mode(0o755))
            .unwrap();
        path
    }

    /// True when `pid` is gone from the proc table or is a reaped/zombie corpse.
    #[cfg(target_os = "linux")]
    fn process_finished(pid: u32) -> bool {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return true; // proc entry gone → reaped
        };
        // `stat` is "pid (comm) state ..."; comm can contain spaces and parens,
        // so the state char is the first token after the final ')'.
        match stat.rsplit_once(')') {
            Some((_, rest)) => matches!(rest.trim_start().chars().next(), Some('Z' | 'X') | None),
            None => true,
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn spawn_and_read_connect_params_returns_the_parsed_handshake() {
        // a fake session that prints the handshake line then stays alive, so the
        // child is still running when the params are read.
        let script = write_fake_session(
            "#!/bin/sh\necho '{\"port\":12345,\"session_token\":\"tok\"}'\nsleep 30\n",
        );
        let cmd = build_session_command(&script, Path::new("/"), None);

        let (conn, proc) = spawn_and_read_connect_params(cmd).await.unwrap();
        assert_eq!(conn.port, 12345);
        assert_eq!(conn.session_token, "tok");

        proc.shutdown().await;
        std::fs::remove_file(&script).ok();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn spawn_and_read_connect_params_errors_when_child_exits_without_params() {
        // a fake session that exits before emitting any ConnectParams; the oneshot
        // sender drops, so the receiver resolves to the "exited" error.
        let script = write_fake_session("#!/bin/sh\nexit 0\n");
        let cmd = build_session_command(&script, Path::new("/"), None);

        // the success arm holds a `SessionProc` (not `Debug`), so match instead
        // of `unwrap_err`.
        let Err(err) = spawn_and_read_connect_params(cmd).await else {
            panic!("expected an error when the child exits without reporting params");
        };
        assert!(
            err.to_string()
                .contains("exited before reporting connect params"),
            "unexpected error: {err}"
        );
        std::fs::remove_file(&script).ok();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn build_session_command_reaps_the_child_on_drop() {
        // dropping the spawned child must SIGKILL it (kill_on_drop), so an aborted
        // connect attempt can't leak a long-running `dagger session`.
        let script = write_fake_session("#!/bin/sh\nsleep 120\n");
        let mut cmd = build_session_command(&script, Path::new("/"), None);

        let child = cmd.spawn().unwrap();
        let pid = child.id().expect("a spawned child has a pid");
        assert!(
            !process_finished(pid),
            "child should be running after spawn"
        );

        drop(child);

        // kill_on_drop sends SIGKILL on drop; poll until the kernel reaps it.
        let mut reaped = false;
        for _ in 0..100 {
            if process_finished(pid) {
                reaped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            reaped,
            "child {pid} outlived its dropped handle (kill_on_drop missing?)"
        );
        std::fs::remove_file(&script).ok();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shutdown_reaps_a_child_that_refuses_to_exit() {
        // Regression for the dagger zombie: teardown must forcibly reap the CLI
        // child even when it never exits on its own (the reconnect-loop shape).
        // The SDK's `DaggerSessionProc::shutdown` only broadcasts to our reader
        // tasks and then *awaits* the child's voluntary exit — no signal, no
        // stdin close — so it blocked here forever. `SessionProc::shutdown`
        // SIGKILLs and reaps instead, so it returns promptly and leaves no
        // orphaned `dagger session` hammering the engine.
        let script = write_fake_session("#!/bin/sh\nsleep 120\n");
        let mut cmd = build_session_command(&script, Path::new("/"), None);
        let child = cmd.spawn().unwrap();
        let pid = child.id().expect("a spawned child has a pid");
        let proc: SessionProc = child.into();

        let returned = tokio::time::timeout(Duration::from_secs(5), proc.shutdown()).await;
        assert!(
            returned.is_ok(),
            "shutdown() must return promptly for a child that never exits on its own"
        );
        assert!(
            process_finished(pid),
            "shutdown() must forcibly reap the child"
        );
        std::fs::remove_file(&script).ok();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shutdown_reaps_a_child_that_already_exited() {
        // If the child exits on its own first, `kill()` errors before its internal
        // wait; shutdown() must still reap the zombie rather than leak it.
        let script = write_fake_session("#!/bin/sh\nexit 0\n");
        let mut cmd = build_session_command(&script, Path::new("/"), None);
        let child = cmd.spawn().unwrap();
        let pid = child.id().expect("a spawned child has a pid");
        let proc: SessionProc = child.into();

        // wait until the child has exited (becomes a zombie awaiting reap).
        for _ in 0..100 {
            if process_finished(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let returned = tokio::time::timeout(Duration::from_secs(5), proc.shutdown()).await;
        assert!(returned.is_ok(), "shutdown() must return promptly");
        assert!(
            process_finished(pid),
            "shutdown() must reap the exited child"
        );
        std::fs::remove_file(&script).ok();
    }

    #[tokio::test]
    async fn keepalive_loop_pings_until_shutdown() {
        use std::sync::atomic::{AtomicU64, Ordering};

        let (shutdown_tx, shutdown_rx) = broadcast::channel::<()>(1);
        let pings = Arc::new(AtomicU64::new(0));
        let counter = pings.clone();
        let handle = tokio::spawn(keepalive_loop(
            Duration::from_millis(10),
            shutdown_rx,
            move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
            },
        ));

        // let several ticks fire (the immediate first tick is skipped), then stop.
        tokio::time::sleep(Duration::from_millis(80)).await;
        shutdown_tx.send(()).unwrap();
        // the loop must observe the broadcast and return; a hang here is a failure.
        tokio::time::timeout(Duration::from_secs(1), handle)
            .await
            .expect("keepalive loop must stop on shutdown")
            .unwrap();

        assert!(
            pings.load(Ordering::Relaxed) >= 2,
            "keepalive must ping repeatedly before shutdown"
        );
    }

    #[test]
    fn runtime_target_host_builds_a_kube_pod_address_for_an_environment() {
        assert_eq!(runtime_target_host(&RuntimeTarget::Default), None);
        assert_eq!(
            runtime_target_host(&RuntimeTarget::Environment {
                environment_id: "abcdef00-1111-2222-3333-444455556666".to_string(),
                namespace: "ns-production".to_string(),
            }),
            Some(
                "kube-pod://dagger-engine-abcdef00-1111-2222-3333-444455556666-0?namespace=ns-production&container=dagger-engine"
                    .to_string()
            )
        );
    }

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
    fn engine_fault_from_panic_recovers_only_the_attachables_timeout() {
        // the dagger SDK unwraps the GraphQL error, so it reaches us as the
        // `Debug` rendering of the failed `Result` inside a panic payload.
        let attachables = "called `Result::unwrap()` on an `Err` value: \
             Query(DomainError { message: \"waiting for client session attachables: \
             context deadline exceeded\" })";
        assert_eq!(
            engine_fault_from_panic(attachables),
            Some(EngineFault::StaleAttachables)
        );

        // an unrelated panic must stay fatal (no respawn/retry).
        assert_eq!(
            engine_fault_from_panic("index out of bounds: the len is 0 but the index is 1"),
            None
        );

        // a generic transport/engine panic carries no fault either: it is
        // ambiguous about whether the command already ran, so it must NOT be
        // re-tagged for retry — that ambiguity is exactly why only the
        // pre-execution attachables timeout qualifies.
        assert_eq!(
            engine_fault_from_panic(
                "called `Result::unwrap()` on an `Err` value: Query(HttpError(\"connection reset\"))"
            ),
            None
        );
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
    fn warm_base_root_setup_prebuilt_verifies_marker_only() {
        let cmd = warm_base_root_setup(true);
        // prebuilt only checks the provenance marker and fails loudly if absent.
        assert!(cmd.contains(&format!("test -f {SANDBOX_BASE_MARKER}")));
        assert!(cmd.contains("ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT=true"));
        assert!(cmd.contains("exit 1"));
        // no network/apt steps — those are what a restricted egress starves.
        assert!(!cmd.contains("apt-get"));
        assert!(!cmd.contains("mkdir"));
    }

    #[test]
    fn warm_base_root_setup_plain_installs_apt_toolbelt() {
        let cmd = warm_base_root_setup(false);
        assert!(cmd.contains("apt-get update"));
        assert!(cmd.contains("apt-get install -y --no-install-recommends"));
        // every default apt package is present.
        for pkg in DEFAULT_APT_PACKAGES {
            assert!(cmd.contains(pkg), "missing apt package: {pkg}");
        }
        assert!(cmd.contains(&format!(
            "mkdir -p {SKILL_SANDBOX_HOME} {SKILL_SANDBOX_ROOT}"
        )));
        assert!(cmd.contains(PIP_SHIM_SETUP));
        // a plain base never checks the baked-image marker.
        assert!(!cmd.contains(SANDBOX_BASE_MARKER));
    }

    #[test]
    fn warm_base_user_setup_exec_is_skipped_when_prebuilt() {
        // a baked base already has the uv project + venv, so no user-level exec.
        assert!(warm_base_user_setup_exec(true).is_none());
    }

    #[test]
    fn warm_base_user_setup_exec_scaffolds_when_plain() {
        let cmd = warm_base_user_setup_exec(false).expect("plain base needs user setup");
        assert!(cmd.contains("uv venv --python python3 /home/sandbox/.venv"));
        // default python deps are seeded via the same `uv add` path the model uses.
        for req in DEFAULT_PYTHON_REQUIREMENTS {
            assert!(cmd.contains(req), "missing python requirement: {req}");
        }
    }

    #[test]
    fn base_prebuilt_from_env_is_true_only_for_exact_true() {
        assert!(base_prebuilt_from_env(Some("true".to_string())));
        // anything but an exact "true" must not skip the toolchain build.
        assert!(!base_prebuilt_from_env(Some("True".to_string())));
        assert!(!base_prebuilt_from_env(Some("TRUE".to_string())));
        assert!(!base_prebuilt_from_env(Some("1".to_string())));
        assert!(!base_prebuilt_from_env(Some("true ".to_string())));
        assert!(!base_prebuilt_from_env(Some(String::new())));
    }

    #[test]
    fn base_prebuilt_from_env_defaults_to_false_when_unset() {
        assert!(!base_prebuilt_from_env(None));
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
        // root-sandwiched decode exec (with_user + with_new_file + with_exec +
        // with_user).
        assert_eq!(snapshot_chain_links("utf8"), 1);
        assert_eq!(snapshot_chain_links("base64"), 4);
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
