use std::collections::HashMap;

// The outcome taxonomy is the shared run.json contract (analyzer reads the same strings).
pub use archestra_bench_core::Outcome;

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

/// Aggregate stats for one slice of rollouts (the whole run, or one env/task/lane group).
#[derive(Debug, Clone)]
pub struct GroupAggregate {
    pub key: String,
    pub total: usize,
    pub passed: usize,
    pub outcomes: HashMap<String, usize>,
    pub total_turns: usize,
    pub total_tokens: i64,
    /// Rollouts that reported a token count — the denominator for `avg_tokens` (infra/error rollouts
    /// have none, and folding them in as 0 would understate the average).
    pub tokens_n: usize,
}

impl GroupAggregate {
    pub fn pass_rate(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.passed as f64 / self.total as f64
        }
    }

    pub fn avg_turns(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.total_turns as f64 / self.total as f64
        }
    }

    pub fn avg_tokens(&self) -> Option<f64> {
        if self.tokens_n == 0 {
            None
        } else {
            Some(self.total_tokens as f64 / self.tokens_n as f64)
        }
    }
}

#[derive(Debug, Clone)]
pub struct Aggregate {
    pub overall: GroupAggregate,
    pub per_env: Vec<GroupAggregate>,
    pub per_task: Vec<GroupAggregate>,
    pub per_lane: Vec<GroupAggregate>,
}

impl Aggregate {
    pub fn to_json(&self) -> serde_json::Value {
        let o = &self.overall;
        serde_json::json!({
            "total": o.total,
            "passed": o.passed,
            "pass_rate": o.pass_rate(),
            "avg_turns": o.avg_turns(),
            "avg_tokens": o.avg_tokens(),
            "total_turns": o.total_turns,
            "total_tokens": o.total_tokens,
            "outcomes": o.outcomes,
            "per_env": self.per_env.iter().map(|g| group_json("env_id", g)).collect::<Vec<_>>(),
            "per_task": self.per_task.iter().map(|g| group_json("task_id", g)).collect::<Vec<_>>(),
            "per_lane": self.per_lane.iter().map(|g| group_json("lane", g)).collect::<Vec<_>>(),
        })
    }
}

fn group_json(key_name: &str, g: &GroupAggregate) -> serde_json::Value {
    serde_json::json!({
        key_name: g.key,
        "total": g.total,
        "passed": g.passed,
        "pass_rate": g.pass_rate(),
        "avg_turns": g.avg_turns(),
        "avg_tokens": g.avg_tokens(),
        "total_turns": g.total_turns,
        "total_tokens": g.total_tokens,
        "outcomes": g.outcomes,
    })
}

pub fn aggregate(results: &[RunResult]) -> Aggregate {
    let all: Vec<&RunResult> = results.iter().collect();
    Aggregate {
        overall: group_aggregate("overall".to_string(), &all),
        per_env: group_by(results, |r| &r.env_id),
        per_task: group_by(results, |r| &r.task_id),
        per_lane: group_by(results, |r| &r.lane),
    }
}

fn group_aggregate(key: String, rows: &[&RunResult]) -> GroupAggregate {
    let mut outcomes: HashMap<String, usize> = HashMap::new();
    for r in rows {
        *outcomes.entry(r.outcome.value().to_string()).or_default() += 1;
    }
    GroupAggregate {
        key,
        total: rows.len(),
        passed: rows.iter().filter(|r| r.verifier_passed()).count(),
        outcomes,
        total_turns: rows.iter().map(|r| r.turn_count).sum(),
        total_tokens: rows.iter().filter_map(|r| r.total_tokens).sum(),
        tokens_n: rows.iter().filter(|r| r.total_tokens.is_some()).count(),
    }
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
            group_aggregate(key, &rows)
        })
        .collect()
}

/// The default benchmark report: aggregates only. Per-rollout detail lives in each rollout's `run.json`
/// under the run dir, so the report stays a quick-scan summary rather than a wide raw table.
pub fn render_markdown(rows: &[RunResult]) -> String {
    let mut lines = vec!["# Archestra benchmark results".to_string(), String::new()];
    if rows.is_empty() {
        lines.push("_no rollouts_".to_string());
        return lines.join("\n") + "\n";
    }

    let agg = aggregate(rows);
    lines.push(format!("**overall**: {}", stats(&agg.overall)));

    for (title, groups) in [
        ("By environment", &agg.per_env),
        ("By task", &agg.per_task),
        ("By lane", &agg.per_lane),
    ] {
        lines.push(String::new());
        lines.push(format!("## {title}"));
        for g in groups {
            lines.push(format!("- `{}`: {}", g.key, stats(g)));
        }
    }

    lines.join("\n") + "\n"
}

/// One line of stats for a group: success rate, then avg turns/tokens, then the non-passed outcome
/// breakdown (the failure reasons) when there are any.
fn stats(g: &GroupAggregate) -> String {
    let tokens = g
        .avg_tokens()
        .map(|t| format!("{t:.0}"))
        .unwrap_or_else(|| "n/a".to_string());
    let failures = failure_summary(&g.outcomes);
    let tail = if failures.is_empty() {
        String::new()
    } else {
        format!(" — {failures}")
    };
    format!(
        "{}/{} passed ({:.0}%) · avg turns {:.1} · avg tokens {}{}",
        g.passed,
        g.total,
        g.pass_rate() * 100.0,
        g.avg_turns(),
        tokens,
        tail
    )
}

fn failure_summary(outcomes: &HashMap<String, usize>) -> String {
    let mut pairs: Vec<_> = outcomes
        .iter()
        .filter(|(name, _)| name.as_str() != Outcome::Passed.value())
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
        .into_iter()
        .map(|(name, count)| format!("{name}={count}"))
        .collect::<Vec<_>>()
        .join(", ")
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
        assert_eq!(agg.overall.total, 3);
        assert_eq!(agg.overall.passed, 2);
        assert_eq!(agg.overall.outcomes.get("passed"), Some(&2));
        assert_eq!(agg.overall.outcomes.get("failed"), Some(&1));
    }

    #[test]
    fn test_aggregate_averages_turns_and_tokens() {
        let mut a = result("basic", "t1", "l1", Outcome::Passed);
        a.turn_count = 4;
        a.total_tokens = Some(1000);
        let mut b = result("basic", "t2", "l1", Outcome::Failed);
        b.turn_count = 2;
        b.total_tokens = None; // an infra/error rollout reports no tokens
        let agg = aggregate(&[a, b]);
        assert_eq!(agg.overall.avg_turns(), 3.0); // (4 + 2) / 2 rollouts
        // tokens averaged only over rollouts that reported them (1), not all (2).
        assert_eq!(agg.overall.avg_tokens(), Some(1000.0));
    }

    #[test]
    fn test_render_markdown_is_aggregate_only() {
        let mut a = result("basic", "t1", "l1", Outcome::Passed);
        a.total_tokens = Some(1500);
        let md = render_markdown(&[a, result("basic", "t2", "l1", Outcome::Failed)]);
        assert!(
            !md.contains("Pass matrix"),
            "default report drops the raw table"
        );
        assert!(md.contains("**overall**: 1/2 passed (50%)"));
        assert!(md.contains("avg turns"));
        assert!(md.contains("avg tokens"));
        assert!(md.contains("failed=1"), "failure reasons are reported");
        assert!(md.contains("## By task"));
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
