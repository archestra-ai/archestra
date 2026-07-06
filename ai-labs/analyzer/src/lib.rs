//! Trajectory analyzer for archestra-bench.
//!
//! Map-reduce over a benchmark run directory: each rollout's `trajectory.jsonl` is summarized by a
//! one-shot LLM call (map), then a repo-grounded nitpicker agent turns the summaries + metrics into
//! a recommendations report (reduce). The benchmarked model is fixed; recommendations target the
//! surfaces we own, led by Tier 1 — the Archestra agentic loop and `archestra__*` tools — over
//! Tier 2, the benchmark fixtures (task prompts, schemas, verifiers, env/skill config, runner).

mod analyze;
pub mod rubric;
mod runmeta;
mod trajectory;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use archestra_bench_core::{TriageRecord, find_lane, load_lanes};
use eyre::{Context, Result, bail};
use futures::stream::{self, StreamExt};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use nitpicker_agent::prelude::AgentProgress;
use serde::Serialize;

use analyze::to_provider;
use runmeta::{RolloutId, RunMeta, load_run_meta, metrics_block};
use trajectory::{format_to_markdown, load_trajectory};

/// Reduce-agent turn cap. Set high enough never to bind in practice — a repo crawl finishes well
/// under it — so it is a runaway backstop, not a knob.
const REDUCE_MAX_TURNS: usize = 200;

/// Inputs for one analyzer run, built by the unified CLI from its `analyze`/`full` flags.
pub struct AnalyzeConfig {
    /// Run directory containing `<env>/<task>__<lane>/trajectory.jsonl` (an `experiments/<id>` dir).
    pub run_dir: PathBuf,
    /// Lane name (from the lanes registry) driving the per-trajectory map phase.
    pub map: String,
    /// Lane name driving the repo-grounded reduce phase.
    pub reduce: String,
    /// Lane registry `map`/`reduce` resolve against; defaults to `lanes.toml` beside the bench crate.
    pub lanes_file: Option<PathBuf>,
    /// Output report path; defaults to `<run-dir>/trajectory_analysis_<ts>.md`.
    pub out: Option<PathBuf>,
    /// Repo the reduce agent crawls; defaults to the autodetected git root above `run_dir`.
    pub explore_root: Option<PathBuf>,
    /// Max concurrent map-phase LLM calls.
    pub concurrency: usize,
}

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

/// One discovered benchmark rollout with its trajectory rendered to markdown in full — the same
/// untruncated text is both persisted as `trajectory.md` and fed to the map-phase LLM.
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
/// reduce prompt simply omits the backend-log pointer.
fn run_dir_rel(run_dir: &Path, explore_root: &Path) -> Option<String> {
    let abs = run_dir.canonicalize().ok()?;
    let rel = abs.strip_prefix(explore_root).ok()?;
    let rel = rel.to_string_lossy().into_owned();
    if rel.is_empty() { None } else { Some(rel) }
}

/// Default lanes registry: `ai-labs/lanes.toml`, resolved from the crate manifest dir so it
/// is found regardless of the caller's working directory.
fn default_lanes_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate manifest dir always has a parent")
        .join("lanes.toml")
}

/// Autodetect the repo root the reduce agent should crawl: the nearest ancestor of `run_dir` holding
/// a `.git` entry. A benchmark `run_dir` lives under `experiments/` in the repo, so an ancestor always
/// has `.git` — this frees the caller from passing `--explore-root` and from running at the repo root.
fn detect_repo_root(run_dir: &Path) -> Result<PathBuf> {
    let start = run_dir
        .canonicalize()
        .wrap_err_with(|| format!("run dir does not exist: {}", run_dir.display()))?;
    for dir in start.ancestors() {
        if dir.join(".git").exists() {
            return Ok(dir.to_path_buf());
        }
    }
    bail!(
        "could not autodetect a repo root (no `.git` above {}); pass an explicit explore root",
        run_dir.display()
    )
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

/// Deterministic report order shared by `analyze` and `prepare_run_dir`: failures first (so the
/// reader sees the struggles), then by rollout id. Factored out so the two orderings cannot drift.
fn rollout_order(
    a_is_pass: bool,
    a_id: &RolloutId,
    b_is_pass: bool,
    b_id: &RolloutId,
) -> std::cmp::Ordering {
    a_is_pass.cmp(&b_is_pass).then_with(|| a_id.cmp(b_id))
}

/// One compact JSON line per triage record, in the caller's (deterministic, failures-first) order —
/// the `trajectory_rubrics_<ts>.jsonl` artifact body.
fn rubrics_jsonl<'a>(records: impl IntoIterator<Item = &'a TriageRecord>) -> String {
    let mut out = String::new();
    for record in records {
        out.push_str(&serde_json::to_string(record).expect("TriageRecord always serializes"));
        out.push('\n');
    }
    out
}

/// One rollout in the [`PrepareManifest`]: its identity, outcome, the one-line outcome summary the
/// map prompt embeds, and the path to its rendered trajectory.
#[derive(Debug, Serialize)]
pub struct PreparedRollout {
    /// `RolloutId` rendered as `<env>/<task>__<lane>`.
    pub id: String,
    pub outcome: String,
    pub outcome_summary: String,
    pub trajectory_md: PathBuf,
}

/// The deterministic inputs an external analyzer (e.g. the Claude trajectory-analysis skill) needs:
/// the same metrics block the reduce phase reads and the rollouts in the same failures-first order,
/// each pointing at its rendered `trajectory.md`.
#[derive(Debug, Serialize)]
pub struct PrepareManifest {
    pub metrics_block: String,
    pub rollouts: Vec<PreparedRollout>,
}

/// Persist each rollout's full rendered trajectory as `trajectory.md` next to its source jsonl, so
/// the complete, untruncated trajectory is inspectable after the fact. `trajectory.md` is never
/// re-discovered (the glob wants jsonl).
fn persist_trajectories(rollouts: &[Rollout]) -> Result<()> {
    for rollout in rollouts {
        let md_path = rollout.dir.join("trajectory.md");
        std::fs::write(&md_path, &rollout.markdown)
            .wrap_err_with(|| format!("writing rendered trajectory to {}", md_path.display()))?;
    }
    Ok(())
}

/// Render every rollout's `trajectory.md` and build the deterministic manifest, reusing the exact
/// discovery, rendering, metrics, and ordering of [`analyze`] — no LLM, no network. Lets a
/// different reducer (e.g. Claude subagents) run the map-reduce over identical inputs.
pub fn prepare_run_dir(run_dir: &Path) -> Result<PrepareManifest> {
    let mut rollouts = discover_rollouts(run_dir)?;

    persist_trajectories(&rollouts)?;

    rollouts.sort_by(|a, b| rollout_order(a.meta.is_pass(), &a.id, b.meta.is_pass(), &b.id));

    // Metrics cover every discovered rollout: unlike `analyze`, `prepare` has no map phase, so there
    // is nothing to exclude. The block is byte-identical to an `analyze` run only when that run also
    // mapped every rollout (no map failures).
    let metric_pairs: Vec<(RolloutId, RunMeta)> = rollouts
        .iter()
        .map(|r| (r.id.clone(), r.meta.clone()))
        .collect();
    let metrics = metrics_block(&metric_pairs);

    let rollouts = rollouts
        .into_iter()
        .map(|r| PreparedRollout {
            id: r.id.to_string(),
            outcome: r.meta.outcome.clone(),
            outcome_summary: r.meta.summarize_outcome(),
            trajectory_md: r.dir.join("trajectory.md"),
        })
        .collect();

    Ok(PrepareManifest {
        metrics_block: metrics,
        rollouts,
    })
}

/// Run the map-reduce analysis described by `cfg`. The caller (the unified CLI) owns tracing init.
pub async fn analyze(cfg: AnalyzeConfig) -> Result<()> {
    if cfg.concurrency == 0 {
        bail!("concurrency must be >= 1");
    }
    // The reduce agent's read tools sandbox by `path.canonicalize().starts_with(work_dir)`, which
    // only holds for an absolute work_dir — a relative explore root would deny every read.
    let explore_root = match &cfg.explore_root {
        Some(p) => p
            .canonicalize()
            .wrap_err_with(|| format!("explore root does not exist: {}", p.display()))?,
        None => detect_repo_root(&cfg.run_dir)?,
    };
    let run_dir_rel = run_dir_rel(&cfg.run_dir, &explore_root);
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();

    let lanes_file = cfg.lanes_file.clone().unwrap_or_else(default_lanes_file);
    let lanes = load_lanes(&lanes_file, None).map_err(|e| eyre::eyre!("{e}"))?;
    let map_lane = find_lane(&lanes, &cfg.map).map_err(|e| eyre::eyre!("{e}"))?;
    let reduce_lane = find_lane(&lanes, &cfg.reduce).map_err(|e| eyre::eyre!("{e}"))?;

    let mp = MultiProgress::new();

    let rollouts = discover_rollouts(&cfg.run_dir)?;
    let total = rollouts.len();
    note(
        &mp,
        format!("● {total} rollouts in {}", cfg.run_dir.display()),
    );

    persist_trajectories(&rollouts)?;

    let map_client = nitpicker_agent::client_from_env(to_provider(
        map_lane.provider,
        map_lane.base_url.clone(),
        map_lane.api_key_env.clone(),
    )?)?;
    let map_model = map_lane.model.clone();

    let bar = mp.add(ProgressBar::new(total as u64));
    bar.set_style(
        ProgressStyle::with_template(
            "  map     {bar:30.cyan/blue} {pos}/{len} rollouts [{elapsed_precise}<{eta_precise}]",
        )
        .expect("static progress template")
        .progress_chars("━━─"),
    );
    let mapped: Vec<(RolloutId, Result<(RunMeta, TriageRecord)>)> = stream::iter(rollouts)
        .map(|rollout| {
            let client = map_client.clone();
            let model = map_model.clone();
            let bar = bar.clone();
            async move {
                let summary = rollout.meta.summarize_outcome();
                let result = analyze::map_one(
                    &client,
                    &model,
                    &rollout.id,
                    &rollout.meta.outcome,
                    &summary,
                    &rollout.markdown,
                )
                .await
                .map(|record| (rollout.meta, record));
                bar.inc(1);
                (rollout.id, result)
            }
        })
        .buffer_unordered(cfg.concurrency)
        .collect()
        .await;
    bar.finish_and_clear();

    // A per-rollout map failure (e.g. a provider outage on one rollout) must not discard the summaries we
    // already paid for. Log each failure loudly and proceed with what mapped; abort only if nothing
    // succeeded.
    let mut analyzed: Vec<(RolloutId, RunMeta, TriageRecord)> = Vec::new();
    let mut excluded: Vec<RolloutId> = Vec::new();
    for (id, result) in mapped {
        match result {
            Ok((meta, record)) => analyzed.push((id, meta, record)),
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
        rollout_order(a_meta.is_pass(), a_id, b_meta.is_pass(), b_id)
    });

    let metric_pairs: Vec<(RolloutId, RunMeta)> = analyzed
        .iter()
        .map(|(id, meta, _)| (id.clone(), meta.clone()))
        .collect();
    let metrics = metrics_block(&metric_pairs);

    // Persist the raw triage records before reduce, in the same failures-first order as the
    // analyses doc; rollouts whose map failed are simply absent (partial artifacts are normal).
    // tmp + rename so the dashboard can never observe a half-written artifact.
    let rubrics_path = cfg
        .run_dir
        .join(format!("trajectory_rubrics_{timestamp}.jsonl"));
    let rubrics_tmp = rubrics_path.with_extension("jsonl.tmp");
    std::fs::write(
        &rubrics_tmp,
        rubrics_jsonl(analyzed.iter().map(|(_, _, record)| record)),
    )
    .and_then(|()| std::fs::rename(&rubrics_tmp, &rubrics_path))
    .wrap_err_with(|| format!("writing triage rubrics to {}", rubrics_path.display()))?;
    note(&mp, format!("✓ rubrics → {}", rubrics_path.display()));

    let analyses: Vec<(RolloutId, String, String)> = analyzed
        .into_iter()
        .map(|(id, meta, record)| {
            // The cap bounds the rendered section body (what the reducer reads), not the record.
            let body = analyze::truncate_chars(
                rubric::render_section(&record),
                analyze::MAP_ANALYSIS_CAP_CHARS,
            );
            (id, meta.outcome, body)
        })
        .collect();
    let mut analyses_doc = analyze::build_analyses_doc(&metrics, &analyses, run_dir_rel.as_deref());
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

    let reduce_client = nitpicker_agent::client_from_env(to_provider(
        reduce_lane.provider,
        reduce_lane.base_url.clone(),
        reduce_lane.api_key_env.clone(),
    )?)?;
    let reduce_model = reduce_lane.model.clone();

    // Persist the paid-for map output before reduce runs: a reduce/provider failure must not throw
    // away every per-rollout summary. The reducer reads its own copy from a temp dir under explore_root.
    let analyses_path = cfg
        .run_dir
        .join(format!("trajectory_analyses_{timestamp}.md"));
    std::fs::write(&analyses_path, &analyses_doc)
        .wrap_err_with(|| format!("writing analyses to {}", analyses_path.display()))?;
    note(&mp, format!("✓ map output → {}", analyses_path.display()));

    let spinner = mp.add(ProgressBar::new_spinner());
    spinner.set_style(
        ProgressStyle::with_template("  {spinner:.green} reduce  [{elapsed_precise}] {msg}")
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
        &reduce_model,
        &analyses_doc,
        &explore_root,
        run_dir_rel.as_deref(),
        REDUCE_MAX_TURNS,
        Some(progress),
    )
    .await;
    spinner.finish_and_clear();
    let report = result.wrap_err("reduce phase failed")?;

    let out_path = cfg.out.unwrap_or_else(|| {
        cfg.run_dir
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
            "ai-labs"
        );
    }

    #[test]
    fn empty_run_dir_is_an_error() {
        let run = tempfile::tempdir().unwrap();
        assert!(discover_rollouts(run.path()).is_err());
    }

    #[test]
    fn detect_repo_root_finds_nearest_git_ancestor() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".git")).unwrap();
        let nested = root.path().join("ai-labs/experiments/run-1");
        std::fs::create_dir_all(&nested).unwrap();
        let found = detect_repo_root(&nested).unwrap();
        assert_eq!(found, root.path().canonicalize().unwrap());
    }

    #[test]
    fn detect_repo_root_errors_without_git() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("experiments/run-1");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(detect_repo_root(&nested).is_err());
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

    #[test]
    fn rubrics_jsonl_is_one_compact_line_per_record_in_rollout_order() {
        let judgment = r#"{"verdict":"v","rubrics":{"knowledge":{"grade":4,"comment":"k"},"reasoning":{"grade":3,"comment":"r"},"instruction_following":{"grade":5,"comment":"i"},"env_ergonomics":{"grade":2,"comment":"e"}},"reward_hacking":{"suspected":false,"evidence":null},"observations":["a"]}"#;
        let record = |env: &str, task: &str, lane: &str, outcome: &str| {
            let id = RolloutId {
                env: env.into(),
                task: task.into(),
                lane: lane.into(),
            };
            let rec = rubric::parse_triage(judgment)
                .unwrap()
                .into_record(&id, outcome);
            (id, outcome == "passed", rec)
        };
        // Passing rollout listed first so the sort must actually reorder.
        let mut rows = [
            record("basic", "a", "x", "passed"),
            record("basic", "b", "y", "failed"),
        ];
        rows.sort_by(|a, b| rollout_order(a.1, &a.0, b.1, &b.0));

        let jsonl = rubrics_jsonl(rows.iter().map(|(_, _, rec)| rec));
        let lines: Vec<&str> = jsonl.lines().collect();
        assert_eq!(lines.len(), 2);
        // Failures first, each line a compact record that parses back with its stamped identity.
        let first: TriageRecord = serde_json::from_str(lines[0]).unwrap();
        let second: TriageRecord = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(
            (first.rollout.as_str(), first.outcome.as_str()),
            ("basic/b__y", "failed")
        );
        assert_eq!(
            (second.rollout.as_str(), second.outcome.as_str()),
            ("basic/a__x", "passed")
        );
    }

    #[test]
    fn prepare_run_dir_renders_md_and_builds_ordered_manifest() {
        let run = tempfile::tempdir().unwrap();
        // Written passing-first so the assertion proves the failures-first sort actually reorders.
        write_rollout(
            run.path(),
            "basic",
            "pi",
            "glm",
            r#"{"env_id":"basic","task_id":"pi","lane":"glm","provider":"anthropic","model":"m","outcome":"passed","turn_count":3,"tool_call_count":4}"#,
        );
        write_rollout(
            run.path(),
            "basic",
            "tau",
            "kimi",
            r#"{"env_id":"basic","task_id":"tau","lane":"kimi","provider":"anthropic","model":"m","outcome":"failed"}"#,
        );

        let manifest = prepare_run_dir(run.path()).unwrap();

        // trajectory.md is rendered next to each source jsonl, byte-identical to the full
        // trajectory rendering.
        let glm_dir = run.path().join("basic/pi__glm");
        let expected =
            format_to_markdown(&load_trajectory(&glm_dir.join("trajectory.jsonl")).unwrap());
        assert_eq!(
            std::fs::read_to_string(glm_dir.join("trajectory.md")).unwrap(),
            expected
        );
        assert!(run.path().join("basic/tau__kimi/trajectory.md").exists());

        // Failures first, then by id.
        let ids: Vec<&str> = manifest.rollouts.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["basic/tau__kimi", "basic/pi__glm"]);

        // Each PreparedRollout carries its outcome and a path to its rendered trajectory.
        let failing = manifest
            .rollouts
            .iter()
            .find(|r| r.id == "basic/tau__kimi")
            .unwrap();
        assert_eq!(failing.outcome, "failed");
        assert!(
            failing
                .trajectory_md
                .ends_with("basic/tau__kimi/trajectory.md")
        );
    }
}
