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
use tracing::{error, info};

use crate::client::EvalClient;

/// A self-contained teardown for one backend instance: the process-group child and the database
/// handle, decoupled from the `Instance` so cleanup can run even after the orchestration future is
/// dropped on signal cancellation. Cloning shares the same `Arc` state as the live `Instance`, and
/// running it twice is a no-op (the child is taken; the db_created flag is cleared).
#[derive(Clone)]
struct Teardown {
    proc: Arc<Mutex<Option<Child>>>,
    db_created: Arc<Mutex<bool>>,
    db_name: String,
    maint_db_url: String,
}

impl Teardown {
    async fn run(&self) {
        kill_backend(&self.proc).await;
        drop_database(&self.db_created, &self.db_name, &self.maint_db_url).await;
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
/// where the run future was dropped mid-flight so `Instance::shutdown` never ran. Awaits each teardown
/// so process groups are killed and databases dropped before the process exits — no leaks on cancel.
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
    for teardown in live {
        teardown.run().await;
    }
}

async fn kill_backend(proc: &Arc<Mutex<Option<Child>>>) {
    let mut guard = proc.lock().await;
    if let Some(mut child) = guard.take()
        && let Some(pid) = child.id()
    {
        info!("stopping backend pid {pid}");
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
    match tokio_postgres::connect(&libpq_url(maint_db_url), tokio_postgres::NoTls).await {
        Ok((client, connection)) => {
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
        Err(e) => {
            error!("failed to drop benchmark database {db_name}: {e}");
        }
    }
}

const DAGGER_RUNNER_HOST: &str = "tcp://127.0.0.1:1234";
const DEV_AUTH_SECRET: &str = "better-auth-secret-12345678901234567890";
const DEFAULT_ADMIN_EMAIL: &str = "admin@example.com";
const DEFAULT_ADMIN_PASSWORD: &str = "password";

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
    api_port: u16,
    metrics_port: u16,
    teardown_id: Option<u64>,
}

impl Instance {
    pub fn new(repo_root: PathBuf, run_id: impl Into<String>, log_path: PathBuf) -> Self {
        let run_id = run_id.into();
        let platform = repo_root.join("platform");
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
            api_port: 0,
            metrics_port: 0,
            teardown_id: None,
        }
    }

    pub async fn start(&mut self) -> Result<(), LifecycleError> {
        let env_path = self.platform.join(".env");
        if !env_path.is_file() {
            return Err(LifecycleError::Config(format!(
                "{} not found; create it from platform/.env.example or start the dev stack",
                env_path.display()
            )));
        }
        self.env = parse_env_file(&env_path)?;
        self.maint_db_url = self
            .env
            .get("ARCHESTRA_DATABASE_URL")
            .ok_or_else(|| {
                LifecycleError::Config("ARCHESTRA_DATABASE_URL not set in .env".to_string())
            })?
            .clone();
        self.db_name = benchmark_db_name(&self.run_id);
        self.db_url = with_dbname(&self.maint_db_url, &self.db_name);
        self.api_port = free_port().await?;
        self.metrics_port = free_port().await?;

        // Register teardown BEFORE the first side effect (database creation): an interruption during a
        // partial boot must still kill the process group and drop the database.
        self.teardown_id = Some(register(Teardown {
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
                    LifecycleError::Postgres(shared_postgres_unavailable_message(
                        &self.maint_db_url,
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
        let output = Command::new("pnpm")
            .args([
                &"--filter".to_string(),
                &"@backend".to_string(),
                &"db:migrate".to_string(),
            ])
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
            match self.client.wait_ready(5.0, 1.0).await {
                Ok(_) => break,
                Err(crate::client::ClientError::Api(e)) if (400..500).contains(&e.status) => {
                    return Err(LifecycleError::NotReady(e.to_string()));
                }
                Err(e) => {
                    last = Some(e.to_string());
                }
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
            &self
                .platform
                .join("dev")
                .join("bin")
                .join("dagger")
                .to_string_lossy(),
        )
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

pub fn shared_postgres_unavailable_message(db_url: &str, _error: impl std::fmt::Display) -> String {
    format!(
        "cannot connect to shared Archestra Postgres at {}; start the dev stack from platform/ with ARCHESTRA_CODE_RUNTIME_ENABLED=true and `tilt up`, or restore the configured Postgres port-forward",
        redacted_db_location(db_url)
    )
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
    env.insert(
        "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST".to_string(),
        DAGGER_RUNNER_HOST.to_string(),
    );
    env.insert(
        "ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN".to_string(),
        dagger_cli_bin.to_string(),
    );
    env.insert("ARCHESTRA_ANALYTICS".to_string(), "disabled".to_string());
    env
}

async fn free_port() -> Result<u16, LifecycleError> {
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    Ok(listener.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // Spawn a real child in its own process group, register a teardown for it (no DB — db_created
        // stays false so drop_database is a no-op), then verify shutdown_all reaps the process group.
        let mut cmd = Command::new("sleep");
        cmd.arg("60").process_group(0);
        let child = cmd.spawn().expect("spawn sleep");
        let pid = child.id().expect("child pid") as i32;

        let proc = Arc::new(Mutex::new(Some(child)));
        let id = register(Teardown {
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

    #[test]
    fn test_parse_env_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".env");
        std::fs::write(&path, "# comment\nFOO=bar\nBAZ=qux\n\nREF=$FOO/${BAZ}\n").unwrap();
        let env = parse_env_file(&path).unwrap();
        assert_eq!(env.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(env.get("REF"), Some(&"bar/qux".to_string()));
    }
}
