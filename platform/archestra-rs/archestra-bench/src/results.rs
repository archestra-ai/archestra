use std::collections::HashMap;

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

#[derive(Debug, Clone)]
pub struct RunResult {
    pub env_id: String,
    pub task_id: String,
    pub lane: String,
    pub provider: String,
    pub model: String,
    pub outcome: Outcome,
    pub finish_reason: Option<String>,
    pub tool_call_count: usize,
    pub turn_count: usize,
    pub total_tokens: Option<i64>,
    pub agent_error: Option<String>,
    pub stage_count: usize,
    pub format_attempts: usize,
    pub artifact_dir: Option<String>,
}

impl RunResult {
    pub fn verifier_passed(&self) -> bool {
        self.outcome == Outcome::Passed
    }
}

pub fn build_report(results: Vec<RunResult>) -> Result<Vec<RunResult>, String> {
    let mut seen = std::collections::HashSet::new();
    for result in &results {
        let key = (&result.env_id, &result.task_id, &result.lane);
        if !seen.insert(key) {
            return Err(format!(
                "duplicate result for ({}, {}, {})",
                result.env_id, result.task_id, result.lane
            ));
        }
    }
    let mut sorted = results;
    sorted.sort_by(|a, b| {
        a.env_id
            .cmp(&b.env_id)
            .then_with(|| a.task_id.cmp(&b.task_id))
            .then_with(|| a.lane.cmp(&b.lane))
    });
    Ok(sorted)
}

#[derive(Debug, Clone)]
pub struct GroupAggregate {
    pub key: String,
    pub total: usize,
    pub passed: usize,
    pub outcomes: HashMap<String, usize>,
}

impl GroupAggregate {
    pub fn pass_rate(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.passed as f64 / self.total as f64
        }
    }
}

#[derive(Debug, Clone)]
pub struct Aggregate {
    pub total: usize,
    pub passed: usize,
    pub outcomes: HashMap<String, usize>,
    pub total_turns: usize,
    pub total_tokens: i64,
    pub per_env: Vec<GroupAggregate>,
    pub per_task: Vec<GroupAggregate>,
    pub per_lane: Vec<GroupAggregate>,
}

impl Aggregate {
    pub fn pass_rate(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.passed as f64 / self.total as f64
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "total": self.total,
            "passed": self.passed,
            "pass_rate": self.pass_rate(),
            "outcomes": self.outcomes,
            "total_turns": self.total_turns,
            "total_tokens": self.total_tokens,
            "per_env": self.per_env.iter().map(|g| group_json("env_id", g)).collect::<Vec<_>>(),
            "per_task": self.per_task.iter().map(|g| group_json("task_id", g)).collect::<Vec<_>>(),
            "per_lane": self.per_lane.iter().map(|g| group_json("lane", g)).collect::<Vec<_>>(),
        })
    }
}

fn group_json(key_name: &str, group: &GroupAggregate) -> serde_json::Value {
    serde_json::json!({
        key_name: group.key,
        "total": group.total,
        "passed": group.passed,
        "pass_rate": group.pass_rate(),
        "outcomes": group.outcomes,
    })
}

pub fn aggregate(results: &[RunResult]) -> Aggregate {
    Aggregate {
        total: results.len(),
        passed: results.iter().filter(|r| r.verifier_passed()).count(),
        outcomes: outcome_counts(results),
        total_turns: results.iter().map(|r| r.turn_count).sum(),
        total_tokens: results.iter().map(|r| r.total_tokens.unwrap_or(0)).sum(),
        per_env: group_by(results, |r| &r.env_id),
        per_task: group_by(results, |r| &r.task_id),
        per_lane: group_by(results, |r| &r.lane),
    }
}

fn outcome_counts(results: &[RunResult]) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for result in results {
        *counts
            .entry(result.outcome.value().to_string())
            .or_default() += 1;
    }
    counts
}

fn group_by<F>(results: &[RunResult], key_fn: F) -> Vec<GroupAggregate>
where
    F: Fn(&RunResult) -> &str,
{
    let mut grouped: HashMap<String, Vec<&RunResult>> = HashMap::new();
    for result in results {
        grouped
            .entry(key_fn(result).to_string())
            .or_default()
            .push(result);
    }
    let mut keys: Vec<_> = grouped.keys().cloned().collect();
    keys.sort();
    keys.into_iter()
        .map(|key| {
            let rows = grouped.remove(&key).unwrap();
            GroupAggregate {
                key,
                total: rows.len(),
                passed: rows.iter().filter(|r| r.verifier_passed()).count(),
                outcomes: outcome_counts(&rows.into_iter().cloned().collect::<Vec<_>>()),
            }
        })
        .collect()
}

pub fn render_markdown(rows: &[RunResult]) -> String {
    let mut lines = vec!["# Archestra benchmark results".to_string(), String::new()];

    lines.push("## Pass matrix".to_string());
    lines.push(String::new());
    lines.push(
        "| env | task | lane | provider/model | outcome | finish | tools | tokens | stages | fmt | agent error | artifacts |"
            .to_string(),
    );
    lines.push(
        "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |".to_string(),
    );

    for row in rows {
        lines.push(format!(
            "| {} | {} | {} | {}/{} | {} | {} | {} | {} | {} | {} | {} | {} |",
            row.env_id,
            row.task_id,
            row.lane,
            row.provider,
            row.model,
            row.outcome.value(),
            cell(row.finish_reason.as_deref()),
            row.tool_call_count,
            cell(row.total_tokens.map(|n| n.to_string()).as_deref()),
            row.stage_count,
            row.format_attempts,
            cell(row.agent_error.as_deref()),
            cell(row.artifact_dir.as_deref()),
        ));
    }

    if !rows.is_empty() {
        let agg = aggregate(rows);
        lines.push(String::new());
        lines.push("## Aggregate".to_string());
        lines.push(String::new());
        lines.push(format!(
            "- overall: {}/{} passed ({:.0}%)",
            agg.passed,
            agg.total,
            agg.pass_rate() * 100.0
        ));
        lines.push(format!("- outcomes: {}", outcome_summary(&agg.outcomes)));
        lines.push(format!(
            "- turns: {}, tokens: {}",
            agg.total_turns, agg.total_tokens
        ));

        lines.push(String::new());
        lines.push("### By environment".to_string());
        for g in &agg.per_env {
            lines.push(group_line(g));
        }

        lines.push(String::new());
        lines.push("### By task".to_string());
        for g in &agg.per_task {
            lines.push(group_line(g));
        }

        lines.push(String::new());
        lines.push("### By lane".to_string());
        for g in &agg.per_lane {
            lines.push(group_line(g));
        }
    }

    lines.join("\n") + "\n"
}

fn group_line(group: &GroupAggregate) -> String {
    format!(
        "- `{}`: {}/{} passed ({:.0}%) - {}",
        group.key,
        group.passed,
        group.total,
        group.pass_rate() * 100.0,
        outcome_summary(&group.outcomes)
    )
}

fn outcome_summary(outcomes: &HashMap<String, usize>) -> String {
    if outcomes.is_empty() {
        return "-".to_string();
    }
    let mut pairs: Vec<_> = outcomes.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
        .into_iter()
        .map(|(name, count)| format!("{}={}", name, count))
        .collect::<Vec<_>>()
        .join(", ")
}

const MAX_CELL_WIDTH: usize = 160;

fn cell(value: Option<&str>) -> String {
    match value {
        None => "-".to_string(),
        Some(text) => {
            let text = text.replace('\n', " ");
            let text = if text.len() > MAX_CELL_WIDTH {
                format!("{}…", &text[..MAX_CELL_WIDTH - 1])
            } else {
                text
            };
            let text = text.replace('|', "\\|");
            if text.is_empty() {
                "-".to_string()
            } else {
                text
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(env_id: &str, task_id: &str, lane: &str, outcome: Outcome) -> RunResult {
        RunResult {
            env_id: env_id.to_string(),
            task_id: task_id.to_string(),
            lane: lane.to_string(),
            provider: "openai".to_string(),
            model: "gpt-4".to_string(),
            outcome,
            finish_reason: None,
            tool_call_count: 0,
            turn_count: 1,
            total_tokens: None,
            agent_error: None,
            stage_count: 1,
            format_attempts: 0,
            artifact_dir: None,
        }
    }

    #[test]
    fn test_aggregate_counts_outcomes() {
        let rows = vec![
            result("basic", "t1", "l1", Outcome::Passed),
            result("basic", "t2", "l1", Outcome::Failed),
            result("api", "t1", "l2", Outcome::Passed),
        ];
        let agg = aggregate(&rows);
        assert_eq!(agg.total, 3);
        assert_eq!(agg.passed, 2);
        assert_eq!(agg.outcomes.get("passed"), Some(&2));
        assert_eq!(agg.outcomes.get("failed"), Some(&1));
    }

    #[test]
    fn test_render_markdown_contains_matrix() {
        let rows = vec![result("basic", "t1", "l1", Outcome::Passed)];
        let md = render_markdown(&rows);
        assert!(md.contains("## Pass matrix"));
        assert!(md.contains("basic"));
        assert!(md.contains("passed"));
    }

    #[test]
    fn test_build_report_rejects_duplicates() {
        let rows = vec![
            result("basic", "t1", "l1", Outcome::Passed),
            result("basic", "t1", "l1", Outcome::Failed),
        ];
        assert!(build_report(rows).is_err());
    }
}
