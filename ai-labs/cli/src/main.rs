//! Single entry point for the archestra benchmark harness and its trajectory analyzer.
//!
//! `archestra-bench benchmark` runs the eval; `archestra-bench analyze` turns a finished run into a
//! recommendations report; `archestra-bench full` does both, feeding the run it just produced straight
//! into the analyzer; `archestra-bench prepare` renders a finished run's trajectories and emits a JSON
//! manifest (metrics + per-rollout summary) for external analysis tooling.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use archestra_bench::lifecycle::shutdown_all;
use archestra_bench::results::Outcome;
use archestra_bench::run::{RunError, RunOutcome, run};
use clap::{Args, Parser, Subcommand};
use tracing::{info, warn};
use trajectory_analyzer::{AnalyzeConfig, analyze, prepare_run_dir};

#[derive(Parser, Debug)]
#[command(
    name = "archestra-bench",
    about = "Archestra benchmark harness + trajectory analyzer"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Run the benchmark over every selected env × task × lane.
    Benchmark(BenchArgs),
    /// Analyze a finished run's trajectories into a recommendations report.
    Analyze(AnalyzeArgs),
    /// Run the benchmark, then analyze the run it just produced.
    Full(FullArgs),
    /// Render a finished run's trajectories and print a JSON manifest (metrics + per-rollout
    /// summary + trajectory.md paths) for external analysis tooling. No LLM, no API key.
    Prepare(PrepareArgs),
    /// Serve a local read-only dashboard over an experiments dir (run list, rubric grids,
    /// rollout details). No LLM, no API key.
    Dashboard(DashboardArgs),
}

/// Flags shared by `benchmark` and `full` — what to run and where. Flattened into both so the two can
/// never drift.
#[derive(Args, Debug)]
struct CommonBenchArgs {
    #[arg(
        short = 'b',
        long,
        help = "Path to benchmark directory (contains envs/, tasks/, lanes.toml)",
        default_value = default_bench_dir()
    )]
    bench_dir: PathBuf,
    #[arg(
        short = 'e',
        long,
        help = "Run only environments matching comma-separated names"
    )]
    env: Option<String>,
    #[arg(
        short = 't',
        long,
        help = "Run only tasks matching comma-separated ids"
    )]
    task: Option<String>,
    #[arg(
        short = 'l',
        long,
        help = "Run only lanes matching comma-separated names"
    )]
    lanes: Option<String>,
    #[arg(long, help = "Override path to lanes.toml")]
    lanes_file: Option<PathBuf>,
    #[arg(short = 'j', long, help = "Maximum parallel rollouts")]
    max_workers: Option<usize>,
    #[arg(
        long,
        env = "ARCHESTRA_BENCH_PLATFORM_DIR",
        help = "Platform directory (the prod image lays the app out at /app); default: <repo>/platform"
    )]
    platform_dir: Option<PathBuf>,
}

/// Flags shared by `analyze` and `full` — which lanes drive the analysis. Flattened into both.
#[derive(Args, Debug)]
struct AnalyzeKnobs {
    #[arg(long, help = "Lane (from lanes.toml) for the per-trajectory map phase")]
    map: String,
    #[arg(
        long,
        help = "Lane (from lanes.toml) for the repo-grounded reduce phase"
    )]
    reduce: String,
    #[arg(
        long,
        help = "Repo root the reduce agent crawls (default: autodetected git root)"
    )]
    explore_root: Option<PathBuf>,
    #[arg(long, default_value_t = 6, help = "Max concurrent map-phase LLM calls")]
    concurrency: usize,
}

#[derive(Args, Debug)]
struct BenchArgs {
    #[command(flatten)]
    common: CommonBenchArgs,
    #[arg(
        short = 'o',
        long,
        help = "Write markdown report to file instead of stdout"
    )]
    out: Option<PathBuf>,
    #[arg(long, help = "Reuse an existing run directory")]
    run_dir: Option<PathBuf>,
    #[arg(
        long,
        help = "Rewrite each selected env's envs/<id>.mcp.lock from the live MCP tool surface instead of enforcing it"
    )]
    update_mcp_lock: bool,
}

#[derive(Args, Debug)]
struct AnalyzeArgs {
    #[arg(long, help = "Run directory to analyze (an experiments/<id> dir)")]
    run_dir: PathBuf,
    #[command(flatten)]
    knobs: AnalyzeKnobs,
    #[arg(long, help = "Override path to lanes.toml")]
    lanes_file: Option<PathBuf>,
    #[arg(
        long,
        help = "Output report path (default: <run-dir>/trajectory_analysis_<ts>.md)"
    )]
    out: Option<PathBuf>,
}

#[derive(Args, Debug)]
struct FullArgs {
    #[command(flatten)]
    common: CommonBenchArgs,
    #[command(flatten)]
    knobs: AnalyzeKnobs,
}

#[derive(Args, Debug)]
struct PrepareArgs {
    #[arg(long, help = "Run directory to prepare (an experiments/<id> dir)")]
    run_dir: PathBuf,
}

#[derive(Args, Debug)]
struct DashboardArgs {
    #[arg(
        long,
        help = "Experiments dir to browse (default: <git toplevel>/ai-labs/experiments, or ./experiments outside a repo)"
    )]
    experiments_dir: Option<PathBuf>,
    #[arg(long, default_value_t = 8000, help = "Port to listen on")]
    port: u16,
}

fn default_bench_dir() -> &'static str {
    // CARGO_MANIFEST_DIR is ai-labs/cli; the benchmark root is its parent.
    concat!(env!("CARGO_MANIFEST_DIR"), "/..")
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    // The benchmark relies on `info` for operational logs, but two dependency targets are pure noise:
    // rmcp's server spans, and the analyzer's per-tool-call agent logs (`full` runs the reduce phase
    // under this same filter, and its spinner already shows turn/tool/subagent counts). `analyze` alone
    // wants a quiet default. `RUST_LOG` overrides either.
    let default_filter = match &cli.cmd {
        Cmd::Analyze(_) | Cmd::Prepare(_) => "warn",
        Cmd::Dashboard(_) => "info,tower_http=info",
        _ => "info,rmcp=warn,nitpicker_agent=warn",
    };
    init_tracing(default_filter);

    match cli.cmd {
        Cmd::Benchmark(a) => run_benchmark(a).await,
        Cmd::Analyze(a) => run_analyze(a).await,
        Cmd::Full(a) => run_full(a).await,
        Cmd::Prepare(a) => run_prepare(a),
        Cmd::Dashboard(a) => run_dashboard(a).await,
    }
}

/// Logs go to stderr so stdout carries only program output — `prepare`'s JSON manifest and
/// `benchmark`'s report — uncorrupted even when `RUST_LOG` is set.
fn init_tracing(default: &str) {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default)),
        )
        .with_writer(std::io::stderr)
        .init();
}

async fn run_benchmark(a: BenchArgs) -> ExitCode {
    match guarded_run(
        &a.common,
        a.out.as_deref(),
        a.run_dir.as_deref(),
        a.update_mcp_lock,
    )
    .await
    {
        None => ExitCode::FAILURE,
        Some(Err(e)) => {
            tracing::error!("benchmark failed: {e}");
            ExitCode::FAILURE
        }
        Some(Ok(outcome)) => benchmark_exit(&outcome),
    }
}

async fn run_analyze(a: AnalyzeArgs) -> ExitCode {
    let cfg = AnalyzeConfig {
        run_dir: a.run_dir,
        map: a.knobs.map,
        reduce: a.knobs.reduce,
        lanes_file: a.lanes_file,
        out: a.out,
        explore_root: a.knobs.explore_root,
        concurrency: a.knobs.concurrency,
    };
    match analyze(cfg).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("✗ analyze failed: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Render the run's trajectories and print the manifest as JSON on stdout. Synchronous: no network,
/// no LLM. stdout carries only the JSON (logs are routed to stderr by `init_tracing`).
fn run_prepare(a: PrepareArgs) -> ExitCode {
    let manifest = match prepare_run_dir(&a.run_dir) {
        Ok(manifest) => manifest,
        Err(e) => {
            eprintln!("✗ prepare failed: {e:#}");
            return ExitCode::FAILURE;
        }
    };
    match serde_json::to_string_pretty(&manifest) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("✗ prepare failed to serialize manifest: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Serve the local dashboard until interrupted. Blocking by design: the process *is* the server.
async fn run_dashboard(a: DashboardArgs) -> ExitCode {
    let experiments_dir = a
        .experiments_dir
        .unwrap_or_else(bench_dashboard::default_experiments_dir);
    let cfg = bench_dashboard::DashboardConfig {
        experiments_dir,
        port: a.port,
    };
    match bench_dashboard::serve(cfg).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("✗ dashboard failed: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run_full(a: FullArgs) -> ExitCode {
    // A fresh run dir every time (no --run-dir): `full` must never overwrite an existing run's
    // config.json/aggregate.json. `run()` picks the timestamped dir and returns it for the analyze step.
    let outcome = match guarded_run(&a.common, None, None, false).await {
        None => return ExitCode::FAILURE,
        Some(Err(e)) => {
            tracing::error!("benchmark failed: {e}");
            return ExitCode::FAILURE;
        }
        Some(Ok(outcome)) => outcome,
    };
    let bench_code = benchmark_exit(&outcome);

    let cfg = AnalyzeConfig {
        run_dir: outcome.run_dir,
        map: a.knobs.map,
        reduce: a.knobs.reduce,
        lanes_file: a.common.lanes_file,
        out: None,
        explore_root: a.knobs.explore_root,
        concurrency: a.knobs.concurrency,
    };
    match analyze(cfg).await {
        Ok(()) => bench_code,
        Err(e) => {
            eprintln!("✗ analyze failed: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Run the benchmark under a signal guard: on SIGINT/SIGTERM the `run` future is dropped mid-flight,
/// so any still-registered instances (process groups + benchmark DBs) are torn down before exit.
/// `None` means a signal fired; `Some(result)` is the completed run.
async fn guarded_run(
    common: &CommonBenchArgs,
    out: Option<&Path>,
    run_dir: Option<&Path>,
    update_mcp_lock: bool,
) -> Option<Result<RunOutcome, RunError>> {
    let result = tokio::select! {
        biased;
        _ = tokio::signal::ctrl_c() => {
            info!("received SIGINT, tearing down live instances...");
            None
        }
        _ = sigterm() => {
            info!("received SIGTERM, tearing down live instances...");
            None
        }
        result = run(
            &common.bench_dir,
            common.env.as_deref(),
            common.task.as_deref(),
            common.lanes.as_deref(),
            common.lanes_file.as_deref(),
            out,
            run_dir,
            common.max_workers,
            update_mcp_lock,
            common.platform_dir.as_deref(),
        ) => Some(result),
    };
    if result.is_none() {
        // run() was dropped mid-flight, so live instances are still registered; shutdown_all tears
        // them down now. Race it against a second signal so the user can force-exit immediately —
        // that may leave still-draining process groups / benchmark DBs un-cleaned, acceptable as an
        // explicit user-requested abort.
        tokio::select! {
            _ = shutdown_all() => {}
            _ = tokio::signal::ctrl_c() => {
                warn!("second interrupt — exiting now, teardown may be incomplete");
                std::process::exit(130);
            }
            _ = sigterm() => {
                warn!("SIGTERM during teardown — exiting now, teardown may be incomplete");
                std::process::exit(143);
            }
        }
    }
    result
}

fn benchmark_exit(outcome: &RunOutcome) -> ExitCode {
    let passed = outcome
        .results
        .iter()
        .filter(|r| r.outcome == Outcome::Passed)
        .count();
    let total = outcome.results.len();
    let all_passed = total > 0 && passed == total;
    let mark = if all_passed { '✓' } else { '✗' };
    eprintln!("{mark} benchmark: {passed}/{total} passed");
    if all_passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn sigterm() {
    let mut sig = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(s) => s,
        Err(_) => {
            // If signal registration fails, wait forever so the ctrl_c path stays usable.
            std::future::pending::<()>().await;
            return;
        }
    };
    sig.recv().await;
}
