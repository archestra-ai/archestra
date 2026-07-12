//! # baton-core
//!
//! A prototype information-flow policy engine for LLM agent trajectories, in
//! the language-based IFC tradition (Sabelfeld/Myers): instead of asking "did
//! this prompt pass a filter?", ask "can this value, derived from these
//! sources, legally flow into this sink?".
//!
//! The moving parts:
//!
//! - A [`turn::Trajectory`] owns an immutable, append-only store of labeled
//!   [`value::StoredValue`]s with full [`value::Provenance`]. Admission is
//!   engine-owned: ingress is the only caller-labeled path (the explicit
//!   trust boundary); every other value's label is computed inside the crate
//!   as the conservative fold of its mandatory dependency sets.
//! - A [`request::ToolRequest`] carries the executable
//!   [`request::ArgumentTree`] — recipients, paths, and payloads are values
//!   in this tree, and the canonical rendering handed out for dispatch comes
//!   from the exact tree the engine checked — plus the *control*
//!   dependencies of whatever selected the invocation. Requirements are
//!   checked against `L_flow = combine(L_args, L_control)`
//!   ([`contract::Requirements::check_flow`]), so a sanitized payload cannot
//!   launder a secret-dependent tool or recipient choice.
//! - Effects are monotone trajectory state
//!   ([`audit::TrajectoryState::past_effects`]), committed when dispatch
//!   begins (a may-effect record: a later failure removes nothing). Audit is
//!   control-plane history ([`audit::AuditEvent`]), not a label field.
//! - Every mutation advances the trajectory's [`revision::Revision`];
//!   capabilities (the [`engine::ExecutionToken`]) are linear, bound to
//!   trajectory + revision + pending action, and spent on use.
//! - `Unknown` is a first-class value of audience, trust, and effects, and an
//!   unregistered tool is evaluable (all-`Unknown` output, `Unknown`
//!   effects). What `Unknown` means at a sink is an explicit policy choice
//!   ([`engine::UnknownPolicy`]) — gradual typing for agent stacks.
//!
//! One deliberate deviation from the original notes: the audience fold is
//! **intersection** (most-restrictive readers), not union — see
//! [`dimension::Audience`] for why union would make the sink check vacuous.

pub mod approval;
pub mod audit;
pub mod contract;
pub mod dimension;
pub mod engine;
pub mod plan;
pub mod preset;
pub mod request;
pub mod revision;
pub mod transition;
pub mod turn;
pub mod value;

#[cfg(test)]
mod test_strategies;

use std::fmt;

use serde::{Deserialize, Serialize};

/// Identifier of a tool exposed to the agent.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ToolName(String);

impl ToolName {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

pub use approval::{PendingApproval, PolicyRule, PolicyRuleFn, Ruling};
pub use audit::{AdjudicatorName, AuditEvent, TrajectoryState, TransitionFailure, TransitionOutcome, WaiverKind};
pub use contract::{AttentionRule, AudienceRule, Breach, Requirements, Unprovable, Verdict, Violation};
pub use dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
pub use engine::{
    BlockReason, Blocked, CanonicalRequest, Decision, DispatchReceipt, DuplicateContract, ExecutionToken, PolicyEngine,
    RESPONSE_SINK, RejectedToken, ResponseDecision, ResponsePolicy, StepCapability, StepOutcome, StepRefused,
    TerminalBlock, ToolContract, UnknownPolicy,
};
pub use plan::{NonEmptyVec, Posture, RemedyPlan, TransitionKind, TransitionSpec, WaiverAuthority};
pub use request::{
    ActionState, ArgumentName, ArgumentSchema, ArgumentTree, FlowLabels, PendingAction, ResponseRequest, ToolRequest,
    render,
};
pub use revision::{ActionId, PlanId, Revision, TransitionId, TurnId, ValueId};
pub use transition::{
    ActionTransition, Adjudicator, DuplicateRegistration, LabelPredicate, RegisteredTransformer, TransformerDescriptor,
    TransformerError, TransformerFn, WaiverDelta,
};
pub use turn::{Actor, Speaker, Trajectory, TrajectoryId, Turn, UserTurn};
pub use value::{OpaqueValue, Provenance, StoredValue, TransformerRef, UnknownValue, ValueLabel, ValueStore};
