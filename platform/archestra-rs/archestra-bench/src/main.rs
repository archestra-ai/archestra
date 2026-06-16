use std::path::PathBuf;
use std::process::ExitCode;

use archestra_bench::run::run;
use clap::Parser;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "archestra_bench")]
#[command(about = "Archestra benchmark harness")]
struct Args {
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
    envs: Option<String>,

    #[arg(
        short = 't',
        long,
        help = "Run only tasks matching comma-separated ids"
    )]
    tasks: Option<String>,

    #[arg(
        short = 'l',
        long,
        help = "Run only lanes matching comma-separated names"
    )]
    lanes: Option<String>,

    #[arg(long, help = "Override path to lanes.toml")]
    lanes_file: Option<PathBuf>,

    #[arg(
        short = 'o',
        long,
        help = "Write markdown report to file instead of stdout"
    )]
    out: Option<PathBuf>,

    #[arg(long, help = "Reuse an existing run directory")]
    run_dir: Option<PathBuf>,

    #[arg(short = 'j', long, help = "Maximum parallel cells")]
    max_workers: Option<usize>,
}

fn default_bench_dir() -> &'static str {
    // CARGO_MANIFEST_DIR is platform/archestra-rs/archestra-bench; the benchmark root is three levels up.
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../archestra-bench")
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let run_dir = args.run_dir.as_deref();

    let result = tokio::select! {
        biased;
        _ = tokio::signal::ctrl_c() => {
            info!("received SIGINT, exiting");
            return ExitCode::FAILURE;
        }
        _ = sigterm() => {
            info!("received SIGTERM, exiting");
            return ExitCode::FAILURE;
        }
        result = run(
            &args.bench_dir,
            args.envs.as_deref(),
            args.tasks.as_deref(),
            args.lanes.as_deref(),
            args.lanes_file.as_deref(),
            args.out.as_deref(),
            run_dir,
            args.max_workers,
        ) => result,
    };

    match result {
        Ok(results) => {
            let passed = results
                .iter()
                .filter(|r| r.outcome == archestra_bench::results::Outcome::Passed)
                .count();
            let total = results.len();
            info!("benchmark complete: {passed}/{total} passed");
            if passed == total {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(e) => {
            tracing::error!("benchmark failed: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn sigterm() {
    let mut sig = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(s) => s,
        Err(_) => {
            // If signal registration fails, just wait forever so ctrl_c path remains usable.
            std::future::pending::<()>().await;
            return;
        }
    };
    sig.recv().await;
}
