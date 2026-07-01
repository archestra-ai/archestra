use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use tokio::fs;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};
use tracing::{error, info, warn};

use crate::client::{ClientError, EvalClient};

/// A self-contained teardown handle, decoupled from its owner so cleanup can run even after the
/// orchestration future is dropped on signal cancellation. Cloning shares the same `Arc` state as the
/// live owner, and running it twice is a no-op (the child is taken). Two kinds ride the same registry
/// so `shutdown_all` kills them all on SIGINT/SIGTERM:
/// - `Backend`: one backend instance — its process-group child plus the per-run database.
/// - `DaggerLogs`: the process-wide managed-engine log follower (no database).
#[derive(Clone)]
enum Teardown {
    Backend {
        proc: Arc<Mutex<Option<Child>>>,
        db_created: Arc<Mutex<bool>>,
        db_name: String,
        maint_db_url: String,
    },
    DaggerLogs {
        proc: Arc<Mutex<Option<Child>>>,
    },
}

impl Teardown {
    async fn run(&self) {
        match self {
            Teardown::Backend {
                proc,
                db_created,
                db_name,
                maint_db_url,
            } => {
                kill_backend(proc).await;
                drop_database(db_created, db_name, maint_db_url).await;
            }
            Teardown::DaggerLogs { proc } => kill_child(proc, "managed Dagger engine log follower").await,
        }
    }
}

fn registry() -> &'static std::sync::Mutex<HashMap<u64, Teardown>> {
    static REGISTRY: OnceLock<std::sync::Mutex<HashMap<u64, Teardown>>> = OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn register(teardown: Teardown) -> u64 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    registry()
        .lock()
        .expect("teardown registry")
        .insert(id, teardown);
    id
}

fn deregister(id: u64) {
    registry().lock().expect("teardown registry").remove(&id);
}

/// Tear down every still-live backend instance (process group + database). Invoked on SIGINT/SIGTERM,
/// where the run future was dropped mid-flight so `Instance::shutdown` never ran. Runs the teardowns
/// concurrently — process groups killed and databases dropped before the process exits, no leaks on
/// cancel — so total wait is bounded by the slowest single backend, not their sum.
pub async fn shutdown_all() {
    let live: Vec<Teardown> = {
        let mut reg = registry().lock().expect("teardown registry");
        reg.drain().map(|(_, t)| t).collect()
    };
    if live.is_empty() {
        return;
    }
    info!(
        "interrupted: tearing down {} live backend instance(s)",
        live.len()
    );
    futures::future::join_all(live.iter().map(|t| t.run())).await;
}

async fn kill_backend(proc: &Arc<Mutex<Option<Child>>>) {
    kill_child(proc, "backend").await;
}

/// SIGTERM the child's process group, then SIGKILL if it doesn't exit in 15s. Takes the child so a
/// second teardown is a no-op. Shared by the backend and the managed-engine log follower — both are
/// spawned in their own process group (`process_group(0)`).
async fn kill_child(proc: &Arc<Mutex<Option<Child>>>, what: &str) {
    let mut guard = proc.lock().await;
    if let Some(mut child) = guard.take()
        && let Some(pid) = child.id()
    {
        info!("stopping {what} pid {pid}");
        let pgid = Pid::from_raw(pid as i32);
        let _ = signal::killpg(pgid, Signal::SIGTERM);
        match tokio::time::timeout(Duration::from_secs(15), child.wait()).await {
            Ok(Ok(_)) => {}
            _ => {
                let _ = signal::killpg(pgid, Signal::SIGKILL);
            }
        }
    }
}

async fn drop_database(db_created: &Arc<Mutex<bool>>, db_name: &str, maint_db_url: &str) {
    if !*db_created.lock().await {
        return;
    }
    info!("dropping benchmark database {db_name}");
    // Bound the connect so an unreachable/hung Postgres can't stall teardown indefinitely (it would
    // keep the interrupted run frozen the same way the serial loop used to). The DB is per-run and
    // recreated next run, so giving up on a drop only leaks one disposable database.
    let connected = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_postgres::connect(&libpq_url(maint_db_url), tokio_postgres::NoTls),
    )
    .await;
    match connected {
        Err(_) => error!("timed out connecting to drop benchmark database {db_name}"),
        Ok(Ok((client, connection))) => {
            let client: tokio_postgres::Client = client;
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    error!("postgres connection error during drop: {e}");
                }
            });
            let _ = client
                .execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
                    &[&db_name],
                )
                .await;
            let quoted = format!("\"{}\"", db_name.replace('"', "\"\""));
            let _ = client
                .batch_execute(&format!("DROP DATABASE IF EXISTS {}", quoted))
                .await;
            *db_created.lock().await = false;
        }
        Ok(Err(e)) => {
            error!("failed to drop benchmark database {db_name}: {e}");
        }
    }
}

const DEV_AUTH_SECRET: &str = "better-auth-secret-12345678901234567890";
const DEFAULT_ADMIN_EMAIL: &str = "admin@example.com";
const DEFAULT_ADMIN_PASSWORD: &str = "password";
/// The dedicated bench Postgres the runner provisions when no external one is configured.
/// Credentials and port must match `archestra-bench/dev/docker-compose.bench-pg.yml`.
const DEFAULT_BENCH_DATABASE_URL: &str = "postgres://postgres:postgres@localhost:5544/postgres";
const BENCH_PG_COMPOSE_PROJECT: &str = "archestra-bench";

/// Process-env override that, when set, names the Dagger runner host explicitly and skips the
/// local resolution ladder (the prod-image / CI path supplies a `kube-pod://` host here).
const RUNNER_HOST_ENV: &str = "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST";
/// Dagger host published by the dev stack's Tilt kubectl port-forward (the resolution fallback).
const K8S_DAGGER_HOST: &str = "tcp://127.0.0.1:1234";
const K8S_DAGGER_PROBE_ADDR: &str = "127.0.0.1:1234";
/// Dagger host published by the runner-managed engine (`docker-compose.bench-dagger.yml`).
const MANAGED_DAGGER_HOST: &str = "tcp://127.0.0.1:1245";
const MANAGED_DAGGER_PROBE_ADDR: &str = "127.0.0.1:1245";
const BENCH_DAGGER_COMPOSE_PROJECT: &str = "archestra-bench-dagger";
/// The image whose presence gates the managed tier; the tag is read from the compose file so the
/// engine version lives in exactly one place (kept in sync by scripts/check-dagger-version-sync.sh).
const DAGGER_ENGINE_IMAGE: &str = "registry.dagger.io/engine";
/// How long the managed engine has to start listening after `docker compose up` before we give up.
const MANAGED_DAGGER_WAIT: Duration = Duration::from_secs(30);

/// Provision the dedicated bench Postgres at most once per process. Isolated lanes call
/// [`Instance::start`] concurrently, so this serializes the `docker compose up` across them.
static BENCH_PG_READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
/// Provision the runner-managed Dagger engine at most once per process (same rationale as above).
static BENCH_DAGGER_READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
/// The Dagger runner host. The first *successful* resolution is cached and shared across all lanes
/// so they cannot split across tiers within a run; a failed attempt does not poison the cell
/// (`get_or_try_init` leaves it empty on `Err`), so a transient hiccup lets the next lane re-resolve.
static RESOLVED_RUNNER_HOST: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("postgres error: {0}")]
    Postgres(String),
    #[error("migration failed ({code}): {message}")]
    Migration { code: i32, message: String },
    #[error("backend not ready: {0}")]
    NotReady(String),
    #[error("backend exited early (code {code}): {message}")]
    EarlyExit { code: i32, message: String },
    #[error("config error: {0}")]
    Config(String),
    #[error("dagger unavailable: {0}")]
    DaggerUnavailable(String),
}

pub struct Instance {
    run_id: String,
    log_path: PathBuf,
    ready_timeout_s: f64,
    pub base_url: String,
    pub client: EvalClient,
    proc: Arc<Mutex<Option<Child>>>,
    db_name: String,
    db_created: Arc<Mutex<bool>>,
    platform: PathBuf,
    env: HashMap<String, String>,
    maint_db_url: String,
    db_url: String,
    db_managed: bool,
    api_port: u16,
    metrics_port: u16,
    bench_compose: PathBuf,
    dagger_compose: PathBuf,
    dagger_runner_host: String,
    teardown_id: Option<u64>,
}

impl Instance {
    /// `platform_dir`, when set, *is* the platform directory directly (the prod image lays the app out
    /// at `/app`, not `<repo>/platform`); unset falls back to today's `repo_root/platform`. The bench
    /// Postgres compose file is only used in the runner-managed local path, so it always derives from
    /// `repo_root`.
    pub fn new(
        repo_root: PathBuf,
        platform_dir: Option<PathBuf>,
        run_id: impl Into<String>,
        log_path: PathBuf,
    ) -> Self {
        let run_id = run_id.into();
        let platform = resolve_platform_dir(platform_dir.as_deref(), &repo_root);
        let bench_dev = repo_root.join("archestra-bench").join("dev");
        let bench_compose = bench_dev.join("docker-compose.bench-pg.yml");
        let dagger_compose = bench_dev.join("docker-compose.bench-dagger.yml");
        Self {
            run_id,
            log_path,
            ready_timeout_s: 300.0,
            base_url: String::new(),
            client: EvalClient::new("http://localhost:0", None),
            proc: Arc::new(Mutex::new(None)),
            db_name: String::new(),
            db_created: Arc::new(Mutex::new(false)),
            platform,
            env: HashMap::new(),
            maint_db_url: String::new(),
            db_url: String::new(),
            db_managed: true,
            api_port: 0,
            metrics_port: 0,
            bench_compose,
            dagger_compose,
            dagger_runner_host: String::new(),
            teardown_id: None,
        }
    }

    pub async fn start(&mut self) -> Result<(), LifecycleError> {
        self.env = load_platform_env(&self.platform)?;
        let (bench_db_url, managed) = resolve_bench_db_url(&self.env);
        self.db_managed = managed;
        info!(
            "bench Postgres: {} ({})",
            redacted_db_location(&bench_db_url),
            if managed {
                "runner-managed container"
            } else {
                "external (ARCHESTRA_BENCH_DATABASE_URL)"
            }
        );
        if managed {
            ensure_bench_postgres(&self.bench_compose).await?;
        }
        self.maint_db_url = bench_db_url;
        self.db_name = benchmark_db_name(&self.run_id);
        self.db_url = with_dbname(&self.maint_db_url, &self.db_name);
        self.api_port = free_port().await?;
        self.metrics_port = free_port().await?;

        // Resolve the Dagger runner host before anything reads `backend_env()` (migrate, spawn). A
        // broken sandbox fails fast here instead of booting a backend that can never run a command.
        // No per-run side effect has happened yet, so a failure just propagates with nothing to undo.
        self.dagger_runner_host = resolve_runner_host(&self.dagger_compose).await?;

        // Register teardown BEFORE the first side effect (database creation): an interruption during a
        // partial boot must still kill the process group and drop the database.
        self.teardown_id = Some(register(Teardown::Backend {
            proc: self.proc.clone(),
            db_created: self.db_created.clone(),
            db_name: self.db_name.clone(),
            maint_db_url: self.maint_db_url.clone(),
        }));

        if let Err(e) = self.create_database().await {
            let _ = self.shutdown().await;
            return Err(e);
        }
        if let Err(e) = self.migrate().await {
            let _ = self.shutdown().await;
            return Err(e);
        }
        if let Err(e) = self.spawn_backend().await {
            let _ = self.shutdown().await;
            return Err(e);
        }
        if let Err(e) = self.connect().await {
            let _ = self.shutdown().await;
            return Err(e);
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), LifecycleError> {
        kill_backend(&self.proc).await;
        drop_database(&self.db_created, &self.db_name, &self.maint_db_url).await;
        if let Some(id) = self.teardown_id {
            deregister(id);
        }
        Ok(())
    }

    async fn create_database(&self) -> Result<(), LifecycleError> {
        info!("creating benchmark database {}", self.db_name);
        let (client, connection): (tokio_postgres::Client, _) =
            tokio_postgres::connect(&libpq_url(&self.maint_db_url), tokio_postgres::NoTls)
                .await
                .map_err(|e| {
                    LifecycleError::Postgres(bench_postgres_unavailable_message(
                        &self.maint_db_url,
                        self.db_managed,
                        e,
                    ))
                })?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                error!("postgres connection error: {e}");
            }
        });
        let quoted = format!("\"{}\"", self.db_name.replace('"', "\"\""));
        // Mark created BEFORE issuing CREATE, deliberately. Teardown's drop is `DROP DATABASE IF EXISTS`
        // (idempotent), so attempting it is always safe; marking first guarantees teardown attempts the
        // drop even if a signal cancels this future mid-CREATE. The alternative (mark after success)
        // leaks the db if a signal lands in the gap between CREATE completing and the flag being set.
        // Residual, inherent to async cancellation: if a cancelled CREATE still executes server-side
        // *after* teardown's drop ran, one uniquely-named db (archestra_bench_<run-id>) can be orphaned
        // — never data corruption, and bounded to a single signal-timing window per run.
        *self.db_created.lock().await = true;
        client
            .batch_execute(&format!("CREATE DATABASE {}", quoted))
            .await
            .map_err(|e| LifecycleError::Postgres(format!("CREATE DATABASE failed: {e}")))?;
        Ok(())
    }

    async fn migrate(&self) -> Result<(), LifecycleError> {
        info!("migrating {}", self.db_name);
        // The prod image has no pnpm; `ARCHESTRA_BENCH_MIGRATE_CMD` lets the image run drizzle-kit
        // directly. The command runs via `sh -c` in the platform dir with the backend env (so
        // `ARCHESTRA_DATABASE_URL` points at the per-run database). Unset → today's pnpm invocation.
        let mut command = match migrate_cmd_override() {
            Some(cmd) => {
                let mut c = Command::new("sh");
                c.arg("-c").arg(cmd);
                c
            }
            None => {
                let mut c = Command::new("pnpm");
                c.args(["--filter", "@backend", "db:migrate"]);
                c
            }
        };
        let output = command
            .current_dir(&self.platform)
            .envs(self.backend_env())
            .output()
            .await?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr)
                .to_string()
                .lines()
                .chain(String::from_utf8_lossy(&output.stdout).to_string().lines())
                .collect::<Vec<_>>()
                .join("\n");
            return Err(LifecycleError::Migration {
                code: output.status.code().unwrap_or(-1),
                message,
            });
        }
        Ok(())
    }

    async fn spawn_backend(&mut self) -> Result<(), LifecycleError> {
        let backend_dir = self.platform.join("backend");
        let server_bundle = backend_dir.join("dist").join("server.mjs");
        if !server_bundle.is_file() {
            return Err(LifecycleError::Config(format!(
                "{} not found; is the main dev stack built and running?",
                server_bundle.display()
            )));
        }
        self.base_url = format!("http://localhost:{}", self.api_port);
        info!(
            "spawning backend on {} (log: {})",
            self.base_url,
            self.log_path.display()
        );
        if let Some(parent) = self.log_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let log_file = std::fs::File::create(&self.log_path)?;
        let mut cmd = Command::new("node");
        cmd.arg("dist/server.mjs")
            .current_dir(&backend_dir)
            .envs(self.backend_env())
            .stdout(log_file.try_clone()?)
            .stderr(log_file)
            .process_group(0);
        let child = cmd.spawn()?;
        *self.proc.lock().await = Some(child);
        Ok(())
    }

    async fn connect(&mut self) -> Result<(), LifecycleError> {
        self.client = EvalClient::new(&self.base_url, None);
        let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(self.ready_timeout_s);
        let mut last: Option<String>;
        loop {
            if let Some(status) = self
                .proc
                .lock()
                .await
                .as_mut()
                .and_then(|p| p.try_wait().ok().flatten())
            {
                let message = format!("backend exited early; see {}", self.log_path.display());
                return Err(LifecycleError::EarlyExit {
                    code: status.code().unwrap_or(-1),
                    message,
                });
            }
            match classify_ready_poll(self.client.wait_ready(5.0, 1.0).await) {
                ReadyPoll::Ready => break,
                ReadyPoll::Terminal(msg) => return Err(LifecycleError::NotReady(msg)),
                ReadyPoll::Retry(msg) => last = Some(msg),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(LifecycleError::NotReady(format!(
                    "backend not ready in {}s; last: {}",
                    self.ready_timeout_s,
                    last.as_deref().unwrap_or("no response")
                )));
            }
            sleep(Duration::from_secs_f64(2.0)).await;
        }

        let email = self
            .env
            .get("ARCHESTRA_AUTH_ADMIN_EMAIL")
            .map(|s| s.as_str())
            .unwrap_or(DEFAULT_ADMIN_EMAIL);
        let password = self
            .env
            .get("ARCHESTRA_AUTH_ADMIN_PASSWORD")
            .map(|s| s.as_str())
            .unwrap_or(DEFAULT_ADMIN_PASSWORD);
        self.client
            .sign_in(email, password)
            .await
            .map_err(|e| LifecycleError::Config(format!("sign_in failed: {e}")))?;
        self.client
            .mint_api_key("archestra-bench")
            .await
            .map_err(|e| LifecycleError::Config(format!("mint_api_key failed: {e}")))?;
        Ok(())
    }

    fn backend_env(&self) -> HashMap<String, String> {
        build_backend_env(
            &self.env,
            &self.db_url,
            &self.base_url,
            self.metrics_port,
            &self.dagger_runner_host,
            &self
                .platform
                .join("dev")
                .join("bin")
                .join("dagger")
                .to_string_lossy(),
        )
    }
}

/// Outcome of one readiness poll inside `connect`'s loop. Split out so the terminal-vs-retry
/// decision is unit-testable: a fatal sandbox must abort immediately, not retry until the deadline.
enum ReadyPoll {
    Ready,
    Terminal(String),
    Retry(String),
}

fn classify_ready_poll<T>(result: Result<T, ClientError>) -> ReadyPoll {
    match result {
        Ok(_) => ReadyPoll::Ready,
        Err(ClientError::Api(e)) if (400..500).contains(&e.status) => {
            ReadyPoll::Terminal(e.to_string())
        }
        // A broken sandbox cannot recover by retrying (the boot status is frozen during the poll),
        // so abort now instead of burning the whole readiness deadline.
        Err(e @ ClientError::SandboxFatal(_)) => ReadyPoll::Terminal(e.to_string()),
        Err(e) => ReadyPoll::Retry(e.to_string()),
    }
}

const ENV_VAR_REF_RE: &str = r"\$\{(\w+)\}|\$(\w+)";

fn expand_env_refs(value: &str, lookup: &HashMap<String, String>) -> String {
    let re = regex::Regex::new(ENV_VAR_REF_RE).expect("valid regex");
    re.replace_all(value, |caps: &regex::Captures| {
        let key = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        lookup.get(key).cloned().unwrap_or_default()
    })
    .to_string()
}

/// Resolve the platform directory: an explicit `--platform-dir` (the prod image lays the app out at
/// `/app`) wins, otherwise `<repo_root>/platform` for the dev tree.
pub fn resolve_platform_dir(platform_dir: Option<&Path>, repo_root: &Path) -> PathBuf {
    platform_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo_root.join("platform"))
}

/// Load `<platform>/.env` into a map, requiring the file to exist. Centralizes the
/// "missing `.env` is a config error, then parse" step shared by `start`, `preflight`, and the
/// runner's lane-key resolution so the operator-facing message stays in one place.
pub fn load_platform_env(platform: &Path) -> Result<HashMap<String, String>, LifecycleError> {
    let env_path = platform.join(".env");
    if !env_path.is_file() {
        return Err(LifecycleError::Config(format!(
            "{} not found; create it from platform/.env.example or start the dev stack",
            env_path.display()
        )));
    }
    parse_env_file(&env_path)
}

pub fn parse_env_file(path: &Path) -> Result<HashMap<String, String>, LifecycleError> {
    let text = std::fs::read_to_string(path)?;
    let mut env: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let stripped = line.trim();
        if stripped.is_empty() || stripped.starts_with('#') || !stripped.contains('=') {
            continue;
        }
        let (key, value) = stripped.split_once('=').unwrap_or((stripped, ""));
        let mut combined = std::env::vars().collect::<HashMap<_, _>>();
        combined.extend(env.clone());
        let value = expand_env_refs(value.trim().trim_matches('"').trim_matches('\''), &combined);
        env.insert(key.trim().to_string(), value);
    }
    Ok(env)
}

pub fn benchmark_db_name(run_id: &str) -> String {
    let safe: String = run_id
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let safe = safe.trim_matches('_');
    format!(
        "archestra_bench_{}",
        if safe.is_empty() { "run" } else { safe }
    )
}

pub fn libpq_url(db_url: &str) -> String {
    match url::Url::parse(db_url) {
        Ok(mut parsed) => {
            parsed.set_query(None);
            parsed.to_string()
        }
        Err(_) => db_url.to_string(),
    }
}

pub fn with_dbname(db_url: &str, dbname: &str) -> String {
    let mut parsed = url::Url::parse(db_url)
        .unwrap_or_else(|_| url::Url::parse(&format!("postgres://localhost/{db_url}")).unwrap());
    parsed.set_path(&format!("/{dbname}"));
    parsed.to_string()
}

/// Resolve the Postgres the benchmark uses, and whether the runner owns its lifecycle.
/// An explicit `ARCHESTRA_BENCH_DATABASE_URL` (process env or `.env`) points at a Postgres the
/// operator manages — the runner leaves it alone. Otherwise it defaults to, and provisions, the
/// dedicated container in `docker-compose.bench-pg.yml`, bypassing the dev stack's slow port-forward.
fn resolve_bench_db_url(env: &HashMap<String, String>) -> (String, bool) {
    let explicit = std::env::var("ARCHESTRA_BENCH_DATABASE_URL")
        .ok()
        .or_else(|| env.get("ARCHESTRA_BENCH_DATABASE_URL").cloned())
        .filter(|s| !s.trim().is_empty());
    match explicit {
        Some(url) => (url, false),
        None => (DEFAULT_BENCH_DATABASE_URL.to_string(), true),
    }
}

/// Bring the dedicated bench Postgres up and block until it is healthy. Idempotent: `docker compose
/// up -d --wait` reconciles an already-running container and returns fast, and [`BENCH_PG_READY`]
/// collapses concurrent callers into a single invocation.
/// Failure of [`compose_up`], split so each caller can map the two cases onto its own error type:
/// Docker couldn't be invoked at all, or the `up` ran but exited non-zero (stderr carried).
enum ComposeUpError {
    Spawn(std::io::Error),
    Exit(String),
}

/// `docker compose -p <project> -f <file> up -d [extra]`, left detached. The shared primitive behind
/// both bench sidecars (Postgres and the managed Dagger engine); each wraps it with its own
/// `OnceCell`, error variant, and readiness step.
async fn compose_up(
    project: &str,
    compose_file: &Path,
    extra: &[&str],
) -> Result<(), ComposeUpError> {
    let compose = compose_file.to_string_lossy();
    let output = Command::new("docker")
        .args(["compose", "-p", project, "-f"])
        .arg(compose.as_ref())
        .args(["up", "-d"])
        .args(extra)
        .output()
        .await
        .map_err(ComposeUpError::Spawn)?;
    if !output.status.success() {
        return Err(ComposeUpError::Exit(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

/// Assert the run-wide sandbox preconditions once, before any rollout boots a backend: the managed
/// bench Postgres must come up and the Dagger runner host must resolve. A broken sandbox aborts the
/// whole run here with a single error instead of every per-(task × lane) backend boot failing the
/// same way and fanning out one `agent_error` result each. Reuses the same memoized resolution as
/// [`Instance::start`] (`BENCH_PG_READY` / `RESOLVED_RUNNER_HOST` / `BENCH_DAGGER_READY`), so a
/// healthy run pays nothing — the per-instance calls that follow are cache hits. Asserts
/// preconditions only: it must not create a database, migrate, or spawn a backend. An external
/// `ARCHESTRA_BENCH_DATABASE_URL` is not probed here (it is first reached at `create_database`).
pub async fn preflight(
    repo_root: &Path,
    platform_dir: Option<&Path>,
) -> Result<(), LifecycleError> {
    let platform = resolve_platform_dir(platform_dir, repo_root);
    let (_bench_db_url, managed) = resolve_bench_db_url(&load_platform_env(&platform)?);
    let bench_dev = repo_root.join("archestra-bench").join("dev");
    if managed {
        ensure_bench_postgres(&bench_dev.join("docker-compose.bench-pg.yml")).await?;
    }
    resolve_runner_host(&bench_dev.join("docker-compose.bench-dagger.yml")).await?;
    Ok(())
}

async fn ensure_bench_postgres(compose_file: &Path) -> Result<(), LifecycleError> {
    BENCH_PG_READY
        .get_or_try_init(|| async {
            info!(
                "ensuring dedicated bench Postgres ({})",
                compose_file.display()
            );
            compose_up(BENCH_PG_COMPOSE_PROJECT, compose_file, &["--wait"])
                .await
                .map_err(|e| match e {
                    ComposeUpError::Spawn(e) => LifecycleError::Config(format!(
                        "failed to run `docker compose` for the bench Postgres (is Docker installed and running?): {e}"
                    )),
                    ComposeUpError::Exit(stderr) => LifecycleError::Postgres(format!(
                        "could not start the dedicated bench Postgres: {stderr}"
                    )),
                })
        })
        .await
        .copied()
}

pub fn bench_postgres_unavailable_message(
    db_url: &str,
    managed: bool,
    _error: impl std::fmt::Display,
) -> String {
    let location = redacted_db_location(db_url);
    if managed {
        format!(
            "cannot connect to the runner-managed bench Postgres at {location}; ensure Docker is running so `docker compose` can provision it, or set ARCHESTRA_BENCH_DATABASE_URL to a Postgres you manage"
        )
    } else {
        format!(
            "cannot connect to the bench Postgres at {location} from ARCHESTRA_BENCH_DATABASE_URL; ensure it is reachable, or unset it to let the runner provision a dedicated container"
        )
    }
}

/// Which local-ladder tier to use, decided purely from booleans so it is unit-testable. The explicit
/// override is handled before this (it short-circuits the whole ladder), so it isn't a variant here.
#[derive(Debug, PartialEq, Eq)]
enum RunnerChoice {
    Managed,
    K8s,
    None,
}

/// The local resolution ladder (no I/O): the runner-managed engine when Docker can run it and the
/// image is already pulled; else the dev-stack port-forward when it is listening; else nothing.
fn decide_runner(managed_runnable: bool, k8s_open: bool) -> RunnerChoice {
    match (managed_runnable, k8s_open) {
        (true, _) => RunnerChoice::Managed,
        (false, true) => RunnerChoice::K8s,
        (false, false) => RunnerChoice::None,
    }
}

/// Resolve the Dagger runner host and share the first successful result across all lanes, so a run
/// cannot end up split across tiers. Memoized in [`RESOLVED_RUNNER_HOST`] (failures are not cached).
async fn resolve_runner_host(dagger_compose: &Path) -> Result<String, LifecycleError> {
    RESOLVED_RUNNER_HOST
        .get_or_try_init(|| async {
            // The explicit override wins outright and must not depend on the local compose file (the
            // prod image sets a `kube-pod://` host and ships no compose), so return before reading it.
            if let Some(host) = env_override(RUNNER_HOST_ENV) {
                info!("sandbox: explicit Dagger runner host {host} (ladder skipped)");
                return Ok(host);
            }
            // Only the local ladder needs the engine tag; reading it here lets a misconfigured compose
            // fail clearly, and the `image_present` probe and the unavailable message share one source.
            let tag = engine_tag(dagger_compose)?;
            let managed_runnable = docker_running().await && image_present(&tag).await;
            // Don't probe k8s once the managed engine is chosen.
            let k8s_open =
                !managed_runnable && tcp_open(K8S_DAGGER_PROBE_ADDR, Duration::from_secs(1)).await;
            match decide_runner(managed_runnable, k8s_open) {
                RunnerChoice::Managed => {
                    ensure_bench_dagger(dagger_compose).await?;
                    info!("sandbox: runner-managed Dagger engine on {MANAGED_DAGGER_HOST}");
                    Ok(MANAGED_DAGGER_HOST.to_string())
                }
                RunnerChoice::K8s => {
                    info!("sandbox: dev-stack Dagger port-forward on {K8S_DAGGER_HOST}");
                    Ok(K8S_DAGGER_HOST.to_string())
                }
                RunnerChoice::None => Err(dagger_unavailable_resolution(&tag)),
            }
        })
        .await
        .cloned()
}

/// Provision the runner-managed Dagger engine at most once per process; left running between runs so
/// the buildkit cache stays warm (`docker-compose.bench-dagger.yml` documents how to stop + prune).
async fn ensure_bench_dagger(compose_file: &Path) -> Result<(), LifecycleError> {
    BENCH_DAGGER_READY
        .get_or_try_init(|| async {
            info!(
                "ensuring runner-managed Dagger engine ({})",
                compose_file.display()
            );
            compose_up(BENCH_DAGGER_COMPOSE_PROJECT, compose_file, &[])
                .await
                .map_err(|e| match e {
                    ComposeUpError::Spawn(e) => LifecycleError::DaggerUnavailable(format!(
                        "failed to run `docker compose` for the managed Dagger engine (is Docker running?): {e}"
                    )),
                    ComposeUpError::Exit(stderr) => LifecycleError::DaggerUnavailable(format!(
                        "could not start the runner-managed Dagger engine: {stderr}"
                    )),
                })?;
            // `docker compose up` returns once the container is running, not once the engine has
            // bound its TCP port; poll the published port directly (the engine image ships no usable
            // in-container health tool to hang a compose `--wait` healthcheck on).
            wait_tcp(MANAGED_DAGGER_PROBE_ADDR, MANAGED_DAGGER_WAIT).await
        })
        .await
        .copied()
}

/// The managed engine's container logs, streamed to `<root_run_dir>/dagger.engine.log` so an engine
/// crash mid-run is root-causeable (OOM vs panic) and correlatable with the backend log's timestamps.
const DAGGER_ENGINE_LOG_FILE: &str = "dagger.engine.log";

/// A running managed-engine log follower. Stopped explicitly at run end via [`Self::stop`]; also
/// registered in the teardown registry so SIGINT/SIGTERM reaps it. Stopping deregisters first, so the
/// signal path and the normal path never double-kill.
pub struct DaggerLogsGuard {
    teardown_id: u64,
    proc: Arc<Mutex<Option<Child>>>,
}

impl DaggerLogsGuard {
    /// Kill the follower and drop it from the teardown registry. Idempotent — a later `shutdown_all`
    /// finds the child already taken and the id already gone.
    pub async fn stop(self) {
        kill_child(&self.proc, "managed Dagger engine log follower").await;
        deregister(self.teardown_id);
    }
}

/// Stream the managed Dagger engine's logs into the run dir for the duration of the run, returning a
/// guard the caller stops at run end (`None` when capture was skipped or could not start).
///
/// MANAGED TIER ONLY: the engine is a local `docker compose` container we can `logs -f`. For the k8s
/// port-forward tier and explicit `kube-pod://`/env-override hosts there is no local container to
/// follow — log a one-line note and skip. Resolution must already have run (`resolve_runner_host`),
/// so this reads the cached host rather than re-deciding.
///
/// NON-FATAL: this is pure diagnostics. If `docker`/compose is missing or the follower fails to
/// spawn, warn and continue — never fail or block a run on log capture. The follower also joins the
/// teardown registry, so SIGINT/SIGTERM reaps it even before [`DaggerLogsGuard::stop`] runs.
pub async fn capture_managed_dagger_logs(
    dagger_compose: &Path,
    root_run_dir: &Path,
) -> Option<DaggerLogsGuard> {
    if RESOLVED_RUNNER_HOST.get().map(String::as_str) != Some(MANAGED_DAGGER_HOST) {
        info!("sandbox: engine-log capture is managed-tier only; skipped for the resolved host");
        return None;
    }
    match spawn_dagger_log_follower(dagger_compose, root_run_dir).await {
        Ok(guard) => Some(guard),
        Err(e) => {
            warn!("could not capture managed Dagger engine logs (continuing): {e}");
            None
        }
    }
}

/// Spawn the detached `docker compose ... logs -f --no-color --timestamps` follower, teeing both
/// stdout and stderr into `dagger.engine.log` (mirrors the backend log tee). Streaming (not a
/// teardown snapshot) so lines survive an engine container crash/recreate mid-run. `--timestamps`
/// aligns engine lines with the backend log.
async fn spawn_dagger_log_follower(
    dagger_compose: &Path,
    root_run_dir: &Path,
) -> Result<DaggerLogsGuard, std::io::Error> {
    let log_path = root_run_dir.join(DAGGER_ENGINE_LOG_FILE);
    let log_file = std::fs::File::create(&log_path)?;
    info!(
        "capturing managed Dagger engine logs ({})",
        log_path.display()
    );
    let mut cmd = Command::new("docker");
    cmd.args(["compose", "-p", BENCH_DAGGER_COMPOSE_PROJECT, "-f"])
        .arg(dagger_compose)
        .args(["logs", "-f", "--no-color", "--timestamps"])
        .stdout(log_file.try_clone()?)
        .stderr(log_file)
        .stdin(std::process::Stdio::null())
        .process_group(0);
    let child = cmd.spawn()?;
    let proc = Arc::new(Mutex::new(Some(child)));
    let teardown_id = register(Teardown::DaggerLogs { proc: proc.clone() });
    Ok(DaggerLogsGuard { teardown_id, proc })
}

/// Names what the resolution ladder tried and how to fix it, in the style of
/// [`bench_postgres_unavailable_message`].
fn dagger_unavailable_resolution(tag: &str) -> LifecycleError {
    LifecycleError::DaggerUnavailable(format!(
        "no Dagger runner host available: the managed engine needs Docker running and \
         `{DAGGER_ENGINE_IMAGE}:{tag}` pulled (`docker pull {DAGGER_ENGINE_IMAGE}:{tag}`), and the \
         dev-stack port-forward was not listening on {K8S_DAGGER_PROBE_ADDR} (is `tilt up` running?). \
         Set {RUNNER_HOST_ENV} to a Dagger engine you manage to bypass resolution"
    ))
}

/// Read the engine image tag from the compose file so the version lives in exactly one place.
fn engine_tag(compose_file: &Path) -> Result<String, LifecycleError> {
    let contents = std::fs::read_to_string(compose_file).map_err(|e| {
        LifecycleError::DaggerUnavailable(format!(
            "cannot read the managed-engine compose file {}: {e}",
            compose_file.display()
        ))
    })?;
    let marker = format!("{DAGGER_ENGINE_IMAGE}:");
    contents
        .lines()
        .map(str::trim_start)
        // Only the `image:` key — never a comment that mentions the image (the marker appears in
        // this file's own header), and never a trailing comment on the value.
        .filter(|line| line.starts_with("image:"))
        .find_map(|line| line.split_once(marker.as_str()))
        .and_then(|(_, rest)| rest.split_whitespace().next())
        .map(|tag| tag.trim_matches('"').to_string())
        .filter(|tag| !tag.is_empty())
        .ok_or_else(|| {
            LifecycleError::DaggerUnavailable(format!(
                "could not find an `image: {DAGGER_ENGINE_IMAGE}:<tag>` line in {}",
                compose_file.display()
            ))
        })
}

/// `docker info` succeeds only when the daemon is reachable.
async fn docker_running() -> bool {
    Command::new("docker")
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `docker image inspect` succeeds only when the image is already pulled locally (we never pull).
async fn image_present(tag: &str) -> bool {
    let reference = format!("{DAGGER_ENGINE_IMAGE}:{tag}");
    Command::new("docker")
        .args(["image", "inspect", &reference])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// True if a TCP connection to `addr` completes within `timeout`.
async fn tcp_open(addr: &str, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Poll `addr` until it accepts a connection or `total` elapses.
async fn wait_tcp(addr: &str, total: Duration) -> Result<(), LifecycleError> {
    let deadline = tokio::time::Instant::now() + total;
    loop {
        if tcp_open(addr, Duration::from_secs(1)).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(LifecycleError::DaggerUnavailable(format!(
                "managed Dagger engine did not start listening on {addr} within {}s",
                total.as_secs()
            )));
        }
        sleep(Duration::from_millis(200)).await;
    }
}

pub fn redacted_db_location(db_url: &str) -> String {
    let parsed = url::Url::parse(db_url).ok();
    let host = parsed
        .as_ref()
        .and_then(|u| u.host_str())
        .unwrap_or("<unknown-host>");
    let port = parsed
        .as_ref()
        .and_then(|u| u.port())
        .map(|p| format!(":{p}"))
        .unwrap_or_default();
    let database = parsed
        .as_ref()
        .map(|u| u.path().trim_start_matches('/'))
        .unwrap_or("<unknown-database>");
    format!("{host}{port}/{database}")
}

pub fn build_backend_env(
    base_env: &HashMap<String, String>,
    db_url: &str,
    api_base_url: &str,
    metrics_port: u16,
    dagger_runner_host: &str,
    dagger_cli_bin: &str,
) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.extend(base_env.iter().map(|(k, v)| (k.clone(), v.clone())));
    env.entry("ARCHESTRA_AUTH_SECRET".to_string())
        .or_insert_with(|| DEV_AUTH_SECRET.to_string());
    env.insert("ARCHESTRA_DATABASE_URL".to_string(), db_url.to_string());
    env.insert(
        "ARCHESTRA_INTERNAL_API_BASE_URL".to_string(),
        api_base_url.to_string(),
    );
    env.insert(
        "ARCHESTRA_METRICS_PORT".to_string(),
        metrics_port.to_string(),
    );
    env.insert(
        "ARCHESTRA_CODE_RUNTIME_ENABLED".to_string(),
        "true".to_string(),
    );
    // These two keys are always force-set (the dev default points the backend at the local Dagger
    // engine), so `/app/.env` cannot steer them — the prod image delivers them through the process
    // env instead, which this honors over the dev default.
    //
    // The runner host arrives already resolved (`resolve_runner_host`): explicit process-env
    // override, else the managed engine, else the k8s port-forward. The CLI-bin override still lives
    // here because it has nothing to resolve — it is a plain process-env-or-default.
    env.insert(RUNNER_HOST_ENV.to_string(), dagger_runner_host.to_string());
    env.insert(
        "ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN".to_string(),
        env_override("ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN")
            .unwrap_or_else(|| dagger_cli_bin.to_string()),
    );
    env.insert("ARCHESTRA_ANALYTICS".to_string(), "disabled".to_string());
    // Per-lane projects isolate file ownership so lanes sharing one backend don't collide on common
    // artifact names; the feature must be on for `POST /api/projects` and project-scoped conversations.
    env.insert("ARCHESTRA_PROJECTS_ENABLED".to_string(), "true".to_string());
    // MCP Apps and agent environments ship dark behind these flags; the bench turns them on for every
    // env (like the sandbox/projects flags above) so a run never depends on the operator's `.env` or
    // `ARCHESTRA_BETA`. With Apps on, the platform assigns the app authoring tools to every agent at
    // creation time (AgentModel.create -> assignAppToolsToAgent), independent of the bench's
    // auto-assignment toggle, so non-apps agents carry them too. That mirrors the real product -- a
    // user with Apps enabled has those tools -- and under the default search_and_run_only exposure
    // they sit behind search_tools rather than in the upfront context, acting as realistic distractors.
    env.insert("ARCHESTRA_APPS_ENABLED".to_string(), "true".to_string());
    env.insert(
        "ARCHESTRA_AGENTS_ENVIRONMENTS_ENABLED".to_string(),
        "true".to_string(),
    );
    env
}

/// Treat an empty/whitespace value as unset so an exported-but-blank container env var falls back to
/// the default rather than wiping it.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

/// Read a process-env override (empty/whitespace → unset).
fn env_override(key: &str) -> Option<String> {
    non_empty(std::env::var(key).ok())
}

/// The migration command to run instead of the dev `pnpm --filter @backend db:migrate`, if set.
fn migrate_cmd_override() -> Option<String> {
    env_override("ARCHESTRA_BENCH_MIGRATE_CMD")
}

async fn free_port() -> Result<u16, LifecycleError> {
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    Ok(listener.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes tests that touch the global teardown registry, since `shutdown_all` drains it
    /// wholesale — without this, parallel registry tests would reap each other's children.
    fn registry_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    #[test]
    fn test_benchmark_db_name() {
        assert_eq!(
            benchmark_db_name("2024-01-01T12:00:00"),
            "archestra_bench_2024_01_01t12_00_00"
        );
    }

    #[test]
    fn test_libpq_url_drops_query() {
        assert_eq!(
            libpq_url("postgres://user:pass@host:5432/db?schema=public"),
            "postgres://user:pass@host:5432/db"
        );
    }

    #[test]
    fn test_with_dbname_preserves_query() {
        assert_eq!(
            with_dbname("postgres://user:pass@host:5432/db?schema=public", "bench"),
            "postgres://user:pass@host:5432/bench?schema=public"
        );
    }

    #[test]
    fn test_redacted_db_location() {
        assert_eq!(
            redacted_db_location("postgres://user:secret@host:5432/db"),
            "host:5432/db"
        );
    }

    #[tokio::test]
    async fn test_shutdown_all_kills_registered_process_group() {
        let _guard = registry_lock().lock().await;
        // Spawn a real child in its own process group, register a teardown for it (no DB — db_created
        // stays false so drop_database is a no-op), then verify shutdown_all reaps the process group.
        let mut cmd = Command::new("sleep");
        cmd.arg("60").process_group(0);
        let child = cmd.spawn().expect("spawn sleep");
        let pid = child.id().expect("child pid") as i32;

        let proc = Arc::new(Mutex::new(Some(child)));
        let id = register(Teardown::Backend {
            proc: proc.clone(),
            db_created: Arc::new(Mutex::new(false)),
            db_name: String::new(),
            maint_db_url: String::new(),
        });

        // process is alive before teardown
        assert!(signal::kill(Pid::from_raw(pid), None).is_ok());

        shutdown_all().await;

        // registry drained, child taken, and the process is gone (ESRCH)
        assert!(registry().lock().unwrap().get(&id).is_none());
        assert!(proc.lock().await.is_none());
        assert!(
            signal::kill(Pid::from_raw(pid), None).is_err(),
            "process group should be dead after shutdown_all"
        );
    }

    #[tokio::test]
    async fn test_shutdown_all_tears_down_concurrently() {
        let _guard = registry_lock().lock().await;
        // Two real children that trap SIGTERM and take ~2s to exit. Serial teardown would wait ~4s;
        // concurrent teardown is bounded by the slower single child (~2s). The wall-clock proves the
        // teardowns overlap (wide margin so it doesn't flake on a loaded CI box), and both process
        // groups must be reaped.
        fn spawn_slow_term_child() -> (Arc<Mutex<Option<Child>>>, i32) {
            let mut cmd = Command::new("sh");
            cmd.arg("-c")
                .arg("trap 'sleep 2; exit 0' TERM; sleep 30")
                .process_group(0);
            let child = cmd.spawn().expect("spawn sh");
            let pid = child.id().expect("child pid") as i32;
            (Arc::new(Mutex::new(Some(child))), pid)
        }

        let (proc_a, pid_a) = spawn_slow_term_child();
        let (proc_b, pid_b) = spawn_slow_term_child();
        for proc in [&proc_a, &proc_b] {
            register(Teardown::Backend {
                proc: proc.clone(),
                db_created: Arc::new(Mutex::new(false)),
                db_name: String::new(),
                maint_db_url: String::new(),
            });
        }

        let start = tokio::time::Instant::now();
        shutdown_all().await;
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_millis(3000),
            "teardowns should overlap (~2s), took {elapsed:?}"
        );
        for pid in [pid_a, pid_b] {
            assert!(
                signal::kill(Pid::from_raw(pid), None).is_err(),
                "process group {pid} should be dead after shutdown_all"
            );
        }
    }

    #[test]
    fn test_non_empty_treats_blank_as_unset() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some(String::new())), None);
        assert_eq!(non_empty(Some("   ".to_string())), None);
        assert_eq!(non_empty(Some("/app".to_string())), Some("/app".to_string()));
    }

    #[test]
    fn test_platform_dir_override_vs_default() {
        let repo = PathBuf::from("/repo");
        let log = PathBuf::from("/tmp/x.log");

        let default = Instance::new(repo.clone(), None, "rid", log.clone());
        assert_eq!(default.platform, repo.join("platform"));

        let overridden = Instance::new(repo, Some(PathBuf::from("/app")), "rid", log);
        assert_eq!(overridden.platform, PathBuf::from("/app"));
    }

    #[test]
    fn test_build_backend_env_force_sets_the_resolved_dagger_host() {
        // The runner host arrives already resolved and is force-set verbatim (the `.env` base map
        // cannot steer it); the CLI bin still falls back to the passed default when unset.
        let base = HashMap::new();
        let env = build_backend_env(
            &base,
            "postgres://h/db",
            "http://localhost:1",
            2,
            MANAGED_DAGGER_HOST,
            "/dev/dagger",
        );
        assert_eq!(
            env.get(RUNNER_HOST_ENV),
            Some(&MANAGED_DAGGER_HOST.to_string())
        );
        assert_eq!(
            env.get("ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN"),
            Some(&"/dev/dagger".to_string())
        );
    }

    #[test]
    fn test_build_backend_env_force_enables_apps_and_environments() {
        // Apps + agent environments are force-on for every env so a run doesn't depend on the
        // operator's `.env`/`ARCHESTRA_BETA`; the apps env's tools can't resolve without them.
        let base = HashMap::new();
        let env = build_backend_env(
            &base,
            "postgres://h/db",
            "http://localhost:1",
            2,
            MANAGED_DAGGER_HOST,
            "/dev/dagger",
        );
        assert_eq!(env.get("ARCHESTRA_APPS_ENABLED"), Some(&"true".to_string()));
        assert_eq!(
            env.get("ARCHESTRA_AGENTS_ENVIRONMENTS_ENABLED"),
            Some(&"true".to_string())
        );
    }

    #[test]
    fn test_classify_ready_poll_fatal_sandbox_aborts_but_transient_retries() {
        // The regression guard for the connect() loop: a fatal sandbox must be terminal (abort now),
        // while a plain Config (the normal "not ready yet" / inner-timeout signal) must keep polling.
        assert!(matches!(
            classify_ready_poll::<()>(Err(ClientError::SandboxFatal("sandbox unreachable".into()))),
            ReadyPoll::Terminal(_)
        ));
        assert!(matches!(
            classify_ready_poll::<()>(Err(ClientError::Config("not ready yet".into()))),
            ReadyPoll::Retry(_)
        ));
        assert!(matches!(classify_ready_poll(Ok(())), ReadyPoll::Ready));
    }

    #[test]
    fn test_decide_runner_prefers_managed_then_k8s_then_none() {
        assert_eq!(decide_runner(true, true), RunnerChoice::Managed);
        assert_eq!(decide_runner(true, false), RunnerChoice::Managed);
        assert_eq!(decide_runner(false, true), RunnerChoice::K8s);
        assert_eq!(decide_runner(false, false), RunnerChoice::None);
    }

    #[test]
    fn test_engine_tag_reads_the_image_line_not_a_comment() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("compose.yml");
        // A comment mentioning `registry.dagger.io/engine:<tag>` precedes the real image line (as in
        // the actual compose header) and a trailing comment follows the value — neither must leak in.
        std::fs::write(
            &path,
            "# see registry.dagger.io/engine:<tag>\nservices:\n  bench-dagger:\n    image: registry.dagger.io/engine:v9.9.9 # pinned\n",
        )
        .unwrap();
        assert_eq!(engine_tag(&path).unwrap(), "v9.9.9");
    }

    #[test]
    fn test_engine_tag_errors_when_image_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("compose.yml");
        std::fs::write(
            &path,
            "services:\n  bench-dagger:\n    image: postgres:18\n",
        )
        .unwrap();
        assert!(matches!(
            engine_tag(&path),
            Err(LifecycleError::DaggerUnavailable(_))
        ));
    }

    #[tokio::test]
    async fn test_docker_image_probe_reports_absent_image() {
        // Runtime-skip when Docker is not running so the suite never blocks on a daemon. When it is
        // running, exercise the real `docker image inspect` path with a tag that cannot exist — no
        // pull, no container, no leftover state. Booting the privileged engine end-to-end is left to
        // manual validation (it would leave a running container + cache volume behind).
        if !docker_running().await {
            return;
        }
        assert!(!image_present("v0.0.0-does-not-exist").await);
    }

    #[test]
    fn test_parse_env_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".env");
        std::fs::write(&path, "# comment\nFOO=bar\nBAZ=qux\n\nREF=$FOO/${BAZ}\n").unwrap();
        let env = parse_env_file(&path).unwrap();
        assert_eq!(env.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(env.get("REF"), Some(&"bar/qux".to_string()));
    }

    #[test]
    fn test_load_platform_env_missing_is_config_error() {
        let tmp = tempfile::tempdir().unwrap();
        let err = load_platform_env(tmp.path()).unwrap_err();
        assert!(matches!(err, LifecycleError::Config(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn test_preflight_missing_env_is_config_error() {
        // A missing platform `.env` is rejected before any Docker/Postgres I/O, mirroring
        // `Instance::start`'s check — so this exercises the preflight's error mapping with no
        // process boundaries to mock.
        let tmp = tempfile::tempdir().unwrap();
        let err = preflight(tmp.path(), Some(tmp.path())).await.unwrap_err();
        assert!(matches!(err, LifecycleError::Config(_)), "got {err:?}");
    }
}
