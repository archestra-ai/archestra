use std::collections::HashMap;

// The outcome taxonomy is the shared run.json contract (analyzer reads the same strings).
pub use archestra_bench_core::Outcome;

/// A rollout's USD cost. The three states are kept distinct so unaccountable spend is never silently
/// dropped: `Unpriced` means billable spend happened that we could not price (no lane slug, a slug
/// absent from the price book, a model with cache-write tokens but no published write rate, mixed
/// models in one session, or a telemetry gap), and it makes any aggregate it lands in *incomplete*;
/// `NoSpend` is a real zero (no LLM call). serde_json cannot carry NaN, so the "loud" signal is the
/// explicit `Unpriced` count, not a NaN sentinel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RunCost {
    Priced(f64),
    Unpriced,
    NoSpend,
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
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    /// OpenRouter slug the run was priced against (`None` when the lane has no slug).
    pub price_model: Option<String>,
    pub cost: RunCost,
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
    pub total_cost_usd: f64,
    /// Rollouts that were priced — the denominator for the cost total (no-spend and unpriced rollouts
    /// are excluded rather than counted as $0).
    pub cost_n: usize,
    /// Rollouts that incurred billable spend we could not price. When > 0 the group's cost total is
    /// *incomplete*: it covers only the priced rollouts, so it is reported with a loud marker and
    /// nulled in JSON rather than passed off as the full figure.
    pub cost_unpriced_n: usize,
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

    /// Total USD cost over the group's priced rollouts, or `None` when none were priced (so an
    /// unpriced/no-spend group reads as `n/a` rather than a misleading `$0`). Not averaged — with few
    /// lanes the per-lane total is the figure worth seeing.
    pub fn cost_usd(&self) -> Option<f64> {
        (self.cost_n > 0).then_some(self.total_cost_usd)
    }

    /// JSON cost: the priced total only when every spend-bearing rollout was priced. When any rollout
    /// is unpriced the total is incomplete, so it is nulled — the `cost_unpriced_n` field carries the
    /// loud signal that would otherwise be lost (serde_json renders a NaN sentinel as null anyway).
    pub fn cost_usd_json(&self) -> Option<f64> {
        (self.cost_unpriced_n == 0).then(|| self.cost_usd()).flatten()
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
            "cost_usd": o.cost_usd_json(),
            "cost_unpriced_n": o.cost_unpriced_n,
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
        "cost_usd": g.cost_usd_json(),
        "cost_unpriced_n": g.cost_unpriced_n,
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
        total_cost_usd: rows
            .iter()
            .filter_map(|r| match r.cost {
                RunCost::Priced(c) => Some(c),
                RunCost::Unpriced | RunCost::NoSpend => None,
            })
            .sum(),
        cost_n: rows.iter().filter(|r| matches!(r.cost, RunCost::Priced(_))).count(),
        cost_unpriced_n: rows.iter().filter(|r| matches!(r.cost, RunCost::Unpriced)).count(),
    }
}

fn group_by<F>(results: &[RunResult], key_fn: F) -> Vec<GroupAggregate>
where
    F: Fn(&RunResult) -> &str,
{
    let mut grouped: HashMap<String, Vec<&RunResult>> = HashMap::new();
    for result in results {
        grouped.entry(key_fn(result).to_string()).or_default().push(result);
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
    let cost = match (g.cost_n, g.cost_unpriced_n) {
        (0, 0) => "n/a".to_string(),
        (_, 0) => format!("${:.4}", g.total_cost_usd),
        // Spend we could not price makes the total incomplete: show the priced subtotal (if any) with
        // a loud unpriced count rather than passing it off as the full cost.
        (0, n) => format!("incomplete ({n} unpriced)"),
        (_, n) => format!("${:.4} (+{n} unpriced)", g.total_cost_usd),
    };
    let failures = failure_summary(&g.outcomes);
    let tail = if failures.is_empty() {
        String::new()
    } else {
        format!(" — {failures}")
    };
    format!(
        "{}/{} passed ({:.0}%) · avg turns {:.1} · avg tokens {} · cost {}{}",
        g.passed,
        g.total,
        g.pass_rate() * 100.0,
        g.avg_turns(),
        tokens,
        cost,
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
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            price_model: None,
            cost: RunCost::NoSpend,
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
    fn test_aggregate_sums_cost_over_priced_rollouts_only() {
        let mut a = result("basic", "t1", "l1", Outcome::Passed);
        a.cost = RunCost::Priced(0.01);
        let mut b = result("basic", "t2", "l1", Outcome::Failed);
        b.cost = RunCost::Priced(0.03);
        let c = result("basic", "t3", "l1", Outcome::AgentError); // no-spend rollout
        let agg = aggregate(&[a, b, c]);
        assert_eq!(agg.overall.cost_n, 2);
        assert_eq!(agg.overall.cost_unpriced_n, 0);
        // Total over the priced rollouts (no averaging); the no-spend one contributes nothing.
        assert_eq!(agg.overall.cost_usd(), Some(0.04));
        assert_eq!(agg.overall.cost_usd_json(), Some(0.04));
    }

    #[test]
    fn test_unpriced_spend_makes_total_incomplete_and_loud() {
        let mut a = result("basic", "t1", "l1", Outcome::Passed);
        a.cost = RunCost::Priced(0.01);
        let mut b = result("basic", "t2", "l1", Outcome::Passed);
        b.cost = RunCost::Unpriced; // billable spend we could not price
        let agg = aggregate(&[a, b]);
        assert_eq!(agg.overall.cost_n, 1);
        assert_eq!(agg.overall.cost_unpriced_n, 1);
        // The priced subtotal is still available, but JSON nulls it because the total is incomplete.
        assert_eq!(agg.overall.cost_usd(), Some(0.01));
        assert_eq!(agg.overall.cost_usd_json(), None);
    }

    #[test]
    fn test_no_spend_rollouts_are_excluded_not_unpriced() {
        // A rollout with no LLM call is a real $0, not an unpriceable gap: it must not inflate the
        // unpriced count nor the priced denominator.
        let agg = aggregate(&[result("basic", "t1", "l1", Outcome::AgentError)]);
        assert_eq!(agg.overall.cost_n, 0);
        assert_eq!(agg.overall.cost_unpriced_n, 0);
        assert_eq!(agg.overall.cost_usd(), None);
    }

    #[test]
    fn test_render_markdown_is_aggregate_only() {
        let mut a = result("basic", "t1", "l1", Outcome::Passed);
        a.total_tokens = Some(1500);
        a.cost = RunCost::Priced(0.0123);
        let md = render_markdown(&[a, result("basic", "t2", "l1", Outcome::Failed)]);
        assert!(!md.contains("Pass matrix"), "default report drops the raw table");
        assert!(md.contains("**overall**: 1/2 passed (50%)"));
        assert!(md.contains("avg turns"));
        assert!(md.contains("avg tokens"));
        assert!(md.contains("· cost $0.0123"));
        assert!(!md.contains("avg cost"));
        assert!(md.contains("failed=1"), "failure reasons are reported");
        assert!(md.contains("## By task"));
    }

    #[test]
    fn test_render_markdown_marks_unpriced_spend() {
        let mut a = result("basic", "t1", "l1", Outcome::Passed);
        a.cost = RunCost::Priced(0.05);
        let mut b = result("basic", "t2", "l1", Outcome::Passed);
        b.cost = RunCost::Unpriced;
        let md = render_markdown(&[a, b]);
        assert!(md.contains("(+1 unpriced)"), "incomplete total is loud: {md}");
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
