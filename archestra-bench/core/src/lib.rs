//! Shared data contract for the archestra-bench harness (writer) and trajectory analyzer (reader).
//!
//! Both sides read/write the same on-disk artifacts (`run.json`, `trajectory.jsonl`) under the same
//! `experiments/<run>/<env>/<task>__<lane>` layout. Defining those shapes once here keeps the two
//! from silently drifting — the rollout-directory layout already drifted once and broke the analyzer.

use std::fmt;

use serde::Deserialize;
use serde_json::Value;

mod lanes;
pub use lanes::{Lane, LaneError, Provider, find_lane, is_slug, load_lanes};

/// Per-rollout artifact file names.
pub const RUN_JSON: &str = "run.json";
pub const TRAJECTORY_JSONL: &str = "trajectory.jsonl";
pub const CONFIG_JSON: &str = "config.json";
pub const AGGREGATE_JSON: &str = "aggregate.json";
pub const SUBMISSION_JSON: &str = "submission.json";

/// Slug-normalize an id for use in a filesystem path: keep `[A-Za-z0-9._-]`, replace anything else
/// with `_`, trim leading/trailing `._-`, and fall back to `run` if nothing survives.
pub fn slug(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let s = out
        .trim_matches(|c| c == '.' || c == '_' || c == '-')
        .to_string();
    if s.is_empty() { "run".to_string() } else { s }
}

/// The per-rollout artifact directory, relative to the run root: `<env>/<task>__<lane>`. This is the
/// single source of truth for the layout the harness writes and the analyzer reads.
pub fn rollout_dir(env_id: &str, task_id: &str, lane: &str) -> String {
    format!("{}/{}__{}", slug(env_id), slug(task_id), slug(lane))
}

/// The terminal classification of a rollout, as written to `run.json`'s `outcome` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Outcome {
    Passed,
    Failed,
    FormatFailed,
    NoSubmission,
    AgentError,
}

impl Outcome {
    pub fn value(&self) -> &'static str {
        match self {
            Outcome::Passed => "passed",
            Outcome::Failed => "failed",
            Outcome::FormatFailed => "format_failed",
            Outcome::NoSubmission => "no_submission",
            Outcome::AgentError => "agent_error",
        }
    }

    pub fn from_value(value: &str) -> Option<Self> {
        match value {
            "passed" => Some(Outcome::Passed),
            "failed" => Some(Outcome::Failed),
            "format_failed" => Some(Outcome::FormatFailed),
            "no_submission" => Some(Outcome::NoSubmission),
            "agent_error" => Some(Outcome::AgentError),
            _ => None,
        }
    }
}

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

/// Typed model of a rollout's `run.json`. The harness writes a superset of these fields; the analyzer
/// reads exactly this subset, tolerating missing optionals for forward-compat.
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
        self.outcome == Outcome::Passed.value()
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

/// One `kind`-tagged line of a `trajectory.jsonl`. Unrecognised kinds degrade to [`Event::Unknown`]
/// (forward-compat); known kinds missing a required field are a deserialization error.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    ConversationCreated,
    AssistantText {
        text: String,
    },
    ToolCall {
        tool_name: String,
        input: Value,
    },
    ToolOutput {
        output: Value,
    },
    TokenUsage,
    Finish,
    StageComplete {
        stage: u32,
    },
    AgentError {
        error: String,
    },
    Error {
        error: String,
    },
    /// Boot/seed/setup failure; the sole record in an infra-failed rollout's trajectory.
    InfraError {
        error: String,
    },
    ArtifactMissing {
        error: String,
    },
    ParseError {
        #[serde(default)]
        reason: Option<String>,
    },
    /// Raw stream framing the harness could not classify, plus any future event kinds.
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_normalizes_and_falls_back() {
        assert_eq!(slug("openai/gpt-4"), "openai_gpt-4");
        assert_eq!(slug("  ..weird.. "), "weird");
        assert_eq!(slug("///"), "run");
    }

    #[test]
    fn rollout_dir_is_env_task_lane() {
        assert_eq!(
            rollout_dir("basic", "median-salary", "kimi"),
            "basic/median-salary__kimi"
        );
    }

    #[test]
    fn outcome_roundtrips_through_value() {
        for o in [
            Outcome::Passed,
            Outcome::Failed,
            Outcome::FormatFailed,
            Outcome::NoSubmission,
            Outcome::AgentError,
        ] {
            assert_eq!(Outcome::from_value(o.value()), Some(o));
        }
        assert_eq!(Outcome::from_value("nope"), None);
    }

    #[test]
    fn run_meta_parses_minimal_and_tolerates_missing_optionals() {
        let m: RunMeta = serde_json::from_str(
            r#"{"env_id":"e","task_id":"t","lane":"l","provider":"p","model":"m","outcome":"passed"}"#,
        )
        .unwrap();
        assert!(m.is_pass());
        assert_eq!(m.turn_count, 0);
        assert_eq!(m.rollout_id().to_string(), "e/t__l");
    }

    #[test]
    fn event_parses_known_and_unknown_kinds() {
        let tool: Event =
            serde_json::from_str(r#"{"kind":"tool_call","tool_name":"run","input":{"cmd":"ls"}}"#)
                .unwrap();
        assert!(matches!(tool, Event::ToolCall { .. }));
        let unknown: Event = serde_json::from_str(r#"{"kind":"brand_new_kind"}"#).unwrap();
        assert!(matches!(unknown, Event::Unknown));
    }
}
