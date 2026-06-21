//! Loading a benchmark `trajectory.jsonl` and rendering it to markdown. The `Event` shape lives in
//! `archestra-bench-core` (shared with the harness writer).
//!
//! Each line is one `kind`-tagged event. Parsing is clean-or-fail: a non-JSON line or a
//! known-kind record missing a required field aborts the rollout with its `path:line`; only an
//! unrecognised `kind` degrades to [`Event::Unknown`] (forward-compat with new event kinds).

use std::fmt;
use std::path::{Path, PathBuf};

use archestra_bench_core::Event;
use serde_json::Value;

/// Per-field render cap (Unicode scalar values), so a single huge tool blob or reasoning dump
/// cannot dominate the map prompt.
const MAX_FIELD_CHARS: usize = 8192;

/// Char-safe truncation: keeps the prefix and appends a marker. Cuts on a char boundary, so it
/// never panics on multibyte input.
fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut = s.char_indices().nth(max).map(|(i, _)| i).unwrap_or(s.len());
    format!(
        "{}\n[truncated, {} chars total]",
        &s[..cut],
        s.chars().count()
    )
}

/// A parse failure pinned to its source line, so the operator can find the offending record.
#[derive(Debug)]
pub struct LoadError {
    pub path: PathBuf,
    pub line: usize,
    pub message: String,
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}: malformed trajectory record: {}",
            self.path.display(),
            self.line,
            self.message
        )
    }
}

impl std::error::Error for LoadError {}

pub fn load_trajectory(path: &Path) -> Result<Vec<Event>, LoadError> {
    let content = std::fs::read_to_string(path).map_err(|e| LoadError {
        path: path.to_path_buf(),
        line: 0,
        message: e.to_string(),
    })?;

    let mut events = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let event = serde_json::from_str::<Event>(line).map_err(|e| LoadError {
            path: path.to_path_buf(),
            line: idx + 1,
            message: e.to_string(),
        })?;
        events.push(event);
    }
    Ok(events)
}

/// Replace any string longer than `MAX_FIELD_CHARS` with a placeholder, recursing into
/// nested objects/arrays so a single huge tool output cannot dominate the prompt.
fn truncate_long_strings(value: &Value) -> Value {
    match value {
        Value::String(s) if s.chars().count() > MAX_FIELD_CHARS => {
            Value::String(format!("[truncated {} chars]", s.chars().count()))
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), truncate_long_strings(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(truncate_long_strings).collect()),
        other => other.clone(),
    }
}

/// The product's built-in dispatcher that forwards a call to a discovered MCP tool. It is optional
/// (a deployment can turn it off) but on by default, so most agents reach `submit_result` and other
/// discovered tools *through* it. Rendered verbatim it reads as a distinct tool the agent "should
/// have called directly", which the map phase then mis-flags as friction — so unwrap it.
const RUN_TOOL_DISPATCHER: &str = "archestra__run_tool";

/// If `tool_name` is the `run_tool` dispatcher carrying a string `tool_name` payload, present the
/// call as the tool it forwards to (`<target> (via run_tool)`) over the inner `tool_args`. Any other
/// shape — a direct tool, the dispatcher off, or a missing/renamed payload — falls through unchanged,
/// so this never hides or reshapes a call it does not recognize.
fn unwrap_dispatch<'a>(tool_name: &'a str, input: &'a Value) -> (String, &'a Value) {
    if tool_name == RUN_TOOL_DISPATCHER
        && let Some(target) = input.get("tool_name").and_then(Value::as_str)
    {
        let args = input.get("tool_args").unwrap_or(input);
        return (format!("{target} (via run_tool)"), args);
    }
    (tool_name.to_string(), input)
}

fn render_value(value: &Value) -> String {
    let truncated = truncate_long_strings(value);
    match &truncated {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

/// Render the trajectory as readable markdown for an LLM: reasoning, tool calls, tool results,
/// and terminal errors. Bookkeeping events (token usage, finish, conversation id) are elided.
pub fn format_to_markdown(events: &[Event]) -> String {
    let mut out = String::from("# Agent trajectory\n\n");
    for event in events {
        match event {
            Event::Prompts {
                system_prompt,
                user_message,
            } => {
                if !system_prompt.trim().is_empty() {
                    out.push_str("### System prompt\n");
                    out.push_str(&cap_chars(system_prompt, MAX_FIELD_CHARS));
                    out.push_str("\n\n");
                }
                out.push_str("### Task\n");
                out.push_str(&cap_chars(user_message, MAX_FIELD_CHARS));
                out.push_str("\n\n");
            }
            Event::AssistantText { text } => {
                out.push_str("### Agent\n");
                out.push_str(&cap_chars(text, MAX_FIELD_CHARS));
                out.push_str("\n\n");
            }
            Event::ToolCall { tool_name, input } => {
                let (display_name, args) = unwrap_dispatch(tool_name, input);
                out.push_str(&format!("### Tool call: `{display_name}`\n```json\n"));
                out.push_str(&render_value(args));
                out.push_str("\n```\n\n");
            }
            Event::ToolOutput { output } => {
                out.push_str("### Tool result\n```\n");
                out.push_str(&render_value(output));
                out.push_str("\n```\n\n");
            }
            Event::AgentError { error } | Event::Error { error } | Event::InfraError { error } => {
                out.push_str(&format!("### ⚠️ Error\n```\n{error}\n```\n\n"));
            }
            Event::ArtifactMissing { error } => {
                out.push_str(&format!("### ⚠️ Artifact missing\n{error}\n\n"));
            }
            Event::ParseError { reason } => {
                let detail = reason.as_deref().unwrap_or("(no detail)");
                out.push_str(&format!("### ⚠️ Stream parse error\n{detail}\n\n"));
            }
            Event::StageComplete { stage } => {
                out.push_str(&format!("---\n_stage {stage} complete_\n\n"));
            }
            Event::EffectivePrompt(data) => {
                out.push_str("### Effective system prompt\n");
                out.push_str(&cap_chars(&data.system_prompt, MAX_FIELD_CHARS));
                out.push_str(&format!(
                    "\n\n_tools ({}): {}_\n_sampling: temperature={:?} max_tokens={:?} top_p={:?}_\n_used by {} call(s)_\n\n",
                    data.tools.len(),
                    data.tools.join(", "),
                    data.sampling.temperature,
                    data.sampling.max_tokens,
                    data.sampling.top_p,
                    data.interaction_count,
                ));
            }
            Event::EffectivePromptError { error } => {
                out.push_str(&format!("### ⚠️ Effective-prompt capture error\n{error}\n\n"));
            }
            Event::ConversationCreated | Event::TokenUsage | Event::Finish | Event::Unknown => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_fixture(lines: &[&str]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trajectory.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        (dir, path)
    }

    #[test]
    fn parses_every_known_kind_and_renders_sections() {
        let (_dir, path) = write_fixture(&[
            r#"{"sequence":1,"timestamp":"t","kind":"conversation_created","conversation_id":"c1"}"#,
            r#"{"sequence":2,"timestamp":"t","kind":"assistant_text","id":"a","text":"thinking"}"#,
            r#"{"sequence":3,"timestamp":"t","kind":"tool_call","tool_call_id":"x","tool_name":"run","input":{"cmd":"ls"}}"#,
            r#"{"sequence":4,"timestamp":"t","kind":"tool_output","tool_call_id":"x","output":"ok"}"#,
            r#"{"sequence":5,"timestamp":"t","kind":"token_usage","total_tokens":42}"#,
            r#"{"sequence":6,"timestamp":"t","kind":"finish","finish_reason":"stop"}"#,
            r#"{"sequence":7,"timestamp":"t","kind":"stage_complete","stage":0,"finish_reason":"stop"}"#,
            r#"{"sequence":8,"timestamp":"t","kind":"agent_error","error":"boom"}"#,
            r#"{"sequence":9,"timestamp":"t","kind":"error","error":"stream"}"#,
            r#"{"sequence":10,"timestamp":"t","kind":"artifact_missing","error":"none found"}"#,
            r#"{"sequence":11,"timestamp":"t","kind":"infra_error","error":"boot failed"}"#,
            r#"{"sequence":12,"timestamp":"t","kind":"parse_error","raw":"...","reason":"bad chunk"}"#,
            r#"{"sequence":13,"timestamp":"t","kind":"chat_stream","event":{"type":"x"}}"#,
            r#"{"sequence":14,"timestamp":"t","kind":"prompts","system_prompt":"be helpful","user_message":"find the answer"}"#,
        ]);
        let events = load_trajectory(&path).unwrap();
        assert_eq!(events.len(), 14);

        let md = format_to_markdown(&events);
        assert!(md.contains("### Agent\nthinking"));
        assert!(md.contains("### System prompt\nbe helpful"));
        assert!(md.contains("### Task\nfind the answer"));
        assert!(md.contains("### Tool call: `run`"));
        assert!(md.contains("### Tool result"));
        assert!(md.contains("boom"));
        assert!(md.contains("none found"));
        assert!(
            md.contains("boot failed"),
            "infra_error must render its message"
        );
        assert!(
            md.contains("bad chunk"),
            "parse_error must render its reason"
        );
    }

    #[test]
    fn effective_prompt_and_its_error_render() {
        let (_dir, path) = write_fixture(&[
            r#"{"sequence":1,"timestamp":"t","kind":"effective_prompt","system_prompt":"you are helpful","tools":["archestra__search_tools","archestra__run_tool"],"sampling":{"temperature":0.0,"max_tokens":8192,"top_p":null},"interaction_count":5}"#,
            r#"{"sequence":2,"timestamp":"t","kind":"effective_prompt_error","error":"context varied across 2 interactions"}"#,
        ]);
        let md = format_to_markdown(&load_trajectory(&path).unwrap());
        assert!(md.contains("### Effective system prompt\nyou are helpful"));
        assert!(md.contains("archestra__search_tools, archestra__run_tool"));
        assert!(md.contains("used by 5 call(s)"));
        // The diagnostic must reach the rendered trajectory, not vanish.
        assert!(md.contains("context varied across 2 interactions"));
    }

    #[test]
    fn null_finish_reason_parses() {
        let (_dir, path) = write_fixture(&[
            r#"{"sequence":1,"timestamp":"t","kind":"finish","finish_reason":null}"#,
        ]);
        let events = load_trajectory(&path).unwrap();
        assert!(matches!(events.as_slice(), [Event::Finish]));
    }

    #[test]
    fn unknown_kind_degrades_to_unknown_not_error() {
        let (_dir, path) = write_fixture(&[
            r#"{"sequence":1,"timestamp":"t","kind":"some_future_kind","whatever":true}"#,
        ]);
        let events = load_trajectory(&path).unwrap();
        assert!(matches!(events.as_slice(), [Event::Unknown]));
    }

    #[test]
    fn non_json_line_fails_with_line_number() {
        let (_dir, path) = write_fixture(&[
            r#"{"sequence":1,"timestamp":"t","kind":"agent_error","error":"ok"}"#,
            "not json at all",
        ]);
        let err = load_trajectory(&path).unwrap_err();
        assert_eq!(err.line, 2);
    }

    #[test]
    fn known_kind_missing_required_field_fails_with_line_number() {
        // tool_call without `tool_name` must hard-fail, not silently drop.
        let (_dir, path) = write_fixture(&[
            r#"{"sequence":1,"timestamp":"t","kind":"assistant_text","text":"hi"}"#,
            r#"{"sequence":2,"timestamp":"t","kind":"tool_call","tool_call_id":"x","input":{}}"#,
        ]);
        let err = load_trajectory(&path).unwrap_err();
        assert_eq!(err.line, 2);
    }

    #[test]
    fn oversized_nested_strings_are_truncated() {
        let big = "z".repeat(MAX_FIELD_CHARS + 10);
        let line =
            format!(r#"{{"kind":"tool_output","tool_call_id":"x","output":{{"log":"{big}"}}}}"#);
        let (_dir, path) = write_fixture(&[&line]);
        let events = load_trajectory(&path).unwrap();
        let md = format_to_markdown(&events);
        assert!(md.contains("[truncated"));
        assert!(!md.contains(&big));
    }

    #[test]
    fn oversized_assistant_text_is_capped() {
        let big = "q".repeat(MAX_FIELD_CHARS + 50);
        let line = format!(r#"{{"kind":"assistant_text","id":"a","text":"{big}"}}"#);
        let (_dir, path) = write_fixture(&[&line]);
        let md = format_to_markdown(&load_trajectory(&path).unwrap());
        assert!(md.contains("[truncated"));
        assert!(!md.contains(&big));
    }

    #[test]
    fn run_tool_dispatch_is_unwrapped_to_its_target() {
        let (_dir, path) = write_fixture(&[
            r#"{"kind":"tool_call","tool_call_id":"x","tool_name":"archestra__run_tool","input":{"tool_name":"final_answer-abc__submit_result","tool_args":{"stars":3864}}}"#,
        ]);
        let md = format_to_markdown(&load_trajectory(&path).unwrap());
        // The forwarded tool is what the reader sees, over its inner args — not the dispatcher.
        assert!(md.contains("### Tool call: `final_answer-abc__submit_result (via run_tool)`"));
        assert!(md.contains("\"stars\": 3864"));
        assert!(!md.contains("\"tool_args\""));
    }

    #[test]
    fn non_dispatch_tool_call_renders_unchanged() {
        // A direct call and a malformed dispatch (no string `tool_name`) both pass through as-is.
        let (_dir, path) = write_fixture(&[
            r#"{"kind":"tool_call","tool_call_id":"x","tool_name":"archestra__run_command","input":{"command":"ls"}}"#,
            r#"{"kind":"tool_call","tool_call_id":"y","tool_name":"archestra__run_tool","input":{"oops":true}}"#,
        ]);
        let md = format_to_markdown(&load_trajectory(&path).unwrap());
        assert!(md.contains("### Tool call: `archestra__run_command`"));
        assert!(md.contains("### Tool call: `archestra__run_tool`"));
        assert!(md.contains("\"oops\": true"));
    }

    #[test]
    fn cap_chars_never_splits_multibyte() {
        // 10 multibyte chars, cap at 4 → must cut on a char boundary without panicking.
        let s = "héllo wörld".chars().take(10).collect::<String>();
        let capped = cap_chars(&s, 4);
        assert!(capped.starts_with("héll"));
        assert!(capped.contains("[truncated"));
    }
}
