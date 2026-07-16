//! The per-MCP-session decision core: one trajectory, mediated tool calls,
//! soft blocks, and the escalation loop. No MCP types here — the gateway
//! binary renders [`Outcome`]s into tool results and supplies the human
//! approval callback; tests drive this module directly.
//!
//! Provenance model at the gateway layer (which never sees the LLM side):
//! every tool call's argument values are admitted as model output whose read
//! and control sets are **all prior tool outputs** — the model saw every
//! result, so the conservative fold is the honest one — and the request's
//! control set is that same context. Consequently an out-of-audience send is
//! both argument-borne (endorse) and control-borne (release), plus a
//! first-egress surface growth (accept): several grants, one human ruling per
//! authority (see [`Session::escalate`]).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use baton_core::{
    ArgumentTree, AuthorityName, BlockReason, EmissionPursuit, EmissionRequest, ExecutionToken, FlowOutcome,
    FlowPermit, OpaqueValue, Pursuit, Ruling, StallCause, ToolName, ToolRequest, UserId, ValueId, Violation,
};

use crate::gateway::config::{GatewayConfig, ToolSim};

/// Remedy steps one pursuit may apply, and approval rounds one escalation may
/// take — bounds against a planning livelock, far above any real remedy (the
/// grant count scales with the argument leaves: each endorsement is a round).
const MAX_REMEDY_STEPS: usize = 32;
const MAX_APPROVAL_ROUNDS: usize = 32;

/// How one mediated call (or escalation) settled. Rendering to MCP text
/// happens at the edge; tests assert on these.
#[derive(Debug)]
pub enum Outcome {
    /// Permitted and dispatched; `result` came from the canonical request.
    Executed { tool: ToolName, result: String },
    /// Blocked, but remediable via escalation: the pending action is kept.
    SoftBlocked {
        tool: ToolName,
        violations: Vec<Violation>,
        recipients: BTreeSet<UserId>,
    },
    /// Blocked with nothing any authority could grant.
    TerminalBlocked {
        tool: ToolName,
        reason: BlockReason,
        violations: Vec<Violation>,
    },
    /// Escalation approved; the pending action was dispatched canonically.
    Granted { tool: ToolName, result: String },
    /// Escalation denied by the human (or terminally blocked mid-remedy).
    Denied { tool: ToolName, reason: String },
    /// The approval channel produced no ruling (elicitation error, timeout,
    /// or dismissal). Fail closed: nothing was ruled or executed — but no
    /// human decision is recorded either, and the pending action is kept so
    /// escalation can be retried.
    EscalationUnavailable { tool: ToolName },
    /// `baton__escalate` with no soft-blocked call pending.
    NothingPending,
    /// The remedy walk stalled (bound exhausted, stale step, failed
    /// transition); the pending action was abandoned.
    RemedyStalled {
        tool: ToolName,
        violations: Vec<Violation>,
        cause: StallCause,
    },
    /// The dispatch was released but the simulated executor failed; the
    /// receipt closed the action via `record_failure`.
    ExecutorFailed { tool: ToolName, reason: String },
    /// Malformed wire arguments (unknown key, non-string value, missing
    /// required argument). Nothing was admitted or evaluated.
    BadArguments { tool: ToolName, reason: String },
    /// The tool is not in this gateway's catalog.
    UnknownTool { tool: String },
    /// A linear capability was refused mid-flow — a gateway bug surfaced
    /// loudly rather than swallowed.
    Refused { tool: ToolName, reason: String },
    /// The final answer passed the emission check and was emitted: send
    /// exactly `rendered` — bytes produced from the exact checked tree.
    Responded { rendered: String },
    /// The final answer was blocked at the emission sink; nothing was
    /// emitted.
    ResponseBlocked { reason: String, violations: Vec<Violation> },
}

/// The soft-blocked call's wire identity: how a re-issued call is recognized
/// as idempotent re-entry (the trajectory's pending action stores `ValueId`s,
/// which a re-issued call would not reuse).
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingWire {
    tool: ToolName,
    args: BTreeMap<String, String>,
    recipients: BTreeSet<UserId>,
}

pub struct Session {
    config: Arc<GatewayConfig>,
    trajectory: baton_core::Trajectory,
    /// Every tool output admitted so far — the conservative read/control set.
    context: BTreeSet<ValueId>,
    pending_wire: Option<PendingWire>,
}

impl Session {
    pub fn new(config: Arc<GatewayConfig>) -> Self {
        Self {
            config,
            trajectory: baton_core::Trajectory::new(),
            context: BTreeSet::new(),
            pending_wire: None,
        }
    }

    /// The engine lives behind the shared config `Arc`; cloning the handle
    /// sidesteps borrowing `self` immutably while the trajectory is borrowed
    /// mutably.
    fn shared(&self) -> Arc<GatewayConfig> {
        Arc::clone(&self.config)
    }

    /// Mediate one tool call from the wire.
    pub fn call_tool(&mut self, tool: &str, args: &serde_json::Map<String, serde_json::Value>) -> Outcome {
        let Some(sim) = self.config.tools.get(&ToolName::new(tool)).cloned() else {
            return Outcome::UnknownTool { tool: tool.to_owned() };
        };
        let args = match wire_args(&sim, args) {
            Ok(args) => args,
            Err(reason) => {
                return Outcome::BadArguments {
                    tool: sim.name.clone(),
                    reason,
                };
            }
        };
        let recipients = recipients_of(&sim, &args);

        // Pending-slot policy: a re-issued identical call re-enters the
        // pending action (and soft-blocks again); a different call abandons
        // it — the agent moved on, and wedging the trajectory helps nobody.
        if self.trajectory.pending_action().is_some() {
            let matches = self
                .pending_wire
                .as_ref()
                .is_some_and(|wire| wire.tool == sim.name && wire.args == args);
            if matches {
                let request = self
                    .trajectory
                    .pending_action()
                    .expect("pending action checked above")
                    .original()
                    .clone();
                return self.settle(&sim, request, recipients);
            }
            self.trajectory
                .abandon_pending()
                .expect("the gateway settles dispatches synchronously, so no released action lingers");
            self.pending_wire = None;
        }

        // Admit the argument values under the conservative fold, then build
        // the request. Admission advances the revision, which stales any
        // previous plans — escalation always re-derives.
        let mut leaves = BTreeMap::new();
        for (name, value) in &args {
            match self.trajectory.admit_model_output(
                OpaqueValue::new(value),
                self.context.clone(),
                self.context.clone(),
            ) {
                Ok(id) => {
                    leaves.insert(name.clone(), ArgumentTree::Value(id));
                }
                Err(unknown) => {
                    return Outcome::Refused {
                        tool: sim.name.clone(),
                        reason: format!("context value vanished: {unknown}"),
                    };
                }
            }
        }
        let request = ToolRequest::new(sim.name.clone(), ArgumentTree::object(leaves), self.context.clone());
        let outcome = self.settle(&sim, request, recipients.clone());
        if let Outcome::SoftBlocked { .. } = &outcome {
            self.pending_wire = Some(PendingWire {
                tool: sim.name.clone(),
                args,
                recipients,
            });
        }
        outcome
    }

    /// Evaluate (or re-enter) a request and settle everything that needs no
    /// human: permitted → dispatch, remediable → soft block, terminal → block.
    fn settle(&mut self, sim: &ToolSim, request: ToolRequest, recipients: BTreeSet<UserId>) -> Outcome {
        match self.shared().engine.evaluate(&mut self.trajectory, request) {
            Err(refusal) => {
                self.pending_wire = None;
                Outcome::Refused {
                    tool: sim.name.clone(),
                    reason: refusal.to_string(),
                }
            }
            Ok(FlowOutcome::AllowedNow(token)) => self.dispatch(sim, token),
            Ok(FlowOutcome::Remediable { violations, .. }) => Outcome::SoftBlocked {
                tool: sim.name.clone(),
                violations,
                recipients,
            },
            Ok(FlowOutcome::Terminal { violations, reason }) => {
                self.pending_wire = None;
                Outcome::TerminalBlocked {
                    tool: sim.name.clone(),
                    reason,
                    violations,
                }
            }
        }
    }

    /// Escalate the soft-blocked pending action to the human, then walk the
    /// remedy to a settled end. `ask` is called **at most once per authority**
    /// the remedy routes to — that authority's single accept/decline is
    /// applied as the ruling to every grant it must rule on (the message says
    /// so; the checked-in scenario has one authority, so one prompt). `ask`
    /// returning `None` means the approval channel produced no ruling: fail
    /// closed without recording a human decision, keeping the action pending.
    pub async fn escalate<F, Fut>(&mut self, reason: &str, mut ask: F) -> Outcome
    where
        F: FnMut(String) -> Fut,
        Fut: Future<Output = Option<bool>>,
    {
        let Some(pending) = self.trajectory.pending_action() else {
            return Outcome::NothingPending;
        };
        let request = pending.original().clone();
        let tool = request.tool.clone();
        let Some(sim) = self.config.tools.get(&tool).cloned() else {
            return Outcome::UnknownTool {
                tool: tool.as_str().to_owned(),
            };
        };
        let (args, recipients) = self
            .pending_wire
            .as_ref()
            .map(|wire| (wire.args.clone(), wire.recipients.clone()))
            .unwrap_or_default();

        let mut verdicts: BTreeMap<AuthorityName, bool> = BTreeMap::new();
        for _ in 0..MAX_APPROVAL_ROUNDS {
            let pending_approval =
                match self
                    .shared()
                    .engine
                    .pursue(&mut self.trajectory, request.clone(), MAX_REMEDY_STEPS)
                {
                    Pursuit::Permitted(token) => return self.granted(&sim, token),
                    Pursuit::Terminal { violations, reason } => {
                        return self.denied_or_terminal(&tool, violations, reason);
                    }
                    Pursuit::Refused(refusal) => {
                        self.pending_wire = None;
                        return Outcome::Refused {
                            tool,
                            reason: refusal.to_string(),
                        };
                    }
                    Pursuit::NeedsApproval(pending_approval) => pending_approval,
                    Pursuit::Stalled { violations, cause } => {
                        self.pending_wire = None;
                        return Outcome::RemedyStalled {
                            tool,
                            violations,
                            cause,
                        };
                    }
                };

            let authority = pending_approval.authority().clone();
            let verdict = match verdicts.get(&authority) {
                Some(verdict) => *verdict,
                None => {
                    let message = approval_message(&tool, &args, &recipients, reason, &pending_approval);
                    let Some(verdict) = ask(message).await else {
                        return Outcome::EscalationUnavailable { tool };
                    };
                    verdicts.insert(authority, verdict);
                    verdict
                }
            };
            let ruling = match verdict {
                true => Ruling::Approve {
                    reason: format!("operator approved escalation: {reason}"),
                },
                false => Ruling::Deny {
                    reason: "operator declined the escalation".to_owned(),
                },
            };
            match self
                .shared()
                .engine
                .apply_approval(&mut self.trajectory, pending_approval, ruling)
            {
                Ok(FlowOutcome::AllowedNow(FlowPermit::Execute(token))) => return self.granted(&sim, token),
                Ok(FlowOutcome::AllowedNow(FlowPermit::Emit(_))) => {
                    unreachable!("a tool flow's approval settles in an execution permit")
                }
                Ok(FlowOutcome::Remediable { .. }) => continue,
                Ok(FlowOutcome::Terminal { violations, reason }) => {
                    return self.denied_or_terminal(&tool, violations, reason);
                }
                Err(refused) => {
                    self.pending_wire = None;
                    return Outcome::Refused {
                        tool,
                        reason: refused.to_string(),
                    };
                }
            }
        }
        self.trajectory
            .abandon_pending()
            .expect("a stalled action was never released");
        self.pending_wire = None;
        Outcome::RemedyStalled {
            tool,
            violations: Vec::new(),
            cause: StallCause::BoundExhausted,
        }
    }

    fn granted(&mut self, sim: &ToolSim, token: ExecutionToken) -> Outcome {
        match self.dispatch(sim, token) {
            Outcome::Executed { tool, result } => Outcome::Granted { tool, result },
            other => other,
        }
    }

    fn denied_or_terminal(
        &mut self,
        tool: &ToolName,
        violations: Vec<baton_core::Violation>,
        reason: BlockReason,
    ) -> Outcome {
        self.pending_wire = None;
        match reason {
            BlockReason::DeniedByAuthority { authority, reason } => Outcome::Denied {
                tool: tool.clone(),
                reason: format!("{authority}: {reason}"),
            },
            reason => Outcome::TerminalBlocked {
                tool: tool.clone(),
                reason,
                violations,
            },
        }
    }

    /// Two-phase dispatch of a permitted flow. The executor consumes only the
    /// canonical request — the exact tree the engine checked — never the
    /// original wire arguments; a failure closes the receipt.
    fn dispatch(&mut self, sim: &ToolSim, token: ExecutionToken) -> Outcome {
        self.pending_wire = None;
        let (canonical, receipt) = match self.trajectory.release(token) {
            Ok(released) => released,
            Err(rejected) => {
                return Outcome::Refused {
                    tool: sim.name.clone(),
                    reason: rejected.to_string(),
                };
            }
        };
        let result = canonical_args(&canonical.rendered).and_then(|args| sim.render_result(&args));
        match result {
            Ok(result) => match self.trajectory.record_output(receipt, OpaqueValue::new(&result)) {
                Ok(value) => {
                    self.context.insert(value);
                    Outcome::Executed {
                        tool: sim.name.clone(),
                        result,
                    }
                }
                Err(rejected) => Outcome::Refused {
                    tool: sim.name.clone(),
                    reason: rejected.to_string(),
                },
            },
            Err(reason) => match self.trajectory.record_failure(receipt) {
                Ok(()) => Outcome::ExecutorFailed {
                    tool: sim.name.clone(),
                    reason,
                },
                Err(rejected) => Outcome::Refused {
                    tool: sim.name.clone(),
                    reason: format!("{reason}; and the failure receipt was refused: {rejected}"),
                },
            },
        }
    }

    /// The audit trail so far — the gateway narrates it at shutdown / on -v.
    /// Mediate the agent's final answer through the emission sink: the text
    /// is admitted under the conservative whole-context fold and checked —
    /// and, when clean, emitted — as an ordinary flow. Only the returned
    /// `rendered` bytes may reach the user. A leak that would need the
    /// external human blocks: response escalation is not wired in this demo
    /// (the follow-up ledger tracks it).
    pub fn respond(&mut self, text: &str) -> Outcome {
        let sink = ToolName::new("baton__respond");
        let body =
            match self
                .trajectory
                .admit_model_output(OpaqueValue::new(text), self.context.clone(), self.context.clone())
            {
                Ok(id) => id,
                Err(unknown) => {
                    return Outcome::Refused {
                        tool: sink,
                        reason: format!("context value vanished: {unknown}"),
                    };
                }
            };
        let request = EmissionRequest {
            body: ArgumentTree::Value(body),
            control: BTreeSet::new(),
            basis: self.trajectory.revision(),
        };
        match self
            .shared()
            .engine
            .pursue_emission(&mut self.trajectory, request, MAX_REMEDY_STEPS)
        {
            EmissionPursuit::Emitted(emitted) => Outcome::Responded {
                rendered: emitted.rendered,
            },
            EmissionPursuit::Terminal { violations, reason } => Outcome::ResponseBlocked {
                reason: reason.to_string(),
                violations,
            },
            EmissionPursuit::NeedsApproval(pending) => {
                let reason = format!(
                    "response needs an external ruling from {}; response escalation is not wired in this demo",
                    pending.authority()
                );
                drop(pending);
                self.trajectory.abandon_pending_emission();
                Outcome::ResponseBlocked {
                    reason,
                    violations: Vec::new(),
                }
            }
            EmissionPursuit::Stalled { violations, cause } => Outcome::ResponseBlocked {
                reason: format!("emission remedy stalled: {cause:?}"),
                violations,
            },
            EmissionPursuit::Refused(refusal) => Outcome::Refused {
                tool: sink,
                reason: refusal.to_string(),
            },
        }
    }

    pub fn audit(&self) -> impl Iterator<Item = String> {
        self.trajectory.audit().iter().map(|event| event.to_string())
    }
}

/// Validate wire arguments against the declared schema: strings only, no
/// undeclared keys, all required keys present.
fn wire_args(
    sim: &ToolSim,
    args: &serde_json::Map<String, serde_json::Value>,
) -> Result<BTreeMap<String, String>, String> {
    let declared = sim.declared_args();
    let mut out = BTreeMap::new();
    for (name, value) in args {
        if !declared.contains(name.as_str()) {
            return Err(format!("undeclared argument `{name}`"));
        }
        match value {
            serde_json::Value::String(s) => {
                out.insert(name.clone(), s.clone());
            }
            other => return Err(format!("argument `{name}` must be a string, got {other}")),
        }
    }
    for arg in &sim.args {
        if arg.required && !out.contains_key(&arg.name) {
            return Err(format!("missing required argument `{}`", arg.name));
        }
    }
    Ok(out)
}

fn recipients_of(sim: &ToolSim, args: &BTreeMap<String, String>) -> BTreeSet<UserId> {
    sim.recipients_arg
        .as_ref()
        .and_then(|arg| args.get(arg))
        .map(|value| BTreeSet::from([UserId::new(value)]))
        .unwrap_or_default()
}

/// Parse the canonical rendering (a JSON object whose leaves are strings)
/// back into the executor's argument map.
fn canonical_args(rendered: &str) -> Result<BTreeMap<String, String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(rendered).map_err(|e| format!("canonical request did not parse: {e}"))?;
    let serde_json::Value::Object(fields) = value else {
        return Err("canonical request is not an object".to_owned());
    };
    fields
        .into_iter()
        .map(|(name, value)| match value {
            serde_json::Value::String(s) => Ok((name, s)),
            other => Err(format!("canonical argument `{name}` is not a string: {other}")),
        })
        .collect()
}

fn approval_message(
    tool: &ToolName,
    args: &BTreeMap<String, String>,
    recipients: &BTreeSet<UserId>,
    reason: &str,
    pending: &baton_core::PendingApproval,
) -> String {
    let recipients = match recipients.is_empty() {
        true => "no declared recipients".to_owned(),
        false => recipients
            .iter()
            .map(|r| r.as_str().to_owned())
            .collect::<Vec<_>>()
            .join(", "),
    };
    let args = match args.is_empty() {
        true => "  (no arguments)".to_owned(),
        false => args
            .iter()
            .map(|(name, value)| format!("  {name}: {}", quote(value)))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    format!(
        "The agent wants to run `{tool}` (recipients: {recipients}), which policy blocks.\n\
         {args}\n\
         Agent's reason (unverified): {reason}\n\
         Grant needed: {grant} — ruled by `{authority}`; one ruling covers every grant \
         this remedy routes to this authority.\n\
         Accept to allow; decline to block.",
        reason = quote(reason),
        grant = pending.grant(),
        authority = pending.authority(),
    )
}

/// Model-controlled text rendered into the privileged approval prompt: quote
/// it as a JSON string (escaping newlines and control sequences that could
/// spoof or erase parts of the prompt) and cap the length.
fn quote(text: &str) -> String {
    const MAX: usize = 300;
    let clipped: String = text.chars().take(MAX).collect();
    let mut quoted = serde_json::to_string(&clipped).expect("a string always serializes");
    if text.chars().count() > MAX {
        quoted.push('…');
    }
    quoted
}
