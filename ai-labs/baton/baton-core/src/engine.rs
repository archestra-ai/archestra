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
use crate::approval::{AncestrySnapshot, Authority, AuthorityMode, PendingApproval, Ruling, TrajectoryView};
use crate::audit::AuditEvent;
use crate::audit::AuthorityName;
use crate::contract::{Fixability, Requirements, Unprovable, Verdict, Violation};
use crate::dimension::Effects;
use crate::plan::{NonEmptyVec, Posture, RemedyPlan, TransitionKind, TransitionSpec};
use crate::request::{ArgumentSchema, ResponseRequest, ToolRequest};
use crate::revision::{ActionId, PlanId, Revision, ValueId};
use crate::transition::{
    ActionTransition, DuplicateRegistration, ProposedGrant, RegisteredTransformer, TransientWaiver,
};
use crate::turn::{Trajectory, TrajectoryId};
use crate::value::{UnknownValue, ValueLabel};

/// The reserved sink name the final assistant response is checked under.
pub(crate) const RESPONSE_SINK: &str = "assistant.response";

/// Identity of one engine configuration, unique within the process. Plans,
/// step capabilities, and pending approvals bind to it: registries are the
/// semantic trust decision, so a capability minted under one engine's
/// registries must never resolve against another's — even if both registered
/// a transformer under the same public name and version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct EngineId(u64);

impl EngineId {
    fn next() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Self(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }
}

impl fmt::Display for EngineId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "engine#{}", self.0)
    }
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
/// fn release_twice(mut trajectory: baton_core::Trajectory, token: baton_core::ExecutionToken) {
///     let _ = trajectory.release(token);
///     let _ = trajectory.release(token);
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
    /// Deterministic rendering of the checked argument tree: the engine
    /// renders once at release and adapters execute this verbatim.
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

/// The linear capability to apply one plan step. Bound to the trajectory,
/// its exact revision, and the exact plan and step; minted by
/// [`PolicyEngine::mint_step`] and consumed — success or failure — by
/// [`PolicyEngine::apply_step`].
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct StepCapability {
    plan: PlanId,
    step: usize,
    action: ActionId,
    trajectory: TrajectoryId,
    revision: Revision,
    engine: EngineId,
}

/// A step or approval interaction was refused without touching state: the
/// capability never described this trajectory's current state.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StepRefused {
    #[error("no stored plan {plan}")]
    UnknownPlan { plan: PlanId },
    #[error("plan minted at {basis}, but the trajectory is now at {current}")]
    StalePlan { basis: Revision, current: Revision },
    #[error("{plan} has no step {step}")]
    NoSuchStep { plan: PlanId, step: usize },
    #[error("capability was minted for {minted_for}, not {this}")]
    ForeignTrajectory {
        minted_for: TrajectoryId,
        this: TrajectoryId,
    },
    #[error("capability was minted under {minted_by}, not {this}")]
    ForeignEngine { minted_by: EngineId, this: EngineId },
    #[error("action {action} is not pending on this trajectory")]
    ActionNotPending { action: ActionId },
}

/// The outcome of applying one plan step.
#[derive(Debug, Serialize)]
#[must_use = "a dropped StepOutcome loses the flow's continuation"]
pub enum StepOutcome {
    /// The step applied; the original flow was re-evaluated against the new
    /// state (permitting, re-planning, or blocking terminally).
    Advanced(Decision),
    /// The step names an external authority: its ruling re-enters through
    /// [`PolicyEngine::apply_approval`].
    NeedsApproval(PendingApproval),
    /// The step's precondition no longer held or its transformer failed. The
    /// failure is audited, the revision advanced (staling every sibling
    /// capability and plan), and no value or action was changed beyond the
    /// audit record. Re-evaluate to replan.
    Failed(crate::audit::TransitionFailure),
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
    /// An authority denied the waiver this flow needed.
    DeniedByAuthority { authority: AuthorityName, reason: String },
    /// An approved or applied remedy did not clear the checks it targeted on
    /// the fail-closed recheck — a bug in prediction or registration; the
    /// engine blocks rather than permit an under-covered flow.
    PostconditionFailed,
    /// Every competent inline authority abstained and none was external, so no
    /// ruling was produced. The plan was enumerable (a competent authority
    /// existed) but its rulings did not resolve the flow; fail closed.
    NoAuthorityRuled,
}

impl fmt::Display for BlockReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
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
            Self::DeniedByAuthority { authority, reason } => {
                write!(f, "denied by {authority}: {reason}")
            }
            Self::PostconditionFailed => {
                write!(f, "an applied remedy did not clear the checks it targeted")
            }
            Self::NoAuthorityRuled => {
                write!(f, "every competent authority abstained; no ruling was produced")
            }
        }
    }
}

/// The result of routing a grant through the competent authorities: the first
/// resolving inline ruling, a deferral to an external authority, or no ruling
/// at all (every competent authority was inline and abstained).
enum RoutedRuling {
    Approved(AuthorityName),
    Denied { authority: AuthorityName, reason: String },
    External(AuthorityName),
    NoRuling,
}

/// A blocked flow. `Terminal` is an explicit type, not an empty plan list:
/// there is nothing any transition or waiver could change. `Remediable`
/// carries at least one predicted route to a permit.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub enum Blocked {
    Terminal(TerminalBlock),
    Remediable {
        violations: Vec<Violation>,
        plans: NonEmptyVec<RemedyPlan>,
    },
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

/// Holds the tool contracts, the transition registries, the authorities, and
/// the response policy. Registries are populated at construction time and
/// never mutated mid-run.
pub struct PolicyEngine {
    id: EngineId,
    contracts: BTreeMap<ToolName, ToolContract>,
    transformers: Vec<RegisteredTransformer>,
    action_transitions: Vec<ActionTransition>,
    authorities: Vec<Authority>,
    response_policy: Option<ResponsePolicy>,
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {
            id: EngineId::next(),
            contracts: BTreeMap::new(),
            transformers: Vec::new(),
            action_transitions: Vec::new(),
            authorities: Vec::new(),
            response_policy: None,
        }
    }

    /// Register a decision-making authority. All authorities share one name
    /// space; a duplicate name is refused. Routing consults inline authorities
    /// before external ones, each in registration order, so registration order
    /// is load-bearing.
    pub fn register_authority(&mut self, authority: Authority) -> Result<(), DuplicateRegistration> {
        if self.authorities.iter().any(|a| a.name == authority.name) {
            debug!(authority = %authority.name, "register_authority: duplicate refused");
            return Err(DuplicateRegistration {
                id: authority.name.to_string(),
            });
        }
        debug!(authority = %authority.name, "register_authority: registered");
        self.authorities.push(authority);
        Ok(())
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

    /// Set the final-response sink policy. Without one, emitting a response is
    /// unprovable (like calling a tool with no contract) and blocks terminally
    /// — the response sink is strict emit-or-terminal (no remediation).
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
            // A released action has a dispatch in flight (its execution token
            // was consumed by `release`, and a receipt is outstanding).
            // Re-permitting it would mint a second token at the same revision
            // and enable a double dispatch — refuse until the receipt closes
            // the action via record_output/record_failure.
            Some(pending)
                if *pending.original() == request && pending.state() == crate::request::ActionState::Released =>
            {
                debug!(action = %pending.id(), "blocked (action already released, dispatch in flight)");
                return Decision::Blocked(Blocked::Terminal(TerminalBlock {
                    violations: Vec::new(),
                    reason: BlockReason::ActionAlreadyPending { pending: pending.id() },
                }));
            }
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

        // The constrained pending action's proposed effects are the single
        // source of truth on re-entry: a ConstrainAction narrowed them, and
        // the target contract's declaration must not overwrite the narrowing
        // baton validated.
        let proposed_effects = match existing_action {
            Some(_) => trajectory
                .pending_action()
                .expect("re-entry implies a pending action")
                .proposed_effects()
                .clone(),
            None => proposed_effects,
        };

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

        // Everything else — provable breaches and unprovable facts alike —
        // routes through the remedy chain. A grant-fixable gap routes to a
        // waiver; an acknowledge-only unprovable to an `acknowledge_unknown`
        // authority (see `enumerate_plans` and `grant_for`). There is no
        // implicit accept: an unprovable with no competent authority blocks.
        // The pending action is the plans' shared target, so it must exist
        // before planning.
        let action = match existing_action {
            Some(action) => action,
            None => trajectory.set_pending(request, proposed_effects),
        };
        let drafts = self.enumerate_plans(
            trajectory,
            &checked_request,
            contract,
            trajectory.pending_action().expect("pending action set above"),
        );
        match NonEmptyVec::from_vec(trajectory.store_plans(action, self.id, drafts)) {
            Some(plans) => {
                debug!(count = plans.len(), "blocked (remediable)");
                Decision::Blocked(Blocked::Remediable { violations, plans })
            }
            None => {
                debug!("blocked (no remedy)");
                self.terminal(trajectory, violations, BlockReason::NoRemedy)
            }
        }
    }

    /// The completely mediated response sink: check the response's explicit
    /// and control flow against the [`ResponsePolicy`], and on success admit
    /// the rendered response (an assistant turn) and return the exact bytes
    /// to emit. Revision-bound via `request.basis`; blocked responses touch
    /// nothing (in particular, they never clear a pending tool action).
    ///
    /// The response is the front door: strict emit-or-terminal, no remediation
    /// (a value too dirty to show is relabeled upstream, before the response is
    /// composed). Without a registered response policy the emission is
    /// unprovable, like a tool with no contract, and blocks terminally.
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
        // Strict emit-or-terminal: any residual violation — breach or
        // unprovable fact — blocks the front door. Nothing is acknowledged or
        // waived here; dirty values are relabeled upstream.
        if !violations.is_empty() {
            debug!("response blocked (no remedy)");
            return blocked(violations, BlockReason::NoRemedy);
        }

        let (value, rendered) = trajectory
            .emit_response(&request.body, request.control)
            .expect("response dependencies were validated by flow_labels above");
        debug!(%value, "response emitted");
        ResponseDecision::Emitted { value, rendered }
    }

    /// Mint the linear capability for one stored plan step. Pure — binding
    /// happens against the current revision; any later state change stales
    /// the capability.
    pub fn mint_step(&self, trajectory: &Trajectory, plan: PlanId, step: usize) -> Result<StepCapability, StepRefused> {
        let stored = trajectory
            .plans()
            .iter()
            .find(|p| p.id == plan)
            .ok_or(StepRefused::UnknownPlan { plan })?;
        if stored.basis != trajectory.revision() {
            return Err(StepRefused::StalePlan {
                basis: stored.basis,
                current: trajectory.revision(),
            });
        }
        if stored.engine != self.id {
            return Err(StepRefused::ForeignEngine {
                minted_by: stored.engine,
                this: self.id,
            });
        }
        stored.steps.get(step).ok_or(StepRefused::NoSuchStep { plan, step })?;
        match trajectory.pending_action() {
            Some(pending) if pending.id() == stored.action => {}
            _ => return Err(StepRefused::ActionNotPending { action: stored.action }),
        }
        Ok(StepCapability {
            plan,
            step,
            action: stored.action,
            trajectory: trajectory.id(),
            revision: trajectory.revision(),
            engine: self.id,
        })
    }

    /// Consume a step capability and apply its transition. Binding failures
    /// (foreign trajectory, stale revision) refuse without touching state;
    /// transition failures are audited and advance the revision, staling
    /// every sibling capability and plan. On success the original flow is
    /// re-evaluated — permitting, re-planning with fresh predictions, or
    /// blocking terminally.
    #[tracing::instrument(level = "debug", skip_all, fields(plan = %capability.plan, step = capability.step))]
    pub fn apply_step(
        &self,
        trajectory: &mut Trajectory,
        capability: StepCapability,
    ) -> Result<StepOutcome, StepRefused> {
        if capability.engine != self.id {
            return Err(StepRefused::ForeignEngine {
                minted_by: capability.engine,
                this: self.id,
            });
        }
        if capability.trajectory != trajectory.id() {
            return Err(StepRefused::ForeignTrajectory {
                minted_for: capability.trajectory,
                this: trajectory.id(),
            });
        }
        if capability.revision != trajectory.revision() {
            return Err(StepRefused::StalePlan {
                basis: capability.revision,
                current: trajectory.revision(),
            });
        }
        let stored = trajectory
            .plans()
            .iter()
            .find(|p| p.id == capability.plan)
            .ok_or(StepRefused::UnknownPlan { plan: capability.plan })?;
        let spec = stored
            .steps
            .get(capability.step)
            .ok_or(StepRefused::NoSuchStep {
                plan: capability.plan,
                step: capability.step,
            })?
            .clone();
        let pending = match trajectory.pending_action() {
            Some(pending) if pending.id() == capability.action => pending,
            _ => {
                return Err(StepRefused::ActionNotPending {
                    action: capability.action,
                });
            }
        };
        let checked = pending.current().clone();
        let original = pending.original().clone();
        let contract = self.contracts.get(&checked.tool);
        let sim = SimFlow::of(trajectory, &checked, contract).expect("pending action dependencies stay admitted");

        // The step's declared precondition must be exactly what the flow
        // reports now.
        if sim.violations(None) != spec.precondition.remaining {
            debug!("step refused (precondition posture no longer holds)");
            trajectory.record_event(AuditEvent::StepFailed {
                plan: capability.plan,
                step: capability.step as u64,
                failure: crate::audit::TransitionFailure::PreconditionMismatch,
            });
            return Ok(StepOutcome::Failed(
                crate::audit::TransitionFailure::PreconditionMismatch,
            ));
        }

        match spec.kind.clone() {
            TransitionKind::TransformValue { source, transformer } => {
                let registered = self
                    .transformers
                    .iter()
                    .find(|t| t.descriptor.transformer == transformer)
                    .expect("plans reference only registered transformers");
                let source_value = trajectory
                    .store()
                    .get(source)
                    .expect("plans reference only admitted values");
                if let Err(failure) = registered.accepts(source_value) {
                    trajectory.fail_transform(
                        source,
                        registered.descriptor.transformer.clone(),
                        registered.descriptor.output.clone(),
                        failure.clone(),
                    );
                    return Ok(StepOutcome::Failed(failure));
                }
                // Validate the declared postcondition BEFORE mutating:
                // labels are deterministic, so simulating the swap is exactly
                // the state the transform would produce. A failed transition
                // must create no value and no substitution.
                let mut after = sim.clone();
                after.leaf_labels.insert(source, registered.descriptor.output.clone());
                if after.violations(None) != spec.postcondition.remaining {
                    let failure = crate::audit::TransitionFailure::PostconditionMismatch;
                    trajectory.fail_transform(
                        source,
                        registered.descriptor.transformer.clone(),
                        registered.descriptor.output.clone(),
                        failure.clone(),
                    );
                    return Ok(StepOutcome::Failed(failure));
                }
                let body = match (registered.run)(source_value.body()) {
                    Ok(body) => body,
                    Err(error) => {
                        let failure = crate::audit::TransitionFailure::TransformerError { message: error.message };
                        trajectory.fail_transform(
                            source,
                            registered.descriptor.transformer.clone(),
                            registered.descriptor.output.clone(),
                            failure.clone(),
                        );
                        return Ok(StepOutcome::Failed(failure));
                    }
                };
                trajectory.apply_transform(
                    source,
                    registered.descriptor.transformer.clone(),
                    registered.descriptor.output.clone(),
                    body,
                );
                Ok(StepOutcome::Advanced(self.evaluate(trajectory, original)))
            }
            TransitionKind::ConstrainAction { transition } => {
                let registered = self
                    .action_transitions
                    .iter()
                    .find(|t| t.id == transition)
                    .expect("plans reference only registered action transitions");
                let pending = trajectory.pending_action().expect("validated above");
                let fail = |trajectory: &mut Trajectory, failure: crate::audit::TransitionFailure| {
                    trajectory.record_event(AuditEvent::StepFailed {
                        plan: capability.plan,
                        step: capability.step as u64,
                        failure: failure.clone(),
                    });
                    Ok(StepOutcome::Failed(failure))
                };
                if let Err(failure) = registered.narrows(pending) {
                    return fail(trajectory, failure);
                }
                // The target contract must exist, declare exactly the
                // effects the transition was validated against, and must not
                // widen the resolved recipient set under its schema.
                let Some(target) = self.contracts.get(&registered.to_tool) else {
                    return fail(trajectory, crate::audit::TransitionFailure::PreconditionMismatch);
                };
                if target.effects != registered.effects {
                    return fail(trajectory, crate::audit::TransitionFailure::PreconditionMismatch);
                }
                let Ok(recipients) = target
                    .arguments
                    .resolve_recipients(&checked.arguments, trajectory.store())
                else {
                    return fail(trajectory, crate::audit::TransitionFailure::PreconditionMismatch);
                };
                if !recipients.is_subset(&sim.recipients) {
                    return fail(trajectory, crate::audit::TransitionFailure::PreconditionMismatch);
                }
                // Pre-mutation postcondition validation, mirroring the
                // planner's simulation exactly.
                let mut after = sim.clone();
                after.tool = registered.to_tool.clone();
                after.requires = target.requires.clone();
                after.recipients = recipients;
                if after.violations(None) != spec.postcondition.remaining {
                    return fail(trajectory, crate::audit::TransitionFailure::PostconditionMismatch);
                }
                trajectory.apply_constraint(registered.to_tool.clone(), registered.effects.clone());
                Ok(StepOutcome::Advanced(self.evaluate(trajectory, original)))
            }
            TransitionKind::ApplyWaiver { delta } => {
                let grant = grant_for(&delta, &spec.precondition.remaining);
                // Route live: walk competent authorities in order. An inline
                // authority that abstains falls through to the next; the first
                // external one defers to an out-of-process ruling. The view
                // borrows the store read-only and is taken (and dropped) before
                // any mutation, so an inline ruling cannot observe its effects.
                let routed = {
                    let view = TrajectoryView::new(trajectory.store());
                    self.route_grant(&grant, &spec.precondition.remaining, &view)
                };
                match routed {
                    RoutedRuling::Approved(authority) => Ok(StepOutcome::Advanced(self.waiver_permit(
                        trajectory,
                        capability.action,
                        delta,
                        authority,
                        spec.precondition.remaining,
                    ))),
                    RoutedRuling::Denied { authority, reason } => {
                        trajectory.record_event(AuditEvent::WaiverDenied {
                            authority: authority.clone(),
                            reason: reason.clone(),
                        });
                        Ok(StepOutcome::Advanced(self.terminal(
                            trajectory,
                            spec.precondition.remaining,
                            BlockReason::DeniedByAuthority { authority, reason },
                        )))
                    }
                    RoutedRuling::External(authority) => {
                        trajectory.record_event(AuditEvent::ApprovalRequested {
                            plan: capability.plan,
                            authority: authority.clone(),
                            resolved: spec.precondition.remaining.clone(),
                        });
                        let basis = checked.arguments.leaves().into_iter().chain(checked.control);
                        let ancestry = AncestrySnapshot::of(trajectory.store(), basis);
                        Ok(StepOutcome::NeedsApproval(PendingApproval::new(
                            capability.plan,
                            capability.action,
                            delta,
                            authority,
                            spec.precondition.remaining,
                            ancestry,
                            trajectory.id(),
                            trajectory.revision(),
                            self.id,
                        )))
                    }
                    RoutedRuling::NoRuling => Ok(StepOutcome::Advanced(self.terminal(
                        trajectory,
                        spec.precondition.remaining,
                        BlockReason::NoAuthorityRuled,
                    ))),
                }
            }
        }
    }

    /// Consult competent authorities for `grant` in routing order and return
    /// the first resolving ruling. Inline authorities decide synchronously;
    /// an abstention (`None`) falls through to the next competent authority.
    /// The first competent external authority defers to an out-of-process
    /// ruling. `NoRuling` means every competent authority was inline and every
    /// one abstained.
    fn route_grant(&self, grant: &ProposedGrant, resolved: &[Violation], view: &TrajectoryView) -> RoutedRuling {
        for authority in self.competent_authorities(grant) {
            match &authority.mode {
                AuthorityMode::Inline(decide) => match decide(grant, resolved, view) {
                    Some(Ruling::Approve { .. }) => return RoutedRuling::Approved(authority.name.clone()),
                    Some(Ruling::Deny { reason }) => {
                        return RoutedRuling::Denied {
                            authority: authority.name.clone(),
                            reason,
                        };
                    }
                    None => continue,
                },
                AuthorityMode::External => return RoutedRuling::External(authority.name.clone()),
            }
        }
        RoutedRuling::NoRuling
    }

    /// Consume a pending approval with the authority's ruling. Binding
    /// failures refuse without touching state. A denial is audited and
    /// blocks terminally; an approval rechecks the flow fail-closed under
    /// the waiver and mints the execution token.
    pub fn apply_approval(
        &self,
        trajectory: &mut Trajectory,
        pending: PendingApproval,
        ruling: Ruling,
    ) -> Result<Decision, StepRefused> {
        let parts = pending.into_parts();
        if parts.engine != self.id {
            return Err(StepRefused::ForeignEngine {
                minted_by: parts.engine,
                this: self.id,
            });
        }
        if parts.trajectory != trajectory.id() {
            return Err(StepRefused::ForeignTrajectory {
                minted_for: parts.trajectory,
                this: trajectory.id(),
            });
        }
        if parts.revision != trajectory.revision() {
            return Err(StepRefused::StalePlan {
                basis: parts.revision,
                current: trajectory.revision(),
            });
        }
        match trajectory.pending_action() {
            Some(action) if action.id() == parts.action => {}
            _ => return Err(StepRefused::ActionNotPending { action: parts.action }),
        }
        match ruling {
            Ruling::Approve { .. } => {
                Ok(self.waiver_permit(trajectory, parts.action, parts.delta, parts.authority, parts.resolved))
            }
            Ruling::Deny { reason } => {
                trajectory.record_event(AuditEvent::WaiverDenied {
                    authority: parts.authority.clone(),
                    reason: reason.clone(),
                });
                Ok(self.terminal(
                    trajectory,
                    parts.resolved,
                    BlockReason::DeniedByAuthority {
                        authority: parts.authority,
                        reason,
                    },
                ))
            }
        }
    }

    /// A granted waiver: recheck the flow fail-closed under the delta, audit
    /// the application, and mint the execution token.
    fn waiver_permit(
        &self,
        trajectory: &mut Trajectory,
        action: ActionId,
        delta: TransientWaiver,
        authority: AuthorityName,
        resolved: Vec<Violation>,
    ) -> Decision {
        let pending = trajectory
            .pending_action()
            .expect("caller validated the pending action");
        let checked = pending.current().clone();
        let original = pending.original().clone();
        let contract = self.contracts.get(&checked.tool);
        let sim = SimFlow::of(trajectory, &checked, contract).expect("pending action dependencies stay admitted");
        let remaining = sim.violations(Some(&delta));
        if !remaining.is_empty() {
            debug!("waiver did not clear its targeted checks, failing closed");
            return self.terminal(trajectory, remaining, BlockReason::PostconditionFailed);
        }
        // If the delta also cleared acknowledge-only facts (unprovable
        // effects, a missing contract) that were in the residual, the audit
        // `changes` must show the acknowledgment alongside the loosened
        // dimensions — an auditor reading `changes` should not have to infer
        // it from `resolved`.
        let mut changes = delta.kinds();
        if resolved.iter().any(|v| v.fixability() == Fixability::AcknowledgeOnly) {
            changes.insert(crate::audit::WaiverKind::Acknowledgment);
        }
        let transition = trajectory.mint_transition();
        trajectory.record_event(AuditEvent::WaiverApplied {
            transition,
            changes,
            authority,
            resolved,
        });
        let (intrinsic, proposed_effects) = match contract {
            Some(c) => (c.output_label.clone(), c.effects.clone()),
            None => (ValueLabel::unknown(), Effects::UNKNOWN),
        };
        self.permit(trajectory, Some(action), original, checked, intrinsic, proposed_effects)
    }

    /// Deterministic bounded plan enumeration: candidate step sequences in
    /// the canonical order Transform? -> Constrain? -> Waiver?, each subset
    /// instantiated from the registries in registration order, kept iff the
    /// predicted final posture is clean, capped at [`MAX_PLANS`].
    fn enumerate_plans(
        &self,
        trajectory: &Trajectory,
        checked: &ToolRequest,
        contract: Option<&ToolContract>,
        pending: &crate::request::PendingAction,
    ) -> Vec<(NonEmptyVec<TransitionSpec>, Posture)> {
        let base = match SimFlow::of(trajectory, checked, contract) {
            Ok(base) => base,
            // A dependency vanished mid-evaluation cannot happen (the store
            // is append-only and we validated already), but fail closed.
            Err(_) => return Vec::new(),
        };

        // Candidate transform steps: non-recipient argument leaves x
        // registered transformers whose precondition matches, in (leaf,
        // registration) order.
        let recipient_leaves: BTreeSet<ValueId> = contract
            .and_then(|c| {
                c.arguments
                    .recipients
                    .as_ref()
                    .and_then(|role| checked.arguments.top_level(role))
            })
            .map(|subtree| subtree.leaves())
            .unwrap_or_default();
        let mut transforms: Vec<(ValueId, &RegisteredTransformer)> = Vec::new();
        for leaf in checked.arguments.leaves() {
            if recipient_leaves.contains(&leaf) {
                continue;
            }
            let label = &base.leaf_labels[&leaf];
            for transformer in &self.transformers {
                if transformer.descriptor.precondition.matches(label) && transformer.descriptor.output != *label {
                    transforms.push((leaf, transformer));
                }
            }
        }

        // Candidate constrain steps: registered action transitions from this
        // tool whose structural narrowing holds and whose target tool has a
        // contract.
        // A constrain candidate needs a registered target contract whose
        // declared effects agree with the transition's (the narrowing baton
        // validates must be what the target actually does) and whose argument
        // schema does not widen the resolved recipient set.
        let constrains: Vec<&ActionTransition> = self
            .action_transitions
            .iter()
            .filter(|t| {
                t.narrows(pending).is_ok()
                    && self.contracts.get(&t.to_tool).is_some_and(|target| {
                        target.effects == t.effects
                            && target
                                .arguments
                                .resolve_recipients(&checked.arguments, trajectory.store())
                                .is_ok_and(|recipients| recipients.is_subset(&base.recipients))
                    })
            })
            .collect();

        let mut plans: Vec<(NonEmptyVec<TransitionSpec>, Posture)> = Vec::new();
        let transform_options: Vec<Option<&(ValueId, &RegisteredTransformer)>> =
            std::iter::once(None).chain(transforms.iter().map(Some)).collect();
        let constrain_options: Vec<Option<&&ActionTransition>> =
            std::iter::once(None).chain(constrains.iter().map(Some)).collect();

        'outer: for transform in &transform_options {
            for constrain in &constrain_options {
                if plans.len() >= MAX_PLANS {
                    break 'outer;
                }
                let mut sim = base.clone();
                let mut steps: Vec<TransitionSpec> = Vec::new();

                if let Some((leaf, transformer)) = transform {
                    let precondition = Posture {
                        remaining: sim.violations(None),
                    };
                    sim.leaf_labels.insert(*leaf, transformer.descriptor.output.clone());
                    steps.push(TransitionSpec {
                        precondition,
                        postcondition: Posture {
                            remaining: sim.violations(None),
                        },
                        kind: TransitionKind::TransformValue {
                            source: *leaf,
                            transformer: transformer.descriptor.transformer.clone(),
                        },
                    });
                }
                if let Some(transition) = constrain {
                    let target = self
                        .contracts
                        .get(&transition.to_tool)
                        .expect("filtered on contract presence");
                    let recipients = match target
                        .arguments
                        .resolve_recipients(&checked.arguments, trajectory.store())
                    {
                        Ok(recipients) => recipients,
                        Err(_) => continue,
                    };
                    let precondition = Posture {
                        remaining: sim.violations(None),
                    };
                    sim.tool = transition.to_tool.clone();
                    sim.requires = target.requires.clone();
                    sim.recipients = recipients;
                    steps.push(TransitionSpec {
                        precondition,
                        postcondition: Posture {
                            remaining: sim.violations(None),
                        },
                        kind: TransitionKind::ConstrainAction {
                            transition: transition.id.clone(),
                        },
                    });
                }

                let remaining = sim.violations(None);
                if remaining.is_empty() {
                    if let Some(steps) = NonEmptyVec::from_vec(steps) {
                        push_plan(&mut plans, steps, Posture::clean());
                    }
                    continue;
                }

                // A final waiver for whatever remains. Prefer the narrower
                // control-release variant when the taint is control-borne.
                let precondition = Posture {
                    remaining: remaining.clone(),
                };
                for delta in self.waiver_candidates(&sim, &remaining) {
                    if !sim.violations(Some(&delta)).is_empty() {
                        continue;
                    }
                    let grant = grant_for(&delta, &remaining);
                    if !self.route_waiver(&grant) {
                        continue;
                    }
                    let mut waiver_steps = steps.clone();
                    waiver_steps.push(TransitionSpec {
                        precondition: precondition.clone(),
                        postcondition: Posture::clean(),
                        kind: TransitionKind::ApplyWaiver { delta },
                    });
                    let steps = NonEmptyVec::from_vec(waiver_steps).expect("waiver step just pushed");
                    push_plan(&mut plans, steps, Posture::clean());
                    break;
                }
            }
        }
        plans
    }

    /// Deterministic waiver candidates for a remaining violation set: the
    /// control-release variant first when releasing control alone shrinks
    /// the need, then the plain full-attestation delta.
    fn waiver_candidates(&self, sim: &SimFlow, remaining: &[Violation]) -> Vec<TransientWaiver> {
        let plain = needed_delta(remaining, &sim.recipients, &sim.requires);
        let after_control_release = sim.violations(Some(&TransientWaiver {
            control_release: true,
            ..TransientWaiver::empty()
        }));
        let mut candidates = Vec::new();
        if after_control_release.len() < remaining.len() {
            let with_release = TransientWaiver {
                control_release: true,
                ..needed_delta(&after_control_release, &sim.recipients, &sim.requires)
            };
            candidates.push(with_release);
        }
        if !candidates.contains(&plain) {
            candidates.push(plain);
        }
        candidates
    }

    /// Authorities competent for `grant`, in routing order: inline before
    /// external (a deterministic answer beats a round-trip to a human), each in
    /// registration order. An inline authority may still abstain at ruling
    /// time, which falls through to the next authority in this order.
    fn competent_authorities<'a>(&'a self, grant: &'a ProposedGrant) -> impl Iterator<Item = &'a Authority> {
        let inline = self
            .authorities
            .iter()
            .filter(move |a| matches!(a.mode, AuthorityMode::Inline(_)) && a.mandate.covers(grant));
        let external = self
            .authorities
            .iter()
            .filter(move |a| matches!(a.mode, AuthorityMode::External) && a.mandate.covers(grant));
        inline.chain(external)
    }

    /// Is any authority competent for `grant`? A waiver plan is enumerated only
    /// when one exists; the actual ruling — which an inline authority may
    /// abstain from, falling through to the next — happens at application.
    fn route_waiver(&self, grant: &ProposedGrant) -> bool {
        self.competent_authorities(grant).next().is_some()
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

/// Bound on enumerated plans per blocked flow.
const MAX_PLANS: usize = 8;

fn push_plan(
    plans: &mut Vec<(NonEmptyVec<TransitionSpec>, Posture)>,
    steps: NonEmptyVec<TransitionSpec>,
    final_postcondition: Posture,
) {
    if plans.iter().all(|(existing, _)| *existing != steps) {
        plans.push((steps, final_postcondition));
    }
}

/// The pure simulation state of one flow's check: per-leaf argument labels
/// (so a transform can be predicted by swapping one), the control fold, and
/// the sink parameters. Prediction (planning) and validation (application)
/// share this so a plan's postconditions mean exactly what the recheck
/// computes.
#[derive(Debug, Clone)]
pub(crate) struct SimFlow {
    pub(crate) leaf_labels: BTreeMap<ValueId, ValueLabel>,
    pub(crate) control: ValueLabel,
    pub(crate) tool: ToolName,
    pub(crate) requires: Requirements,
    pub(crate) recipients: BTreeSet<crate::dimension::UserId>,
    pub(crate) past_effects: Effects,
    pub(crate) confirmed: Option<ToolName>,
    /// Violations independent of the check (a missing contract).
    pub(crate) extra: Vec<Violation>,
}

impl SimFlow {
    pub(crate) fn of(
        trajectory: &Trajectory,
        checked: &ToolRequest,
        contract: Option<&ToolContract>,
    ) -> Result<Self, UnknownValue> {
        let store = trajectory.store();
        let mut leaf_labels = BTreeMap::new();
        for leaf in checked.arguments.leaves() {
            leaf_labels.insert(leaf, store.get(leaf)?.label().clone());
        }
        let control = store.fold_labels(checked.control.iter())?;
        let (requires, recipients, extra) = match contract {
            Some(c) => (
                c.requires.clone(),
                c.arguments.resolve_recipients(&checked.arguments, store)?,
                Vec::new(),
            ),
            None => (
                Requirements::default(),
                BTreeSet::new(),
                vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: checked.tool.clone(),
                })],
            ),
        };
        Ok(Self {
            leaf_labels,
            control,
            tool: checked.tool.clone(),
            requires,
            recipients,
            past_effects: trajectory.state().past_effects().clone(),
            confirmed: trajectory.pending_confirmation().cloned(),
            extra,
        })
    }

    /// The violations this flow would report, optionally under a
    /// check-transient waiver. A waiver lifts exactly its declared
    /// dimensions and acknowledges acknowledge-only facts on the record.
    pub(crate) fn violations(&self, waiver: Option<&TransientWaiver>) -> Vec<Violation> {
        let control = match waiver {
            Some(w) if w.control_release => ValueLabel::identity(),
            _ => self.control.clone(),
        };
        let mut flow = ValueLabel::fold(self.leaf_labels.values().cloned()).combine(control);
        let mut past = self.past_effects.clone();
        let mut confirmed = self.confirmed.clone();
        if let Some(w) = waiver {
            if let Some(attested) = w.trust {
                flow.trust = flow.trust.raised_to(attested);
            }
            if let Some(vouched) = &w.audience {
                flow.audience = flow.audience.admitting(vouched);
            }
            if let Some(waived) = &w.prior_effects {
                past = past.waiving(waived);
            }
            if w.confirms {
                confirmed = Some(self.tool.clone());
            }
        }
        let mut remaining = self.extra.clone();
        match self
            .requires
            .check_flow(&flow, &past, confirmed.as_ref(), &self.tool, &self.recipients)
        {
            Verdict::Allow => {}
            Verdict::Escalate(violations) => remaining.extend(violations),
        }
        if waiver.is_some() {
            remaining.retain(|v| v.fixability() != Fixability::AcknowledgeOnly);
        }
        remaining
    }
}

/// The typed grant a residual asks an authority to authorize. A non-empty
/// lift is a [`ProposedGrant::Waive`]; an empty lift over an acknowledge-only
/// residual is a [`ProposedGrant::Acknowledge`], which routes on the explicit
/// `acknowledge_unknown` capability rather than being covered by every mandate.
fn grant_for(delta: &TransientWaiver, resolved: &[Violation]) -> ProposedGrant {
    if delta == &TransientWaiver::empty() {
        let facts = resolved
            .iter()
            .filter_map(|violation| match violation {
                Violation::Unprovable(fact) => Some(fact.clone()),
                Violation::Breach(_) => None,
            })
            .collect();
        ProposedGrant::Acknowledge { facts }
    } else {
        ProposedGrant::Waive(delta.clone())
    }
}

/// The delta that would cover the grant-fixable gaps in `violations` —
/// acknowledge-only and structural members contribute nothing.
fn needed_delta(
    violations: &[Violation],
    recipients: &BTreeSet<crate::dimension::UserId>,
    requires: &Requirements,
) -> TransientWaiver {
    use crate::contract::Breach;
    let mut delta = TransientWaiver::empty();
    for violation in violations {
        match violation {
            Violation::Breach(Breach::TrustBelow { required, .. }) => {
                delta.trust = Some(*required);
            }
            Violation::Unprovable(Unprovable::TrustUnknown) => {
                delta.trust = requires.trust;
            }
            Violation::Breach(Breach::AudienceExceeds { outside }) => {
                delta
                    .audience
                    .get_or_insert_with(BTreeSet::new)
                    .extend(outside.iter().cloned());
            }
            Violation::Unprovable(Unprovable::AudienceUnknown) => {
                delta
                    .audience
                    .get_or_insert_with(BTreeSet::new)
                    .extend(recipients.iter().cloned());
            }
            Violation::Breach(Breach::ForbiddenPriorEffects { effects }) => {
                delta
                    .prior_effects
                    .get_or_insert_with(BTreeSet::new)
                    .extend(effects.iter().copied());
            }
            Violation::Breach(Breach::ConfirmationMissing { .. } | Breach::ConfirmationForOtherTool { .. }) => {
                delta.confirms = true;
            }
            Violation::Breach(Breach::UndeclaredRecipients)
            | Violation::Unprovable(Unprovable::EffectsUnknown | Unprovable::NoContract { .. }) => {}
        }
    }
    delta
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

    fn engine_with(contracts: impl IntoIterator<Item = ToolContract>) -> PolicyEngine {
        let mut engine = PolicyEngine::new();
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

    /// Test shorthand for the full dispatch boundary: release, then record.
    fn dispatch(trajectory: &mut Trajectory, token: ExecutionToken, body: &str) -> Result<ValueId, RejectedToken> {
        let (_, receipt) = trajectory.release(token)?;
        trajectory.record_output(receipt, OpaqueValue::new(body))
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
        let engine = engine_with([email_contract()]);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "the doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        assert!(trajectory.pending_action().is_some());

        let result = dispatch(&mut trajectory, token, "sent").unwrap();
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
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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
    fn unregistered_tool_blocks_without_an_acknowledge_authority() {
        let engine = engine_with([]);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
        let request = ToolRequest::new(
            ToolName::new("mystery.tool"),
            ArgumentTree::Value(body),
            BTreeSet::new(),
        );

        // No implicit accept: an unprovable flow with no competent authority
        // has no remedy and blocks terminally (fail-closed default).
        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::NoRemedy);
    }

    #[test]
    fn unregistered_tool_acknowledged_dispatches_with_unknown_output() {
        fn accept_unknowns(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            Some(crate::approval::Ruling::Approve {
                reason: "operator accepts unknowns".to_owned(),
            })
        }
        let mut engine = engine_with([]);
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("accept-unknowns"),
                mandate: crate::transition::AuthorityMandate {
                    acknowledge_unknown: true,
                    ..crate::transition::AuthorityMandate::none()
                },
                mode: crate::approval::AuthorityMode::Inline(accept_unknowns),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
        let request = ToolRequest::new(
            ToolName::new("mystery.tool"),
            ArgumentTree::Value(body),
            BTreeSet::new(),
        );

        // The unprovable flow routes through the chain: it blocks remediably,
        // and acknowledging it (an `acknowledge_unknown` authority) clears it.
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected a remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Permitted(token)) = engine.apply_step(&mut trajectory, capability).unwrap()
        else {
            panic!("expected the acknowledgment to permit");
        };
        assert!(trajectory.state().audit().iter().any(|e| matches!(
            e,
            AuditEvent::WaiverApplied { changes, .. } if changes.contains(&crate::audit::WaiverKind::Acknowledgment)
        )));

        let result = dispatch(&mut trajectory, token, "???").unwrap();
        // Intrinsic unknown poisons the output despite trusted inputs...
        assert_eq!(trajectory.value(result).unwrap().label(), &ValueLabel::unknown());
        // ...and unknown effects absorb the past.
        assert_eq!(trajectory.state().past_effects(), &Effects::UNKNOWN);
    }

    /// A grant-fixable unprovable (unknown trust at a Trusted-requiring sink)
    /// routes through the chain as a waiver, exactly like a breach.
    #[test]
    fn unknown_trust_routes_as_a_waiver() {
        let mut engine = engine_with([email_contract()]);
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        // Unknown trust cannot prove the sink's `Trusted` requirement.
        let doc = ingress(&mut trajectory, &["alice", "bob"], Trust::UNKNOWN, "doc");
        let request = email_request(&mut trajectory, doc, "bob");

        let Decision::Blocked(Blocked::Remediable { violations, plans }) = engine.evaluate(&mut trajectory, request)
        else {
            panic!("expected a remediable block");
        };
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, Violation::Unprovable(crate::contract::Unprovable::TrustUnknown)))
        );
        // The waiver step routes to the trust-competent external human.
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        assert!(matches!(
            engine.apply_step(&mut trajectory, capability).unwrap(),
            StepOutcome::NeedsApproval(_)
        ));
    }

    #[test]
    fn guarded_sink_without_recipients_is_structural() {
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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

        let err = dispatch(&mut trajectory, token, "sent").unwrap_err();
        assert!(matches!(err, RejectedToken::Stale { .. }));
    }

    #[test]
    fn foreign_trajectory_token_is_rejected() {
        let engine = engine_with([email_contract()]);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");
        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };

        let mut other = Trajectory::new();
        let err = dispatch(&mut other, token, "sent").unwrap_err();
        assert!(matches!(err, RejectedToken::ForeignTrajectory { .. }));
    }

    #[test]
    fn second_distinct_proposal_is_refused_until_abandoned() {
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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
        dispatch(&mut trajectory, second, "sent").unwrap();
        let err = dispatch(&mut trajectory, first, "again").unwrap_err();
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

        let engine = engine_with([email_contract(), report]);
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, body, "bob");

        let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected permit");
        };
        dispatch(&mut trajectory, token, "sent").unwrap();

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
        let mut engine = PolicyEngine::new();
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
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([drop_contract]);
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
        PolicyEngine::new().with_response_policy(ResponsePolicy {
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
        let engine = engine_with([]);
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
        // The response sink is strict emit-or-terminal (D1): an unprovable
        // response with no policy has no remedy.
        assert_eq!(block.reason, BlockReason::NoRemedy);
    }

    #[test]
    fn duplicate_reentry_token_cannot_release_twice() {
        let engine = engine_with([email_contract()]);
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
        let engine = engine_with([email_contract()]);
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
        let mut engine = PolicyEngine::new();
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

    fn redact_transformer() -> RegisteredTransformer {
        fn redact(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
            Ok(OpaqueValue::new("[redacted]"))
        }
        RegisteredTransformer {
            descriptor: crate::transition::TransformerDescriptor {
                transformer: crate::value::TransformerRef {
                    id: "pii.redact".into(),
                    version: 1,
                },
                precondition: crate::transition::LabelPredicate {
                    trust: Some(Trust::SUSPICIOUS),
                    audience: None,
                },
                output: ValueLabel::identity(),
            },
            run: redact,
        }
    }

    fn human() -> crate::approval::Authority {
        crate::approval::Authority {
            name: crate::audit::AuthorityName::new("human"),
            mandate: crate::transition::AuthorityMandate {
                trust: Some(crate::dimension::KnownTrust::Trusted),
                audience: Some(BTreeSet::from([user("alice"), user("bob"), user("charlie")])),
                acquire_effects: false,
                waive_prior_effects: true,
                confirms: true,
                acknowledge_unknown: true,
                may_release_control: true,
            },
            mode: crate::approval::AuthorityMode::External,
        }
    }

    /// A suspicious payload with a registered redactor yields a single-step
    /// transform plan predicting a clean flow.
    #[test]
    fn tainted_payload_plans_a_transform() {
        let mut engine = engine_with([email_contract()]);
        engine.register_transformer(redact_transformer()).unwrap();
        let mut trajectory = Trajectory::new();
        let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw page");
        let request = email_request(&mut trajectory, raw, "bob");

        let Decision::Blocked(Blocked::Remediable { violations, plans }) = engine.evaluate(&mut trajectory, request)
        else {
            panic!("expected remediable block");
        };
        assert!(matches!(
            violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::TrustBelow { .. })]
        ));
        let transform_plan = plans
            .iter()
            .find(|p| p.steps.len() == 1)
            .expect("single-step transform plan");
        assert!(matches!(
            &transform_plan.steps.first().kind,
            TransitionKind::TransformValue { source, .. } if *source == raw
        ));
        assert!(transform_plan.final_postcondition.is_clean());
        // Plans are stored on the trajectory, bound to its current revision,
        // and the pending action they target stays open.
        assert_eq!(trajectory.plans().len(), plans.len());
        assert_eq!(trajectory.plans()[0].basis, trajectory.revision());
        assert!(trajectory.pending_action().is_some());
    }

    /// An audience breach with a competent authority yields a waiver plan
    /// routed to it.
    #[test]
    fn audience_breach_plans_a_waiver() {
        let mut engine = engine_with([email_contract()]);
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        // Only alice may read the doc; sending to charlie exceeds it.
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private doc");
        let request = email_request(&mut trajectory, doc, "charlie");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let waiver = plans.first();
        assert_eq!(waiver.steps.len(), 1);
        assert!(matches!(
            &waiver.steps.first().kind,
            TransitionKind::ApplyWaiver {
                delta: crate::transition::TransientWaiver { audience: Some(vouched), .. },
            } if vouched.contains(&user("charlie"))
        ));
        // Routing is live at application: the waiver step is consulted against
        // the registered authorities and defers to the competent external one.
        let plan_id = waiver.id;
        let capability = engine.mint_step(&trajectory, plan_id, 0).unwrap();
        let StepOutcome::NeedsApproval(pending) = engine.apply_step(&mut trajectory, capability).unwrap() else {
            panic!("expected the external human to be consulted");
        };
        assert_eq!(pending.authority().as_str(), "human");
    }

    /// Control-borne taint prefers the narrower control-release waiver over
    /// attesting the data itself.
    #[test]
    fn control_taint_plans_control_release_first() {
        let mut engine = engine_with([email_contract()]);
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
        let clean = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "harmless");
        let to = trajectory.ingress(
            crate::turn::Speaker::user(user("alice")),
            ValueLabel::identity(),
            OpaqueValue::new("bob"),
        );
        let request = ToolRequest::new(
            ToolName::new("email.send"),
            ArgumentTree::Object(std::collections::BTreeMap::from([
                (ArgumentName::new("to"), ArgumentTree::Value(to)),
                (ArgumentName::new("body"), ArgumentTree::Value(clean)),
            ])),
            BTreeSet::from([secret]),
        );

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        assert!(matches!(
            &plans.first().steps.first().kind,
            TransitionKind::ApplyWaiver {
                delta: crate::transition::TransientWaiver {
                    control_release: true,
                    audience: None,
                    ..
                },
            }
        ));
    }

    /// A registered tool-identity mapping to a weaker-contract tool yields a
    /// constrain plan.
    #[test]
    fn constrain_plan_maps_to_narrower_tool() {
        let fetch = ToolContract {
            name: ToolName::new("web.fetch"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                ..Requirements::default()
            },
            output_label: ValueLabel {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
            },
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::opaque(),
        };
        let cached = ToolContract {
            name: ToolName::new("web.fetch.cached"),
            requires: Requirements::default(),
            output_label: ValueLabel {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
            },
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        };
        let mut engine = engine_with([fetch, cached]);
        engine
            .register_action_transition(ActionTransition {
                id: crate::value::TransformerRef {
                    id: "cache-only".into(),
                    version: 1,
                },
                from_tool: ToolName::new("web.fetch"),
                to_tool: ToolName::new("web.fetch.cached"),
                effects: Effects::none(),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let url = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "http://x");
        let request = ToolRequest::new(ToolName::new("web.fetch"), ArgumentTree::Value(url), BTreeSet::new());

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let constrain = plans
            .iter()
            .find(|p| matches!(&p.steps.first().kind, TransitionKind::ConstrainAction { .. }))
            .expect("constrain plan");
        assert!(constrain.final_postcondition.is_clean());
    }

    /// With no registered remedy that predicts a clean flow, the block stays
    /// terminal.
    #[test]
    fn no_applicable_remedy_is_terminal() {
        let engine = engine_with([email_contract()]);
        let mut trajectory = Trajectory::new();
        let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw");
        let request = email_request(&mut trajectory, raw, "bob");

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(block.reason, BlockReason::NoRemedy);
        assert!(trajectory.pending_action().is_none());
    }

    /// A transform plan applied end-to-end: the derived value takes the
    /// tainted slot, the flow permits, and the canonical rendering carries
    /// the redacted bytes.
    #[test]
    fn transform_step_applies_and_flow_permits() {
        let mut engine = engine_with([email_contract()]);
        engine.register_transformer(redact_transformer()).unwrap();
        let mut trajectory = Trajectory::new();
        let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw secrets");
        let request = email_request(&mut trajectory, raw, "bob");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let plan = plans
            .iter()
            .find(|p| p.steps.len() == 1 && matches!(&p.steps.first().kind, TransitionKind::TransformValue { .. }))
            .expect("transform plan");

        let capability = engine.mint_step(&trajectory, plan.id, 0).unwrap();
        let outcome = engine.apply_step(&mut trajectory, capability).unwrap();
        let StepOutcome::Advanced(Decision::Permitted(token)) = outcome else {
            panic!("expected the transform to advance to a permit, got {outcome:?}");
        };
        // The raw value keeps its label; the derived value took its slot.
        assert_eq!(trajectory.value(raw).unwrap().label().trust, Trust::SUSPICIOUS);
        assert!(matches!(
            trajectory.state().audit(),
            [AuditEvent::ValueTransition {
                outcome: crate::audit::TransitionOutcome::Applied,
                ..
            }]
        ));

        let (canonical, receipt) = trajectory.release(token).unwrap();
        assert!(canonical.rendered.contains("[redacted]"));
        assert!(!canonical.rendered.contains("raw secrets"));
        trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
    }

    /// A rule-approved waiver permits inline, with the application audited.
    #[test]
    fn rule_approved_waiver_permits_inline() {
        fn approve(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            Some(crate::approval::Ruling::Approve {
                reason: "within policy".to_owned(),
            })
        }
        let mut engine = engine_with([email_contract()]);
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("auto-approve"),
                mandate: human().mandate,
                mode: crate::approval::AuthorityMode::Inline(approve),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        assert!(matches!(
            &plans.first().steps.first().kind,
            TransitionKind::ApplyWaiver { .. }
        ));
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let outcome = engine.apply_step(&mut trajectory, capability).unwrap();
        let StepOutcome::Advanced(Decision::Permitted(_token)) = outcome else {
            panic!("expected inline waiver permit, got {outcome:?}");
        };
        assert!(
            trajectory
                .state()
                .audit()
                .iter()
                .any(|e| matches!(e, AuditEvent::WaiverApplied { .. }))
        );
    }

    /// An inline authority that abstains falls through to the next competent
    /// authority rather than denying the flow.
    #[test]
    fn inline_abstention_falls_through_to_the_next_authority() {
        fn abstain(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            None
        }
        fn approve(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            Some(crate::approval::Ruling::Approve {
                reason: "second".to_owned(),
            })
        }
        let mut engine = engine_with([email_contract()]);
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("first"),
                mandate: human().mandate,
                mode: crate::approval::AuthorityMode::Inline(abstain),
            })
            .unwrap();
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("second"),
                mandate: human().mandate,
                mode: crate::approval::AuthorityMode::Inline(approve),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Permitted(_)) = engine.apply_step(&mut trajectory, capability).unwrap()
        else {
            panic!("expected the second authority to approve after the first abstained");
        };
        // The applied waiver is attributed to the authority that actually ruled.
        assert!(trajectory.state().audit().iter().any(|e| matches!(
            e,
            AuditEvent::WaiverApplied { authority, .. } if authority.as_str() == "second"
        )));
    }

    /// Inline authorities are consulted before external ones, even when an
    /// external authority was registered first.
    #[test]
    fn inline_authority_is_consulted_before_external() {
        fn approve(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            Some(crate::approval::Ruling::Approve {
                reason: "inline".to_owned(),
            })
        }
        let mut engine = engine_with([email_contract()]);
        // External registered first; the inline authority must still win.
        engine.register_authority(human()).unwrap();
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("inline"),
                mandate: human().mandate,
                mode: crate::approval::AuthorityMode::Inline(approve),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        // Inline resolves synchronously — no round-trip to the external human.
        let StepOutcome::Advanced(Decision::Permitted(_)) = engine.apply_step(&mut trajectory, capability).unwrap()
        else {
            panic!("expected the inline authority to decide before the external one");
        };
    }

    /// When every competent authority is inline and all abstain, the flow
    /// fails closed with no ruling produced.
    #[test]
    fn all_inline_abstentions_block_with_no_ruling() {
        fn abstain(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            None
        }
        let mut engine = engine_with([email_contract()]);
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("only"),
                mandate: human().mandate,
                mode: crate::approval::AuthorityMode::Inline(abstain),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
            engine.apply_step(&mut trajectory, capability).unwrap()
        else {
            panic!("expected a terminal block when every authority abstains");
        };
        assert_eq!(block.reason, BlockReason::NoAuthorityRuled);
    }

    /// An external waiver round-trips through PendingApproval; approval
    /// permits, and the whole loop is audited.
    #[test]
    fn external_waiver_approval_roundtrip() {
        let mut engine = engine_with([email_contract()]);
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::NeedsApproval(pending) = engine.apply_step(&mut trajectory, capability).unwrap() else {
            panic!("expected pending approval");
        };
        assert_eq!(pending.authority().as_str(), "human");

        let decision = engine
            .apply_approval(
                &mut trajectory,
                pending,
                crate::approval::Ruling::Approve {
                    reason: "reviewed".to_owned(),
                },
            )
            .unwrap();
        assert!(matches!(decision, Decision::Permitted(_)));
        assert!(
            trajectory
                .state()
                .audit()
                .iter()
                .any(|e| matches!(e, AuditEvent::ApprovalRequested { .. }))
        );
        assert!(
            trajectory
                .state()
                .audit()
                .iter()
                .any(|e| matches!(e, AuditEvent::WaiverApplied { .. }))
        );
    }

    /// An inline authority reads the trajectory view (a value's label) and the
    /// violations to decide, and abstains when the view fails its check.
    #[test]
    fn inline_authority_inspects_the_view_and_violations() {
        // Auto-vouch an audience expansion only when the trajectory's first
        // ingress (the document under review) is itself trusted.
        fn vouch_trusted_source(
            grant: &crate::transition::ProposedGrant,
            violations: &[Violation],
            view: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            let audience_breach = violations
                .iter()
                .any(|v| matches!(v, Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })));
            let source_trusted = view
                .label(crate::revision::ValueId::new(0))
                .is_some_and(|label| label.trust == Trust::TRUSTED);
            if audience_breach && source_trusted && matches!(grant, crate::transition::ProposedGrant::Waive(_)) {
                Some(crate::approval::Ruling::Approve {
                    reason: "source document is trusted".to_owned(),
                })
            } else {
                None
            }
        }
        let mut engine = engine_with([email_contract()]);
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("vouch"),
                mandate: human().mandate,
                mode: crate::approval::AuthorityMode::Inline(vouch_trusted_source),
            })
            .unwrap();

        // Trusted source (value#0): the view read passes, the authority approves.
        let mut trusted = Trajectory::new();
        let doc = ingress(&mut trusted, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trusted, doc, "charlie");
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trusted, request) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trusted, plans.first().id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Permitted(_)) = engine.apply_step(&mut trusted, capability).unwrap() else {
            panic!("expected approval when the view shows a trusted source");
        };

        // Suspicious source: same audience breach, but the view read fails the
        // trust check, so the authority abstains and no ruling is produced.
        let mut suspicious = Trajectory::new();
        let doc = ingress(&mut suspicious, &["alice"], Trust::SUSPICIOUS, "private");
        let request = email_request(&mut suspicious, doc, "charlie");
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut suspicious, request) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&suspicious, plans.first().id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
            engine.apply_step(&mut suspicious, capability).unwrap()
        else {
            panic!("expected abstention when the view shows a suspicious source");
        };
        assert_eq!(block.reason, BlockReason::NoAuthorityRuled);
    }

    /// An external pending approval carries an owned ancestry snapshot — the
    /// labels and provenance of the values in scope — and the round-trip
    /// completes on approval.
    #[test]
    fn external_pending_carries_an_ancestry_snapshot() {
        let mut engine = engine_with([email_contract()]);
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::NeedsApproval(pending) = engine.apply_step(&mut trajectory, capability).unwrap() else {
            panic!("expected pending approval");
        };
        // The snapshot carries the doc's label and provenance, never its bytes.
        let doc_view = pending.ancestry().get(doc).expect("the doc is in the grant's scope");
        assert_eq!(doc_view.label.trust, Trust::TRUSTED);
        assert!(matches!(doc_view.provenance, crate::value::Provenance::Ingress { .. }));

        let decision = engine
            .apply_approval(
                &mut trajectory,
                pending,
                crate::approval::Ruling::Approve {
                    reason: "reviewed the ancestry".to_owned(),
                },
            )
            .unwrap();
        assert!(matches!(decision, Decision::Permitted(_)));
    }

    /// A denial blocks terminally and is audited; the identical later flow
    /// escalates afresh (nothing was stored loosened).
    #[test]
    fn external_waiver_denial_blocks_terminally() {
        let mut engine = engine_with([email_contract()]);
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request.clone())
        else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::NeedsApproval(pending) = engine.apply_step(&mut trajectory, capability).unwrap() else {
            panic!("expected pending approval");
        };
        let decision = engine
            .apply_approval(
                &mut trajectory,
                pending,
                crate::approval::Ruling::Deny {
                    reason: "not comfortable".to_owned(),
                },
            )
            .unwrap();
        let Decision::Blocked(Blocked::Terminal(block)) = decision else {
            panic!("expected terminal block");
        };
        assert!(matches!(block.reason, BlockReason::DeniedByAuthority { .. }));
        assert!(trajectory.pending_action().is_none());

        // The same flow escalates again from scratch: the denial loosened
        // and stored nothing.
        assert!(matches!(
            engine.evaluate(&mut trajectory, request),
            Decision::Blocked(Blocked::Remediable { .. })
        ));
    }

    /// Stale and foreign step capabilities and approvals are refused without
    /// touching state.
    #[test]
    fn stale_and_foreign_step_capabilities_are_refused() {
        let mut engine = engine_with([email_contract()]);
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let plan = plans.first().id;
        let capability = engine.mint_step(&trajectory, plan, 0).unwrap();

        // Any state change stales the capability (and the plan itself).
        trajectory
            .admit_model_output(OpaqueValue::new("thinking"), BTreeSet::from([doc]), BTreeSet::new())
            .unwrap();
        let revision_before = trajectory.revision();
        assert!(matches!(
            engine.apply_step(&mut trajectory, capability),
            Err(StepRefused::StalePlan { .. })
        ));
        assert!(matches!(
            engine.mint_step(&trajectory, plan, 0),
            Err(StepRefused::StalePlan { .. })
        ));
        // Refusal touched nothing.
        assert_eq!(trajectory.revision(), revision_before);

        // A stale approval is likewise refused.
        trajectory.abandon_pending();
        let retry = email_request(&mut trajectory, doc, "charlie");
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, retry) else {
            panic!("expected remediable block");
        };
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::NeedsApproval(pending) = engine.apply_step(&mut trajectory, capability).unwrap() else {
            panic!("expected pending approval");
        };
        trajectory
            .admit_model_output(OpaqueValue::new("more"), BTreeSet::from([doc]), BTreeSet::new())
            .unwrap();
        assert!(matches!(
            engine.apply_approval(
                &mut trajectory,
                pending,
                crate::approval::Ruling::Approve {
                    reason: "late".to_owned()
                }
            ),
            Err(StepRefused::StalePlan { .. })
        ));
    }

    /// A transformer error fails the step, audits the failure with no
    /// derived value, and advances the revision (staling siblings).
    #[test]
    fn transformer_error_fails_the_step_and_audits() {
        fn broken(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
            Err(crate::transition::TransformerError {
                message: "redactor crashed".to_owned(),
            })
        }
        let mut engine = engine_with([email_contract()]);
        let mut transformer = redact_transformer();
        transformer.run = broken;
        engine.register_transformer(transformer).unwrap();
        let mut trajectory = Trajectory::new();
        let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw");
        let request = email_request(&mut trajectory, raw, "bob");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let values_before = trajectory.store().len();
        let revision_before = trajectory.revision();
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let outcome = engine.apply_step(&mut trajectory, capability).unwrap();
        assert!(matches!(
            outcome,
            StepOutcome::Failed(crate::audit::TransitionFailure::TransformerError { .. })
        ));
        assert_eq!(trajectory.store().len(), values_before);
        assert!(trajectory.revision() > revision_before);
        assert!(matches!(
            trajectory.state().audit(),
            [AuditEvent::ValueTransition {
                derived: None,
                outcome: crate::audit::TransitionOutcome::Failed(_),
                ..
            }]
        ));
    }

    /// The design's canonical composition across re-planning rounds:
    /// Transform -> (replan) -> Waiver -> recheck -> Permit.
    #[test]
    fn multi_step_composition_transform_then_waiver() {
        // This redactor establishes trust but cannot widen the audience:
        // its output stays readable by alice only.
        fn redact(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
            Ok(OpaqueValue::new("[redacted]"))
        }
        let mut engine = engine_with([email_contract()]);
        engine
            .register_transformer(RegisteredTransformer {
                descriptor: crate::transition::TransformerDescriptor {
                    transformer: crate::value::TransformerRef {
                        id: "pii.redact.private".into(),
                        version: 1,
                    },
                    precondition: crate::transition::LabelPredicate {
                        trust: Some(Trust::SUSPICIOUS),
                        audience: None,
                    },
                    output: ValueLabel {
                        audience: Audience::readers([user("alice")]),
                        trust: Trust::TRUSTED,
                    },
                },
                run: redact,
            })
            .unwrap();
        engine.register_authority(human()).unwrap();
        let mut trajectory = Trajectory::new();
        // Suspicious AND readable only by alice, sent to charlie: needs both
        // a transform (trust) and a waiver (audience).
        let raw = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "raw");
        let request = email_request(&mut trajectory, raw, "charlie");

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        // A two-step plan predicting the full route exists...
        assert!(plans.iter().any(|p| p.steps.len() == 2));
        // ...and application goes step by step, re-planning in between.
        let transform_plan = plans
            .iter()
            .find(|p| matches!(&p.steps.first().kind, TransitionKind::TransformValue { .. }))
            .expect("plan starting with a transform");
        let capability = engine.mint_step(&trajectory, transform_plan.id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Blocked(Blocked::Remediable { plans, violations })) =
            engine.apply_step(&mut trajectory, capability).unwrap()
        else {
            panic!("expected the transform to advance to a re-planned block");
        };
        // Only the audience breach remains.
        assert!(matches!(
            violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })]
        ));
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::NeedsApproval(pending) = engine.apply_step(&mut trajectory, capability).unwrap() else {
            panic!("expected pending approval");
        };
        let decision = engine
            .apply_approval(
                &mut trajectory,
                pending,
                crate::approval::Ruling::Approve {
                    reason: "redacted version may go out".to_owned(),
                },
            )
            .unwrap();
        let Decision::Permitted(token) = decision else {
            panic!("expected permit after the full composition");
        };
        let (canonical, receipt) = trajectory.release(token).unwrap();
        assert!(canonical.rendered.contains("[redacted]"));
        trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
    }

    /// A confirmation survives remedy steps on the confirmed action and is
    /// spent only at release (decision 12).
    #[test]
    fn confirmation_survives_remedy_steps() {
        let drop_contract = ToolContract {
            name: ToolName::new("db.drop"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                attention: crate::contract::AttentionRule::ExplicitConfirmation,
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Mutation]),
            arguments: ArgumentSchema::opaque(),
        };
        let mut engine = engine_with([drop_contract]);
        engine.register_transformer(redact_transformer()).unwrap();
        let mut trajectory = Trajectory::new();
        let table = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "users_table");
        trajectory.ingress(
            crate::turn::Speaker::confirming(user("alice"), ToolName::new("db.drop")),
            ValueLabel::identity(),
            OpaqueValue::new("yes, drop it"),
        );
        let request = ToolRequest::new(ToolName::new("db.drop"), ArgumentTree::Value(table), BTreeSet::new());

        // Blocked on trust only — the confirmation holds.
        let Decision::Blocked(Blocked::Remediable { violations, plans }) = engine.evaluate(&mut trajectory, request)
        else {
            panic!("expected remediable block");
        };
        assert!(matches!(
            violations.as_slice(),
            [Violation::Breach(crate::contract::Breach::TrustBelow { .. })]
        ));
        let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Permitted(token)) = engine.apply_step(&mut trajectory, capability).unwrap()
        else {
            panic!("expected permit — the confirmation must survive the transform");
        };
        assert!(trajectory.pending_confirmation().is_some());
        let (_, receipt) = trajectory.release(token).unwrap();
        // Release spends it.
        assert_eq!(trajectory.pending_confirmation(), None);
        trajectory.record_output(receipt, OpaqueValue::new("dropped")).unwrap();
    }

    #[test]
    fn authorities_share_one_name_space() {
        fn approve(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            Some(crate::approval::Ruling::Approve {
                reason: "ok".to_owned(),
            })
        }
        let gate = |mode| crate::approval::Authority {
            name: crate::audit::AuthorityName::new("gate"),
            mandate: crate::transition::AuthorityMandate::none(),
            mode,
        };
        let mut engine = PolicyEngine::new();
        engine
            .register_authority(gate(crate::approval::AuthorityMode::Inline(approve)))
            .unwrap();
        // The same name is refused regardless of mode.
        assert!(
            engine
                .register_authority(gate(crate::approval::AuthorityMode::Inline(approve)))
                .is_err()
        );
        assert!(
            engine
                .register_authority(gate(crate::approval::AuthorityMode::External))
                .is_err()
        );
    }

    /// A capability minted under one engine's registries never resolves
    /// against another's — even one configured identically.
    #[test]
    fn capabilities_are_bound_to_their_engine() {
        let mut engine_a = engine_with([email_contract()]);
        engine_a.register_authority(human()).unwrap();
        // Engine B registers the same names — a different trust domain.
        let mut engine_b = engine_with([email_contract()]);
        engine_b.register_authority(human()).unwrap();

        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
        let request = email_request(&mut trajectory, doc, "charlie");
        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine_a.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };

        // B can neither mint nor apply against A's stored plan.
        assert!(matches!(
            engine_b.mint_step(&trajectory, plans.first().id, 0),
            Err(StepRefused::ForeignEngine { .. })
        ));
        let capability = engine_a.mint_step(&trajectory, plans.first().id, 0).unwrap();
        assert!(matches!(
            engine_b.apply_step(&mut trajectory, capability),
            Err(StepRefused::ForeignEngine { .. })
        ));

        // Nor can B consume A's pending approval.
        let capability = engine_a.mint_step(&trajectory, plans.first().id, 0).unwrap();
        let StepOutcome::NeedsApproval(pending) = engine_a.apply_step(&mut trajectory, capability).unwrap() else {
            panic!("expected pending approval");
        };
        assert!(matches!(
            engine_b.apply_approval(
                &mut trajectory,
                pending,
                crate::approval::Ruling::Approve {
                    reason: "cross-domain".to_owned()
                }
            ),
            Err(StepRefused::ForeignEngine { .. })
        ));
    }

    /// An action transition whose declared effects disagree with the target
    /// contract is never planned: the narrowing baton validates must be what
    /// the target actually does.
    #[test]
    fn constrain_with_mismatched_target_effects_is_not_planned() {
        let fetch = ToolContract {
            name: ToolName::new("web.fetch"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::opaque(),
        };
        // The target contract says it mutates; the transition claims no
        // effects. The narrowing claim and reality disagree.
        let cached = ToolContract {
            name: ToolName::new("web.fetch.cached"),
            requires: Requirements::default(),
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Mutation]),
            arguments: ArgumentSchema::opaque(),
        };
        let mut engine = engine_with([fetch, cached]);
        engine
            .register_action_transition(ActionTransition {
                id: crate::value::TransformerRef {
                    id: "cache-only".into(),
                    version: 1,
                },
                from_tool: ToolName::new("web.fetch"),
                to_tool: ToolName::new("web.fetch.cached"),
                effects: Effects::none(),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let url = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "http://x");
        let request = ToolRequest::new(ToolName::new("web.fetch"), ArgumentTree::Value(url), BTreeSet::new());

        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block — the inconsistent mapping must not be planned");
        };
        assert_eq!(block.reason, BlockReason::NoRemedy);
    }

    /// A constrained action's narrowed effects are what release commits, and
    /// a later effect-sensitive sink sees exactly them.
    #[test]
    fn constrained_effects_survive_to_release_and_later_sinks() {
        let fetch = ToolContract {
            name: ToolName::new("web.fetch"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::opaque(),
        };
        let cached = ToolContract {
            name: ToolName::new("web.fetch.cached"),
            requires: Requirements::default(),
            output_label: ValueLabel::identity(),
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        };
        let report = ToolContract {
            name: ToolName::new("report.generate"),
            requires: Requirements {
                forbid_prior_effects: BTreeSet::from([Effect::Egress]),
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        };
        let mut engine = engine_with([fetch, cached, report]);
        engine
            .register_action_transition(ActionTransition {
                id: crate::value::TransformerRef {
                    id: "cache-only".into(),
                    version: 1,
                },
                from_tool: ToolName::new("web.fetch"),
                to_tool: ToolName::new("web.fetch.cached"),
                effects: Effects::none(),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let url = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "http://x");
        let request = ToolRequest::new(ToolName::new("web.fetch"), ArgumentTree::Value(url), BTreeSet::new());

        let Decision::Blocked(Blocked::Remediable { plans, .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected remediable block");
        };
        let constrain = plans
            .iter()
            .find(|p| matches!(&p.steps.first().kind, TransitionKind::ConstrainAction { .. }))
            .expect("constrain plan");
        let capability = engine.mint_step(&trajectory, constrain.id, 0).unwrap();
        let StepOutcome::Advanced(Decision::Permitted(token)) = engine.apply_step(&mut trajectory, capability).unwrap()
        else {
            panic!("expected the constraint to clear the flow");
        };
        let (canonical, receipt) = trajectory.release(token).unwrap();
        assert_eq!(canonical.tool, ToolName::new("web.fetch.cached"));
        // The narrowed (empty) effects were committed, not the original
        // tool's egress.
        assert_eq!(trajectory.state().past_effects(), &Effects::none());
        trajectory
            .record_output(receipt, OpaqueValue::new("cached page"))
            .unwrap();

        // An egress-forbidding sink is satisfied: no egress ever happened.
        let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "notes");
        let report_request = ToolRequest::new(
            ToolName::new("report.generate"),
            ArgumentTree::Value(doc),
            BTreeSet::new(),
        );
        assert!(matches!(
            engine.evaluate(&mut trajectory, report_request),
            Decision::Permitted(_)
        ));
    }

    /// After release, a dispatch is in flight: re-evaluating the same request
    /// must NOT re-permit the action, and a second release is refused. This
    /// closes the double-dispatch hole (release advances the revision, so a
    /// naive re-entry would mint a fresh valid token).
    #[test]
    fn released_action_cannot_be_re_permitted_or_re_released() {
        let engine = engine_with([email_contract()]);
        let mut trajectory = Trajectory::new();
        let doc = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
        let request = email_request(&mut trajectory, doc, "bob");

        let Decision::Permitted(token1) = engine.evaluate(&mut trajectory, request.clone()) else {
            panic!("expected permit");
        };
        let (_, receipt) = trajectory.release(token1).unwrap();

        // Re-entry while the dispatch is in flight is refused, not re-permitted.
        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected the released action to block re-entry");
        };
        assert!(matches!(block.reason, BlockReason::ActionAlreadyPending { .. }));

        // The outstanding receipt still closes the action normally.
        trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
        assert!(trajectory.pending_action().is_none());
    }

    /// Re-evaluating an unprovable flow is idempotent: acknowledgment happens
    /// at application (once, on a consumed capability), so evaluation — first
    /// or re-entrant — writes no acknowledgment audit.
    #[test]
    fn unprovable_re_entry_writes_no_audit() {
        fn accept_unknowns(
            _: &crate::transition::ProposedGrant,
            _: &[Violation],
            _: &crate::approval::TrajectoryView,
        ) -> Option<crate::approval::Ruling> {
            Some(crate::approval::Ruling::Approve {
                reason: "operator accepts unknowns".to_owned(),
            })
        }
        let mut engine = engine_with([]);
        engine
            .register_authority(crate::approval::Authority {
                name: crate::audit::AuthorityName::new("accept-unknowns"),
                mandate: crate::transition::AuthorityMandate {
                    acknowledge_unknown: true,
                    ..crate::transition::AuthorityMandate::none()
                },
                mode: crate::approval::AuthorityMode::Inline(accept_unknowns),
            })
            .unwrap();
        let mut trajectory = Trajectory::new();
        let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
        let request = ToolRequest::new(
            ToolName::new("mystery.tool"),
            ArgumentTree::Value(body),
            BTreeSet::new(),
        );

        let waiver_audits = |trajectory: &Trajectory| {
            trajectory
                .state()
                .audit()
                .iter()
                .filter(|e| matches!(e, AuditEvent::WaiverApplied { .. }))
                .count()
        };

        let Decision::Blocked(Blocked::Remediable { .. }) = engine.evaluate(&mut trajectory, request.clone()) else {
            panic!("expected a remediable block");
        };
        assert_eq!(waiver_audits(&trajectory), 0);
        // Re-evaluate the same original request: still remediable, still no audit.
        let Decision::Blocked(Blocked::Remediable { .. }) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected a remediable block on re-entry");
        };
        assert_eq!(waiver_audits(&trajectory), 0);
    }
}
