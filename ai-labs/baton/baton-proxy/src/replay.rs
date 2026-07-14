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
            // No approval record covered the derived grant. A human can only
            // resolve a pure *audience* declassification: this prototype records
            // approval as admitted recipients, so a grant that also needs trust,
            // effects, or confirmation can never be covered — routing it to a
            // human would just loop. Offer approval only for audience-only grants.
            BlockReason::NoCompetentAuthority => match self.observed.borrow().as_ref() {
                Some(grant) if is_audience_only(grant) => CallOutcome::NeedsApproval {
                    tool,
                    recipients: grant.audience.clone().unwrap_or_default(),
                    reason: why,
                },
                _ => CallOutcome::Terminal {
                    reason: format!(
                        "`{tool}` was blocked and this prototype can only seek approval for audience-only flows: {why}"
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

    /// A display of the trajectory's current folded audience — the context each
    /// new call is judged against. For the trajectory log.
    pub fn context_audience(&self) -> String {
        self.trajectory.context_label().audience.to_string()
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
        // The empty grant means the escalation is acknowledge-only (a taint entry
        // or unprovable effects — baton's own model has an authority *sign these
        // off*, not block them). There is nothing for a human to grant, so
        // acknowledge it automatically; otherwise a degrading-but-permitted flow
        // (e.g. any egress under `taint_policy=escalate`) would hard-block.
        if *needed == Grant::empty() {
            return Some((
                AuthorityName::new("baton-proxy-ack"),
                Ruling::Approve {
                    reason: "acknowledged (no human-grantable dimension)".to_string(),
                },
            ));
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

/// Whether a grant asks for an audience declassification and nothing else — the
/// only shape this prototype can route to a human (approval is recorded as
/// admitted recipients, so trust/effects/confirmation needs are unresolvable).
fn is_audience_only(grant: &Grant) -> bool {
    matches!(&grant.audience, Some(a) if !a.is_empty())
        && grant.trust.is_none()
        && grant.effects.is_none()
        && !grant.confirms
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
