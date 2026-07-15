//! Recover the *effective* prompt the model received from the platform's persisted provider
//! requests (the `interactions` rows the LLM proxy writes). Pure, provider-shape-aware, and loud:
//! anything it cannot extract becomes an explicit error string, never a silent null.
//!
//! The effective context (system prompt + tool names + sampling) is expected to be constant within a
//! bench conversation, so the normal result is exactly one [`EffectivePromptData`]; any variation, an
//! unhandled provider shape, or a missing system prompt is reported in `errors`.

use std::collections::BTreeSet;

use archestra_bench_core::{EffectivePromptData, SamplingParams};
use serde_json::Value;

/// Distinct effective contexts (normally one) plus any anomalies detected while extracting them.
pub struct ExtractionOutcome {
    pub prompts: Vec<EffectivePromptData>,
    pub errors: Vec<String>,
}

pub fn extract_effective_prompts(interactions: &[Value]) -> ExtractionOutcome {
    let mut prompts: Vec<EffectivePromptData> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for interaction in interactions {
        let type_tag = interaction
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Skip non-chat calls outright — they carry no model-facing system prompt.
        if type_tag.ends_with(":embeddings") {
            continue;
        }

        // Intra-turn platform machinery (`chat:compaction`, `chat:title_generation`,
        // `chat:tool_call_repair`) is logged under a `chat:`-prefixed source. Those calls don't
        // carry the agent's effective context — a tool-call repair re-ask has no system prompt at
        // all — so they are neither a context to capture nor an anomaly.
        if interaction
            .get("source")
            .and_then(Value::as_str)
            .is_some_and(|s| s.starts_with("chat:"))
        {
            continue;
        }

        let body = request_body(interaction);
        let extracted = match type_tag.as_str() {
            t if t.ends_with(":chatCompletions") => extract_openai_chat(body),
            "anthropic:messages" => extract_anthropic(body),
            t if t.ends_with(":responses") => extract_openai_responses(body),
            "gemini:generateContent" => extract_gemini(body),
            "" => {
                errors.push("interaction missing a `type` discriminator".to_string());
                continue;
            }
            other => {
                errors.push(format!("unhandled interaction type: {other}"));
                continue;
            }
        };

        match extracted {
            Some((system, tools, sampling)) => merge(&mut prompts, system, tools, sampling),
            None => errors.push(format!(
                "interaction type {type_tag}: could not extract a system prompt"
            )),
        }
    }

    if prompts.len() > 1 {
        errors.push(format!(
            "effective context varied across the conversation: {} distinct contexts (expected 1)",
            prompts.len()
        ));
    }

    // We were handed interactions yet produced neither a prompt nor an error (e.g. every row was an
    // embedding) — surface it rather than returning an empty, signal-free outcome.
    if prompts.is_empty() && errors.is_empty() && !interactions.is_empty() {
        errors.push("interactions present but no model-facing prompt could be extracted from any of them".to_string());
    }

    ExtractionOutcome { prompts, errors }
}

/// Billable token usage summed across a session's chat interaction rows. Each LLM-proxy row is one
/// agentic step, so summing the rows recovers the full spend of a multi-step turn — unlike the chat
/// SSE `data-token-usage` event, whose final value is only the *last* step. The four token categories
/// are the platform's disjoint counts (`inputTokens` is already net of cache reads and cache writes).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Non-embedding interaction rows seen — each is a billed LLM step. Zero means no recorded spend.
    pub chat_rows: usize,
    /// Chat rows missing the core `inputTokens`/`outputTokens` fields: a telemetry gap the caller
    /// treats as unpriceable rather than a measured zero.
    pub rows_with_null_tokens: usize,
    /// Distinct `model` values across the chat rows; more than one means the session mixed models
    /// (e.g. cost-optimization or dual-LLM), which a single lane slug cannot price.
    pub models: BTreeSet<String>,
}

impl RunUsage {
    pub fn add(&mut self, other: &RunUsage) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
        self.chat_rows += other.chat_rows;
        self.rows_with_null_tokens += other.rows_with_null_tokens;
        self.models.extend(other.models.iter().cloned());
    }

    /// True when at least one billed LLM step was recorded. Distinguishes a real $0 (no call) from
    /// measured usage.
    pub fn had_spend(&self) -> bool {
        self.chat_rows > 0
    }

    pub fn total_tokens(&self) -> i64 {
        self.prompt_tokens + self.completion_tokens + self.cache_read_tokens + self.cache_write_tokens
    }
}

/// Sum billable usage across a session's interaction rows. Embedding rows carry no chat generation and
/// are skipped (matching `extract_effective_prompts`); every other row is a billed step. Negative
/// counts clamp to zero. A chat row missing `inputTokens`/`outputTokens` is recorded as a telemetry
/// gap (`rows_with_null_tokens`) rather than summed as zero.
pub fn sum_usage(interactions: &[Value]) -> RunUsage {
    let mut usage = RunUsage::default();
    for interaction in interactions {
        let type_tag = interaction.get("type").and_then(Value::as_str).unwrap_or("");
        if type_tag.ends_with(":embeddings") {
            continue;
        }
        usage.chat_rows += 1;
        if let Some(model) = interaction.get("model").and_then(Value::as_str) {
            usage.models.insert(model.to_string());
        }
        let token = |key: &str| interaction.get(key).and_then(Value::as_i64);
        match (token("inputTokens"), token("outputTokens")) {
            (Some(input), Some(output)) => {
                usage.prompt_tokens += input.max(0);
                usage.completion_tokens += output.max(0);
                usage.cache_read_tokens += token("cacheReadTokens").unwrap_or(0).max(0);
                // `cacheWriteTokens` is the full cache-creation count; `cacheWrite1hTokens` is the
                // 1h-TTL *subset* of it (the platform's premium-pricing breakdown), so it must not be
                // added on top or the 1h portion is double-counted.
                usage.cache_write_tokens += token("cacheWriteTokens").unwrap_or(0).max(0);
            }
            _ => usage.rows_with_null_tokens += 1,
        }
    }
    usage
}

// ===== Internal helpers =====

/// The mutated payload actually sent upstream (`processedRequest`) when present, else the original
/// (`request`). Returns `Value::Null` if neither exists, which extractors degrade to `None`.
fn request_body(interaction: &Value) -> &Value {
    match interaction.get("processedRequest") {
        Some(v) if !v.is_null() => v,
        _ => interaction.get("request").unwrap_or(&Value::Null),
    }
}

/// Accumulate an extracted context into the distinct-context list, comparing by everything except the
/// running count so repeated identical calls collapse into one entry.
fn merge(prompts: &mut Vec<EffectivePromptData>, system_prompt: String, tools: Vec<String>, sampling: SamplingParams) {
    if let Some(existing) = prompts
        .iter_mut()
        .find(|p| p.system_prompt == system_prompt && p.tools == tools && p.sampling == sampling)
    {
        existing.interaction_count += 1;
        return;
    }
    prompts.push(EffectivePromptData {
        system_prompt,
        tools,
        sampling,
        interaction_count: 1,
    });
}

/// A `system`/`developer` role — both carry the effective system instruction in current OpenAI usage.
fn is_system_role(role: Option<&Value>) -> bool {
    matches!(role.and_then(Value::as_str), Some("system" | "developer"))
}

/// Stitch the system instruction from a Responses request's `input[]` items (system/developer roles).
fn responses_input_system(req: &Value) -> Option<String> {
    let parts: Vec<String> = req
        .get("input")
        .and_then(Value::as_array)?
        .iter()
        .filter(|it| is_system_role(it.get("role")))
        .filter_map(|it| it.get("content").and_then(join_text))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// A string, or an array of `{text: "..."}` parts joined with newlines. `None` if empty/absent — both
/// Anthropic `system` blocks, OpenAI message content arrays, and Gemini `parts` use this shape.
fn join_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => (!s.is_empty()).then(|| s.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|it| it.get("text").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn extract_openai_chat(req: &Value) -> Option<(String, Vec<String>, SamplingParams)> {
    let system = req
        .get("messages")
        .and_then(Value::as_array)?
        .iter()
        .find(|m| is_system_role(m.get("role")))
        .and_then(|m| m.get("content"))
        .and_then(join_text)?;
    let tools = names(req.get("tools"), |t| t.get("function").and_then(|f| f.get("name")));
    let sampling = SamplingParams {
        temperature: f64_at(req, "temperature"),
        max_tokens: i64_at(req, "max_tokens").or_else(|| i64_at(req, "max_completion_tokens")),
        top_p: f64_at(req, "top_p"),
    };
    Some((system, tools, sampling))
}

fn extract_anthropic(req: &Value) -> Option<(String, Vec<String>, SamplingParams)> {
    let system = req.get("system").and_then(join_text)?;
    let tools = names(req.get("tools"), |t| t.get("name"));
    let sampling = SamplingParams {
        temperature: f64_at(req, "temperature"),
        max_tokens: i64_at(req, "max_tokens"),
        top_p: f64_at(req, "top_p"),
    };
    Some((system, tools, sampling))
}

fn extract_openai_responses(req: &Value) -> Option<(String, Vec<String>, SamplingParams)> {
    // The Responses API carries the system instruction either as top-level `instructions` or as
    // system/developer items inside `input[]`.
    let system = req
        .get("instructions")
        .and_then(join_text)
        .or_else(|| responses_input_system(req))?;
    let tools = names(req.get("tools"), |t| t.get("name"));
    let sampling = SamplingParams {
        temperature: f64_at(req, "temperature"),
        max_tokens: i64_at(req, "max_output_tokens"),
        top_p: f64_at(req, "top_p"),
    };
    Some((system, tools, sampling))
}

fn extract_gemini(req: &Value) -> Option<(String, Vec<String>, SamplingParams)> {
    let system = req
        .get("systemInstruction")
        .and_then(|si| si.get("parts"))
        .and_then(join_text)?;
    // tools may be a single object or an array of them; each holds functionDeclarations[].name.
    let tool_groups: Vec<Value> = match req.get("tools") {
        Some(Value::Array(arr)) => arr.clone(),
        Some(obj @ Value::Object(_)) => vec![obj.clone()],
        _ => Vec::new(),
    };
    let tools = tool_groups
        .iter()
        .filter_map(|g| g.get("functionDeclarations").and_then(Value::as_array))
        .flatten()
        .filter_map(|d| d.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let cfg = req.get("generationConfig").unwrap_or(&Value::Null);
    let sampling = SamplingParams {
        temperature: f64_at(cfg, "temperature"),
        max_tokens: i64_at(cfg, "maxOutputTokens"),
        top_p: f64_at(cfg, "topP"),
    };
    Some((system, tools, sampling))
}

/// Collect tool names from a `tools` array, locating each name via `pick` (provider-specific path).
fn names(tools: Option<&Value>, pick: impl Fn(&Value) -> Option<&Value>) -> Vec<String> {
    tools
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| pick(t).and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn f64_at(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn i64_at(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sampling(t: Option<f64>, m: Option<i64>, p: Option<f64>) -> SamplingParams {
        SamplingParams {
            temperature: t,
            max_tokens: m,
            top_p: p,
        }
    }

    #[test]
    fn openai_chat_shape() {
        let it = json!({
            "type": "openrouter:chatCompletions",
            "request": {
                "messages": [
                    {"role": "system", "content": "be helpful"},
                    {"role": "user", "content": "hi"}
                ],
                "tools": [{"type": "function", "function": {"name": "search_tools"}}],
                "temperature": 0.0, "max_tokens": 8192
            }
        });
        let out = extract_effective_prompts(&[it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts.len(), 1);
        let p = &out.prompts[0];
        assert_eq!(p.system_prompt, "be helpful");
        assert_eq!(p.tools, vec!["search_tools"]);
        assert_eq!(p.sampling, sampling(Some(0.0), Some(8192), None));
        assert_eq!(p.interaction_count, 1);
    }

    #[test]
    fn anthropic_shape_with_text_block_system() {
        let it = json!({
            "type": "anthropic:messages",
            "request": {
                "system": [{"type": "text", "text": "denial rule"}],
                "tools": [{"name": "run_tool"}],
                "temperature": 1.0, "max_tokens": 4096, "top_p": 0.9
            }
        });
        let out = extract_effective_prompts(&[it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts[0].system_prompt, "denial rule");
        assert_eq!(out.prompts[0].tools, vec!["run_tool"]);
        assert_eq!(out.prompts[0].sampling, sampling(Some(1.0), Some(4096), Some(0.9)));
    }

    #[test]
    fn gemini_shape() {
        let it = json!({
            "type": "gemini:generateContent",
            "request": {
                "systemInstruction": {"parts": [{"text": "sys a"}, {"text": "sys b"}]},
                "tools": [{"functionDeclarations": [{"name": "f1"}, {"name": "f2"}]}],
                "generationConfig": {"temperature": 0.5, "maxOutputTokens": 2048, "topP": 0.8}
            }
        });
        let out = extract_effective_prompts(&[it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts[0].system_prompt, "sys a\nsys b");
        assert_eq!(out.prompts[0].tools, vec!["f1", "f2"]);
        assert_eq!(out.prompts[0].sampling, sampling(Some(0.5), Some(2048), Some(0.8)));
    }

    #[test]
    fn openai_responses_shape() {
        let it = json!({
            "type": "openai:responses",
            "request": {
                "instructions": "responses sys",
                "tools": [{"type": "function", "name": "t1"}],
                "temperature": 0.2, "max_output_tokens": 1000
            }
        });
        let out = extract_effective_prompts(&[it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts[0].system_prompt, "responses sys");
        assert_eq!(out.prompts[0].tools, vec!["t1"]);
        assert_eq!(out.prompts[0].sampling, sampling(Some(0.2), Some(1000), None));
    }

    #[test]
    fn processed_request_is_preferred_over_request() {
        let it = json!({
            "type": "anthropic:messages",
            "request": {"system": "original", "max_tokens": 1},
            "processedRequest": {"system": "mutated", "max_tokens": 2}
        });
        let out = extract_effective_prompts(&[it]);
        assert_eq!(out.prompts[0].system_prompt, "mutated");
        assert_eq!(out.prompts[0].sampling.max_tokens, Some(2));
    }

    #[test]
    fn null_processed_request_falls_back_to_request() {
        let it = json!({
            "type": "anthropic:messages",
            "request": {"system": "original", "max_tokens": 1},
            "processedRequest": null
        });
        let out = extract_effective_prompts(&[it]);
        assert_eq!(out.prompts[0].system_prompt, "original");
    }

    #[test]
    fn identical_contexts_collapse_into_one_with_count() {
        let it = json!({
            "type": "anthropic:messages",
            "request": {"system": "s", "tools": [{"name": "a"}], "max_tokens": 10}
        });
        let out = extract_effective_prompts(&[it.clone(), it.clone(), it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts.len(), 1);
        assert_eq!(out.prompts[0].interaction_count, 3);
    }

    #[test]
    fn varying_context_is_flagged_as_an_anomaly() {
        let a = json!({"type": "anthropic:messages", "request": {"system": "A"}});
        let b = json!({"type": "anthropic:messages", "request": {"system": "B"}});
        let out = extract_effective_prompts(&[a, b]);
        assert_eq!(out.prompts.len(), 2);
        assert_eq!(out.errors.len(), 1);
        assert!(out.errors[0].contains("varied"));
    }

    #[test]
    fn unhandled_type_is_an_explicit_error() {
        let it = json!({"type": "bedrock:converse", "request": {}});
        let out = extract_effective_prompts(&[it]);
        assert!(out.prompts.is_empty());
        assert_eq!(out.errors.len(), 1);
        assert!(out.errors[0].contains("bedrock:converse"));
    }

    #[test]
    fn empty_system_for_handled_type_is_an_error_not_a_null() {
        let it = json!({"type": "anthropic:messages", "request": {"max_tokens": 10}});
        let out = extract_effective_prompts(&[it]);
        assert!(out.prompts.is_empty());
        assert_eq!(out.errors.len(), 1);
        assert!(out.errors[0].contains("could not extract a system prompt"));
    }

    #[test]
    fn embeddings_among_real_calls_are_skipped() {
        let chat = json!({
            "type": "openai:chatCompletions",
            "request": {"messages": [{"role": "system", "content": "s"}]}
        });
        let emb = json!({"type": "openai:embeddings", "request": {"input": "x"}});
        let out = extract_effective_prompts(&[emb, chat]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts.len(), 1);
        assert_eq!(out.prompts[0].system_prompt, "s");
    }

    #[test]
    fn chat_machinery_sub_sources_are_skipped() {
        let main = json!({
            "type": "anthropic:messages",
            "source": "chat",
            "request": {"system": "agent context", "max_tokens": 10}
        });
        // Tool-call repair re-asks have no system prompt at all.
        let repair = json!({
            "type": "anthropic:messages",
            "source": "chat:tool_call_repair",
            "request": {"messages": [{"role": "user", "content": "re-emit as valid JSON"}]}
        });
        // Compaction has its own system prompt that must not register as a second context.
        let compaction = json!({
            "type": "anthropic:messages",
            "source": "chat:compaction",
            "request": {"system": "summarizer rules", "max_tokens": 10}
        });
        let out = extract_effective_prompts(&[main.clone(), repair, compaction, main]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts.len(), 1);
        assert_eq!(out.prompts[0].system_prompt, "agent context");
        assert_eq!(out.prompts[0].interaction_count, 2);
    }

    #[test]
    fn only_machinery_rows_is_flagged_not_silent() {
        let repair = json!({
            "type": "anthropic:messages",
            "source": "chat:tool_call_repair",
            "request": {"messages": [{"role": "user", "content": "re-emit"}]}
        });
        let out = extract_effective_prompts(&[repair]);
        assert!(out.prompts.is_empty());
        assert_eq!(out.errors.len(), 1);
        assert!(out.errors[0].contains("no model-facing prompt"));
    }

    #[test]
    fn only_embeddings_is_flagged_not_silent() {
        let emb = json!({"type": "openai:embeddings", "request": {"input": "x"}});
        let out = extract_effective_prompts(&[emb.clone(), emb]);
        assert!(out.prompts.is_empty());
        assert_eq!(out.errors.len(), 1);
        assert!(out.errors[0].contains("no model-facing prompt"));
    }

    #[test]
    fn developer_role_is_treated_as_system() {
        let it = json!({
            "type": "openai:chatCompletions",
            "request": {"messages": [{"role": "developer", "content": "dev rules"}]}
        });
        let out = extract_effective_prompts(&[it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts[0].system_prompt, "dev rules");
    }

    #[test]
    fn responses_reads_system_from_input_items() {
        let it = json!({
            "type": "openai:responses",
            "request": {
                "input": [
                    {"role": "developer", "content": [{"type": "input_text", "text": "from input"}]},
                    {"role": "user", "content": "hi"}
                ],
                "tools": [{"type": "function", "name": "t1"}]
            }
        });
        let out = extract_effective_prompts(&[it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts[0].system_prompt, "from input");
        assert_eq!(out.prompts[0].tools, vec!["t1"]);
    }

    #[test]
    fn gemini_tools_as_single_object() {
        let it = json!({
            "type": "gemini:generateContent",
            "request": {
                "systemInstruction": {"parts": [{"text": "sys"}]},
                "tools": {"functionDeclarations": [{"name": "f1"}]},
                "generationConfig": {"temperature": 0.5}
            }
        });
        let out = extract_effective_prompts(&[it]);
        assert!(out.errors.is_empty());
        assert_eq!(out.prompts[0].tools, vec!["f1"]);
    }

    fn usage_row(model: &str, input: i64, output: i64, cache_read: i64, cache_write: i64) -> Value {
        json!({
            "type": "anthropic:messages",
            "model": model,
            "inputTokens": input,
            "outputTokens": output,
            "cacheReadTokens": cache_read,
            "cacheWriteTokens": cache_write,
        })
    }

    #[test]
    fn sum_usage_sums_every_step_and_counts_cache_writes_once() {
        let rows = vec![
            usage_row("claude", 100, 10, 5, 200),
            json!({
                "type": "anthropic:messages", "model": "claude",
                "inputTokens": 300, "outputTokens": 40,
                "cacheReadTokens": 90, "cacheWriteTokens": 50, "cacheWrite1hTokens": 25,
            }),
        ];
        let u = sum_usage(&rows);
        assert_eq!(u.chat_rows, 2);
        assert_eq!(u.prompt_tokens, 400);
        assert_eq!(u.completion_tokens, 50);
        assert_eq!(u.cache_read_tokens, 95);
        // 200 + 50: `cacheWriteTokens` is already the full cache-creation count; the 1h field (25) is
        // a subset of the second row's 50 and must not be added again.
        assert_eq!(u.cache_write_tokens, 250);
        assert_eq!(u.total_tokens(), 400 + 50 + 95 + 250);
        assert_eq!(u.rows_with_null_tokens, 0);
        assert_eq!(u.models.len(), 1);
        assert!(u.had_spend());
    }

    #[test]
    fn sum_usage_skips_embeddings_but_counts_them_as_no_chat() {
        let rows = vec![
            json!({"type": "openai:embeddings", "model": "embed", "inputTokens": 999, "outputTokens": 0}),
            usage_row("claude", 100, 10, 0, 0),
        ];
        let u = sum_usage(&rows);
        assert_eq!(u.chat_rows, 1);
        assert_eq!(u.prompt_tokens, 100);
        assert!(!u.models.contains("embed"));
    }

    #[test]
    fn sum_usage_flags_missing_token_fields_as_a_gap() {
        // A chat row with no token fields is a telemetry gap, not a measured zero.
        let rows = vec![json!({"type": "anthropic:messages", "model": "claude"})];
        let u = sum_usage(&rows);
        assert_eq!(u.chat_rows, 1);
        assert_eq!(u.rows_with_null_tokens, 1);
        assert_eq!(u.prompt_tokens, 0);
    }

    #[test]
    fn sum_usage_clamps_negatives_and_unions_models() {
        let rows = vec![usage_row("a", -5, -5, -5, -5), usage_row("b", 10, 10, 0, 0)];
        let u = sum_usage(&rows);
        assert_eq!(u.prompt_tokens, 10);
        assert_eq!(u.completion_tokens, 10);
        assert_eq!(u.models.len(), 2);
    }

    #[test]
    fn sum_usage_empty_is_no_spend() {
        let u = sum_usage(&[]);
        assert!(!u.had_spend());
        assert_eq!(u.total_tokens(), 0);
    }
}
