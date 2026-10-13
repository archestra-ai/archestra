//! Disk-only loading of run artifacts for the dashboard: run listing, rollout discovery, and rubric
//! jsonl parsing. Reads the shared contract from `archestra-bench-core`; never writes anything.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use archestra_bench_core::{
    AGGREGATE_JSON, CONFIG_JSON, Outcome, RUN_JSON, RolloutId, Rubrics, RunMeta, TriageRecord, rollout_dir,
};
use eyre::{Result, WrapErr};
use serde::Deserialize;

/// Subset of a run's `config.json` the dashboard reads. Lenient: unknown fields are ignored so
/// config drift never breaks rendering.
#[derive(Debug, Clone, Deserialize)]
pub struct RunConfig {
    #[serde(default)]
    pub environments: Vec<ConfigEnv>,
    #[serde(default)]
    pub lanes: Vec<ConfigLane>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigEnv {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigLane {
    pub name: String,
    #[serde(default)]
    pub model: Option<String>,
}

/// Subset of `aggregate.json` the dashboard reads.
#[derive(Debug, Clone, Deserialize)]
pub struct Aggregate {
    #[serde(default)]
    pub outcomes: BTreeMap<String, u64>,
    #[serde(default)]
    pub pass_rate: Option<f64>,
    #[serde(default)]
    pub avg_turns: Option<f64>,
    #[serde(default)]
    pub avg_tokens: Option<f64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

/// Typed outcome tally (the on-disk `outcomes` map uses raw strings).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutcomeCounts {
    pub passed: u64,
    pub failed: u64,
    pub format_failed: u64,
    pub no_submission: u64,
    pub agent_error: u64,
}

impl OutcomeCounts {
    pub fn add(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Passed => self.passed += 1,
            Outcome::Failed => self.failed += 1,
            Outcome::FormatFailed => self.format_failed += 1,
            Outcome::NoSubmission => self.no_submission += 1,
            Outcome::AgentError => self.agent_error += 1,
        }
    }

    pub fn total(&self) -> u64 {
        self.passed + self.failed + self.format_failed + self.no_submission + self.agent_error
    }

    pub fn pass_rate(&self) -> Option<f64> {
        match self.total() {
            0 => None,
            total => Some(self.passed as f64 / total as f64),
        }
    }

    fn from_raw(raw: &BTreeMap<String, u64>) -> Self {
        let mut counts = Self::default();
        for (key, n) in raw {
            if let Some(outcome) = Outcome::from_value(key) {
                match outcome {
                    Outcome::Passed => counts.passed += n,
                    Outcome::Failed => counts.failed += n,
                    Outcome::FormatFailed => counts.format_failed += n,
                    Outcome::NoSubmission => counts.no_submission += n,
                    Outcome::AgentError => counts.agent_error += n,
                }
            }
        }
        counts
    }
}

/// How much rubric coverage a run has, relative to its discovered rollouts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RubricStatus {
    None,
    Full { count: usize },
    Partial { present: usize, total: usize },
}

/// The four fixed rubric keys, typed so the averages table can't drift from core's [`Rubrics`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RubricKey {
    Knowledge,
    Reasoning,
    InstructionFollowing,
    EnvErgonomics,
}

impl RubricKey {
    pub const ALL: [RubricKey; 4] = [
        RubricKey::Knowledge,
        RubricKey::Reasoning,
        RubricKey::InstructionFollowing,
        RubricKey::EnvErgonomics,
    ];

    pub fn label(self) -> &'static str {
        match self {
            RubricKey::Knowledge => "knowledge",
            RubricKey::Reasoning => "reasoning",
            RubricKey::InstructionFollowing => "instruction_following",
            RubricKey::EnvErgonomics => "env_ergonomics",
        }
    }

    pub fn score(self, rubrics: &Rubrics) -> &archestra_bench_core::RubricScore {
        match self {
            RubricKey::Knowledge => &rubrics.knowledge,
            RubricKey::Reasoning => &rubrics.reasoning,
            RubricKey::InstructionFollowing => &rubrics.instruction_following,
            RubricKey::EnvErgonomics => &rubrics.env_ergonomics,
        }
    }
}

/// Which pipeline produced a rendered reduce-phase report. The Rust analyzer writes
/// `trajectory_analysis_<ts>.md`; the Claude skill writes `trajectory_analysis_claude_<ts>.md`.
/// Discriminant order (analyzer, then Claude) is relied on for both slot indexing and render order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReduceSource {
    Analyzer,
    Claude,
}

impl ReduceSource {
    pub const ALL: [ReduceSource; 2] = [ReduceSource::Analyzer, ReduceSource::Claude];

    pub fn label(self) -> &'static str {
        match self {
            ReduceSource::Analyzer => "Analyzer report",
            ReduceSource::Claude => "Claude report",
        }
    }
}

/// A discovered reduce-phase markdown report. Its content quotes untrusted agent/tool output, so the
/// view renders it through the same neutralizing markdown path as trajectories.
#[derive(Debug, Clone)]
pub struct ReduceReport {
    pub source: ReduceSource,
    pub filename: String,
    pub markdown: String,
}

/// Mean of a triage record's four grades.
pub fn mean_grade(rubrics: &Rubrics) -> f64 {
    let sum: u32 = RubricKey::ALL
        .iter()
        .map(|k| u32::from(k.score(rubrics).grade.value()))
        .sum();
    f64::from(sum) / 4.0
}

/// One discovered rollout: identity from `run.json` (never the directory name), artifact dir
/// derived from that identity via core's `rollout_dir`.
#[derive(Debug, Clone)]
pub struct Rollout {
    pub id: RolloutId,
    pub dir: PathBuf,
    pub meta: RunMeta,
}

/// A fully loaded run: everything the run and rollout pages need, keyed for opaque-id lookup.
#[derive(Debug)]
pub struct Run {
    pub id: String,
    pub dir: PathBuf,
    pub mtime: SystemTime,
    pub config: Option<RunConfig>,
    pub aggregate: Option<Aggregate>,
    /// Keyed by the `<env>/<task>__<lane>` display string of [`RolloutId`] — the same opaque key
    /// the rollout URLs carry.
    pub rollouts: BTreeMap<String, Rollout>,
    /// Rubric records keyed by their `rollout` field (same key space as `rollouts`).
    pub rubrics: BTreeMap<String, TriageRecord>,
    pub rubric_status: RubricStatus,
    /// Latest rendered reduce-phase report per source (analyzer, Claude), in that order. Empty when
    /// no reduce report has been written for the run yet.
    pub reports: Vec<ReduceReport>,
    /// Non-fatal problems (malformed rollout dirs, malformed rubric files) surfaced in the UI.
    pub warnings: Vec<String>,
}

impl Run {
    pub fn counts(&self) -> OutcomeCounts {
        match &self.aggregate {
            Some(agg) => OutcomeCounts::from_raw(&agg.outcomes),
            None => {
                let mut counts = OutcomeCounts::default();
                for rollout in self.rollouts.values() {
                    if let Some(outcome) = Outcome::from_value(&rollout.meta.outcome) {
                        counts.add(outcome);
                    }
                }
                counts
            }
        }
    }

    pub fn pass_rate(&self) -> Option<f64> {
        match &self.aggregate {
            Some(agg) if agg.pass_rate.is_some() => agg.pass_rate,
            _ => self.counts().pass_rate(),
        }
    }

    /// Lane names for grid columns: config order when available, otherwise the distinct lanes
    /// observed in the rollouts.
    pub fn lane_names(&self) -> Vec<String> {
        match &self.config {
            Some(cfg) if !cfg.lanes.is_empty() => cfg.lanes.iter().map(|l| l.name.clone()).collect(),
            _ => {
                let mut lanes: Vec<String> = self.rollouts.values().map(|r| r.id.lane.clone()).collect();
                lanes.sort();
                lanes.dedup();
                lanes
            }
        }
    }

    pub fn env_names(&self) -> Vec<String> {
        match &self.config {
            Some(cfg) if !cfg.environments.is_empty() => cfg.environments.iter().map(|e| e.id.clone()).collect(),
            _ => {
                let mut envs: Vec<String> = self.rollouts.values().map(|r| r.id.env.clone()).collect();
                envs.sort();
                envs.dedup();
                envs
            }
        }
    }

    /// Per-lane average of one rubric over the records present. `None` when a lane has no records.
    pub fn lane_rubric_avg(&self, lane: &str, key: RubricKey) -> Option<f64> {
        self.rubric_avg_where(key, |r| r.id.lane == lane)
    }

    /// Overall average of one rubric across every rollout that has a record — the aggregate the
    /// by-lane table's "avg" column shows. `None` when the run has no rubric records at all.
    pub fn rubric_avg(&self, key: RubricKey) -> Option<f64> {
        self.rubric_avg_where(key, |_| true)
    }

    fn rubric_avg_where(&self, key: RubricKey, pred: impl Fn(&Rollout) -> bool) -> Option<f64> {
        let grades: Vec<f64> = self
            .rollouts
            .values()
            .filter(|r| pred(r))
            .filter_map(|r| self.rubrics.get(&r.id.to_string()))
            .map(|rec| f64::from(rec.rubrics.grade_of(key)))
            .collect();
        match grades.len() {
            0 => None,
            n => Some(grades.iter().sum::<f64>() / n as f64),
        }
    }
}

/// Small extension so callers can pull a grade by [`RubricKey`] without repeating the match.
trait GradeOf {
    fn grade_of(&self, key: RubricKey) -> u8;
}

impl GradeOf for Rubrics {
    fn grade_of(&self, key: RubricKey) -> u8 {
        key.score(self).grade.value()
    }
}

/// A row of the run list: enough to render `GET /` without holding the full run.
#[derive(Debug)]
pub struct RunListEntry {
    pub id: String,
    pub mtime: SystemTime,
    pub envs: Vec<String>,
    pub lanes: Vec<String>,
    pub counts: OutcomeCounts,
    pub pass_rate: Option<f64>,
    pub rubric_status: RubricStatus,
    /// Which reduce-phase reports exist for the run, in [`ReduceSource::ALL`] order.
    pub report_sources: Vec<ReduceSource>,
}

/// True when the directory looks like a run root (the harness always writes `config.json` first
/// and `aggregate.json` last, so either marks a run).
fn is_run_dir(dir: &Path) -> bool {
    dir.is_dir() && (dir.join(CONFIG_JSON).is_file() || dir.join(AGGREGATE_JSON).is_file())
}

/// Scan the experiments dir for runs, newest (by dir mtime) first. A missing experiments dir is an
/// empty list, not an error — the dashboard should come up before the first run exists.
pub fn list_runs(experiments_dir: &Path) -> Result<Vec<RunListEntry>> {
    let entries = match std::fs::read_dir(experiments_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut runs = Vec::new();
    for entry in entries {
        let entry = entry.wrap_err("reading experiments dir entry")?;
        let dir = entry.path();
        if !is_run_dir(&dir) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let run = load_run_dir(&dir, &id)?;
        runs.push(RunListEntry {
            id: run.id.clone(),
            mtime: run.mtime,
            envs: run.env_names(),
            lanes: run.lane_names(),
            counts: run.counts(),
            pass_rate: run.pass_rate(),
            rubric_status: run.rubric_status,
            report_sources: run.reports.iter().map(|r| r.source).collect(),
        });
    }
    runs.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| b.id.cmp(&a.id)));
    Ok(runs)
}

/// Load one run by id. `Ok(None)` when `run_id` does not exactly match a scanned run dir name —
/// the id is matched against directory listing names, never joined into a path, so traversal
/// sequences can't escape the experiments dir.
pub fn load_run(experiments_dir: &Path, run_id: &str) -> Result<Option<Run>> {
    let entries = match std::fs::read_dir(experiments_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };
    for entry in entries {
        let entry = entry.wrap_err("reading experiments dir entry")?;
        if entry.file_name().to_string_lossy() != run_id {
            continue;
        }
        let dir = entry.path();
        if !is_run_dir(&dir) {
            return Ok(None);
        }
        return Ok(Some(load_run_dir(&dir, run_id)?));
    }
    Ok(None)
}

fn load_run_dir(dir: &Path, id: &str) -> Result<Run> {
    let mtime = std::fs::metadata(dir)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut warnings = Vec::new();

    let config = read_json_lenient::<RunConfig>(&dir.join(CONFIG_JSON), &mut warnings);
    let aggregate = read_json_lenient::<Aggregate>(&dir.join(AGGREGATE_JSON), &mut warnings);
    let rollouts = discover_rollouts(dir, &mut warnings)?;
    let (rubrics, rubric_file_found) = load_rubrics(dir, &mut warnings)?;
    let reports = load_reports(dir, &mut warnings)?;

    let matched = rollouts.keys().filter(|k| rubrics.contains_key(*k)).count();
    for key in rubrics.keys().filter(|k| !rollouts.contains_key(*k)) {
        warnings.push(format!(
            "rubric record for unknown rollout {key} (no matching run.json)"
        ));
    }
    let rubric_status = match (rubric_file_found, matched) {
        (false, _) | (true, 0) => RubricStatus::None,
        (true, n) if n == rollouts.len() => RubricStatus::Full { count: n },
        (true, n) => RubricStatus::Partial {
            present: n,
            total: rollouts.len(),
        },
    };

    Ok(Run {
        id: id.to_string(),
        dir: dir.to_path_buf(),
        mtime,
        config,
        aggregate,
        rollouts,
        rubrics,
        rubric_status,
        reports,
        warnings,
    })
}

/// Discover the latest reduce-phase report of each source. "Latest" by the `<ts>` embedded in the
/// file name (lexical, same convention as [`load_rubrics`], never mtime). Reports are returned in
/// [`ReduceSource::ALL`] order. An unreadable report is skipped with a warning, not a hard failure.
fn load_reports(run_dir: &Path, warnings: &mut Vec<String>) -> Result<Vec<ReduceReport>> {
    let pattern = run_dir.join("trajectory_analysis_*.md");
    let pattern = pattern.to_string_lossy();
    // One slot per source, indexed by discriminant; each holds the newest `(ts, path)` seen.
    let mut latest: [Option<(String, PathBuf)>; ReduceSource::ALL.len()] = [None, None];
    for entry in glob::glob(&pattern).wrap_err("invalid report glob pattern")? {
        let path = entry.wrap_err("reading report glob entry")?;
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let source = match stem.contains("_claude_") {
            true => ReduceSource::Claude,
            false => ReduceSource::Analyzer,
        };
        let ts = stem.rsplit('_').next().unwrap_or_default().to_string();
        let slot = &mut latest[source as usize];
        let newer = match slot {
            Some((best, _)) => ts > *best,
            None => true,
        };
        if newer {
            *slot = Some((ts, path));
        }
    }
    let mut reports = Vec::new();
    for (source, slot) in ReduceSource::ALL.into_iter().zip(latest) {
        let Some((_, path)) = slot else { continue };
        match std::fs::read_to_string(&path) {
            Ok(markdown) => reports.push(ReduceReport {
                source,
                filename: path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                markdown,
            }),
            Err(err) => warnings.push(format!("unreadable report file {}: {err}", path.display())),
        }
    }
    Ok(reports)
}

/// Parse an optional JSON artifact; a malformed file degrades to `None` plus a warning instead of
/// failing the whole run page.
fn read_json_lenient<T: serde::de::DeserializeOwned>(path: &Path, warnings: &mut Vec<String>) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(err) => {
            warnings.push(format!("malformed {}: {err}", path.display()));
            None
        }
    }
}

/// Glob `<run>/*/*__*/run.json` and parse each into a [`Rollout`]. Malformed files are skipped
/// with a warning; identity always comes from the parsed `run.json`, never the directory name.
fn discover_rollouts(run_dir: &Path, warnings: &mut Vec<String>) -> Result<BTreeMap<String, Rollout>> {
    let pattern = run_dir.join("*/*__*").join(RUN_JSON);
    let pattern = pattern.to_string_lossy();
    let mut rollouts = BTreeMap::new();
    for entry in glob::glob(&pattern).wrap_err("invalid rollout glob pattern")? {
        let path = entry.wrap_err("reading rollout glob entry")?;
        let meta: RunMeta = match std::fs::read(&path)
            .map_err(eyre::Report::from)
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(eyre::Report::from))
        {
            Ok(meta) => meta,
            Err(err) => {
                warnings.push(format!("skipped malformed rollout {}: {err}", path.display()));
                continue;
            }
        };
        let id = meta.rollout_id();
        let dir = run_dir.join(rollout_dir(&id.env, &id.task, &id.lane));
        // A copied/stale run.json whose identity doesn't match the directory it sits in would
        // silently point artifact links at the wrong rollout — same cross-check the analyzer does.
        if path.parent() != Some(dir.as_path()) {
            warnings.push(format!(
                "skipped rollout {}: run.json identity `{id}` does not match its directory",
                path.display()
            ));
            continue;
        }
        rollouts.insert(id.to_string(), Rollout { id, dir, meta });
    }
    Ok(rollouts)
}

/// Parse the latest `trajectory_rubrics*.jsonl`, "latest" by the `<ts>` embedded in the file name
/// (`%Y%m%d-%H%M%S`, lexically ordered) — mtime is not trusted, a stale file touched later must not
/// shadow a newer analysis. Returns `(records, file_found)`. Any malformed line invalidates the
/// whole file: empty records plus a warning, per the strict-oracle convention — a half-trusted
/// rubric table is worse than none.
fn load_rubrics(run_dir: &Path, warnings: &mut Vec<String>) -> Result<(BTreeMap<String, TriageRecord>, bool)> {
    let pattern = run_dir.join("trajectory_rubrics*.jsonl");
    let pattern = pattern.to_string_lossy();
    let mut latest: Option<((String, String), PathBuf)> = None;
    for entry in glob::glob(&pattern).wrap_err("invalid rubric glob pattern")? {
        let path = entry.wrap_err("reading rubric glob entry")?;
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ts = stem.rsplit('_').next().unwrap_or_default().to_string();
        let key = (ts, stem);
        let newer = match &latest {
            Some((best, _)) => key > *best,
            None => true,
        };
        if newer {
            latest = Some((key, path));
        }
    }
    let Some((_, path)) = latest else {
        return Ok((BTreeMap::new(), false));
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) => {
            warnings.push(format!("unreadable rubric file {}: {err}", path.display()));
            return Ok((BTreeMap::new(), true));
        }
    };
    let mut records = BTreeMap::new();
    for (lineno, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<TriageRecord>(line) {
            Ok(record) => {
                records.insert(record.rollout.clone(), record);
            }
            Err(err) => {
                warnings.push(format!(
                    "malformed rubric file {} (line {}): {err} — rendering run as rubric-less",
                    path.display(),
                    lineno + 1
                ));
                return Ok((BTreeMap::new(), true));
            }
        }
    }
    Ok((records, true))
}
