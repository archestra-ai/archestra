//! The policy engine: evaluate one requested flow against exactly the values
//! it depends on.
//!
//! Audience and trust requirements are checked against
//! `L_flow = combine(L_args, L_control)` — the fold of the values rendered
//! into the request plus the values that *selected* it — never against the
//! whole trajectory. Effects are checked against the trajectory's monotone
//! past. A raw value elsewhere in the conversation no longer taints an
//! unrelated sink, but it still taints any action whose data or control
//! provenance depends on it.
//!
//! Remedy machinery (typed transitions, plans, waivers, external approval)
//! arrives in later stages; until then every escalation is an explicit
//! terminal block.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;
use tracing::debug;

use crate::ToolName;
use crate::audit::AuditEvent;
use crate::contract::{Fixability, Requirements, Unprovable, Verdict, Violation};
use crate::dimension::Effects;
use crate::request::{ArgumentSchema, ResponseRequest, ToolRequest};
use crate::revision::{ActionId, Revision, ValueId};
use crate::transition::{ActionTransition, DuplicateRegistration, RegisteredTransformer};
use crate::turn::{Trajectory, TrajectoryId};
use crate::value::ValueLabel;

/// The reserved sink name the final assistant response is checked under.
pub const RESPONSE_SINK: &str = "assistant.response";

/// What an unprovable (`Unknown`-caused) violation means at a sink.
///
/// This is the gradual-adoption knob: annotate a handful of high-risk tools,
/// leave the rest unknown, and choose how loudly the gaps fail — without
/// pretending the whole system is formally safe.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UnknownPolicy {
    /// Treat unprovable violations like breaches: escalate them.
    #[default]
    Escalate,
    /// Fail closed.
    Deny,
    /// Let the flow through, recording an [`AuditEvent::UnknownAudited`] on
    /// the trajectory's control-plane audit log.
    AllowWithAudit,
}

/// A tool's annotation: what it demands of a flow, the intrinsic label its
/// results wear, the effects running it proposes, and where its argument
/// tree carries typed roles.
///
/// The output label is per-result provenance only — it folds together with
/// the dispatched argument and control dependencies at admission and can
/// only worsen that fold, never override it. A label cannot express a user
/// confirmation (confirmations are structural on user turns), so a contract
/// cannot re-arm a confirmation gate from its own output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolContract {
    pub name: ToolName,
    pub requires: Requirements,
    pub output_label: ValueLabel,
    /// Effects one dispatch of this tool proposes; committed to the monotone
    /// past when dispatch begins.
    pub effects: Effects,
    pub arguments: ArgumentSchema,
}

/// Proof that the engine authorized one tool call — the only way to append a
/// tool result to a [`Trajectory`]. Bound to the trajectory, its exact
/// revision, and the pending action, so any state change invalidates it.
///
/// Linear (not `Clone`, no public constructor, `Serialize`-only) and spent on
/// use:
///
/// ```compile_fail
/// fn spend_twice(mut trajectory: baton_core::Trajectory, token: baton_core::ExecutionToken) {
///     let _ = trajectory.record_result(token, baton_core::OpaqueValue::new("first"));
///     let _ = trajectory.record_result(token, baton_core::OpaqueValue::new("second"));
/// }
/// ```
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ExecutionToken {
    action: ActionId,
    tool: ToolName,
    intrinsic: ValueLabel,
    arguments: BTreeSet<ValueId>,
    control: BTreeSet<ValueId>,
    proposed_effects: Effects,
    trajectory: TrajectoryId,
    revision: Revision,
}

/// The consumed contents of an [`ExecutionToken`].
pub(crate) struct TokenParts {
    pub(crate) action: ActionId,
    pub(crate) tool: ToolName,
    pub(crate) intrinsic: ValueLabel,
    pub(crate) arguments: BTreeSet<ValueId>,
    pub(crate) control: BTreeSet<ValueId>,
    pub(crate) proposed_effects: Effects,
    pub(crate) trajectory: TrajectoryId,
    pub(crate) revision: Revision,
}

impl ExecutionToken {
    pub fn action(&self) -> ActionId {
        self.action
    }

    /// The tool this token authorizes, verbatim as evaluated.
    pub fn tool(&self) -> &ToolName {
        &self.tool
    }

    pub(crate) fn into_parts(self) -> TokenParts {
        TokenParts {
            action: self.action,
            tool: self.tool,
            intrinsic: self.intrinsic,
            arguments: self.arguments,
            control: self.control,
            proposed_effects: self.proposed_effects,
            trajectory: self.trajectory,
            revision: self.revision,
        }
    }
}

/// The owned, canonically rendered request handed to the adapter at release
/// time. Produced from the exact argument tree the engine checked; adapters
/// execute this and never re-render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CanonicalRequest {
    pub action: ActionId,
    pub tool: ToolName,
    /// Deterministic rendering of the checked argument tree
    /// (see [`crate::request::render`]).
    pub rendered: String,
}

/// The linear receipt minted at release: the only way to admit the dispatched
/// tool's output — or declare its failure — and close the action. Bound to
/// the trajectory, the action, and the post-release revision; one receipt
/// closes one action exactly once.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct DispatchReceipt {
    action: ActionId,
    tool: ToolName,
    intrinsic: ValueLabel,
    arguments: BTreeSet<ValueId>,
    control: BTreeSet<ValueId>,
    trajectory: TrajectoryId,
    revision: Revision,
}

/// The consumed contents of a [`DispatchReceipt`].
pub(crate) struct ReceiptParts {
    pub(crate) action: ActionId,
    pub(crate) tool: ToolName,
    pub(crate) intrinsic: ValueLabel,
    pub(crate) arguments: BTreeSet<ValueId>,
    pub(crate) control: BTreeSet<ValueId>,
    pub(crate) trajectory: TrajectoryId,
    pub(crate) revision: Revision,
}

impl DispatchReceipt {
    pub fn action(&self) -> ActionId {
        self.action
    }

    pub(crate) fn from_token_parts(parts: TokenParts, revision: Revision) -> Self {
        Self {
            action: parts.action,
            tool: parts.tool,
            intrinsic: parts.intrinsic,
            arguments: parts.arguments,
            control: parts.control,
            trajectory: parts.trajectory,
            revision,
        }
    }

    pub(crate) fn into_parts(self) -> ReceiptParts {
        ReceiptParts {
            action: self.action,
            tool: self.tool,
            intrinsic: self.intrinsic,
            arguments: self.arguments,
            control: self.control,
            trajectory: self.trajectory,
            revision: self.revision,
        }
    }
}

/// A linear capability ([`ExecutionToken`] or [`DispatchReceipt`]) was
/// refused: it no longer (or never did) describe that trajectory's state, so
/// the flow must be re-evaluated. The capability is consumed either way.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RejectedToken {
    /// The token was minted for a different trajectory.
    #[error("token was minted for {minted_for}, not {this}")]
    ForeignTrajectory {
        minted_for: TrajectoryId,
        this: TrajectoryId,
    },
    /// The trajectory's state changed between `evaluate` and the recording.
    #[error("token minted at {minted_at}, but the trajectory is now at {current}")]
    Stale { minted_at: Revision, current: Revision },
    /// The action the token was minted for is no longer pending.
    #[error("action {action} is not pending on this trajectory")]
    ActionNotPending { action: ActionId },
}

/// [`PolicyEngine::register`] refused a contract: a contract for that tool is
/// already registered. Contracts are the policy boundary, so a silent replace
/// could weaken policy unnoticed — registration fails loudly instead.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("a contract for `{tool}` is already registered")]
pub struct DuplicateContract {
    pub tool: ToolName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum BlockReason {
    /// [`UnknownPolicy::Deny`] and at least one requirement was unprovable.
    UnknownDenied,
    /// A structural violation (an integration bug the caller must fix) was
    /// present; nothing may override it.
    RequiresStructuralFix,
    /// The flow escalated and no remedy machinery exists for it (yet).
    NoRemedy,
    /// A different action is already pending on this trajectory; it must be
    /// recorded or abandoned before a new proposal.
    ActionAlreadyPending { pending: ActionId },
    /// The request referenced a value this trajectory never admitted — a
    /// caller bug, failed closed and loudly.
    UnknownValueReferenced { value: ValueId },
    /// The response was composed against a revision the trajectory has moved
    /// past; recompose against the real state.
    StaleResponse { composed_at: Revision, current: Revision },
}

impl fmt::Display for BlockReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownDenied => write!(f, "unknown-policy is deny and the flow is unprovable"),
            Self::RequiresStructuralFix => {
                write!(f, "a structural violation nothing may override")
            }
            Self::NoRemedy => write!(f, "the flow escalated and no remedy applies"),
            Self::ActionAlreadyPending { pending } => {
                write!(f, "{pending} is already pending on this trajectory")
            }
            Self::UnknownValueReferenced { value } => {
                write!(f, "request references {value}, which this trajectory never admitted")
            }
            Self::StaleResponse { composed_at, current } => {
                write!(
                    f,
                    "response composed at {composed_at}, but the trajectory is now at {current}"
                )
            }
        }
    }
}

/// A blocked flow. `Terminal` is an explicit type, not an empty plan list:
/// there is nothing any transition or waiver could change.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub enum Blocked {
    Terminal(TerminalBlock),
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct TerminalBlock {
    pub violations: Vec<Violation>,
    pub reason: BlockReason,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[must_use = "a dropped Decision means the flow was neither executed nor blocked"]
pub enum Decision {
    Permitted(ExecutionToken),
    Blocked(Blocked),
}

/// Outcome of the completely mediated response sink. On `Emitted`, the
/// harness sends `rendered` — bytes produced from the exact checked tree —
/// and nothing else; there is no separate raw model string that may be
/// returned after the check.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[must_use = "a dropped ResponseDecision means the response was neither emitted nor blocked"]
pub enum ResponseDecision {
    Emitted { value: ValueId, rendered: String },
    Blocked(Blocked),
}

/// Policy for the final-response sink: what the response flow must satisfy,
/// and who reads the conversation (the sink's recipients).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResponsePolicy {
    pub requires: Requirements,
    pub readers: BTreeSet<crate::dimension::UserId>,
}

/// Holds the tool contracts, the transition registries, the response policy,
/// and the unknown policy. Registries are populated at construction time and
/// never mutated mid-run.
pub struct PolicyEngine {
    contracts: BTreeMap<ToolName, ToolContract>,
    transformers: Vec<RegisteredTransformer>,
    action_transitions: Vec<ActionTransition>,
    response_policy: Option<ResponsePolicy>,
    unknown_policy: UnknownPolicy,
}

impl PolicyEngine {
    pub fn new(unknown_policy: UnknownPolicy) -> Self {
        Self {
            contracts: BTreeMap::new(),
            transformers: Vec::new(),
            action_transitions: Vec::new(),
            response_policy: None,
            unknown_policy,
        }
    }

    /// Register a value transformer. Fails on a duplicate identity+version;
    /// registration order is the deterministic candidate order for planning.
    pub fn register_transformer(&mut self, transformer: RegisteredTransformer) -> Result<(), DuplicateRegistration> {
        let id = &transformer.descriptor.transformer;
        if self.transformers.iter().any(|t| t.descriptor.transformer == *id) {
            debug!(transformer = %id, "register_transformer: duplicate refused");
            return Err(DuplicateRegistration { id: id.to_string() });
        }
        debug!(transformer = %id, "register_transformer: registered");
        self.transformers.push(transformer);
        Ok(())
    }

    /// Register an action transition (an explicit tool-identity mapping with
    /// declared replacement effects). Fails on a duplicate identity+version.
    pub fn register_action_transition(&mut self, transition: ActionTransition) -> Result<(), DuplicateRegistration> {
        if self.action_transitions.iter().any(|t| t.id == transition.id) {
            debug!(transition = %transition.id, "register_action_transition: duplicate refused");
            return Err(DuplicateRegistration {
                id: transition.id.to_string(),
            });
        }
        debug!(transition = %transition.id, "register_action_transition: registered");
        self.action_transitions.push(transition);
        Ok(())
    }

    /// Set the final-response sink policy. Without one, emitting a response
    /// is unprovable (like calling a tool with no contract) and is disposed
    /// of by the [`UnknownPolicy`].
    #[must_use]
    pub fn with_response_policy(mut self, policy: ResponsePolicy) -> Self {
        self.response_policy = Some(policy);
        self
    }

    /// Register a tool's contract. Fails if one is already registered for that
    /// tool: contracts are the policy boundary, so an accidental replace is an
    /// error, not a silent overwrite.
    pub fn register(&mut self, contract: ToolContract) -> Result<(), DuplicateContract> {
        if self.contracts.contains_key(&contract.name) {
            debug!(tool = %contract.name, "register: duplicate contract refused");
            return Err(DuplicateContract { tool: contract.name });
        }
        debug!(tool = %contract.name, "register: contract registered");
        self.contracts.insert(contract.name.clone(), contract);
        Ok(())
    }

    /// Evaluate one requested flow against exactly its dependencies.
    ///
    /// Takes the trajectory mutably: a permitted evaluation stores the
    /// pending action, and decision-time audit (policy-audited unknowns)
    /// appends control-plane events. Re-evaluating the same original request
    /// is idempotent re-entry — it reuses the stored pending action; a
    /// *different* proposal while one is pending blocks without touching it.
    ///
    /// A tool with no registered contract is first-class: calling it is
    /// itself unprovable ([`Unprovable::NoContract`]), its output label is
    /// all-`Unknown`, and its proposed effects are `Unknown` (anything may
    /// happen), which then poison exactly the flows that depend on them.
    #[tracing::instrument(level = "debug", skip_all, fields(tool = %request.tool))]
    pub fn evaluate(&self, trajectory: &mut Trajectory, request: ToolRequest) -> Decision {
        // Pending-slot discipline: at most one action, idempotent re-entry
        // against the immutable original, everything else refused.
        let (checked_request, existing_action) = match trajectory.pending_action() {
            Some(pending) if *pending.original() == request => {
                debug!(action = %pending.id(), "re-entry: reusing pending action");
                (pending.current().clone(), Some(pending.id()))
            }
            Some(pending) => {
                debug!(pending = %pending.id(), "blocked (another action already pending)");
                return Decision::Blocked(Blocked::Terminal(TerminalBlock {
                    violations: Vec::new(),
                    reason: BlockReason::ActionAlreadyPending { pending: pending.id() },
                }));
            }
            None => (request.clone(), None),
        };

        let flow = match checked_request.flow_labels(trajectory.store()) {
            Ok(labels) => labels,
            Err(unknown) => {
                debug!(value = %unknown.id, "blocked (unknown value referenced)");
                return self.terminal(
                    trajectory,
                    Vec::new(),
                    BlockReason::UnknownValueReferenced { value: unknown.id },
                );
            }
        };

        let contract = self.contracts.get(&checked_request.tool);
        let (verdict, intrinsic, proposed_effects) = match contract {
            Some(c) => {
                let recipients = match c
                    .arguments
                    .resolve_recipients(&checked_request.arguments, trajectory.store())
                {
                    Ok(recipients) => recipients,
                    Err(unknown) => {
                        return self.terminal(
                            trajectory,
                            Vec::new(),
                            BlockReason::UnknownValueReferenced { value: unknown.id },
                        );
                    }
                };
                (
                    c.requires.check_flow(
                        &flow.flow(),
                        trajectory.state().past_effects(),
                        trajectory.pending_confirmation(),
                        &checked_request.tool,
                        &recipients,
                    ),
                    c.output_label.clone(),
                    c.effects.clone(),
                )
            }
            None => (
                Verdict::Escalate(vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: checked_request.tool.clone(),
                })]),
                ValueLabel::unknown(),
                Effects::UNKNOWN,
            ),
        };
        debug!(has_contract = contract.is_some(), flow = %flow.flow(), "contract lookup");

        let violations = match verdict {
            Verdict::Allow => Vec::new(),
            Verdict::Escalate(violations) => violations,
        };

        if violations.is_empty() {
            debug!("permitted (no violations)");
            return self.permit(
                trajectory,
                existing_action,
                request,
                checked_request,
                intrinsic,
                proposed_effects,
            );
        }
        debug!(violations = ?violations, "triaging violations");

        // Axis: fixability. A structural violation is an integration bug
        // nothing may override — block before any disposition.
        if violations.iter().any(|v| v.fixability() == Fixability::Structural) {
            debug!("blocked (structural fix required)");
            return self.terminal(trajectory, violations, BlockReason::RequiresStructuralFix);
        }

        // Axis: provability. Apply the UnknownPolicy to the unprovables.
        let (unprovable, breaches): (Vec<Violation>, Vec<Violation>) = violations
            .into_iter()
            .partition(|v| matches!(v, Violation::Unprovable(_)));

        let mut escalating = breaches;
        let mut audited_unknowns = Vec::new();
        debug!(
            policy = ?self.unknown_policy,
            unprovable = unprovable.len(),
            breaches = escalating.len(),
            "unknown-policy disposition",
        );
        match self.unknown_policy {
            UnknownPolicy::Escalate => escalating.extend(unprovable),
            UnknownPolicy::Deny => {
                if !unprovable.is_empty() {
                    escalating.extend(unprovable);
                    debug!("blocked (unknown-policy deny)");
                    return self.terminal(trajectory, escalating, BlockReason::UnknownDenied);
                }
            }
            UnknownPolicy::AllowWithAudit => audited_unknowns = unprovable,
        }

        if escalating.is_empty() {
            if !audited_unknowns.is_empty() {
                debug!(count = audited_unknowns.len(), "recording policy-audited unknowns");
                trajectory.record_event(AuditEvent::UnknownAudited {
                    tool: checked_request.tool.clone(),
                    facts: audited_unknowns,
                });
            }
            debug!("permitted (no escalation)");
            return self.permit(
                trajectory,
                existing_action,
                request,
                checked_request,
                intrinsic,
                proposed_effects,
            );
        }

        // Remedy machinery (transitions, plans, waivers) lands in later
        // stages; until then every escalation is terminal.
        debug!("blocked (no remedy)");
        escalating.extend(audited_unknowns);
        self.terminal(trajectory, escalating, BlockReason::NoRemedy)
    }

    /// The completely mediated response sink: check the response's explicit
    /// and control flow against the [`ResponsePolicy`], and on success admit
    /// the rendered response (an assistant turn) and return the exact bytes
    /// to emit. Revision-bound via `request.basis`; blocked responses touch
    /// nothing (in particular, they never clear a pending tool action).
    ///
    /// Without a registered response policy the emission is unprovable, like
    /// a tool with no contract, and the [`UnknownPolicy`] disposes of it.
    #[tracing::instrument(level = "debug", skip_all)]
    pub fn evaluate_response(&self, trajectory: &mut Trajectory, request: ResponseRequest) -> ResponseDecision {
        let blocked =
            |violations, reason| ResponseDecision::Blocked(Blocked::Terminal(TerminalBlock { violations, reason }));

        if request.basis != trajectory.revision() {
            debug!(composed_at = %request.basis, current = %trajectory.revision(), "response blocked (stale basis)");
            return blocked(
                Vec::new(),
                BlockReason::StaleResponse {
                    composed_at: request.basis,
                    current: trajectory.revision(),
                },
            );
        }
        let flow = match request.flow_labels(trajectory.store()) {
            Ok(labels) => labels,
            Err(unknown) => {
                return blocked(Vec::new(), BlockReason::UnknownValueReferenced { value: unknown.id });
            }
        };

        let sink = ToolName::new(RESPONSE_SINK);
        let verdict = match &self.response_policy {
            Some(policy) => policy.requires.check_flow(
                &flow.flow(),
                trajectory.state().past_effects(),
                None,
                &sink,
                &policy.readers,
            ),
            None => Verdict::Escalate(vec![Violation::Unprovable(Unprovable::NoContract {
                tool: sink.clone(),
            })]),
        };
        let violations = match verdict {
            Verdict::Allow => Vec::new(),
            Verdict::Escalate(violations) => violations,
        };

        if violations.iter().any(|v| v.fixability() == Fixability::Structural) {
            debug!("response blocked (structural fix required)");
            return blocked(violations, BlockReason::RequiresStructuralFix);
        }
        let (unprovable, breaches): (Vec<Violation>, Vec<Violation>) = violations
            .into_iter()
            .partition(|v| matches!(v, Violation::Unprovable(_)));
        let mut escalating = breaches;
        let mut audited_unknowns = Vec::new();
        match self.unknown_policy {
            UnknownPolicy::Escalate => escalating.extend(unprovable),
            UnknownPolicy::Deny => {
                if !unprovable.is_empty() {
                    escalating.extend(unprovable);
                    debug!("response blocked (unknown-policy deny)");
                    return blocked(escalating, BlockReason::UnknownDenied);
                }
            }
            UnknownPolicy::AllowWithAudit => audited_unknowns = unprovable,
        }
        if !escalating.is_empty() {
            debug!("response blocked (no remedy)");
            escalating.extend(audited_unknowns);
            return blocked(escalating, BlockReason::NoRemedy);
        }

        if !audited_unknowns.is_empty() {
            trajectory.record_event(AuditEvent::UnknownAudited {
                tool: sink,
                facts: audited_unknowns,
            });
        }
        let (value, rendered) = trajectory
            .emit_response(&request.body, request.control)
            .expect("response dependencies were validated by flow_labels above");
        debug!(%value, "response emitted");
        ResponseDecision::Emitted { value, rendered }
    }

    /// Mint the execution token, storing the pending action first if this is
    /// a fresh proposal. Minting happens after every mutation, so the token
    /// is bound to the trajectory's final revision.
    fn permit(
        &self,
        trajectory: &mut Trajectory,
        existing_action: Option<ActionId>,
        original: ToolRequest,
        checked_request: ToolRequest,
        intrinsic: ValueLabel,
        proposed_effects: Effects,
    ) -> Decision {
        let action = match existing_action {
            Some(action) => action,
            None => trajectory.set_pending(original, proposed_effects.clone()),
        };
        Decision::Permitted(ExecutionToken {
            action,
            tool: checked_request.tool.clone(),
            intrinsic,
            arguments: checked_request.arguments.leaves(),
            control: checked_request.control,
            proposed_effects,
            trajectory: trajectory.id(),
            revision: trajectory.revision(),
        })
    }

    /// A terminal block clears the pending slot: the flow cannot proceed, so
    /// holding the action open would only wedge the trajectory.
    fn terminal(&self, trajectory: &mut Trajectory, violations: Vec<Violation>, reason: BlockReason) -> Decision {
        trajectory.clear_pending();
        Decision::Blocked(Blocked::Terminal(TerminalBlock { violations, reason }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::{Audience, Effect, KnownTrust, Trust, UserId};
    use crate::request::{ArgumentName, ArgumentTree};
    use crate::turn::Speaker;
    use crate::value::OpaqueValue;

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    fn email_contract() -> ToolContract {
        ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                audience: crate::contract::AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
        }
    }

    fn engine_with(contracts: impl IntoIterator<Item = ToolContract>, policy: UnknownPolicy) -> PolicyEngine {
        let mut engine = PolicyEngine::new(policy);
        for contract in contracts {
            engine.register(contract).unwrap();
        }
        engine
    }

    /// Ingress a value readable by `readers` with the given trust.
    fn ingress(trajectory: &mut Trajectory, readers: &[&str], trust: Trust, body: &str) -> ValueId {
        trajectory.ingress(
            Speaker::user(user("alice")),
            ValueLabel {
                audience: Audience::readers(readers.iter().map(|r| user(r))),
                trust,
            },
            OpaqueValue::new(body),
        )
    }

    fn email_request(trajectory: &mut Trajectory, body: ValueId, recipient: &str) -> ToolRequest {
        let to = trajectory.ingress(
            Speaker::user(user("alice")),
            ValueLabel::identity(),
            OpaqueValue::new(recipient),
        );
        ToolRequest::new(
            ToolName::new("email.send"),
            ArgumentTree::Object(std::collections::BTreeMap::from([
                (ArgumentName::new("to"), ArgumentTree::Value(to)),
                (ArgumentName::new("body"), ArgumentTree::Value(body)),
            ])),
            BTreeSet::new(),
        )
    }

    #[test]
    fn clean_flow_is_permitted_and_result_admitted_with_folded_label() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "the doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        assert!(trajectory.pending_action().is_some());

        let result = trajectory.record_result(token, OpaqueValue::new("sent")).unwrap();
        assert!(trajectory.pending_action().is_none());
        // Output label folds intrinsic (identity) with the argument labels.
        assert_eq!(
            trajectory.value(result).unwrap().label().audience,
            Audience::readers([user("alice"), user("bob")])
        );
        // Effects were committed at dispatch.
        assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
    }

    #[test]
    fn explicit_flow_taint_blocks_the_sink() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw page");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::NoRemedy);
        assert!(matches!(
            block.violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::TrustBelow { .. })]
        ));
        assert!(trajectory.pending_action().is_none());
    }

    #[test]
    fn control_dependence_taints_a_clean_payload() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
        let clean_body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "harmless");
        let to = trajectory.ingress(
            Speaker::user(user("alice")),
            ValueLabel::identity(),
            OpaqueValue::new("bob"),
        );
        // The invocation was selected by something that read the secret:
        // whether this email happens leaks a bit even though the payload is
        // clean.
        let request = ToolRequest::new(
            ToolName::new("email.send"),
            ArgumentTree::Object(std::collections::BTreeMap::from([
                (ArgumentName::new("to"), ArgumentTree::Value(to)),
                (ArgumentName::new("body"), ArgumentTree::Value(clean_body)),
            ])),
            BTreeSet::from([secret]),
        );

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert!(matches!(
            block.violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::AudienceExceeds { outside })]
                if *outside == BTreeSet::from([user("bob")])
        ));
    }

    #[test]
    fn unregistered_tool_denied_under_deny_policy() {
        let engine = engine_with([], UnknownPolicy::Deny);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
        let request = ToolRequest::new(
            ToolName::new("mystery.tool"),
            ArgumentTree::Value(body),
            BTreeSet::new(),
        );

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::UnknownDenied);
    }

    #[test]
    fn unregistered_tool_audited_through_with_unknown_output() {
        let engine = engine_with([], UnknownPolicy::AllowWithAudit);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
        let request = ToolRequest::new(
            ToolName::new("mystery.tool"),
            ArgumentTree::Value(body),
            BTreeSet::new(),
        );

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        assert!(matches!(
            trajectory.state().audit(),
            [AuditEvent::UnknownAudited { .. }]
        ));

        let result = trajectory.record_result(token, OpaqueValue::new("???")).unwrap();
        // Intrinsic unknown poisons the output despite trusted inputs...
        assert_eq!(trajectory.value(result).unwrap().label(), &ValueLabel::unknown());
        // ...and unknown effects absorb the past.
        assert_eq!(trajectory.state().past_effects(), &Effects::UNKNOWN);
    }

    #[test]
    fn guarded_sink_without_recipients_is_structural() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = ToolRequest::new(
            ToolName::new("email.send"),
            ArgumentTree::Object(std::collections::BTreeMap::from([(
                ArgumentName::new("body"),
                ArgumentTree::Value(body),
            )])),
            BTreeSet::new(),
        );

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::RequiresStructuralFix);
    }

    #[test]
    fn stale_token_is_rejected_after_any_mutation() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        // Any state change — here a value admission, not even a turn —
        // invalidates the token.
        trajectory
            .admit_model_output(OpaqueValue::new("thinking"), BTreeSet::from([body]), BTreeSet::new())
            .unwrap();

        let err = trajectory.record_result(token, OpaqueValue::new("sent")).unwrap_err();
        assert!(matches!(err, RejectedToken::Stale { .. }));
    }

    #[test]
    fn foreign_trajectory_token_is_rejected() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");
        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };

        let mut other = Trajectory::new();
        let err = other.record_result(token, OpaqueValue::new("sent")).unwrap_err();
        assert!(matches!(err, RejectedToken::ForeignTrajectory { .. }));
    }

    #[test]
    fn second_distinct_proposal_is_refused_until_abandoned() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let first = email_request(&mut trajectory, body, "bob");
        let second = ToolRequest::new(ToolName::new("email.send"), ArgumentTree::Value(body), BTreeSet::new());

        let Decision::Permitted(_token) = engine.evaluate(&mut trajectory, first.clone()) else {
            panic!("expected permit");
        };
        let pending = trajectory.pending_action().unwrap().id();

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, second.clone()) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::ActionAlreadyPending { pending });
        // The in-flight action is untouched by the refused proposal.
        assert_eq!(trajectory.pending_action().unwrap().id(), pending);

        trajectory.abandon_pending();
        assert!(trajectory.pending_action().is_none());
    }

    #[test]
    fn re_entry_reuses_the_pending_action() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(first) = engine.evaluate(&mut trajectory, request.clone()) else {
            panic!("expected permit");
        };
        let Decision::Permitted(second) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit on re-entry");
        };
        assert_eq!(first.action(), second.action());

        // Both tokens are bound to the same revision; spending one consumes
        // the action and invalidates the other.
        trajectory.record_result(second, OpaqueValue::new("sent")).unwrap();
        let err = trajectory.record_result(first, OpaqueValue::new("again")).unwrap_err();
        assert!(matches!(err, RejectedToken::Stale { .. }));
    }

    #[test]
    fn committed_effects_feed_later_checks() {
        let mut report = email_contract();
        report.name = ToolName::new("report.generate");
        report.requires = Requirements {
            forbid_prior_effects: BTreeSet::from([Effect::Egress]),
            ..Requirements::default()
        };
        report.effects = Effects::none();
        report.arguments = ArgumentSchema::opaque();

        let engine = engine_with([email_contract(), report], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        trajectory.record_result(token, OpaqueValue::new("sent")).unwrap();

        let report_request = ToolRequest::new(
            ToolName::new("report.generate"),
            ArgumentTree::Value(body),
            BTreeSet::new(),
        );
        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, report_request) else {
            panic!("expected terminal block");
        };
        assert!(matches!(
            block.violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::ForbiddenPriorEffects { .. })]
        ));
    }

    #[test]
    fn duplicate_contract_is_refused() {
        let mut engine = PolicyEngine::new(UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();
        assert_eq!(
            engine.register(email_contract()),
            Err(DuplicateContract {
                tool: ToolName::new("email.send")
            })
        );
    }

    #[test]
    fn unknown_value_reference_blocks_loudly() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let ghost = ValueId::new(1000);
        let request = ToolRequest::new(ToolName::new("email.send"), ArgumentTree::Value(ghost), BTreeSet::new());

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::UnknownValueReferenced { value: ghost });
    }

    #[test]
    fn effects_survive_a_declared_dispatch_failure() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        let (canonical, receipt) = trajectory.release(token).unwrap();
        assert_eq!(canonical.tool, ToolName::new("email.send"));
        // Effects are committed at release, before any result exists.
        assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));

        trajectory.record_failure(receipt).unwrap();
        assert!(trajectory.pending_action().is_none());
        // Failure removes nothing.
        assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
    }

    #[test]
    fn canonical_request_renders_the_checked_tree() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "the doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        let (canonical, receipt) = trajectory.release(token).unwrap();
        assert_eq!(canonical.rendered, r#"{"body":"the doc","to":"bob"}"#);
        trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
    }

    #[test]
    fn stale_receipt_is_rejected_after_any_mutation() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        let (_, receipt) = trajectory.release(token).unwrap();
        trajectory
            .admit_model_output(OpaqueValue::new("meanwhile"), BTreeSet::from([body]), BTreeSet::new())
            .unwrap();
        let err = trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap_err();
        assert!(matches!(err, RejectedToken::Stale { .. }));
    }

    #[test]
    fn foreign_receipt_is_rejected() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");
        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        let (_, receipt) = trajectory.release(token).unwrap();

        let mut other = Trajectory::new();
        let err = other.record_output(receipt, OpaqueValue::new("sent")).unwrap_err();
        assert!(matches!(err, RejectedToken::ForeignTrajectory { .. }));
    }

    #[test]
    fn spent_confirmation_cannot_authorize_a_second_attempt() {
        let drop_contract = ToolContract {
            name: ToolName::new("db.drop"),
            requires: Requirements {
                attention: crate::contract::AttentionRule::ExplicitConfirmation,
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Mutation]),
            arguments: ArgumentSchema::opaque(),
        };
        let engine = engine_with([drop_contract], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let go = trajectory.ingress(
            crate::turn::Speaker::confirming(user("alice"), ToolName::new("db.drop")),
            ValueLabel::identity(),
            OpaqueValue::new("yes, drop it"),
        );
        let request = ToolRequest::new(ToolName::new("db.drop"), ArgumentTree::Value(go), BTreeSet::new());

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request.clone()) else {
            panic!("expected permit with confirmation in force");
        };
        let (_, receipt) = trajectory.release(token).unwrap();
        // The dispatch fails without appending a turn: the confirming turn is
        // the newest turn again, but its confirmation was spent at release.
        trajectory.record_failure(receipt).unwrap();
        assert_eq!(trajectory.pending_confirmation(), None);

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected block without a live confirmation");
        };
        assert!(matches!(
            block.violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::ConfirmationMissing { .. })]
        ));
    }

    fn response_engine(readers: &[&str]) -> PolicyEngine {
        PolicyEngine::new(UnknownPolicy::Escalate).with_response_policy(ResponsePolicy {
            requires: Requirements {
                audience: crate::contract::AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            readers: readers.iter().map(|r| user(r)).collect(),
        })
    }

    #[test]
    fn clean_response_is_emitted_from_the_exact_checked_tree() {
        let engine = response_engine(&["alice"]);
        let mut trajectory = Trajectory::new();
        let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "all done");
        let request = ResponseRequest {
            body: ArgumentTree::Value(note),
            control: BTreeSet::new(),
            basis: trajectory.revision(),
        };

        let ResponseDecision::Emitted { value, rendered } = engine.evaluate_response(&mut trajectory, request) else {
            panic!("expected emission");
        };
        assert_eq!(rendered, "\"all done\"");
        // The emitted value is the rendered bytes, derived from the tree.
        assert_eq!(trajectory.value(value).unwrap().body().as_str(), rendered);
        assert!(matches!(
            trajectory.turns().last(),
            Some(crate::turn::Turn {
                actor: crate::turn::Actor::Assistant,
                ..
            })
        ));
    }

    #[test]
    fn response_leaking_outside_readers_is_blocked() {
        // The conversation reader is charlie, but the response depends on a
        // value only alice may read.
        let engine = response_engine(&["charlie"]);
        let mut trajectory = Trajectory::new();
        let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
        let summary = trajectory
            .admit_model_output(
                OpaqueValue::new("about the secret"),
                BTreeSet::from([secret]),
                BTreeSet::new(),
            )
            .unwrap();
        let request = ResponseRequest {
            body: ArgumentTree::Value(summary),
            control: BTreeSet::new(),
            basis: trajectory.revision(),
        };

        let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request)
        else {
            panic!("expected block");
        };
        assert!(matches!(
            block.violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })]
        ));
    }

    #[test]
    fn response_control_dependence_is_checked() {
        let engine = response_engine(&["charlie"]);
        let mut trajectory = Trajectory::new();
        let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
        let bland = ingress(&mut trajectory, &["alice", "charlie"], Trust::TRUSTED, "ok");
        // The response text is clean, but WHETHER to say it was decided after
        // reading the secret.
        let request = ResponseRequest {
            body: ArgumentTree::Value(bland),
            control: BTreeSet::from([secret]),
            basis: trajectory.revision(),
        };

        let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request)
        else {
            panic!("expected block");
        };
        assert!(matches!(
            block.violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })]
        ));
    }

    #[test]
    fn stale_response_basis_is_blocked_and_touches_nothing() {
        let engine = response_engine(&["alice"]);
        let mut trajectory = Trajectory::new();
        let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "done");
        let stale_basis = trajectory.revision();
        // The trajectory moves on before emission.
        trajectory
            .admit_model_output(OpaqueValue::new("more"), BTreeSet::from([note]), BTreeSet::new())
            .unwrap();
        let turns_before = trajectory.turns().len();

        let request = ResponseRequest {
            body: ArgumentTree::Value(note),
            control: BTreeSet::new(),
            basis: stale_basis,
        };
        let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request)
        else {
            panic!("expected block");
        };
        assert!(matches!(block.reason, BlockReason::StaleResponse { .. }));
        assert_eq!(trajectory.turns().len(), turns_before);
    }

    #[test]
    fn response_without_policy_is_unprovable() {
        let engine = engine_with([], UnknownPolicy::Deny);
        let mut trajectory = Trajectory::new();
        let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "hi");
        let request = ResponseRequest {
            body: ArgumentTree::Value(note),
            control: BTreeSet::new(),
            basis: trajectory.revision(),
        };

        let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request)
        else {
            panic!("expected block");
        };
        assert_eq!(block.reason, BlockReason::UnknownDenied);
    }

    #[test]
    fn duplicate_reentry_token_cannot_release_twice() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(first) = engine.evaluate(&mut trajectory, request.clone()) else {
            panic!("expected permit");
        };
        let Decision::Permitted(second) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit on re-entry");
        };

        // Releasing one consumes the dispatch slot at that revision; the
        // duplicate can never begin a second dispatch.
        let (_, receipt) = trajectory.release(first).unwrap();
        let err = trajectory.release(second).unwrap_err();
        assert!(matches!(err, RejectedToken::Stale { .. }));
        trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
    }

    #[test]
    fn unknown_control_dependency_blocks_loudly() {
        let engine = engine_with([email_contract()], UnknownPolicy::Escalate);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let ghost = ValueId::new(1000);
        let request = ToolRequest::new(
            ToolName::new("email.send"),
            ArgumentTree::Value(body),
            BTreeSet::from([ghost]),
        );

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::UnknownValueReferenced { value: ghost });
    }

    #[test]
    fn duplicate_transformer_and_transition_registration_refused() {
        fn passthrough(v: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
            Ok(v.clone())
        }
        let entry = || RegisteredTransformer {
            descriptor: crate::transition::TransformerDescriptor {
                transformer: crate::value::TransformerRef {
                    id: "pii.redact".into(),
                    version: 1,
                },
                precondition: crate::transition::LabelPredicate::any(),
                output: ValueLabel::identity(),
            },
            run: passthrough,
        };
        let mut engine = PolicyEngine::new(UnknownPolicy::Escalate);
        engine.register_transformer(entry()).unwrap();
        assert!(engine.register_transformer(entry()).is_err());

        let transition = || ActionTransition {
            id: crate::value::TransformerRef {
                id: "sandbox".into(),
                version: 1,
            },
            from_tool: ToolName::new("shell.run"),
            to_tool: ToolName::new("shell.run.sandboxed"),
            effects: Effects::none(),
        };
        engine.register_action_transition(transition()).unwrap();
        assert!(engine.register_action_transition(transition()).is_err());
    }
}
