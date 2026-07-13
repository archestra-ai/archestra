//! The agent: give a [`Toolset`] and a workspace to an [`OpenRouter`] model and
//! run the tool-calling loop, optionally behind a [`BatonGate`].
//!
//! This is AgentDojo's agent pipeline: alternate model turns with tool execution
//! until the model stops. When defended, every proposed call goes through baton's
//! `evaluate → execute → record_result` protocol; a blocked call is not executed
//! and its reason is handed back to the model as that tool's result.

use crate::error::DojoError;
use crate::openrouter::{ChatMessage, FinishReason, OpenRouter};
use crate::policy::{BatonGate, GateVerdict};
use crate::tool::{ToolError, Toolset};

/// What one tool call produced.
#[derive(Debug, Clone)]
pub enum ToolOutcome {
    /// Executed and returned this JSON.
    Ok(serde_json::Value),
    /// Not run, or run and failed — the string is what the model was told.
    Error(String),
    /// Refused by the baton policy gate before execution. The string is the block
    /// reason. This variant is reserved for policy denials only, so counting it
    /// yields a clean policy-block metric.
    Blocked(String),
}

/// A record of one tool call the model made during a run.
#[derive(Debug, Clone)]
pub struct ToolCallRecord {
    pub name: String,
    pub input: serde_json::Value,
    pub outcome: ToolOutcome,
}

/// Why the loop stopped.
#[derive(Debug, Clone)]
pub enum StopReason {
    /// The model produced a final answer with no tool calls.
    Stop,
    /// The iteration cap was hit with tool calls still pending.
    MaxIters,
    /// The provider truncated the completion (`finish_reason = length`).
    Length,
    /// The provider filtered the completion (`finish_reason = content_filter`).
    ContentFilter,
    /// The provider reported an in-band error on a successful HTTP response.
    ProviderError(String),
}

/// The result of one agent run: the final text, the full transcript, the ordered
/// tool calls, and why it stopped.
#[derive(Debug, Clone)]
pub struct AgentRun {
    pub final_text: String,
    pub transcript: Vec<ChatMessage>,
    pub tool_calls: Vec<ToolCallRecord>,
    pub stop_reason: StopReason,
}

impl AgentRun {
    /// The number of tool calls the baton gate blocked — the single source of
    /// truth for the policy-block metric.
    pub fn blocked_calls(&self) -> usize {
        self.tool_calls
            .iter()
            .filter(|r| matches!(r.outcome, ToolOutcome::Blocked(_)))
            .count()
    }
}

/// An agent bound to a model. Configure a system prompt and iteration cap, then
/// [`run`](Agent::run) it (undefended) or [`run_defended`](Agent::run_defended).
pub struct Agent<'m> {
    model: &'m OpenRouter,
    system: Option<String>,
    max_iters: usize,
}

/// Chosen local default; AgentDojo's own loop uses a similar small cap.
const DEFAULT_MAX_ITERS: usize = 12;

impl<'m> Agent<'m> {
    pub fn new(model: &'m OpenRouter) -> Self {
        Self {
            model,
            system: None,
            max_iters: DEFAULT_MAX_ITERS,
        }
    }

    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn max_iters(mut self, max_iters: usize) -> Self {
        self.max_iters = max_iters;
        self
    }

    /// Run the tool-calling loop with no policy gate.
    pub async fn run<W>(
        &self,
        ws: &mut W,
        tools: &Toolset<W>,
        user_prompt: impl Into<String>,
    ) -> Result<AgentRun, DojoError> {
        self.drive(ws, tools, user_prompt.into(), None).await
    }

    /// Run the tool-calling loop behind a baton policy gate. The gate is consumed
    /// (it carries the run's trajectory); read `blocked_calls()` off the result.
    pub async fn run_defended<W>(
        &self,
        ws: &mut W,
        tools: &Toolset<W>,
        mut gate: BatonGate,
        user_prompt: impl Into<String>,
    ) -> Result<AgentRun, DojoError> {
        self.drive(ws, tools, user_prompt.into(), Some(&mut gate)).await
    }

    async fn drive<W>(
        &self,
        ws: &mut W,
        tools: &Toolset<W>,
        user_prompt: String,
        mut gate: Option<&mut BatonGate>,
    ) -> Result<AgentRun, DojoError> {
        let schemas = tools.schemas();
        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(system) = &self.system {
            messages.push(ChatMessage::System(system.clone()));
        }
        messages.push(ChatMessage::User(user_prompt.clone()));
        if let Some(g) = gate.as_deref_mut() {
            g.begin(&user_prompt);
        }

        let mut tool_calls: Vec<ToolCallRecord> = Vec::new();

        for _ in 0..self.max_iters {
            let resp = self.model.complete(&messages, &schemas).await?;
            let final_text = resp.text.clone().unwrap_or_default();
            messages.push(ChatMessage::Assistant {
                text: resp.text.clone(),
                tool_calls: resp.tool_calls.clone(),
            });

            // Terminal finish reasons: never dispatch, surface distinctly.
            match &resp.finish {
                FinishReason::Length => {
                    return Ok(AgentRun {
                        final_text,
                        transcript: messages,
                        tool_calls,
                        stop_reason: StopReason::Length,
                    });
                }
                FinishReason::ContentFilter => {
                    return Ok(AgentRun {
                        final_text,
                        transcript: messages,
                        tool_calls,
                        stop_reason: StopReason::ContentFilter,
                    });
                }
                FinishReason::Error { message, .. } => {
                    return Ok(AgentRun {
                        final_text,
                        transcript: messages,
                        tool_calls,
                        stop_reason: StopReason::ProviderError(message.clone()),
                    });
                }
                _ => {}
            }

            if resp.tool_calls.is_empty() {
                return Ok(AgentRun {
                    final_text,
                    transcript: messages,
                    tool_calls,
                    stop_reason: StopReason::Stop,
                });
            }

            for call in &resp.tool_calls {
                let args = match parse_call_args(&call.name, &call.arguments_raw) {
                    Ok(args) => args,
                    Err(err) => {
                        let content = error_content(&err);
                        messages.push(ChatMessage::Tool {
                            tool_call_id: call.id.clone(),
                            content: content.clone(),
                        });
                        tool_calls.push(ToolCallRecord {
                            name: call.name.clone(),
                            input: serde_json::Value::String(call.arguments_raw.clone()),
                            outcome: ToolOutcome::Error(content),
                        });
                        continue;
                    }
                };

                if let Some(g) = gate.as_deref_mut() {
                    match g.check(&call.name, &args) {
                        GateVerdict::Block { reason } => {
                            let content = format!("blocked by policy: {reason}");
                            messages.push(ChatMessage::Tool {
                                tool_call_id: call.id.clone(),
                                content,
                            });
                            tool_calls.push(ToolCallRecord {
                                name: call.name.clone(),
                                input: args,
                                outcome: ToolOutcome::Blocked(reason),
                            });
                            continue;
                        }
                        GateVerdict::Allow => {
                            let result = tools.dispatch(ws, &call.name, args.clone());
                            let content = result_content(&result);
                            // Fold the tool's contract-fixed output label into the trajectory.
                            // Done even on error: the tool may have mutated state before failing.
                            g.commit(&content)?;
                            messages.push(ChatMessage::Tool {
                                tool_call_id: call.id.clone(),
                                content,
                            });
                            tool_calls.push(record(call.name.clone(), args, result));
                        }
                    }
                } else {
                    let result = tools.dispatch(ws, &call.name, args.clone());
                    let content = result_content(&result);
                    messages.push(ChatMessage::Tool {
                        tool_call_id: call.id.clone(),
                        content,
                    });
                    tool_calls.push(record(call.name.clone(), args, result));
                }
            }
        }

        Ok(AgentRun {
            final_text: String::new(),
            transcript: messages,
            tool_calls,
            stop_reason: StopReason::MaxIters,
        })
    }
}

/// Parse a proposed call's raw argument string. An empty tool name (a known
/// provider quirk) and malformed JSON both become a [`ToolError::BadArgs`], which
/// the loop feeds back as one bad tool result rather than failing the completion.
fn parse_call_args(name: &str, raw: &str) -> Result<serde_json::Value, ToolError> {
    if name.trim().is_empty() {
        return Err(ToolError::BadArgs {
            tool: name.to_owned(),
            detail: "empty tool name".to_owned(),
        });
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(trimmed).map_err(|e| ToolError::BadArgs {
        tool: name.to_owned(),
        detail: e.to_string(),
    })
}

fn record(name: String, input: serde_json::Value, result: Result<serde_json::Value, ToolError>) -> ToolCallRecord {
    let outcome = match result {
        Ok(value) => ToolOutcome::Ok(value),
        Err(err) => ToolOutcome::Error(err.to_string()),
    };
    ToolCallRecord { name, input, outcome }
}

/// The string the model is shown for a dispatched call — the JSON result, or a
/// JSON error object so the model can recover.
fn result_content(result: &Result<serde_json::Value, ToolError>) -> String {
    match result {
        Ok(value) => value.to_string(),
        Err(err) => error_content(err),
    }
}

fn error_content(err: &ToolError) -> String {
    serde_json::json!({ "error": err.to_string() }).to_string()
}
