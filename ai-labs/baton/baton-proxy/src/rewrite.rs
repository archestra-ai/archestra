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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Policy;
    use serde_json::{Value, json};

    fn policy() -> Policy {
        Policy::from_toml(
            r#"
            upstream_base_url = "http://upstream"
            [user]
            audience = ["alice@archestra.ai", "bob@archestra.ai"]
            [[tool]]
            name = "send_email"
            requires.audience = "recipients_within_context"
            recipients_args = ["to"]
            output.effects = ["egress"]
            "#,
        )
        .unwrap()
    }

    fn tool_call(id: &str, tool: &str, args: Value) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            kind: "function".to_string(),
            function: FunctionCall {
                name: tool.to_string(),
                arguments: args.to_string(),
            },
        }
    }

    fn response_with(calls: Vec<ToolCall>) -> ChatResponse {
        serde_json::from_value(json!({
            "id": "x",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": null, "tool_calls":
                    serde_json::to_value(&calls).unwrap() },
                "finish_reason": "tool_calls"
            }]
        }))
        .unwrap()
    }

    fn user_messages() -> Vec<crate::wire::RequestMessage> {
        vec![serde_json::from_value(json!({ "role": "user", "content": "email the auditor" })).unwrap()]
    }

    fn only_call(response: &ChatResponse) -> &ToolCall {
        let calls = response.choices[0].message.tool_calls.as_ref().unwrap();
        assert_eq!(calls.len(), 1);
        &calls[0]
    }

    #[test]
    fn out_of_audience_call_becomes_an_approval_call() {
        let policy = policy();
        let session = Session::build(&policy, &user_messages()).unwrap();
        let mut response = response_with(vec![tool_call(
            "c1",
            "send_email",
            json!({ "to": "alex@finance-audit.com" }),
        )]);

        assert_eq!(rewrite_response(&session, &mut response), 1);
        assert_eq!(response.choices[0].finish_reason.as_deref(), Some("tool_calls"));
        let call = only_call(&response);
        assert_eq!(call.id, "c1"); // same id: the harness pairs the result naturally
        assert_eq!(call.function.name, "baton__request_approval");
        let args: Value = serde_json::from_str(&call.function.arguments).unwrap();
        assert_eq!(args["tool"], "send_email");
        assert_eq!(args["recipients"], json!(["alex@finance-audit.com"]));
    }

    #[test]
    fn permitted_call_passes_through_untouched() {
        let policy = policy();
        let session = Session::build(&policy, &user_messages()).unwrap();
        let mut response = response_with(vec![tool_call("c1", "send_email", json!({ "to": "bob@archestra.ai" }))]);

        assert_eq!(rewrite_response(&session, &mut response), 0);
        assert_eq!(only_call(&response).function.name, "send_email");
    }

    #[test]
    fn mixed_response_rewrites_only_the_blocked_call() {
        let policy = policy();
        let session = Session::build(&policy, &user_messages()).unwrap();
        let mut response = response_with(vec![
            tool_call("c1", "send_email", json!({ "to": "alex@finance-audit.com" })),
            tool_call("c2", "send_email", json!({ "to": "bob@archestra.ai" })),
        ]);

        assert_eq!(rewrite_response(&session, &mut response), 1);
        let calls = response.choices[0].message.tool_calls.as_ref().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].function.name, "baton__request_approval");
        assert_eq!(calls[1].function.name, "send_email"); // permitted sibling untouched
        assert_eq!(response.choices[0].finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn structural_block_yields_terminal_text() {
        let policy = policy();
        let session = Session::build(&policy, &user_messages()).unwrap();
        // No recipients on an audience-guarded sink → structural block.
        let mut response = response_with(vec![tool_call("c1", "send_email", json!({ "subject": "hi" }))]);

        assert_eq!(rewrite_response(&session, &mut response), 1);
        assert!(response.choices[0].message.tool_calls.is_none());
        assert_eq!(response.choices[0].finish_reason.as_deref(), Some("stop"));
        let text = response.choices[0].message.content.as_ref().unwrap().as_str().unwrap();
        assert!(text.contains("cannot proceed"));
    }

    #[test]
    fn text_only_response_is_untouched() {
        let policy = policy();
        let session = Session::build(&policy, &user_messages()).unwrap();
        let mut response: ChatResponse = serde_json::from_value(json!({
            "choices": [{ "message": { "role": "assistant", "content": "here you go" }, "finish_reason": "stop" }]
        }))
        .unwrap();
        assert_eq!(rewrite_response(&session, &mut response), 0);
    }
}
