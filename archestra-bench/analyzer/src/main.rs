//! Trajectory analyzer for archestra-bench.
//!
//! Map-reduce over a benchmark run directory: each rollout's `trajectory.jsonl` is summarized by a
//! one-shot LLM call (map), then a repo-grounded nitpicker agent turns the summaries + metrics into
//! a recommendations report (reduce). The benchmarked model is fixed; recommendations target the
//! surfaces we own, led by Tier 1 — the Archestra agentic loop and `archestra__*` tools — over
//! Tier 2, the benchmark fixtures (task prompts, schemas, verifiers, env/skill config, runner).

mod analyze;
mod lanes;
mod runmeta;
mod trajectory;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use eyre::{Context, Result, bail};
use futures::stream::{self, StreamExt};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use nitpicker_agent::prelude::AgentProgress;

use lanes::Lanes;
use runmeta::{RolloutId, RunMeta, load_run_meta, metrics_block};
use trajectory::{format_to_markdown, load_trajectory};

/// Print a persistent status line that survives a non-TTY target. `MultiProgress::println` is a
/// no-op when the draw target is hidden (piped/CI/`NO_COLOR`), which would drop the summary and
/// failure lines operators rely on, so fall back to plain stderr there.
fn note(mp: &MultiProgress, msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    if mp.is_hidden() {
        eprintln!("{msg}");
    } else {
        let _ = mp.println(msg);
    }
}

#[derive(Parser, Debug)]
#[command(about = "Analyze archestra-bench trajectories into a recommendations report")]
struct Args {
    /// Run directory containing `<env>/<task>__<lane>/trajectory.jsonl` (an `experiments/<id>` dir).
    #[arg(long)]
    run_dir: PathBuf,

    /// Repository the reduce agent crawls to ground recommendations; point it at the repo root so
    /// the agent can cross-check issues against both the harness and the product source.
    #[arg(long, default_value = ".")]
    explore_root: PathBuf,

    /// Lane name (from `--lanes-file`) driving the per-trajectory map phase.
    #[arg(long)]
    map: String,
    /// Lane name (from `--lanes-file`) driving the repo-grounded reduce phase.
    #[arg(long)]
    reduce: String,
    /// Lane registry `--map`/`--reduce` resolve against. Defaults to `lanes.toml` beside the
    /// benchmark crate, resolved from the build manifest dir so it is found regardless of cwd.
    #[arg(long)]
    lanes_file: Option<PathBuf>,

    /// Output report path (default: `<run-dir>/trajectory_analysis_<ts>.md`).
    #[arg(long)]
    out: Option<PathBuf>,

    /// Reduce agent turn cap.
    #[arg(long, default_value_t = 50)]
    max_turns: usize,

    /// Max concurrent map-phase LLM calls.
    #[arg(long, default_value_t = 6)]
    concurrency: usize,
}

/// One discovered benchmark rollout with its trajectory already rendered to the markdown fed to map.
#[derive(Debug)]
struct Rollout {
    id: RolloutId,
    dir: PathBuf,
    meta: RunMeta,
    markdown: String,
}

/// Path of `run_dir` relative to `explore_root`, for pointing the reduce agent at this run's
/// `*.backend.log`. The reduce agent's read tools sandbox to `explore_root`, so logs are only
/// reachable when `run_dir` sits under it. Returns `None` when `run_dir` is outside `explore_root`,
/// cannot be canonicalized, or *is* `explore_root` (an empty relative path) — in every such case the
/// reduce prompt simply omits the backend-log pointer. The empty case never arises in practice:
/// `discover_rollouts` requires `run_dir` to hold nested `*/*__*/trajectory.jsonl` rollouts, so it
/// is always a subdirectory, never the explore root itself.
fn run_dir_rel(run_dir: &Path, explore_root: &Path) -> Option<String> {
    let abs = run_dir.canonicalize().ok()?;
    let rel = abs.strip_prefix(explore_root).ok()?;
    let rel = rel.to_string_lossy().into_owned();
    if rel.is_empty() { None } else { Some(rel) }
}

/// Default lanes registry: `archestra-bench/lanes.toml`, resolved from the crate manifest dir so it
/// is found regardless of the caller's working directory — mirroring the Python runner, which
/// resolves the same file relative to its own source rather than cwd.
fn default_lanes_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate manifest dir always has a parent")
        .join("lanes.toml")
}

fn discover_rollouts(run_dir: &Path) -> Result<Vec<Rollout>> {
    if !run_dir.is_dir() {
        bail!("run dir does not exist: {}", run_dir.display());
    }
    let pattern = run_dir.join("*/*__*/trajectory.jsonl");
    let pattern = pattern.to_string_lossy();

    let mut rollouts = Vec::new();
    for entry in glob::glob(&pattern).wrap_err("invalid glob pattern")? {
        let traj_path = entry.wrap_err("reading glob entry")?;
        let rollout_dir = traj_path
            .parent()
            .ok_or_else(|| eyre::eyre!("trajectory has no parent dir: {}", traj_path.display()))?;

        let meta = load_run_meta(rollout_dir)?;

        // Cross-check the discovered path against run.json's authoritative identity, so a stale or
        // copied run.json cannot silently misattribute its analysis to the wrong rollout.
        let dir_name = rollout_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let env_name = rollout_dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let expected = format!("{}__{}", meta.task_id, meta.lane);
        if dir_name != expected || env_name != meta.env_id {
            bail!(
                "run.json identity {}/{} disagrees with its directory {}/{}",
                meta.env_id,
                expected,
                env_name,
                dir_name
            );
        }

        let events = load_trajectory(&traj_path)?;
        rollouts.push(Rollout {
            id: meta.rollout_id(),
            dir: rollout_dir.to_path_buf(),
            meta,
            markdown: format_to_markdown(&events),
        });
    }

    if rollouts.is_empty() {
        bail!(
            "no trajectories found under {} (looked for */*__*/trajectory.jsonl)",
            run_dir.display()
        );
    }
    Ok(rollouts)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let args = Args::parse();
    if args.concurrency == 0 {
        bail!("--concurrency must be >= 1");
    }
    // The reduce agent's read tools sandbox by `path.canonicalize().starts_with(work_dir)`, which
    // only holds for an absolute work_dir — a relative `--explore-root` would deny every read.
    let explore_root = args.explore_root.canonicalize().wrap_err_with(|| {
        format!(
            "--explore-root does not exist: {}",
            args.explore_root.display()
        )
    })?;
    let run_dir_rel = run_dir_rel(&args.run_dir, &explore_root);
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();

    let lanes_file = args.lanes_file.clone().unwrap_or_else(default_lanes_file);
    let lanes = Lanes::load(&lanes_file)?;
    let map_lane = lanes.get(&args.map)?;
    let reduce_lane = lanes.get(&args.reduce)?;

    let mp = MultiProgress::new();

    let rollouts = discover_rollouts(&args.run_dir)?;
    let total = rollouts.len();
    note(
        &mp,
        format!("● {total} rollouts in {}", args.run_dir.display()),
    );

    // Persist the rendered trajectory we feed the map phase next to its source jsonl, so the map
    // input is inspectable after the fact. `trajectory.md` is never re-discovered (glob wants jsonl).
    for rollout in &rollouts {
        let md_path = rollout.dir.join("trajectory.md");
        std::fs::write(&md_path, &rollout.markdown)
            .wrap_err_with(|| format!("writing rendered trajectory to {}", md_path.display()))?;
    }

    let map_client = nitpicker_agent::client_from_env(map_lane.provider()?)?;

    let bar = mp.add(ProgressBar::new(total as u64));
    bar.set_style(
        ProgressStyle::with_template("  map     {bar:30.cyan/blue} {pos}/{len} rollouts")
            .expect("static progress template")
            .progress_chars("━━─"),
    );
    let mapped: Vec<(RolloutId, Result<(RunMeta, String)>)> = stream::iter(rollouts)
        .map(|rollout| {
            let client = map_client.clone();
            let model = map_lane.model.clone();
            let bar = bar.clone();
            async move {
                let summary = rollout.meta.summarize_outcome();
                let result =
                    analyze::map_one(&client, &model, &rollout.id, &summary, &rollout.markdown)
                        .await
                        .map(|analysis| (rollout.meta, analysis));
                bar.inc(1);
                (rollout.id, result)
            }
        })
        .buffer_unordered(args.concurrency)
        .collect()
        .await;
    bar.finish_and_clear();

    // A per-rollout map failure (e.g. a provider outage on one rollout) must not discard the summaries we
    // already paid for. Log each failure loudly and proceed with what mapped; abort only if nothing
    // succeeded.
    let mut analyzed: Vec<(RolloutId, RunMeta, String)> = Vec::new();
    let mut excluded: Vec<RolloutId> = Vec::new();
    for (id, result) in mapped {
        match result {
            Ok((meta, analysis)) => analyzed.push((id, meta, analysis)),
            Err(e) => {
                note(&mp, format!("  ✗ map failed for {id}, excluding it: {e:#}"));
                excluded.push(id);
            }
        }
    }
    if analyzed.is_empty() {
        bail!(
            "all {} rollouts failed the map phase; nothing to analyze",
            excluded.len()
        );
    }
    if !excluded.is_empty() {
        excluded.sort();
    }
    note(
        &mp,
        format!(
            "✓ mapped {}/{} rollouts{}",
            analyzed.len(),
            total,
            if excluded.is_empty() {
                String::new()
            } else {
                format!(" ({} excluded)", excluded.len())
            }
        ),
    );

    // Failures first, then by rollout id — deterministic regardless of map completion order.
    analyzed.sort_by(|(a_id, a_meta, _), (b_id, b_meta, _)| {
        a_meta.is_pass().cmp(&b_meta.is_pass()).then(a_id.cmp(b_id))
    });

    let metric_pairs: Vec<(RolloutId, RunMeta)> = analyzed
        .iter()
        .map(|(id, meta, _)| (id.clone(), meta.clone()))
        .collect();
    let metrics = metrics_block(&metric_pairs);

    let analyses: Vec<(RolloutId, String, String)> = analyzed
        .into_iter()
        .map(|(id, meta, analysis)| (id, meta.outcome, analysis))
        .collect();
    let mut analyses_doc = analyze::build_analyses_doc(&metrics, &analyses);
    if !excluded.is_empty() {
        let names = excluded
            .iter()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        analyses_doc = format!(
            "> NOTE: {} rollout(s) failed the map phase and are excluded from this analysis: {names}.\n\n{analyses_doc}",
            excluded.len()
        );
    }

    let reduce_client = nitpicker_agent::client_from_env(reduce_lane.provider()?)?;

    // Persist the paid-for map output before reduce runs: a reduce/provider failure must not throw
    // away every per-rollout summary. The reducer reads its own copy from a temp dir under explore_root.
    let analyses_path = args
        .run_dir
        .join(format!("trajectory_analyses_{timestamp}.md"));
    std::fs::write(&analyses_path, &analyses_doc)
        .wrap_err_with(|| format!("writing analyses to {}", analyses_path.display()))?;
    note(&mp, format!("✓ map output → {}", analyses_path.display()));

    let spinner = mp.add(ProgressBar::new_spinner());
    spinner.set_style(
        ProgressStyle::with_template("  {spinner:.green} reduce  {msg}")
            .expect("static spinner template")
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ "),
    );
    spinner.enable_steady_tick(Duration::from_millis(120));
    spinner.set_message(format!("crawling {}", explore_root.display()));

    let progress: Arc<dyn Fn(AgentProgress) + Send + Sync> = {
        let spinner = spinner.clone();
        Arc::new(move |p: AgentProgress| {
            let sub = p
                .last_subagent
                .as_deref()
                .map(|s| format!(" · {s}"))
                .unwrap_or_default();
            spinner.set_message(format!(
                "turn {} · {} tool calls · {} subagents{sub}",
                p.turns, p.tool_calls, p.subagents_spawned
            ));
        })
    };

    // Clear the spinner on both success and failure, so an errored reduce does not leave a ticking
    // line behind on the path operators most need to read.
    let result = analyze::reduce(
        reduce_client,
        &reduce_lane.model,
        &analyses_doc,
        &explore_root,
        run_dir_rel.as_deref(),
        args.max_turns,
        Some(progress),
    )
    .await;
    spinner.finish_and_clear();
    let report = result.wrap_err("reduce phase failed")?;

    let out_path = args.out.unwrap_or_else(|| {
        args.run_dir
            .join(format!("trajectory_analysis_{timestamp}.md"))
    });
    std::fs::write(&out_path, &report.text)
        .wrap_err_with(|| format!("writing report to {}", out_path.display()))?;

    note(
        &mp,
        format!(
            "✓ report → {}  ·  reduce: {} turns, {} tool calls, {} subagents, {} tokens",
            out_path.display(),
            report.turns,
            report.tool_calls,
            report.subagents_spawned,
            report.total_tokens,
        ),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write a `<run>/<env>/<task>__<lane>/` rollout with a run.json + one-line trajectory.
    fn write_rollout(run_dir: &Path, env: &str, task: &str, lane: &str, run_json: &str) {
        let dir = run_dir.join(env).join(format!("{task}__{lane}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("run.json"), run_json).unwrap();
        std::fs::write(
            dir.join("trajectory.jsonl"),
            "{\"kind\":\"assistant_text\",\"text\":\"hi\"}\n",
        )
        .unwrap();
    }

    fn run_json(env: &str, task: &str, lane: &str) -> String {
        format!(
            "{{\"env_id\":\"{env}\",\"task_id\":\"{task}\",\"lane\":\"{lane}\",\
             \"provider\":\"anthropic\",\"model\":\"m\",\"outcome\":\"passed\"}}"
        )
    }

    #[test]
    fn discovers_rollouts_matching_the_task_lane_glob() {
        let run = tempfile::tempdir().unwrap();
        write_rollout(
            run.path(),
            "basic",
            "pi",
            "glm",
            &run_json("basic", "pi", "glm"),
        );
        // A task id that itself contains `__` must still resolve via run.json identity.
        write_rollout(
            run.path(),
            "api",
            "list__stats",
            "kimi",
            &run_json("api", "list__stats", "kimi"),
        );

        let rollouts = discover_rollouts(run.path()).unwrap();
        let mut ids: Vec<String> = rollouts.iter().map(|c| c.id.to_string()).collect();
        ids.sort();
        assert_eq!(ids, vec!["api/list__stats__kimi", "basic/pi__glm"]);
    }

    #[test]
    fn default_lanes_file_sits_beside_the_bench_crate() {
        let p = default_lanes_file();
        assert!(p.ends_with("lanes.toml"));
        assert_eq!(
            p.parent().and_then(|d| d.file_name()).unwrap(),
            "archestra-bench"
        );
    }

    #[test]
    fn empty_run_dir_is_an_error() {
        let run = tempfile::tempdir().unwrap();
        assert!(discover_rollouts(run.path()).is_err());
    }

    #[test]
    fn run_dir_rel_resolves_nested_run_dir() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("experiments").join("run-1");
        std::fs::create_dir_all(&nested).unwrap();
        // canonicalize both sides so the result is path-separator/realpath agnostic.
        let root_c = root.path().canonicalize().unwrap();
        assert_eq!(
            run_dir_rel(&nested, &root_c).as_deref(),
            Some("experiments/run-1")
        );
    }

    #[test]
    fn run_dir_rel_is_none_outside_root() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let root_c = root.path().canonicalize().unwrap();
        assert_eq!(run_dir_rel(other.path(), &root_c), None);
    }

    #[test]
    fn run_dir_rel_is_none_when_equal_to_root() {
        let root = tempfile::tempdir().unwrap();
        let root_c = root.path().canonicalize().unwrap();
        assert_eq!(run_dir_rel(&root_c, &root_c), None);
    }

    #[test]
    fn run_dir_rel_is_none_when_run_dir_missing() {
        let root = tempfile::tempdir().unwrap();
        let root_c = root.path().canonicalize().unwrap();
        assert_eq!(run_dir_rel(&root_c.join("nope"), &root_c), None);
    }

    #[test]
    fn run_json_identity_disagreeing_with_dir_fails() {
        let run = tempfile::tempdir().unwrap();
        // Directory says pi__glm, run.json claims a different task.
        write_rollout(
            run.path(),
            "basic",
            "pi",
            "glm",
            &run_json("basic", "other", "glm"),
        );
        let err = discover_rollouts(run.path()).unwrap_err();
        assert!(err.to_string().contains("disagrees with its directory"));
    }
}
