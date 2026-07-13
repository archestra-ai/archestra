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

/// Apply the policy to every choice in `response`, mutating blocked ones in
/// place. Returns the number of choices that were rewritten.
pub fn rewrite_response(session: &Session, response: &mut ChatResponse) -> usize {
    let approval_tool = session.approval_tool().as_str();
    let mut rewritten = 0;
    for choice in &mut response.choices {
        let Some(calls) = choice.message.tool_calls.clone() else {
            continue;
        };
        if calls.is_empty() {
            continue;
        }

        let outcomes: Vec<CallOutcome> = calls.iter().map(|call| session.evaluate_new_call(call)).collect();
        let terminals: Vec<&str> = outcomes
            .iter()
            .filter_map(|o| match o {
                CallOutcome::Terminal { reason } => Some(reason.as_str()),
                _ => None,
            })
            .collect();

        if !terminals.is_empty() {
            replace_with_text(&mut choice.message, terminal_text(&terminals));
            choice.finish_reason = Some("stop".to_string());
            rewritten += 1;
            continue;
        }

        if outcomes.iter().any(|o| matches!(o, CallOutcome::NeedsApproval { .. })) {
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
            rewritten += 1;
        }
        // else: every call permitted — leave the choice untouched.
    }
    rewritten
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
