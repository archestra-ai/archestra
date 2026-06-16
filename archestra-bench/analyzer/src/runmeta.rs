//! Typed model of a rollout's `run.json` plus the deterministic metrics block fed to the reducer.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

use eyre::{Context, Result};
use serde::Deserialize;

/// Identifies a benchmark rollout. Taken from `run.json`'s authoritative fields rather than the
/// `task__lane` directory name, which is `__`-ambiguous. Ordering drives deterministic reduce input.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RolloutId {
    pub env: String,
    pub task: String,
    pub lane: String,
}

impl fmt::Display for RolloutId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}__{}", self.env, self.task, self.lane)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunMeta {
    pub env_id: String,
    pub task_id: String,
    pub lane: String,
    pub provider: String,
    pub model: String,
    pub outcome: String,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub tool_call_count: u64,
    #[serde(default)]
    pub turn_count: u64,
    #[serde(default)]
    pub total_tokens: Option<u64>,
    #[serde(default)]
    pub agent_error: Option<String>,
    #[serde(default)]
    pub stage_count: u64,
    #[serde(default)]
    pub format_attempts: u64,
    #[serde(default)]
    pub verifier_exit_code: Option<i64>,
    #[serde(default)]
    pub verifier_timed_out: Option<bool>,
}

impl RunMeta {
    pub fn rollout_id(&self) -> RolloutId {
        RolloutId {
            env: self.env_id.clone(),
            task: self.task_id.clone(),
            lane: self.lane.clone(),
        }
    }

    pub fn is_pass(&self) -> bool {
        self.outcome == "passed"
    }

    /// One-line outcome summary embedded in the per-trajectory map prompt.
    pub fn summarize_outcome(&self) -> String {
        let mut parts = vec![
            format!("outcome={}", self.outcome),
            format!("provider/model={}/{}", self.provider, self.model),
            format!("turns={}", self.turn_count),
            format!("tool_calls={}", self.tool_call_count),
            format!("stages={}", self.stage_count),
            format!("format_attempts={}", self.format_attempts),
        ];
        if let Some(reason) = &self.finish_reason {
            parts.push(format!("finish={reason}"));
        }
        if let Some(tokens) = self.total_tokens {
            parts.push(format!("tokens={tokens}"));
        }
        if let Some(code) = self.verifier_exit_code {
            parts.push(format!("verifier_exit={code}"));
        }
        if self.verifier_timed_out == Some(true) {
            parts.push("verifier_timed_out=true".to_string());
        }
        if let Some(err) = &self.agent_error {
            parts.push(format!("agent_error={err}"));
        }
        parts.join(" ")
    }
}

pub fn load_run_meta(rollout_dir: &Path) -> Result<RunMeta> {
    let path = rollout_dir.join("run.json");
    let content = std::fs::read_to_string(&path)
        .wrap_err_with(|| format!("reading required run.json at {}", path.display()))?;
    serde_json::from_str(&content)
        .wrap_err_with(|| format!("parsing run.json at {}", path.display()))
}

const FAILURE_CLUSTERS: &[&str] = &["format_failed", "no_submission", "agent_error", "failed"];

/// Deterministic quantitative grounding for the reducer: outcome counts, failure clusters,
/// and per-task pass rates. Pure over the loaded rollouts.
pub fn metrics_block(rollouts: &[(RolloutId, RunMeta)]) -> String {
    let total = rollouts.len();
    let passed = rollouts.iter().filter(|(_, m)| m.is_pass()).count();

    let mut outcome_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (_, m) in rollouts {
        *outcome_counts.entry(m.outcome.as_str()).or_default() += 1;
    }

    let mut per_task: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (id, m) in rollouts {
        let entry = per_task.entry(id.task.as_str()).or_default();
        entry.1 += 1;
        if m.is_pass() {
            entry.0 += 1;
        }
    }

    let mut out = String::from("## Run metrics\n\n");
    out.push_str(&format!(
        "- overall: {passed}/{total} passed ({:.0}%)\n",
        pct(passed, total)
    ));
    out.push_str("- outcomes: ");
    out.push_str(
        &outcome_counts
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    out.push_str("\n\n### Per-task pass rate\n");
    for (task, (p, t)) in &per_task {
        out.push_str(&format!("- `{task}`: {p}/{t} ({:.0}%)\n", pct(*p, *t)));
    }

    out.push_str("\n### Failure clusters\n");
    let mut any_failure = false;
    for cluster in FAILURE_CLUSTERS {
        let members: Vec<String> = rollouts
            .iter()
            .filter(|(_, m)| m.outcome == *cluster)
            .map(|(id, _)| id.to_string())
            .collect();
        if !members.is_empty() {
            any_failure = true;
            out.push_str(&format!("- **{cluster}**: {}\n", members.join(", ")));
        }
    }
    if !any_failure {
        out.push_str("- none\n");
    }
    out
}

fn pct(num: usize, den: usize) -> f64 {
    if den == 0 {
        0.0
    } else {
        100.0 * num as f64 / den as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn meta(json: &str) -> RunMeta {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn parses_minimal_run_json_with_null_tokens() {
        let m = meta(
            r#"{"env_id":"basic","task_id":"crypto-price","lane":"minimax","provider":"openrouter",
                "model":"minimax/minimax-m3","outcome":"passed","finish_reason":"stop",
                "tool_call_count":6,"turn_count":7,"total_tokens":null,"stage_count":1,
                "format_attempts":1,"agent_error":null,"verifier_exit_code":0}"#,
        );
        assert_eq!(
            m.rollout_id(),
            RolloutId {
                env: "basic".into(),
                task: "crypto-price".into(),
                lane: "minimax".into()
            }
        );
        assert!(m.is_pass());
        assert!(m.total_tokens.is_none());
        assert!(m.summarize_outcome().contains("outcome=passed"));
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        let m = meta(
            r#"{"env_id":"e","task_id":"t","lane":"l","provider":"p","model":"m","outcome":"failed"}"#,
        );
        assert_eq!(m.turn_count, 0);
        assert!(m.finish_reason.is_none());
        assert!(!m.is_pass());
    }

    #[test]
    fn load_run_meta_errors_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_run_meta(dir.path()).unwrap_err();
        assert!(err.to_string().contains("run.json"));
    }

    #[test]
    fn load_run_meta_reads_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = std::fs::File::create(dir.path().join("run.json")).unwrap();
        write!(
            f,
            r#"{{"env_id":"e","task_id":"t","lane":"l","provider":"p","model":"m","outcome":"passed"}}"#
        )
        .unwrap();
        let m = load_run_meta(dir.path()).unwrap();
        assert_eq!(m.task_id, "t");
    }

    #[test]
    fn metrics_block_reports_rates_and_clusters() {
        let rollouts = vec![
            (
                RolloutId {
                    env: "basic".into(),
                    task: "a".into(),
                    lane: "x".into(),
                },
                meta(
                    r#"{"env_id":"basic","task_id":"a","lane":"x","provider":"p","model":"m","outcome":"passed"}"#,
                ),
            ),
            (
                RolloutId {
                    env: "basic".into(),
                    task: "a".into(),
                    lane: "y".into(),
                },
                meta(
                    r#"{"env_id":"basic","task_id":"a","lane":"y","provider":"p","model":"m","outcome":"failed"}"#,
                ),
            ),
            (
                RolloutId {
                    env: "basic".into(),
                    task: "b".into(),
                    lane: "x".into(),
                },
                meta(
                    r#"{"env_id":"basic","task_id":"b","lane":"x","provider":"p","model":"m","outcome":"agent_error"}"#,
                ),
            ),
        ];
        let block = metrics_block(&rollouts);
        assert!(block.contains("1/3 passed"));
        assert!(block.contains("`a`: 1/2"));
        assert!(block.contains("**agent_error**: basic/b__x"));
    }
}
