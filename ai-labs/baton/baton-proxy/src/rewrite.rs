//! Rewrite a chat-completions response so a harness's tool loop drives the
//! approval flow itself.
//!
//! Per choice: a call that needs approval is **replaced in place** with a call
//! to the approval MCP tool (same call id), carrying the tool, recipients, and
//! reason — so the harness executes it like any other tool, a human rules, and
//! the model retries the original once it sees `GRANTED`. Permitted siblings ride
//! through untouched. A *terminal* block (nothing a human can approve) instead
//! replaces the whole message with a stop explanation, since there is nothing to
//! retry. Terminal takes precedence over approval.

use baton_core::UserId;
use serde_json::json;

use crate::replay::{CallOutcome, Session};
use crate::wire::{ChatResponse, FunctionCall, ResponseMessage, ToolCall};

/// The policy decision for one model tool-call turn — what the trajectory log
/// records.
#[derive(Debug, Clone)]
pub struct TurnDecision {
    pub tool: String,
    pub outcome: &'static str,
    pub recipients: Vec<String>,
    pub reason: Option<String>,
}

impl TurnDecision {
    /// Whether this decision changed what the model asked for.
    pub fn rewritten(&self) -> bool {
        self.outcome != "permitted"
    }
}

/// Apply the policy to every choice in `response`, mutating blocked ones in
/// place. Returns one [`TurnDecision`] per evaluated tool call, for logging.
pub fn rewrite_response(session: &Session, response: &mut ChatResponse) -> Vec<TurnDecision> {
    let approval_tool = session.approval_tool().as_str();
    let mut decisions = Vec::new();
    for choice in &mut response.choices {
        // The deprecated `function_call` form is not modeled and thus not
        // evaluated; rather than let it bypass the policy, block it fail-closed.
        if choice.message.extra.contains_key("function_call") {
            replace_with_text(
                &mut choice.message,
                "This response used the deprecated `function_call` form, which baton-proxy cannot inspect. \
                 Use `tools`/`tool_calls` instead."
                    .to_string(),
            );
            choice.finish_reason = Some("stop".to_string());
            decisions.push(TurnDecision {
                tool: "function_call".to_string(),
                outcome: "terminal",
                recipients: Vec::new(),
                reason: Some("deprecated function_call form is not inspectable".to_string()),
            });
            continue;
        }

        let Some(calls) = choice.message.tool_calls.clone() else {
            continue;
        };
        if calls.is_empty() {
            continue;
        }

        let outcomes: Vec<CallOutcome> = calls.iter().map(|call| session.evaluate_new_call(call)).collect();
        for (call, outcome) in calls.iter().zip(&outcomes) {
            decisions.push(decision_of(&call.function.name, outcome));
        }
        let has_terminal = outcomes.iter().any(|o| matches!(o, CallOutcome::Terminal { .. }));
        let has_approval = outcomes.iter().any(|o| matches!(o, CallOutcome::NeedsApproval { .. }));

        if has_terminal {
            let terminals: Vec<&str> = outcomes
                .iter()
                .filter_map(|o| match o {
                    CallOutcome::Terminal { reason } => Some(reason.as_str()),
                    _ => None,
                })
                .collect();
            replace_with_text(&mut choice.message, terminal_text(&terminals));
            choice.finish_reason = Some("stop".to_string());
        } else if has_approval {
            let rewired: Vec<ToolCall> = calls
                .into_iter()
                .zip(outcomes)
                .map(|(call, outcome)| match outcome {
                    CallOutcome::NeedsApproval {
                        tool,
                        recipients,
                        reason,
                    } => approval_call(call.id, approval_tool, tool.as_str(), &recipients, &reason),
                    _ => call, // permitted sibling: unchanged
                })
                .collect();
            choice.message.tool_calls = Some(rewired);
            choice.finish_reason = Some("tool_calls".to_string());
        }
        // else: every call permitted — leave the choice untouched.
    }
    decisions
}

fn decision_of(tool: &str, outcome: &CallOutcome) -> TurnDecision {
    match outcome {
        CallOutcome::Permitted => TurnDecision {
            tool: tool.to_string(),
            outcome: "permitted",
            recipients: Vec::new(),
            reason: None,
        },
        CallOutcome::NeedsApproval { recipients, reason, .. } => TurnDecision {
            tool: tool.to_string(),
            outcome: "needs_approval",
            recipients: recipients.iter().map(|r| r.as_str().to_string()).collect(),
            reason: Some(reason.clone()),
        },
        CallOutcome::Terminal { reason } => TurnDecision {
            tool: tool.to_string(),
            outcome: "terminal",
            recipients: Vec::new(),
            reason: Some(reason.clone()),
        },
    }
}

/// A call to the approval MCP tool standing in for a blocked call.
fn approval_call(
    id: String,
    approval_tool: &str,
    tool: &str,
    recipients: &std::collections::BTreeSet<UserId>,
    reason: &str,
) -> ToolCall {
    let recipients: Vec<&str> = recipients.iter().map(UserId::as_str).collect();
    let arguments = json!({ "tool": tool, "recipients": recipients, "reason": reason }).to_string();
    ToolCall {
        id,
        kind: "function".to_string(),
        function: FunctionCall {
            name: approval_tool.to_string(),
            arguments,
        },
    }
}

fn replace_with_text(message: &mut ResponseMessage, text: String) {
    message.tool_calls = None;
    message.content = Some(serde_json::Value::String(text));
}

fn terminal_text(reasons: &[&str]) -> String {
    let mut text = String::from("This step was blocked by policy and cannot proceed:\n");
    for reason in reasons {
        text.push_str("- ");
        text.push_str(reason);
        text.push('\n');
    }
    text.push_str("Do not retry these calls; take a different approach or ask the user how to proceed.");
    text
}
