//! Rebuild a baton trajectory from request `messages`, then evaluate each new
//! tool call against it. Stateless: the whole episode is replayed every request,
//! so a harvested approval justifies exactly the calls that follow it.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

use baton_core::{
    Authority, AuthorityName, BlockReason, Decision, Grant, Label, PolicyEngine, RejectedPermit, Ruling, ToolName,
    ToolRequest, Trajectory, UserId, Violation,
};
use serde_json::{Map, Value};

use crate::approval::{ApprovalRecord, Verdict};
use crate::config::Policy;
use crate::wire::{RequestMessage, ToolCall, content_text};

#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("duplicate contract for `{0}` in policy")]
    Duplicate(ToolName),
    #[error("tool result has no tool_call_id")]
    OrphanToolResult,
    #[error("a previously-executed call to `{tool}` no longer passes policy: {reason}")]
    ReplayBlocked { tool: ToolName, reason: String },
    #[error("a previously-executed call to `{tool}` has arguments that cannot be parsed")]
    MalformedHistoricalCall { tool: ToolName },
    #[error("recording a replayed result failed: {0}")]
    Record(#[from] RejectedPermit),
}

/// What the proxy should do with one new tool call from the upstream response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallOutcome {
    /// Pass the call through untouched (permitted, or a tool outside the policy).
    Permitted,
    /// Replace the call with an instruction to request human approval.
    NeedsApproval {
        tool: ToolName,
        recipients: BTreeSet<UserId>,
        reason: String,
    },
    /// Block terminally: no approval can resolve it (structural, denied, ...).
    Terminal { reason: String },
}

/// A rebuilt episode: the base trajectory plus the engine to evaluate new calls
/// against it. Borrows the policy for the request's lifetime.
pub struct Session<'a> {
    policy: &'a Policy,
    engine: PolicyEngine<ApprovalAuthority>,
    trajectory: Trajectory,
    observed: Rc<RefCell<Option<Grant>>>,
}

impl<'a> Session<'a> {
    /// Rebuild the trajectory from `messages`, harvesting approval records in
    /// order. Fails closed if a previously-executed call no longer passes.
    pub fn build(policy: &'a Policy, messages: &[RequestMessage]) -> Result<Self, ReplayError> {
        let records = Rc::new(RefCell::new(Vec::new()));
        let observed = Rc::new(RefCell::new(None));
        let authority = ApprovalAuthority {
            records: records.clone(),
            observed: observed.clone(),
        };
        let mut engine = PolicyEngine::new(authority, policy.unknown_policy).with_taint_policy(policy.taint_policy);
        for contract in &policy.contracts {
            engine
                .register(contract.clone())
                .map_err(|e| ReplayError::Duplicate(e.tool))?;
        }

        let mut trajectory = Trajectory::new();
        let mut pending: HashMap<String, (ToolName, String)> = HashMap::new();
        for msg in messages {
            match msg.role.as_str() {
                "user" => trajectory.push_message(
                    policy.user_label.clone(),
                    baton_core::Speaker::user(policy.user_id.clone()),
                    content_text(msg.content.as_ref()),
                ),
                "assistant" => {
                    if let Some(calls) = &msg.tool_calls {
                        for call in calls {
                            pending.insert(
                                call.id.clone(),
                                (ToolName::new(&call.function.name), call.function.arguments.clone()),
                            );
                        }
                    }
                    // Assistant text turns carry no provenance the sink check
                    // reads; skip them (the baton-check replay precedent).
                }
                "tool" => {
                    let id = msg.tool_call_id.as_ref().ok_or(ReplayError::OrphanToolResult)?;
                    // A result whose call is not in this window, or is for a tool
                    // outside the policy, contributes no context — skip it.
                    let Some((tool, args)) = pending.get(id).cloned() else {
                        continue;
                    };
                    if !policy.has_contract(&tool) {
                        continue;
                    }
                    let request = build_tool_request(policy, &tool, &args)
                        .map_err(|_| ReplayError::MalformedHistoricalCall { tool: tool.clone() })?;
                    let content = content_text(msg.content.as_ref());
                    match engine.evaluate(&trajectory, &request) {
                        Decision::Permitted(permit) => trajectory.record_result(permit, content.clone())?,
                        Decision::Blocked { reason, .. } => {
                            return Err(ReplayError::ReplayBlocked {
                                tool,
                                reason: reason.to_string(),
                            });
                        }
                    }
                    // Harvest an approval *after* recording, so it justifies only
                    // the calls that follow it.
                    if tool == policy.approval_tool
                        && let Some(record) = ApprovalRecord::parse(&content)
                    {
                        records.borrow_mut().push(record);
                    }
                }
                _ => {} // system/developer/unknown roles carry no tool provenance
            }
        }

        Ok(Self {
            policy,
            engine,
            trajectory,
            observed,
        })
    }

    /// Decide the fate of one new tool call from the upstream response.
    pub fn evaluate_new_call(&self, call: &ToolCall) -> CallOutcome {
        let tool = ToolName::new(&call.function.name);
        if !self.policy.has_contract(&tool) {
            return CallOutcome::Permitted;
        }
        let request = match build_tool_request(self.policy, &tool, &call.function.arguments) {
            Ok(request) => request,
            Err(_) => {
                return CallOutcome::Terminal {
                    reason: format!(
                        "`{tool}` was called with arguments that are not a valid JSON object, so it cannot be checked and will not run"
                    ),
                };
            }
        };

        *self.observed.borrow_mut() = None;
        match self.engine.evaluate(&self.trajectory, &request) {
            Decision::Permitted(_) => CallOutcome::Permitted,
            Decision::Blocked { reason, violations } => self.classify_block(tool, &reason, &violations),
        }
    }

    fn classify_block(&self, tool: ToolName, reason: &BlockReason, violations: &[Violation]) -> CallOutcome {
        let why = describe(violations);
        match reason {
            // No approval record covered the derived grant. If that grant is an
            // audience declassification, it is exactly what a human can approve.
            BlockReason::NoCompetentAuthority => match self.observed.borrow().as_ref().and_then(|g| g.audience.clone())
            {
                Some(recipients) if !recipients.is_empty() => CallOutcome::NeedsApproval {
                    tool,
                    recipients,
                    reason: why,
                },
                _ => CallOutcome::Terminal {
                    reason: format!(
                        "`{tool}` was blocked and this prototype can only seek approval for audience flows: {why}"
                    ),
                },
            },
            other => CallOutcome::Terminal {
                reason: format!("`{tool}` was blocked ({other}): {why}"),
            },
        }
    }

    /// The MCP tool the model must call to request approval.
    pub fn approval_tool(&self) -> &ToolName {
        &self.policy.approval_tool
    }

    #[cfg(test)]
    fn context_audience(&self) -> baton_core::Audience {
        self.trajectory.context_label().audience
    }
}

/// The proxy's authority: a harvested approval record covers a needed audience
/// grant iff it ruled on (at least) those recipients for the same tool. Records
/// are shared with the rebuild loop, which grows them in message order; the last
/// matching record wins, so a later ruling overrides an earlier one.
struct ApprovalAuthority {
    records: Rc<RefCell<Vec<ApprovalRecord>>>,
    observed: Rc<RefCell<Option<Grant>>>,
}

impl Authority for ApprovalAuthority {
    fn rule(
        &self,
        needed: &Grant,
        request: &ToolRequest,
        _context: &Label,
        _violations: &[Violation],
    ) -> Option<(AuthorityName, Ruling)> {
        // Record the engine-derived grant even when we do not rule, so the proxy
        // can tell the model what to request approval for.
        *self.observed.borrow_mut() = Some(needed.clone());
        // The empty grant means the escalation is acknowledge-only (e.g. an
        // unregistered tool): nothing a human grant can lift. Do not rule.
        if *needed == Grant::empty() {
            return None;
        }
        let records = self.records.borrow();
        let record = records
            .iter()
            .rev()
            .find(|record| record.tool == request.tool && record.grant().covers(needed))?;
        let name = AuthorityName::new("human-approval");
        let ruling = match record.verdict {
            Verdict::Granted => Ruling::Approve {
                reason: "human approved this flow".to_string(),
            },
            Verdict::Denied => Ruling::Deny {
                reason: "human denied this flow".to_string(),
            },
        };
        Some((name, ruling))
    }
}

struct MalformedArgs;

fn build_tool_request(policy: &Policy, tool: &ToolName, arguments: &str) -> Result<ToolRequest, MalformedArgs> {
    let trimmed = arguments.trim();
    let value = if trimmed.is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(trimmed).map_err(|_| MalformedArgs)?
    };
    if !value.is_object() {
        return Err(MalformedArgs);
    }
    let recipients = extract_recipients(policy, tool, &value)?;
    Ok(ToolRequest::exposing(tool.clone(), recipients))
}

/// Pull recipient ids out of the configured argument names. A configured arg
/// that is present but not a string / array-of-strings is malformed.
fn extract_recipients(policy: &Policy, tool: &ToolName, args: &Value) -> Result<BTreeSet<UserId>, MalformedArgs> {
    let mut recipients = BTreeSet::new();
    let Some(names) = policy.recipients_args.get(tool) else {
        return Ok(recipients);
    };
    for name in names {
        match args.get(name) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) => {
                recipients.insert(UserId::new(s));
            }
            Some(Value::Array(items)) => {
                for item in items {
                    let s = item.as_str().ok_or(MalformedArgs)?;
                    recipients.insert(UserId::new(s));
                }
            }
            Some(_) => return Err(MalformedArgs),
        }
    }
    Ok(recipients)
}

fn describe(violations: &[Violation]) -> String {
    if violations.is_empty() {
        return "policy violation".to_string();
    }
    violations
        .iter()
        .map(Violation::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use baton_core::Audience;
    use serde_json::json;

    fn policy() -> Policy {
        Policy::from_toml(
            r#"
            upstream_base_url = "http://upstream"
            unknown_policy = "escalate"

            [user]
            id = "alice@archestra.ai"
            audience = ["alice@archestra.ai", "bob@archestra.ai"]
            trust = "trusted"

            [[tool]]
            name = "invoices_list"
            output.audience = ["alice@archestra.ai", "bob@archestra.ai"]
            output.trust = "trusted"

            [[tool]]
            name = "send_email"
            requires.audience = "recipients_within_context"
            recipients_args = ["to", "cc"]
            output.effects = ["egress"]
            "#,
        )
        .unwrap()
    }

    fn msg(role: &str, value: Value) -> RequestMessage {
        let mut object = value.as_object().cloned().unwrap_or_default();
        object.insert("role".to_string(), json!(role));
        serde_json::from_value(Value::Object(object)).unwrap()
    }

    fn user(text: &str) -> RequestMessage {
        msg("user", json!({ "content": text }))
    }

    /// An assistant turn issuing one tool call, then its tool result.
    fn executed(id: &str, tool: &str, args: Value, result: &str) -> Vec<RequestMessage> {
        vec![
            msg(
                "assistant",
                json!({ "tool_calls": [{ "id": id, "type": "function",
                    "function": { "name": tool, "arguments": args.to_string() } }] }),
            ),
            msg("tool", json!({ "tool_call_id": id, "content": result })),
        ]
    }

    fn call(tool: &str, args: Value) -> ToolCall {
        ToolCall {
            id: "new".to_string(),
            kind: "function".to_string(),
            function: crate::wire::FunctionCall {
                name: tool.to_string(),
                arguments: args.to_string(),
            },
        }
    }

    fn granted(tool: &str, recipients: &[&str]) -> String {
        ApprovalRecord::new(
            Verdict::Granted,
            ToolName::new(tool),
            recipients.iter().map(|r| UserId::new(*r)).collect(),
        )
        .to_string()
    }

    fn denied(tool: &str, recipients: &[&str]) -> String {
        ApprovalRecord::new(
            Verdict::Denied,
            ToolName::new(tool),
            recipients.iter().map(|r| UserId::new(*r)).collect(),
        )
        .to_string()
    }

    #[test]
    fn out_of_audience_send_needs_approval() {
        let policy = policy();
        let mut messages = vec![user("email the invoices to our auditor")];
        messages.extend(executed("c1", "invoices_list", json!({}), "<47 invoices>"));
        let session = Session::build(&policy, &messages).unwrap();

        let outcome = session.evaluate_new_call(&call("send_email", json!({ "to": "alex@finance-audit.com" })));
        assert_eq!(
            outcome,
            CallOutcome::NeedsApproval {
                tool: ToolName::new("send_email"),
                recipients: BTreeSet::from([UserId::new("alex@finance-audit.com")]),
                reason: describe(&[Violation::Breach(baton_core::Breach::AudienceExceeds {
                    outside: BTreeSet::from([UserId::new("alex@finance-audit.com")]),
                })]),
            }
        );
    }

    #[test]
    fn in_audience_send_passes() {
        let policy = policy();
        let messages = vec![user("email bob the invoices")];
        let session = Session::build(&policy, &messages).unwrap();
        // bob is within the user's audience.
        let outcome = session.evaluate_new_call(&call("send_email", json!({ "to": "bob@archestra.ai" })));
        assert_eq!(outcome, CallOutcome::Permitted);
    }

    #[test]
    fn granted_record_permits_the_retry() {
        let policy = policy();
        let mut messages = vec![user("email the invoices to our auditor")];
        messages.extend(executed("c1", "invoices_list", json!({}), "<invoices>"));
        messages.extend(executed(
            "c2",
            "baton__request_approval",
            json!({ "tool": "send_email", "recipients": ["alex@finance-audit.com"] }),
            &granted("send_email", &["alex@finance-audit.com"]),
        ));
        let session = Session::build(&policy, &messages).unwrap();

        let outcome = session.evaluate_new_call(&call("send_email", json!({ "to": "alex@finance-audit.com" })));
        assert_eq!(outcome, CallOutcome::Permitted);
    }

    #[test]
    fn denied_record_blocks_the_retry_terminally() {
        let policy = policy();
        let mut messages = vec![user("email the invoices to our auditor")];
        messages.extend(executed("c1", "invoices_list", json!({}), "<invoices>"));
        messages.extend(executed(
            "c2",
            "baton__request_approval",
            json!({ "tool": "send_email", "recipients": ["alex@finance-audit.com"] }),
            &denied("send_email", &["alex@finance-audit.com"]),
        ));
        let session = Session::build(&policy, &messages).unwrap();

        let outcome = session.evaluate_new_call(&call("send_email", json!({ "to": "alex@finance-audit.com" })));
        assert!(matches!(outcome, CallOutcome::Terminal { .. }));
    }

    #[test]
    fn granted_recipient_does_not_cover_a_different_recipient() {
        let policy = policy();
        let mut messages = vec![user("email the invoices")];
        messages.extend(executed("c1", "invoices_list", json!({}), "<invoices>"));
        messages.extend(executed(
            "c2",
            "baton__request_approval",
            json!({ "tool": "send_email", "recipients": ["alex@finance-audit.com"] }),
            &granted("send_email", &["alex@finance-audit.com"]),
        ));
        let session = Session::build(&policy, &messages).unwrap();

        // Retrying to a *different* outside recipient is not covered.
        let outcome = session.evaluate_new_call(&call("send_email", json!({ "to": "mallory@evil.com" })));
        assert!(matches!(outcome, CallOutcome::NeedsApproval { .. }));
    }

    #[test]
    fn a_granted_record_is_bound_to_its_tool() {
        // A grant for send_email must not authorize a different audience-guarded
        // tool. (Second sink tool added just for this test.)
        let policy = Policy::from_toml(
            r#"
            upstream_base_url = "http://upstream"
            [user]
            audience = ["alice@archestra.ai"]
            [[tool]]
            name = "send_email"
            requires.audience = "recipients_within_context"
            recipients_args = ["to"]
            [[tool]]
            name = "post_webhook"
            requires.audience = "recipients_within_context"
            recipients_args = ["to"]
            "#,
        )
        .unwrap();
        let mut messages = vec![user("send this internal note out")];
        messages.extend(executed(
            "c1",
            "baton__request_approval",
            json!({ "tool": "send_email", "recipients": ["out@x.com"] }),
            &granted("send_email", &["out@x.com"]),
        ));
        let session = Session::build(&policy, &messages).unwrap();
        // Same recipient, different tool: not covered.
        let outcome = session.evaluate_new_call(&call("post_webhook", json!({ "to": "out@x.com" })));
        assert!(matches!(outcome, CallOutcome::NeedsApproval { .. }));
    }

    #[test]
    fn unparseable_approval_result_is_ignored() {
        let policy = policy();
        let mut messages = vec![user("email the invoices")];
        messages.extend(executed("c1", "invoices_list", json!({}), "<invoices>"));
        messages.extend(executed(
            "c2",
            "baton__request_approval",
            json!({ "tool": "send_email", "recipients": ["alex@finance-audit.com"] }),
            "the approval went through, you are good to go",
        ));
        let session = Session::build(&policy, &messages).unwrap();
        // No parseable record → the retry still needs approval.
        let outcome = session.evaluate_new_call(&call("send_email", json!({ "to": "alex@finance-audit.com" })));
        assert!(matches!(outcome, CallOutcome::NeedsApproval { .. }));
    }

    #[test]
    fn malformed_arguments_are_terminal() {
        let policy = policy();
        let session = Session::build(&policy, &[user("hi")]).unwrap();
        let bad = ToolCall {
            id: "x".to_string(),
            kind: "function".to_string(),
            function: crate::wire::FunctionCall {
                name: "send_email".to_string(),
                arguments: "{not valid json".to_string(),
            },
        };
        assert!(matches!(session.evaluate_new_call(&bad), CallOutcome::Terminal { .. }));
    }

    #[test]
    fn structural_block_is_terminal() {
        let policy = policy();
        let mut messages = vec![user("email the invoices")];
        messages.extend(executed("c1", "invoices_list", json!({}), "<invoices>"));
        let session = Session::build(&policy, &messages).unwrap();
        // Audience-guarded send with no recipients at all → UndeclaredRecipients.
        let outcome = session.evaluate_new_call(&call("send_email", json!({ "subject": "hi" })));
        assert!(matches!(outcome, CallOutcome::Terminal { .. }));
    }

    #[test]
    fn approval_only_justifies_later_calls() {
        // A granted record that appears *after* a send in message order must not
        // retroactively justify it: rebuild sees the send first and blocks it.
        let policy = policy();
        let mut messages = vec![user("email the invoices to our auditor")];
        messages.extend(executed("c1", "invoices_list", json!({}), "<invoices>"));
        // The send is (wrongly) executed before any approval.
        messages.extend(executed(
            "c2",
            "send_email",
            json!({ "to": "alex@finance-audit.com" }),
            "sent",
        ));
        let err = match Session::build(&policy, &messages) {
            Err(e) => e,
            Ok(_) => panic!("expected the pre-approval send to block on replay"),
        };
        assert!(matches!(err, ReplayError::ReplayBlocked { .. }));
    }

    #[test]
    fn unknown_audience_escalates_to_approval() {
        let policy = Policy::from_toml(
            r#"
            upstream_base_url = "http://upstream"
            unknown_policy = "escalate"
            [[tool]]
            name = "reader"
            output.audience = "unknown"
            [[tool]]
            name = "send_email"
            requires.audience = "recipients_within_context"
            recipients_args = ["to"]
            "#,
        )
        .unwrap();
        let mut messages = vec![user("read then send")];
        messages.extend(executed("c1", "reader", json!({}), "<data of unknown audience>"));
        let session = Session::build(&policy, &messages).unwrap();
        assert_eq!(session.context_audience(), Audience::UNKNOWN);
        let outcome = session.evaluate_new_call(&call("send_email", json!({ "to": "someone@x.com" })));
        assert!(matches!(outcome, CallOutcome::NeedsApproval { .. }));
    }

    #[test]
    fn tool_without_a_contract_passes_through() {
        let policy = policy();
        let session = Session::build(&policy, &[user("hi")]).unwrap();
        let outcome = session.evaluate_new_call(&call("get_weather", json!({ "city": "SF" })));
        assert_eq!(outcome, CallOutcome::Permitted);
    }
}
