//! Opt-in native Guardrails suite. Disabled unless `archestra-bench guardrails-native --execute`.
//!
//! Execution is the restored Node pilots under `platform/benchmarks`:
//! `claude-native-project-pilot.mjs` and `codex-native-project-pilot.mjs`, plus the fixture, policy,
//! measurement, and native-client modules they import. This module does not invent CLI flags or a
//! transcript format. The default command returns before any process. `--execute` launches those
//! pilots; tests replace the process boundary.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::results::{Aggregate, RunCost, RunResult, aggregate, render_markdown};

pub const SUITE: &str = "guardrails-native";
pub const PROFILE: &str = "distributed";
const ARMS: [&str; 4] = ["off", "on", "on", "off"];

const PILOTS: [(&str, &str, &str, &str); 4] = [
    ("claude", "main", "claude-native-project-pilot.mjs", "--main-task"),
    ("claude", "child", "claude-native-project-pilot.mjs", "--full-task"),
    ("codex", "main", "codex-native-project-pilot.mjs", "main"),
    ("codex", "child", "codex-native-project-pilot.mjs", "delegation"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardrailsPlan {
    pub suite: &'static str,
    pub profile: &'static str,
    pub order: Vec<&'static str>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PilotCommand {
    pub provider: &'static str,
    pub role: &'static str,
    pub arm: &'static str,
    pub script: &'static str,
    pub mode: &'static str,
    pub namespace: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardrailsError {
    NotEnabled,
    RejectedFlag(&'static str),
    Setup(String),
    Execution(String),
}

impl std::fmt::Display for GuardrailsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEnabled => write!(
                f,
                "guardrails-native is disabled; pass --execute to run the restored native pilots"
            ),
            Self::RejectedFlag(name) => {
                write!(
                    f,
                    "guardrails-native rejects {name}; the only profile is fixed distributed"
                )
            }
            Self::Setup(detail) => write!(f, "guardrails-native setup refused: {detail}"),
            Self::Execution(detail) => write!(f, "guardrails-native execution failed: {detail}"),
        }
    }
}

pub fn plan() -> GuardrailsPlan {
    GuardrailsPlan {
        suite: SUITE,
        profile: PROFILE,
        order: ARMS.to_vec(),
        enabled: false,
    }
}

pub fn prepare(execute: bool) -> Result<GuardrailsPlan, GuardrailsError> {
    if !execute {
        return Err(GuardrailsError::NotEnabled);
    }
    Ok(GuardrailsPlan {
        enabled: true,
        ..plan()
    })
}

pub fn reject_profile_override(name: &str) -> GuardrailsError {
    match name {
        "--profile" => GuardrailsError::RejectedFlag("--profile"),
        "--intervention" => GuardrailsError::RejectedFlag("--intervention"),
        "ARCHESTRA_BENCH_GUARDRAILS_PROFILE" => GuardrailsError::RejectedFlag("ARCHESTRA_BENCH_GUARDRAILS_PROFILE"),
        "ARCHESTRA_BENCH_GUARDRAILS_INTERVENTION" => {
            GuardrailsError::RejectedFlag("ARCHESTRA_BENCH_GUARDRAILS_INTERVENTION")
        }
        _ => GuardrailsError::RejectedFlag("profile override"),
    }
}

pub fn pilot_commands(run_id: &str) -> Result<Vec<PilotCommand>, GuardrailsError> {
    if !run_id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit()) || run_id.len() < 8 || run_id.len() > 12
    {
        return Err(GuardrailsError::Setup(
            "run id must be 8-12 lowercase letters or digits".into(),
        ));
    }
    let mut commands = Vec::new();
    for (index, arm) in ARMS.iter().enumerate() {
        for (provider, role, script, mode) in PILOTS {
            let namespace = format!(
                "{run_id}{}{}{}{index}",
                provider_tag(provider),
                role_tag(role),
                arm_tag(arm)
            );
            if !(8..=30).contains(&namespace.len()) {
                return Err(GuardrailsError::Setup(format!(
                    "namespace {namespace} outside pilot length"
                )));
            }
            commands.push(PilotCommand {
                provider,
                role,
                arm,
                script,
                mode,
                namespace,
            });
        }
    }
    Ok(commands)
}

fn provider_tag(provider: &str) -> &'static str {
    match provider {
        "claude" => "c",
        "codex" => "x",
        _ => "z",
    }
}

fn role_tag(role: &str) -> &'static str {
    match role {
        "main" => "m",
        "child" => "d",
        _ => "z",
    }
}

fn arm_tag(arm: &str) -> &'static str {
    match arm {
        "off" => "f",
        "on" => "n",
        _ => "z",
    }
}

pub fn fresh_run_id() -> String {
    uuid::Uuid::new_v4().simple().to_string().chars().take(10).collect()
}

pub fn benchmarks_dir(repo_root: &Path) -> PathBuf {
    repo_root.join("platform/benchmarks")
}

/// Node invocation of a restored pilot. Arguments match the historical scripts:
/// `node <pilot>.mjs <namespace> <off|on> <mode> sequential distributed`.
pub fn node_args(benchmarks: &Path, command: &PilotCommand) -> Vec<String> {
    vec![
        benchmarks.join(command.script).to_string_lossy().into_owned(),
        command.namespace.clone(),
        command.arm.to_string(),
        command.mode.to_string(),
        "sequential".to_string(),
        PROFILE.to_string(),
    ]
}

pub fn node_binary() -> PathBuf {
    PathBuf::from("node")
}

const PILOT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STREAM_CAP: usize = 256 * 1024;

pub async fn run_pilot(benchmarks: &Path, command: &PilotCommand, node: &Path) -> Result<(), GuardrailsError> {
    let mut child = Command::new(node)
        .args(node_args(benchmarks, command))
        .current_dir(benchmarks)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            GuardrailsError::Execution(format!(
                "spawn {} {} {}: {error}",
                command.script, command.role, command.arm
            ))
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GuardrailsError::Execution("stdout missing".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| GuardrailsError::Execution("stderr missing".into()))?;
    let logs = tokio::spawn(async move { tokio::try_join!(drain_capped(stdout), drain_capped(stderr)) });
    let status = tokio::time::timeout(PILOT_TIMEOUT, child.wait())
        .await
        .map_err(|_| {
            GuardrailsError::Execution(format!("{} {} {} timed out", command.script, command.role, command.arm))
        })?
        .map_err(|error| GuardrailsError::Execution(error.to_string()))?;
    logs.await
        .map_err(|error| GuardrailsError::Execution(error.to_string()))?
        .map_err(GuardrailsError::Execution)?;
    if !status.success() {
        return Err(GuardrailsError::Execution(format!(
            "{} {} {} exited {}",
            command.script,
            command.role,
            command.arm,
            status.code().unwrap_or(-1)
        )));
    }
    Ok(())
}

async fn drain_capped(mut reader: impl AsyncRead + Unpin) -> Result<(), String> {
    let mut buf = [0_u8; 8192];
    let mut total = 0_usize;
    loop {
        let read = reader.read(&mut buf).await.map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        total = total.saturating_add(read);
        if total > STREAM_CAP {
            return Err("pilot log exceeded capture cap".into());
        }
    }
}

const REQUIRED_SOURCES: [&str; 8] = [
    "claude-native-project-pilot.mjs",
    "codex-native-project-pilot.mjs",
    "native-client.mjs",
    "project-workload-fixture.mjs",
    "project-intervention-profile.mjs",
    "stateful-gateway-setup.mjs",
    "project-attention-policy.mjs",
    "native-long-qualification.mjs",
];

pub fn require_sources(benchmarks: &Path) -> Result<(), GuardrailsError> {
    for script in REQUIRED_SOURCES {
        if !benchmarks.join(script).is_file() {
            return Err(GuardrailsError::Setup(format!("missing restored source {script}")));
        }
    }
    Ok(())
}

pub fn load_pilot_evidence(out_dir: &Path) -> Result<Value, GuardrailsError> {
    let summary = read_json(&out_dir.join("pilot-summary.json"))?;
    let restoration = read_json(&out_dir.join("restoration.json"))?;
    let qualified = summary.pointer("/qualification/qualified").and_then(Value::as_bool) == Some(true);
    let completed = summary.get("pilotCompleted").and_then(Value::as_bool) == Some(true);
    let interventions = summary.pointer("/interventions/qualified").and_then(Value::as_bool) == Some(true);
    let restored = restoration.get("policyContentRestored").and_then(Value::as_bool) == Some(true)
        && restoration.get("deploymentOff").and_then(Value::as_bool) == Some(true);
    let usage = usage_from_summary(&summary)?;
    let metadata = metadata_from_summary(&summary)?;
    if !(qualified && completed && interventions && restored) {
        return Err(GuardrailsError::Execution(format!(
            "pilot evidence unqualified completed={completed} qualified={qualified} interventions={interventions} restored={restored}"
        )));
    }
    Ok(json!({
        "qualified": qualified,
        "completed": completed,
        "interventionsQualified": interventions,
        "policyContentRestored": true,
        "deploymentRestoredOff": true,
        "usage": usage,
        "metadata": metadata,
    }))
}

fn metadata_from_summary(summary: &Value) -> Result<Value, GuardrailsError> {
    let provider = match summary.get("kind").and_then(Value::as_str) {
        Some("actual_native_claude_project_pilot") => "claude",
        Some("actual_native_codex_project_pilot") => "codex",
        _ => return Err(GuardrailsError::Execution("pilot kind missing".into())),
    };
    let model = observed_model(summary)?;
    let tool_calls = if provider == "claude" {
        count_present(
            summary,
            &[
                "parentAgentCalls",
                "childMcpCalls",
                "parentProjectChecks",
                "childProjectChecks",
            ],
        )?
    } else {
        let parent = object_count(summary, "/parent/fixtures")? + object_count(summary, "/parent/helpers")?;
        let child = object_count(summary, "/child/fixtures")? + object_count(summary, "/child/helpers")?;
        parent
            .checked_add(child)
            .ok_or_else(|| GuardrailsError::Execution("tool count overflow".into()))?
    };
    Ok(json!({
        "provider": provider,
        "model": model,
        "turnCount": required_counter(&json!({"samples": summary.pointer("/providerEvidence/attempts").and_then(Value::as_array).map(Vec::len).unwrap_or(0)}), "samples").ok(),
        "toolCallCount": tool_calls,
    }))
}

fn observed_model(summary: &Value) -> Result<String, GuardrailsError> {
    let mut models = Vec::new();
    if let Some(attempts) = summary.pointer("/providerEvidence/attempts").and_then(Value::as_array) {
        for attempt in attempts {
            if let Some(model) = attempt.get("model").and_then(Value::as_str) {
                models.push(model.to_string());
            }
        }
    }
    if let Some(model) = summary.get("requestedModel").and_then(Value::as_str) {
        models.push(model.to_string());
    }
    if let Some(list) = summary.get("observedModels").and_then(Value::as_array) {
        for model in list.iter().filter_map(Value::as_str) {
            models.push(model.to_string());
        }
    }
    models.retain(|model| !model.is_empty());
    models.dedup();
    match models.as_slice() {
        [] => Err(GuardrailsError::Execution("pilot summary has no observed model".into())),
        [model] => Ok(model.clone()),
        many => Err(GuardrailsError::Execution(format!(
            "pilot summary mixed models: {}",
            many.join(",")
        ))),
    }
}

fn count_present(summary: &Value, names: &[&str]) -> Result<u64, GuardrailsError> {
    names.iter().try_fold(0_u64, |total, name| {
        let count = summary
            .get(*name)
            .and_then(Value::as_u64)
            .ok_or_else(|| GuardrailsError::Execution(format!("tool counter {name} missing")))?;
        total
            .checked_add(count)
            .ok_or_else(|| GuardrailsError::Execution("tool count overflow".into()))
    })
}

fn object_count(summary: &Value, pointer: &str) -> Result<u64, GuardrailsError> {
    summary
        .pointer(pointer)
        .and_then(Value::as_u64)
        .ok_or_else(|| GuardrailsError::Execution(format!("tool counter {pointer} missing")))
}

fn usage_from_summary(summary: &Value) -> Result<Value, GuardrailsError> {
    let owned;
    let samples: &[Value] = if summary.pointer("/providerEvidence/complete").and_then(Value::as_bool) == Some(true) {
        summary
            .pointer("/providerEvidence/attempts")
            .and_then(Value::as_array)
            .filter(|attempts| !attempts.is_empty())
            .ok_or_else(|| GuardrailsError::Execution("complete providerEvidence has no attempts".into()))?
    } else if summary.get("kind").and_then(Value::as_str) == Some("actual_native_codex_project_pilot") {
        owned = ["parent", "child"]
            .into_iter()
            .filter_map(|role| summary.pointer(&format!("/{role}/usage")).and_then(Value::as_array))
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        if owned.is_empty() {
            return Err(GuardrailsError::Execution(
                "codex summary has no parent or child usage".into(),
            ));
        }
        &owned
    } else {
        return Err(GuardrailsError::Execution(
            "providerEvidence incomplete and no codex usage rows".into(),
        ));
    };
    let mut input = 0_u64;
    let mut cache_read = 0_u64;
    let mut cache_write = 0_u64;
    let mut output = 0_u64;
    for sample in samples {
        let counters = sample.get("counters").unwrap_or(sample);
        let sample_input = if counters.get("totalInput").is_some() {
            required_counter(counters, "totalInput")?
        } else {
            required_counter(counters, "input")?
        };
        let sample_output = required_counter(counters, "output")?;
        let sample_read = optional_cache(counters, "cacheRead")?;
        let sample_write = optional_cache(counters, "cacheWrite")?;
        if sample_read.saturating_add(sample_write) > sample_input {
            return Err(GuardrailsError::Execution("cache tokens exceed input".into()));
        }
        input += sample_input;
        output += sample_output;
        cache_read += sample_read;
        cache_write += sample_write;
    }
    Ok(json!({
        "input": input,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "uncachedInput": input - cache_read - cache_write,
        "output": output,
        "samples": samples.len(),
    }))
}

fn optional_cache(counters: &Value, name: &str) -> Result<u64, GuardrailsError> {
    match counters.get(name) {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| GuardrailsError::Execution(format!("usage counter {name} is not a count"))),
    }
}

fn required_counter(counters: &Value, name: &str) -> Result<u64, GuardrailsError> {
    counters
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| GuardrailsError::Execution(format!("usage counter {name} missing; not counted as zero")))
}

fn read_json(path: &Path) -> Result<Value, GuardrailsError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| GuardrailsError::Execution(format!("read {}: {error}", path.display())))?;
    serde_json::from_str(&text)
        .map_err(|error| GuardrailsError::Execution(format!("parse {}: {error}", path.display())))
}

pub fn pilot_out_dir(benchmarks: &Path, namespace: &str) -> PathBuf {
    benchmarks.join("results").join(namespace)
}

pub async fn execute(
    planned: &GuardrailsPlan,
    benchmarks: &Path,
    run_id: &str,
    node: &Path,
) -> Result<Value, GuardrailsError> {
    if !planned.enabled {
        return Err(GuardrailsError::NotEnabled);
    }
    require_sources(benchmarks)?;
    let commands = pilot_commands(run_id)?;
    let mut rows = Vec::new();
    let mut episodes = Vec::new();
    for command in &commands {
        run_pilot(benchmarks, command, node).await?;
        let evidence = load_pilot_evidence(&pilot_out_dir(benchmarks, &command.namespace))?;
        rows.push(evidence_result(command, &evidence)?);
        episodes.push(json!({
            "namespace": command.namespace,
            "provider": command.provider,
            "role": command.role,
            "arm": command.arm,
            "result": run_json(&rows[rows.len() - 1]),
            "evidence": evidence,
        }));
    }
    let aggregate = aggregate(&rows);
    let markdown = render_markdown(&rows);
    let section = guardrails_section(&rows);
    Ok(json!({
        "suite": SUITE,
        "profile": PROFILE,
        "order": ARMS,
        "runId": run_id,
        "status": "qualified",
        "sharedPolicyWrites": true,
        "policyRestored": true,
        "deploymentRestoredOff": true,
        "definitionHash": fixed_distributed_definition_hash(),
        "aggregate": with_optional_section(&aggregate, Some(&json!({"episodes": episodes}))),
        "reportMarkdown": append_section(&markdown, Some(&section)),
        "episodes": episodes,
    }))
}

fn evidence_result(command: &PilotCommand, evidence: &Value) -> Result<RunResult, GuardrailsError> {
    let usage = &evidence["usage"];
    let metadata = &evidence["metadata"];
    let input = required_counter(usage, "input")?;
    let output = required_counter(usage, "output")?;
    let samples = required_counter(usage, "samples")?;
    let tool_calls = required_counter(metadata, "toolCallCount")?;
    Ok(RunResult {
        env_id: SUITE.to_string(),
        task_id: format!("{}-{}", command.provider, command.role),
        lane: command.arm.to_string(),
        provider: metadata["provider"].as_str().unwrap_or(command.provider).to_string(),
        model: metadata
            .get("model")
            .and_then(Value::as_str)
            .ok_or_else(|| GuardrailsError::Execution("evidence model missing".into()))?
            .to_string(),
        outcome: archestra_bench_core::Outcome::Passed,
        finish_reason: Some("qualified".to_string()),
        tool_call_count: checked_usize(tool_calls, "tool calls")?,
        turn_count: checked_usize(samples, "turns")?,
        total_tokens: Some(checked_i64(
            input
                .checked_add(output)
                .ok_or_else(|| GuardrailsError::Execution("token total overflow".into()))?,
        )?),
        prompt_tokens: Some(checked_i64(input)?),
        completion_tokens: Some(checked_i64(output)?),
        cache_read_tokens: Some(checked_i64(required_counter(usage, "cacheRead")?)?),
        cache_write_tokens: Some(checked_i64(required_counter(usage, "cacheWrite")?)?),
        price_model: None,
        cost: RunCost::Unpriced,
        agent_error: None,
        stage_count: 1,
        format_attempts: 0,
        artifact_dir: Some(command.namespace.clone()),
    })
}

fn checked_i64(value: u64) -> Result<i64, GuardrailsError> {
    i64::try_from(value).map_err(|_| GuardrailsError::Execution("token count exceeds i64".into()))
}

fn checked_usize(value: u64, label: &str) -> Result<usize, GuardrailsError> {
    usize::try_from(value).map_err(|_| GuardrailsError::Execution(format!("{label} count exceeds usize")))
}

pub fn run_json(result: &RunResult) -> Value {
    json!({
        "env_id": result.env_id,
        "task_id": result.task_id,
        "lane": result.lane,
        "provider": result.provider,
        "model": result.model,
        "outcome": result.outcome.value(),
        "finish_reason": result.finish_reason,
        "tool_call_count": result.tool_call_count,
        "turn_count": result.turn_count,
        "total_tokens": result.total_tokens,
        "prompt_tokens": result.prompt_tokens,
        "completion_tokens": result.completion_tokens,
        "cache_read_tokens": result.cache_read_tokens,
        "cache_write_tokens": result.cache_write_tokens,
        "cost_usd": null,
        "agent_error": result.agent_error,
        "stage_count": result.stage_count,
        "format_attempts": result.format_attempts,
    })
}

pub fn write_run_artifacts(run_dir: &Path, report: &Value) -> Result<(), GuardrailsError> {
    std::fs::create_dir_all(run_dir).map_err(|error| GuardrailsError::Execution(error.to_string()))?;
    let aggregate = report.get("aggregate").cloned().unwrap_or_else(|| json!({}));
    let markdown = report.get("reportMarkdown").and_then(Value::as_str).unwrap_or("");
    std::fs::write(
        run_dir.join("aggregate.json"),
        serde_json::to_vec_pretty(&aggregate).expect("aggregate serializes"),
    )
    .map_err(|error| GuardrailsError::Execution(error.to_string()))?;
    std::fs::write(run_dir.join("report.md"), markdown)
        .map_err(|error| GuardrailsError::Execution(error.to_string()))?;
    for episode in report.get("episodes").and_then(Value::as_array).into_iter().flatten() {
        let namespace = episode.get("namespace").and_then(Value::as_str).unwrap_or("episode");
        let dir = run_dir.join(SUITE).join(namespace);
        std::fs::create_dir_all(&dir).map_err(|error| GuardrailsError::Execution(error.to_string()))?;
        let rollout = episode
            .get("result")
            .cloned()
            .ok_or_else(|| GuardrailsError::Execution("episode result missing".into()))?;
        std::fs::write(
            dir.join("run.json"),
            serde_json::to_vec_pretty(&rollout).expect("rollout serializes"),
        )
        .map_err(|error| GuardrailsError::Execution(error.to_string()))?;
    }
    Ok(())
}

pub fn fixed_distributed_definition_hash() -> String {
    let definition = json!({
        "name": PROFILE,
        "checkpoints": [
            {"stage": 2, "operation": "project_edit"},
            {"stage": 5, "operation": "project_edit"},
            {"stage": 9, "operation": "project_edit"},
            {"stage": 13, "operation": "project_edit"},
            {"stage": 15, "operation": "project_publish"}
        ],
        "sharedPolicyWrites": true
    });
    Sha256::digest(serde_json::to_vec(&definition).expect("definition serializes"))
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

pub fn append_section(markdown: &str, section: Option<&str>) -> String {
    match section {
        Some(section) if !section.is_empty() => {
            let mut out = markdown.to_string();
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(section);
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out
        }
        _ => markdown.to_string(),
    }
}

pub fn guardrails_section(rows: &[RunResult]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        String::new(),
        "## Guardrails native (opt-in)".to_string(),
        format!("Fixed profile `{PROFILE}`, ABBA order off/on/on/off. Not part of the default sweep."),
    ];
    for row in rows {
        lines.push(format!("- `{}` / `{}`: {}", row.task_id, row.lane, row.outcome.value()));
    }
    lines.join("\n") + "\n"
}

pub fn with_optional_section(aggregate: &Aggregate, section: Option<&Value>) -> Value {
    let mut value = aggregate.to_json();
    if let Some(section) = section
        && !section.is_null()
        && section != &json!({})
    {
        value["guardrails_native"] = section.clone();
    }
    value
}

pub fn legacy_paths_unchanged(root: &Path) -> bool {
    let entry = root.join(".github/bench/runner-entrypoint.sh");
    root.join(".github/workflows/benchmark.yml").is_file()
        && root.join("ai-labs/lanes.toml").is_file()
        && entry.is_file()
        && !std::fs::read_to_string(&entry)
            .map(|text| text.contains("guardrails-native"))
            .unwrap_or(true)
}

pub fn sample_result(task_id: &str, lane: &str, passed: bool) -> RunResult {
    RunResult {
        env_id: SUITE.to_string(),
        task_id: task_id.to_string(),
        lane: lane.to_string(),
        provider: "native".to_string(),
        model: "pilot".to_string(),
        outcome: if passed {
            archestra_bench_core::Outcome::Passed
        } else {
            archestra_bench_core::Outcome::Failed
        },
        finish_reason: None,
        tool_call_count: 0,
        turn_count: 0,
        total_tokens: None,
        prompt_tokens: None,
        completion_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        price_model: None,
        cost: RunCost::NoSpend,
        agent_error: None,
        stage_count: 0,
        format_attempts: 0,
        artifact_dir: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::results::aggregate;

    #[test]
    fn default_plan_is_disabled() {
        assert!(!plan().enabled);
        assert!(prepare(false).is_err());
        let commands = pilot_commands("abcd1234ef").unwrap();
        assert_eq!(commands.len(), 16);
        assert_eq!(
            commands
                .iter()
                .map(|command| &command.namespace)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            16
        );
        assert!(pilot_commands("short").is_err());
    }

    #[test]
    fn commands_use_historical_pilot_arguments() {
        let benchmarks = Path::new("/repo/platform/benchmarks");
        let child = pilot_commands("abcd1234ef")
            .unwrap()
            .into_iter()
            .find(|command| command.provider == "claude" && command.role == "child" && command.arm == "on")
            .unwrap();
        let args = node_args(benchmarks, &child);
        assert!(args[0].ends_with("claude-native-project-pilot.mjs"));
        assert_eq!(&args[2..], ["on", "--full-task", "sequential", "distributed"]);
        let codex = PilotCommand {
            provider: "codex",
            role: "child",
            arm: "off",
            script: "codex-native-project-pilot.mjs",
            mode: "delegation",
            namespace: "gn-codex".into(),
        };
        let args = node_args(benchmarks, &codex);
        assert_eq!(&args[2..], ["off", "delegation", "sequential", "distributed"]);
    }

    #[test]
    fn restored_sources_reject_removed_profiles_and_hash() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../platform/benchmarks");
        let profile = std::fs::read_to_string(root.join("project-intervention-profile.mjs")).unwrap();
        assert!(profile.contains("distributed"));
        assert!(!profile.contains("aggressive"));
        assert!(!profile.contains("saturation"));
        let qualification = std::fs::read_to_string(root.join("native-long-qualification.mjs")).unwrap();
        assert!(!qualification.contains("LONG_BASELINE_POLICY_HASH"));
        let delegation = std::fs::read_to_string(root.join("stateful-codex-native-delegation.mjs")).unwrap();
        assert!(!delegation.contains("engineering-native-session"));
        assert!(!delegation.contains("engineering-workload"));
        assert!(root.join("native-client.mjs").is_file());
        assert!(root.join("project-workload-fixture.mjs").is_file());
    }

    fn qualified_summary() -> String {
        json!({
            "pilotCompleted": true,
            "qualification": {"qualified": true},
            "interventions": {"qualified": true},
            "modelObservations": [{
                "counters": {"input": 100, "cacheRead": 40, "cacheWrite": 10, "output": 5}
            }]
        })
        .to_string()
    }

    fn restoration() -> String {
        json!({"policyContentRestored": true, "deploymentOff": true}).to_string()
    }

    #[tokio::test]
    async fn injected_node_writes_files_and_drains_stderr() {
        let dir = std::env::temp_dir().join(format!("guardrails-native-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in REQUIRED_SOURCES {
            std::fs::write(dir.join(name), "// restored source stand-in\n").unwrap();
        }
        let node = dir.join("node");
        std::fs::write(
            &node,
            r#"#!/bin/sh
ns=$(printf '%s' "$*" | awk '{print $2}')
mkdir -p "results/$ns"
case "$*" in
  *claude*)
    printf '%s\n' '{"kind":"actual_native_claude_project_pilot","pilotCompleted":true,"qualification":{"qualified":true},"interventions":{"qualified":true},"parentAgentCalls":1,"childMcpCalls":2,"parentProjectChecks":1,"childProjectChecks":2,"providerEvidence":{"complete":true,"attempts":[{"model":"claude-sonnet","counters":{"input":100,"output":5,"cacheRead":null,"cacheWrite":null}}]}}' > "results/$ns/pilot-summary.json"
    ;;
  *)
    printf '%s\n' '{"kind":"actual_native_codex_project_pilot","pilotCompleted":true,"qualification":{"qualified":true},"interventions":{"qualified":true},"requestedModel":"gpt-6.1-sol","providerEvidence":{"complete":false},"parent":{"fixtures":2,"helpers":1,"usage":[{"totalInput":80,"uncachedInput":60,"cacheRead":20,"cacheWrite":0,"output":4}]},"child":{"fixtures":1,"helpers":0,"usage":[{"totalInput":20,"uncachedInput":20,"cacheRead":0,"cacheWrite":0,"output":1}]}}' > "results/$ns/pilot-summary.json"
    ;;
esac
printf '%s\n' '{"policyContentRestored":true,"deploymentOff":true}' > "results/$ns/restoration.json"
dd if=/dev/zero bs=1024 count=32 2>/dev/null >&2
printf '%s\n' "log line not the summary"
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let planned = prepare(true).unwrap();
        let report = execute(&planned, &dir, "abcd1234ef", &node).await.unwrap();
        let run_dir = dir.join("published");
        write_run_artifacts(&run_dir, &report).unwrap();
        assert_eq!(report["status"], "qualified");
        assert_eq!(report["sharedPolicyWrites"], true);
        assert_eq!(report["episodes"].as_array().unwrap().len(), 16);
        assert!(run_dir.join("aggregate.json").is_file());
        assert!(run_dir.join("report.md").is_file());
        assert!(std::fs::read_dir(run_dir.join(SUITE)).unwrap().count() == 16);
        let claude = report["episodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|episode| episode["provider"] == "claude")
            .unwrap();
        assert_eq!(claude["evidence"]["usage"]["input"], 100);
        assert_eq!(claude["evidence"]["usage"]["cacheRead"], 0);
        assert_eq!(claude["result"]["model"], "claude-sonnet");
        assert_eq!(claude["result"]["turn_count"], 1);
        assert_eq!(claude["result"]["tool_call_count"], 6);
        let codex = report["episodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|episode| episode["provider"] == "codex" && episode["role"] == "child")
            .unwrap();
        assert_eq!(codex["evidence"]["usage"]["input"], 100);
        assert_eq!(codex["evidence"]["usage"]["cacheRead"], 20);
        let rollout: Value = serde_json::from_str(
            &std::fs::read_to_string(
                run_dir
                    .join(SUITE)
                    .join(claude["namespace"].as_str().unwrap())
                    .join("run.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let meta: archestra_bench_core::RunMeta = serde_json::from_value(rollout).unwrap();
        assert_eq!(meta.provider, "claude");
        assert_eq!(meta.model, "claude-sonnet");
        assert_eq!(meta.turn_count, 1);
        assert_eq!(meta.tool_call_count, 6);
        assert_eq!(codex["result"]["turn_count"], 2);
        assert_eq!(codex["result"]["tool_call_count"], 4);
        assert_eq!(codex["result"]["model"], "gpt-6.1-sol");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_usage_is_not_zero() {
        let dir = std::env::temp_dir().join(format!("guardrails-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("pilot-summary.json"),
            qualified_summary().replace("100", "null"),
        )
        .unwrap();
        std::fs::write(dir.join("restoration.json"), restoration()).unwrap();
        assert!(load_pilot_evidence(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stderr_flood_times_out_or_caps_without_hanging() {
        let dir = std::env::temp_dir().join(format!("guardrails-flood-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in REQUIRED_SOURCES {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let node = dir.join("node");
        std::fs::write(&node, "#!/bin/sh\nwhile true; do echo flood >&2; done\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let command = &pilot_commands("abcd1234ef").unwrap()[0];
        let error = run_pilot(&dir, command, &node).await.unwrap_err();
        assert!(error.to_string().contains("capture cap") || error.to_string().contains("timed out"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_section_and_legacy_entrypoint_stay_unchanged() {
        let rows = [sample_result("t1", "lane", true)];
        let agg = aggregate(&rows);
        let base = agg.to_json();
        assert_eq!(base, with_optional_section(&agg, None));
        let report = crate::results::render_markdown(&rows);
        assert_eq!(append_section(&report, None), report);
        assert!(append_section(&report, Some(&guardrails_section(&rows))).contains("Guardrails native"));
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert!(legacy_paths_unchanged(&root));
    }
}
