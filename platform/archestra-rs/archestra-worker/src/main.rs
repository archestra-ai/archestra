use std::{
    error::Error,
    io,
    path::PathBuf,
    time::{Duration, Instant},
};

use archestra_db::{
    PgPool,
    llm_usage_rollup::{Progress, Work, step},
    pilot_pool,
    tasks::{
        JobOutcome, PeriodicTask, TaskClaim, claim, finish_periodic, heartbeat, recover_periodic,
    },
};
use tokio::{
    signal::unix::{SignalKind, signal},
    time::{interval, sleep, timeout},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const ROLLUP: PeriodicTask<'static> = PeriodicTask {
    task_type: "llm_usage_rollup",
    interval_seconds: 60,
};
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const RUN_BUDGET: Duration = Duration::from_secs(45);

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::var("ARCHESTRA_TASK_QUEUE_RUST_ROLLUP_ENABLED").as_deref() != Ok("true") {
        return Err(io::Error::other("Rust rollup ownership is not enabled").into());
    }
    let db_url =
        std::env::var("ARCHESTRA_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"))?;
    let pool = pilot_pool(&db_url).await?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let stop = async {
        tokio::select! {
            _ = terminate.recv() => {},
            _ = interrupt.recv() => {},
        }
    };
    tokio::pin!(stop);

    let mut tick = interval(POLL_INTERVAL);
    let readiness = Readiness(
        std::env::var_os("ARCHESTRA_NATIVE_RUNTIME_DIR")
            .map(|directory| PathBuf::from(directory).join("worker.ready")),
    );
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => return Ok(()),
            _ = tick.tick() => {},
        }
        let run = run_once(&pool);
        tokio::pin!(run);
        let result = tokio::select! {
            result = &mut run => result,
            _ = &mut stop => {
                if let Ok(Err(error)) = timeout(DRAIN_TIMEOUT, run).await {
                    eprintln!("Rust rollup drain failed: {error}");
                }
                return Ok(());
            }
        };
        match result {
            Ok(()) => {
                if let Some(path) = &readiness.0 {
                    std::fs::write(path, "")?;
                }
            }
            Err(error) => {
                readiness.clear();
                eprintln!("Rust rollup worker failed: {error}");
            }
        }
    }
}

struct Readiness(Option<PathBuf>);

impl Readiness {
    fn clear(&self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for Readiness {
    fn drop(&mut self) {
        self.clear();
    }
}

async fn run_once(pool: &PgPool) -> Result<()> {
    let mut connection = pool.get().await?;
    recover_periodic(&mut connection, &ROLLUP, 300).await?;
    let Some(task) = claim(&mut connection, &[ROLLUP.task_type]).await? else {
        return Ok(());
    };
    drop(connection);

    let outcome = match rollup(pool, &task).await {
        Ok(()) => JobOutcome::Completed,
        Err(error) => {
            eprintln!("Rust rollup job failed: {error}");
            JobOutcome::Failed
        }
    };
    let mut connection = pool.get().await?;
    finish_periodic(&mut connection, &task, &ROLLUP, outcome).await?;
    Ok(())
}

async fn rollup(pool: &PgPool, task: &TaskClaim) -> Result<()> {
    let deadline = Instant::now() + RUN_BUDGET;
    let mut work = Work::MarkedFirst;
    while Instant::now() < deadline {
        let started = Instant::now();
        let mut connection = pool.get().await?;
        if !heartbeat(&mut connection, task).await? {
            return Err(io::Error::other("rollup claim lost").into());
        }
        let progress = step(&mut connection, work).await?;
        drop(connection);
        work = match progress {
            Progress::Recomputed => Work::UnrolledFirst,
            Progress::Rolled => Work::MarkedFirst,
            Progress::Idle => break,
        };
        sleep((started.elapsed() * 3).min(deadline.saturating_duration_since(Instant::now())))
            .await;
    }
    Ok(())
}
