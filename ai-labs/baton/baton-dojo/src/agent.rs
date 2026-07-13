//! The agent: give a [`Toolset`] and a workspace to a rig-core OpenRouter model
//! and run the tool-calling loop, optionally behind a [`BatonGate`].
//!
//! rig-core owns the wire: `CompletionModel::completion` returns typed
//! [`AssistantContent`] (text / tool calls / reasoning), so this loop reads those
//! directly and keeps the baton `evaluate → execute → record_result` protocol at
//! the dispatch seam. A blocked call is not executed and its reason is handed back
//! to the model as that tool's result.

use rig_core::OneOrMany;
use rig_core::completion::message::{AssistantContent, Message, ToolChoice};
use rig_core::completion::{CompletionModel, CompletionRequest};

use crate::error::DojoError;
use crate::model::Model;
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
}

/// The result of one agent run: the final text, the full transcript, the ordered
/// tool calls, and why it stopped.
#[derive(Debug, Clone)]
pub struct AgentRun {
    pub final_text: String,
    /// The full rig message log, for inspection.
    pub transcript: Vec<Message>,
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
    model: &'m Model,
    system: Option<String>,
    max_iters: usize,
}

/// Chosen local default; AgentDojo's own loop uses a similar small cap.
const DEFAULT_MAX_ITERS: usize = 12;

impl<'m> Agent<'m> {
    pub fn new(model: &'m Model) -> Self {
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
        let tool_choice = (!schemas.is_empty()).then_some(ToolChoice::Auto);

        // The system prompt is a leading `Message::System` (one canonical
        // representation; no `preamble`).
        let mut messages: Vec<Message> = Vec::new();
        if let Some(system) = &self.system {
            messages.push(Message::system(system.clone()));
        }
        messages.push(Message::user(user_prompt.clone()));
        if let Some(g) = gate.as_deref_mut() {
            g.begin(&user_prompt);
        }

        let mut tool_calls: Vec<ToolCallRecord> = Vec::new();

        for _ in 0..self.max_iters {
            let chat_history = OneOrMany::many(messages.clone()).expect("chat history always holds the prompt");
            let request = CompletionRequest {
                model: None,
                preamble: None,
                chat_history,
                documents: Vec::new(),
                tools: schemas.clone(),
                temperature: Some(0.0),
                max_tokens: None,
                tool_choice: tool_choice.clone(),
                additional_params: None,
                output_schema: None,
            };
            // rig collapses transport/provider errors and malformed tool args into
            // one error here (propagated); it never silently continues.
            let response = self.model.completion(request).await?;

            let final_text: String = response
                .choice
                .iter()
                .filter_map(|c| match c {
                    AssistantContent::Text(t) => Some(t.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            let calls: Vec<(String, String, serde_json::Value)> = response
                .choice
                .iter()
                .filter_map(|c| match c {
                    AssistantContent::ToolCall(tc) => {
                        Some((tc.id.clone(), tc.function.name.clone(), tc.function.arguments.clone()))
                    }
                    _ => None,
                })
                .collect();

            // A tool call with no id cannot be correlated to its result; abort
            // before any side effect rather than execute an uncorrelatable call
            // (rig does not validate this).
            if calls.iter().any(|(id, _, _)| id.trim().is_empty()) {
                return Err(DojoError::Malformed {
                    detail: "a tool call has no id".to_owned(),
                });
            }

            // Replay the assistant turn verbatim next round (rig round-trips its
            // reasoning blocks through this).
            messages.push(Message::from(response.choice));

            if calls.is_empty() {
                return Ok(AgentRun {
                    final_text,
                    transcript: messages,
                    tool_calls,
                    stop_reason: StopReason::Stop,
                });
            }

            for (id, name, args) in calls {
                let content = if name.trim().is_empty() || !tools.contains(&name) {
                    // Unknown tools never reach the gate: an unregistered tool would be
                    // permitted with an all-unknown label and taint later calls.
                    let content = error_content(&ToolError::UnknownTool(name.clone()));
                    tool_calls.push(ToolCallRecord {
                        name,
                        input: args,
                        outcome: ToolOutcome::Error(content.clone()),
                    });
                    content
                } else if let Some(g) = gate.as_deref_mut() {
                    match g.check(&name, &args) {
                        GateVerdict::Block { reason } => {
                            let content = format!("blocked by policy: {reason}");
                            tool_calls.push(ToolCallRecord {
                                name,
                                input: args,
                                outcome: ToolOutcome::Blocked(reason),
                            });
                            content
                        }
                        GateVerdict::Allow => {
                            let result = tools.dispatch(ws, &name, args.clone());
                            let content = result_content(&result);
                            // Fold the tool's contract-fixed output label into the trajectory,
                            // even on error: the handler may mutate state before failing.
                            g.commit(&content)?;
                            tool_calls.push(record(name, args, result));
                            content
                        }
                    }
                } else {
                    let result = tools.dispatch(ws, &name, args.clone());
                    let content = result_content(&result);
                    tool_calls.push(record(name, args, result));
                    content
                };
                messages.push(Message::tool_result(id, content));
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
