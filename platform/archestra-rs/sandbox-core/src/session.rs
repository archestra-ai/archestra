use std::any::Any;
use std::env;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use dagger_sdk::{Config, Container, ContainerWithNewFileOpts, DaggerConn, connect_opts};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use tokio::sync::{Mutex, OnceCell, Semaphore, mpsc, oneshot};

use crate::{
    ArtifactBytes, CommandExecution, Result, SKILL_SANDBOX_HOME, SKILL_SANDBOX_ROOT,
    SKILL_SANDBOX_USER, SUPERVISOR_PATH, SandboxError,
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

const CHANNEL_CAPACITY: usize = 64;
const SESSION_READY_TIMEOUT: Duration = Duration::from_secs(60);
// Rust-side cap on concurrent Dagger handlers. Defense in depth — the TS
// adapter caps its own queue at a smaller value, but if any other caller ever
// reaches the NAPI surface directly we still want the engine protected.
const MAX_CONCURRENT_HANDLERS: usize = 32;

pub(crate) struct RunRequest {
    pub snapshots: Vec<crate::SnapshotFile>,
    pub replay_commands: Vec<crate::ReplayCommand>,
    pub limits: crate::Limits,
    pub command: String,
    pub cwd: String,
    pub timeout_seconds: u32,
    pub traceparent: Option<String>,
    /// optional PYTHONPATH applied as a container env var for the materialized
    /// run. used to make a skill's modules importable from any cwd without
    /// forcing the model to cd into the skill root.
    pub pythonpath: Option<String>,
}

pub(crate) struct ArtifactRequest {
    pub snapshots: Vec<crate::SnapshotFile>,
    pub replay_commands: Vec<crate::ReplayCommand>,
    pub limits: crate::Limits,
    pub path: String,
    pub default_cwd: String,
    pub traceparent: Option<String>,
    /// same semantics as `RunRequest::pythonpath`; forwarded to the synthetic
    /// run used to replay history before reading the artifact, so module
    /// imports resolve identically to the original commands.
    pub pythonpath: Option<String>,
}

pub(crate) enum SessionMsg {
    Run {
        req: RunRequest,
        reply: oneshot::Sender<Result<CommandExecution>>,
    },
    ReadArtifact {
        req: ArtifactRequest,
        reply: oneshot::Sender<Result<ArtifactBytes>>,
    },
    CheckSession {
        traceparent: Option<String>,
        reply: oneshot::Sender<Result<()>>,
    },
}

pub(crate) struct SessionHandle {
    tx: mpsc::Sender<SessionMsg>,
}

impl SessionHandle {
    async fn send(&self, msg: SessionMsg) -> Result<()> {
        self.tx.send(msg).await.map_err(|_| {
            SandboxError::EngineUnreachable("the Dagger session is not running".to_string())
        })
    }

    fn is_open(&self) -> bool {
        !self.tx.is_closed()
    }
}

type SharedSpawn = Shared<BoxFuture<'static, Result<Arc<SessionHandle>>>>;

struct Slot {
    handle: Option<Arc<SessionHandle>>,
    /// the in-flight spawn future, shared so concurrent callers all await the
    /// same connect attempt instead of serially retrying after a 60s timeout.
    spawning: Option<SharedSpawn>,
}

static HANDLE_SLOT: OnceCell<Mutex<Slot>> = OnceCell::const_new();

/// returns a live handle, spawning the actor on first call or after a previous
/// session torn down (engine restart, panic in the connect closure).
pub(crate) async fn current() -> Result<Arc<SessionHandle>> {
    let slot = HANDLE_SLOT
        .get_or_init(|| async {
            Mutex::new(Slot {
                handle: None,
                spawning: None,
            })
        })
        .await;

    // pick up either the live handle or a shared in-flight spawn; release the
    // lock before awaiting so concurrent callers don't block on each other.
    let spawn_fut = {
        let mut guard = slot.lock().await;
        if let Some(handle) = guard.handle.as_ref() {
            if handle.is_open() {
                return Ok(handle.clone());
            }
            guard.handle = None;
        }
        if let Some(s) = guard.spawning.clone() {
            s
        } else {
            let fut: BoxFuture<'static, Result<Arc<SessionHandle>>> = spawn().boxed();
            let shared = fut.shared();
            guard.spawning = Some(shared.clone());
            shared
        }
    };

    let result = spawn_fut.await;

    let mut guard = slot.lock().await;
    guard.spawning = None;
    if let Ok(handle) = &result {
        guard.handle = Some(handle.clone());
    }
    result
}

/// submit a request and await the reply.
pub(crate) async fn submit<T, F>(build: F) -> Result<T>
where
    F: FnOnce(oneshot::Sender<Result<T>>) -> SessionMsg,
{
    let (reply_tx, reply_rx) = oneshot::channel();
    let handle = current().await?;
    handle.send(build(reply_tx)).await?;
    reply_rx.await.map_err(|_| {
        SandboxError::internal("the Dagger session dropped a request before replying")
    })?
}

async fn spawn() -> Result<Arc<SessionHandle>> {
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
            run_loop(client, msg_rx).await;
            Ok(())
        })
        .await;
        if let Err(err) = result {
            if let Some(tx) = fail_tx.take() {
                let _ = tx.send(SandboxError::engine(err));
            }
        }
    });

    tokio::select! {
        ready = ready_rx => match ready {
            Ok(()) => {
                tracing::info!("dagger session ready");
                Ok(Arc::new(SessionHandle { tx: msg_tx }))
            }
            Err(_) => Err(SandboxError::EngineUnreachable(
                "the Dagger session task exited before reporting ready".to_string(),
            )),
        },
        failure = fail_rx => match failure {
            Ok(err) => Err(err),
            Err(_) => Err(SandboxError::EngineUnreachable(
                "the Dagger session failed without a diagnostic".to_string(),
            )),
        },
        _ = tokio::time::sleep(SESSION_READY_TIMEOUT) => Err(SandboxError::EngineUnreachable(
            format!("the Dagger session did not become ready within {}s", SESSION_READY_TIMEOUT.as_secs()),
        )),
    }
}

async fn run_loop(client: DaggerConn, mut rx: mpsc::Receiver<SessionMsg>) {
    let session = Arc::new(Session {
        client,
        warm: OnceCell::new(),
    });
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_HANDLERS));
    // kick warmup off in the background so it overlaps with the first request.
    // this runs detached and shared across callers, so its `warm_base.build`
    // span has no caller traceparent and lands as its own root trace rather than
    // nested under whichever request triggered the cold start.
    {
        let session = session.clone();
        tokio::spawn(async move {
            let _ = session.ensure_warm().await;
        });
    }
    while let Some(msg) = rx.recv().await {
        // back-pressure: hold the recv loop until a permit is available, so we
        // never spawn more than MAX_CONCURRENT_HANDLERS tasks against Dagger.
        // a failed try_acquire means the handler pool is saturated — the one
        // back-pressure signal worth surfacing for capacity tuning.
        let permit = match permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                tracing::debug!(
                    max = MAX_CONCURRENT_HANDLERS,
                    "dagger handler pool saturated; waiting for a permit"
                );
                permits
                    .clone()
                    .acquire_owned()
                    .await
                    .expect("session semaphore was closed")
            }
        };
        let session = session.clone();
        tokio::spawn(async move {
            let _permit = permit;
            handle(session, msg).await;
        });
    }
}

pub(crate) struct Session {
    client: DaggerConn,
    warm: OnceCell<Container>,
}

impl Session {
    pub(crate) fn client(&self) -> &DaggerConn {
        &self.client
    }

    pub(crate) async fn ensure_warm(&self) -> Result<Container> {
        let container = self
            .warm
            .get_or_try_init(|| async { build_warm_base(&self.client).await })
            .await?;
        Ok(container.clone())
    }
}

/// venv pre-baked into the warm base, owned by the sandbox user; reused by every
/// `python3` command so per-call uv installs are layered on (fast) instead of
/// recreated (slow).
pub const DEFAULT_VENV_DIR: &str = "/home/sandbox/.venv";
pub const DEFAULT_VENV_PYTHON: &str = "/home/sandbox/.venv/bin/python";
pub const DEFAULT_PYTHON_REQUIREMENTS: &[&str] = &["numpy", "pandas", "httpx"];

/// shell snippet baked into the warm base: writes a `pip` shim that redirects
/// to uv and aliases `pip3`/`pip3.12` to the same shim. we `rm -f` first
/// because the upstream uv-python image ships `pip` as a symlink to `pip3`,
/// so a naive `> /usr/local/bin/pip` would follow the symlink and write to
/// `pip3` instead — and the follow-up `cp pip pip3` would refuse with
/// "are the same file". kept as a const so it shows up verbatim in build
/// logs and survives `cargo fmt`.
const PIP_SHIM_SETUP: &str = "rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12 && printf '%s\\n' '#!/bin/sh' 'echo \"error: pip is disabled in this sandbox. Use \\\"uv add <pkg>\\\" instead.\" >&2' 'exit 1' > /usr/local/bin/pip && chmod +x /usr/local/bin/pip && ln -s pip /usr/local/bin/pip3 && ln -s pip /usr/local/bin/pip3.12";

/// command supervisor written into the warm base at `SUPERVISOR_PATH`. runs
/// `bash -c <cmd>` in its own session under cpu (`RLIMIT_CPU`) and memory
/// (`RLIMIT_AS`) limits, enforces the wall-clock timeout by SIGKILLing the whole
/// process group, caps each output stream at `--out-cap` bytes, and prints a
/// single json result on stdout. kept as a const (like `PIP_SHIM_SETUP`) so it
/// shows up verbatim in build logs and updates with a napi rebuild rather than an
/// image republish. stdlib-only, so any python3 on the image can run it.
const ARCHESTRA_RUN_PY: &str = r##"#!/usr/bin/env python3
import json
import os
import resource
import signal
import subprocess
import sys
import threading
import time


def main():
    argv = sys.argv[1:]
    if "--" not in argv:
        sys.stderr.write("archestra_run: missing -- separator\n")
        return 2
    sep = argv.index("--")
    flags = argv[:sep]
    cmd = argv[sep + 1:]
    if len(flags) % 2 != 0:
        sys.stderr.write("archestra_run: malformed flags\n")
        return 2
    if not cmd:
        sys.stderr.write("archestra_run: empty command\n")
        return 2
    opts = {flags[i]: flags[i + 1] for i in range(0, len(flags), 2)}
    timeout = int(opts["--timeout"])
    cpu = int(opts["--cpu"])
    mem = int(opts["--mem"])
    cap = int(opts["--out-cap"])

    def preexec():
        os.setsid()
        if cpu > 0:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        if mem > 0:
            resource.setrlimit(resource.RLIMIT_AS, (mem, mem))

    streams = {}

    def drain(name, fp):
        buf = bytearray()
        total = 0
        while True:
            chunk = fp.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if len(buf) < cap:
                buf.extend(chunk[: cap - len(buf)])
        streams[name] = (bytes(buf), total > cap)

    start = time.monotonic()
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=preexec
    )
    out_thread = threading.Thread(target=drain, args=("out", proc.stdout))
    err_thread = threading.Thread(target=drain, args=("err", proc.stderr))
    out_thread.start()
    err_thread.start()

    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    out_thread.join()
    err_thread.join()
    duration_ms = int((time.monotonic() - start) * 1000)

    out_bytes, out_trunc = streams.get("out", (b"", False))
    err_bytes, err_trunc = streams.get("err", (b"", False))

    rc = proc.returncode
    if timed_out:
        exit_code = 124
    elif rc is not None and rc < 0:
        exit_code = 128 - rc
    else:
        exit_code = rc if rc is not None else 0

    json.dump(
        {
            "stdout": out_bytes.decode("utf-8", "replace"),
            "stderr": err_bytes.decode("utf-8", "replace"),
            "exitCode": exit_code,
            "timedOut": timed_out,
            "stdoutTruncated": out_trunc,
            "stderrTruncated": err_trunc,
            "durationMs": duration_ms,
        },
        sys.stdout,
    )
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
"##;

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
    // user setup: uv venv + default python packages, owned by sandbox user.
    let user_setup = format!(
        "uv venv --python python3 {DEFAULT_VENV_DIR} && uv pip install --python {DEFAULT_VENV_PYTHON} {py_requirements}"
    );
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
        .map_err(SandboxError::engine)
        .map(|id| client.load_container_from_id(id))
        .inspect(|_| tracing::info!("warm base image ready"))
        .inspect_err(|err| tracing::warn!(error = %err, "warm base image build failed"))
}

async fn handle(session: Arc<Session>, msg: SessionMsg) {
    match msg {
        SessionMsg::Run { req, reply } => {
            let result = catch_panic(crate::runtime::execute_run(session, req)).await;
            let _ = reply.send(result);
        }
        SessionMsg::ReadArtifact { req, reply } => {
            let result = catch_panic(crate::runtime::execute_read_artifact(session, req)).await;
            let _ = reply.send(result);
        }
        SessionMsg::CheckSession { traceparent, reply } => {
            let result =
                catch_panic(crate::runtime::execute_check_session(session, traceparent)).await;
            let _ = reply.send(result);
        }
    }
}

async fn catch_panic<T, Fut>(fut: Fut) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    AssertUnwindSafe(fut)
        .catch_unwind()
        .await
        .unwrap_or_else(|payload| {
            let message = panic_message(payload.as_ref());
            tracing::error!(panic = message, "recovered a panic in a dagger handler");
            Err(SandboxError::Internal(format!("rust panic: {message}")))
        })
}

fn panic_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return s;
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.as_str();
    }
    "unknown panic payload"
}
