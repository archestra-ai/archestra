use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

use crate::ToolName;
use crate::approval::PendingApproval;
use crate::audit::AuthorityName;
use crate::contract::{AudienceRule, Requirements, Violation};
use crate::dimension::{Effect, Effects};
use crate::plan::{NonEmptyVec, RemedyPlan};
use crate::request::{ArgumentName, ArgumentSchema};
use crate::revision::{ActionId, PlanId, Revision, ValueId};
use crate::turn::TrajectoryId;
use crate::value::ValueLabel;

use super::EngineId;

/// The reserved sink name the final assistant response is checked under.
pub(crate) const RESPONSE_SINK: &str = "assistant.response";

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
    /// What the trajectory must satisfy before this tool runs. `None` means
    /// the requirements were never stated — every call escalates as
    /// [`crate::contract::Unprovable::RequirementsUnknown`], fail closed;
    /// `Some(Requirements::default())` means considered, nothing required.
    pub requires: Option<Requirements>,
    pub output_label: ValueLabel,
    /// Effects one dispatch of this tool proposes; committed to the monotone
    /// past when dispatch begins.
    pub effects: Effects,
    pub arguments: ArgumentSchema,
}

impl ToolContract {
    /// A pure read: no requirements, no effects, opaque arguments. A
    /// dependency-free call's output wears exactly `output_label`; argument
    /// and control dependencies fold in and can only worsen it.
    pub fn source(name: impl Into<String>, output_label: ValueLabel) -> Self {
        Self {
            name: ToolName::new(name),
            requires: Some(Requirements::default()),
            output_label,
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        }
    }

    /// An egress sink: recipients are read from the top-level argument
    /// `recipients_arg` and must lie within the flow's audience; one dispatch
    /// proposes an `Egress` effect. The output wears the identity label.
    pub fn egress_sink(name: impl Into<String>, recipients_arg: impl Into<String>) -> Self {
        Self {
            name: ToolName::new(name),
            requires: Some(Requirements {
                audience: AudienceRule::FromRecipients,
                ..Requirements::default()
            }),
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::with_recipients(ArgumentName::new(recipients_arg)),
        }
    }
}

/// Proof that the engine authorized one tool call — the only way to append a
/// tool result to a [`Trajectory`](crate::turn::Trajectory). Bound to the trajectory, its exact
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
    pub(super) action: ActionId,
    pub(super) tool: ToolName,
    pub(super) intrinsic: ValueLabel,
    pub(super) arguments: BTreeSet<ValueId>,
    pub(super) control: BTreeSet<ValueId>,
    pub(super) proposed_effects: Effects,
    pub(super) trajectory: TrajectoryId,
    pub(super) revision: Revision,
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
/// the trajectory and to the action's `Released` phase, deliberately *not* to
/// the revision: a receipt closes an external dispatch that already happened,
/// and refusing it cannot undo that dispatch, so an unrelated later mutation
/// (a checked emission, a new value) must never wedge the action open.
/// Tokens, step capabilities, and approvals authorize *future* state changes
/// and stay revision-bound; the receipt records a past one. Linearity
/// (non-`Clone`, consumed on use) plus the `Released`-phase check keep one
/// receipt closing one action exactly once.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct DispatchReceipt {
    action: ActionId,
    tool: ToolName,
    intrinsic: ValueLabel,
    arguments: BTreeSet<ValueId>,
    control: BTreeSet<ValueId>,
    trajectory: TrajectoryId,
}

/// The consumed contents of a [`DispatchReceipt`].
pub(crate) struct ReceiptParts {
    pub(crate) action: ActionId,
    pub(crate) tool: ToolName,
    pub(crate) intrinsic: ValueLabel,
    pub(crate) arguments: BTreeSet<ValueId>,
    pub(crate) control: BTreeSet<ValueId>,
    pub(crate) trajectory: TrajectoryId,
}

impl DispatchReceipt {
    pub fn action(&self) -> ActionId {
        self.action
    }

    pub(crate) fn from_token_parts(parts: TokenParts) -> Self {
        Self {
            action: parts.action,
            tool: parts.tool,
            intrinsic: parts.intrinsic,
            arguments: parts.arguments,
            control: parts.control,
            trajectory: parts.trajectory,
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
/// its exact revision, the checked flow, and the exact plan and step; minted
/// by [`PolicyEngine::mint_step`](crate::engine::PolicyEngine::mint_step) and consumed — success or failure — by
/// [`PolicyEngine::apply_step`](crate::engine::PolicyEngine::apply_step).
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct StepCapability {
    pub(super) plan: PlanId,
    pub(super) step: usize,
    pub(super) flow: crate::revision::FlowId,
    pub(super) trajectory: TrajectoryId,
    pub(super) revision: Revision,
    pub(super) engine: EngineId,
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
    /// Only a plan's head step is executable; the remainder is predictive
    /// and is re-planned by the recheck after each applied remedy.
    #[error("only the plan's head step is executable; step {step} is predictive")]
    NotNextStep { step: usize },
    #[error("capability was minted for {minted_for}, not {this}")]
    ForeignTrajectory {
        minted_for: TrajectoryId,
        this: TrajectoryId,
    },
    #[error("capability was minted under {minted_by}, not {this}")]
    ForeignEngine { minted_by: EngineId, this: EngineId },
    #[error("action {action} is not pending on this trajectory")]
    ActionNotPending { action: ActionId },
    #[error("flow {flow} has no pending proposal on this trajectory")]
    FlowNotPending { flow: crate::revision::FlowId },
}

/// The outcome of applying one plan step: a continuation within the
/// remediable flow, never a new policy outcome kind.
#[derive(Debug, Serialize)]
#[must_use = "a dropped StepOutcome loses the flow's continuation"]
pub enum StepOutcome {
    /// The step applied; the original flow was re-evaluated against the new
    /// state (allowing, re-planning, or blocking terminally).
    Advanced(FlowOutcome<FlowPermit>),
    /// The step names an external authority: its ruling re-enters through
    /// [`PolicyEngine::apply_approval`](crate::engine::PolicyEngine::apply_approval).
    NeedsApproval(PendingApproval),
    /// The step's reduction relation no longer held or its transformer
    /// failed. The failure is audited, the revision advanced (staling every
    /// sibling capability and plan), and no value or action was changed
    /// beyond the audit record. Re-evaluate to replan.
    Failed(crate::audit::TransitionFailure),
}

/// [`PolicyEngine::register`](crate::engine::PolicyEngine::register) refused a contract: a contract for that tool is
/// already registered. Contracts are the policy boundary, so a silent replace
/// could weaken policy unnoticed — registration fails loudly instead.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("a contract for `{tool}` is already registered")]
pub struct DuplicateContract {
    pub tool: ToolName,
}

/// Why a flow is terminally blocked: a *policy* outcome — the flow was
/// well-formed and the policy proved (or an authority ruled) it cannot
/// proceed. Protocol/state defects are [`FlowRefusal`]s, never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum BlockReason {
    /// A structural violation (an integration bug the caller must fix) was
    /// present; nothing may override it.
    RequiresStructuralFix,
    /// The flow escalated and no remedy machinery exists for it (yet).
    NoRemedy,
    /// An authority denied the authorization this flow needed.
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

/// An invalid, stale, foreign, or conflicting proposal, refused before any
/// policy judgment — outside the tri-state, touching no state (no revision
/// advance, no event, no cleared slot). Distinct from a [`BlockReason`]:
/// a refusal says "this request does not describe the trajectory's current
/// state", not "policy forbids this flow".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
pub enum FlowRefusal {
    /// A different action is already pending on this trajectory (or this one
    /// has a dispatch in flight); it must be recorded or abandoned before a
    /// new proposal.
    #[error("{pending} is already pending on this trajectory")]
    ActionAlreadyPending { pending: ActionId },
    /// A different emission is already pending on this trajectory.
    #[error("emission {flow} is already pending on this trajectory")]
    EmissionAlreadyPending { flow: crate::revision::FlowId },
    /// The request referenced a value this trajectory never admitted — a
    /// caller bug, failed closed and loudly.
    #[error("request references {value}, which this trajectory never admitted")]
    UnknownValueReferenced { value: ValueId },
    /// The proposal was composed against a revision the trajectory has moved
    /// past; recompose against the real state.
    #[error("proposal composed at {composed_at}, but the trajectory is now at {current}")]
    StaleBasis { composed_at: Revision, current: Revision },
}

/// The one policy outcome of checking a well-formed flow proposal against
/// the current state, for every emission sink alike (a tool dispatch or an
/// assistant emission — `P` is the sink's permit payload).
#[derive(Debug, PartialEq, Eq, Serialize)]
#[must_use = "a dropped FlowOutcome loses the permit or the flow's continuation"]
pub enum FlowOutcome<P> {
    /// The checked flow satisfies policy now.
    AllowedNow(P),
    /// Blocked, with at least one predicted remedy plan that can unlock it.
    /// A plan is a prediction, never a permit.
    Remediable {
        violations: Vec<Violation>,
        plans: NonEmptyVec<RemedyPlan>,
    },
    /// Blocked, and no available remedy can unlock it under the current
    /// policy and registered capabilities.
    Terminal {
        violations: Vec<Violation>,
        reason: BlockReason,
    },
}

impl<P> FlowOutcome<P> {
    /// Map the permit payload, preserving the policy outcome.
    pub(crate) fn map_allowed<Q>(self, f: impl FnOnce(P) -> Q) -> FlowOutcome<Q> {
        match self {
            Self::AllowedNow(permit) => FlowOutcome::AllowedNow(f(permit)),
            Self::Remediable { violations, plans } => FlowOutcome::Remediable { violations, plans },
            Self::Terminal { violations, reason } => FlowOutcome::Terminal { violations, reason },
        }
    }
}

/// An emitted assistant response: the harness sends `rendered` — bytes
/// produced from the exact checked tree — and nothing else; there is no
/// separate raw model string that may be returned after the check.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[must_use = "a dropped Emitted loses the only bytes the check permitted"]
pub struct Emitted {
    pub value: ValueId,
    pub rendered: String,
}

/// The permit payload of a flow whose sink kind is dynamic (plan application
/// and approval re-entry work over stored plans, which may target a tool
/// action or a pending emission).
#[derive(Debug, PartialEq, Eq, Serialize)]
#[must_use = "a dropped FlowPermit means the flow was authorized but never carried out"]
pub enum FlowPermit {
    /// A tool flow: release the token to dispatch.
    Execute(ExecutionToken),
    /// An emission flow: the checked response was emitted atomically.
    Emit(Emitted),
}

/// Policy for the reserved assistant-response sink: what an emission flow
/// must satisfy, and who reads the conversation (the sink's recipients).
/// Registration routes emissions through the same shared evaluation
/// pipeline as every tool sink.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResponsePolicy {
    pub requires: Requirements,
    pub readers: BTreeSet<crate::dimension::UserId>,
}
