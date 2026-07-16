//! # baton-core
//!
//! A prototype information-flow policy engine for LLM agent trajectories, in
//! the language-based IFC tradition (Sabelfeld/Myers): instead of asking "did
//! this prompt pass a filter?", ask "can this value, derived from these
//! sources, legally flow into this sink?".
//!
//! The moving parts:
//!
//! - A [`turn::Trajectory`] is an append-only [`event::EventSet`] of scoped
//!   facts. Everything else is a [`projection`] of it — value labels and
//!   [`value::Provenance`], effects, action/emission lifecycle, grants,
//!   turns, and audit are all facts or derived from them, with the store
//!   holding nothing but the opaque bodies. One public mutation = prevalidation, then one
//!   atomic event batch. Admission is engine-owned: ingress is the only
//!   caller-labeled path (the explicit trust boundary); every other value's
//!   label is computed inside the crate as the conservative fold of its
//!   mandatory dependency sets — a declared-wider output label is absorbed by
//!   the fold, and each dimension's widening relation guards that no-widening
//!   invariant.
//! - A [`request::ToolRequest`] carries the executable
//!   [`request::ArgumentTree`] — recipients, paths, and payloads are values
//!   in this tree, and the canonical rendering handed out for dispatch comes
//!   from the exact tree the engine checked — plus the *control*
//!   dependencies of whatever selected the invocation. Requirements are
//!   checked against `L_flow = combine(L_args, L_control)` (the sink check
//!   behind [`contract::Requirements`]), so a sanitized payload cannot
//!   launder a secret-dependent tool or recipient choice. An assistant
//!   emission ([`request::EmissionRequest`]) is a flow to the reserved
//!   response sink through the same pipeline — core never infers that a turn
//!   is "final", and caller-labeled assistant ingress does not typecheck.
//! - Every checked flow settles in one tri-state [`engine::FlowOutcome`]:
//!   allowed now (a linear permit), remediable (the irreducible nondominated
//!   frontier of predicted [`plan::RemedyPlan`]s — `Reduce` via registered
//!   transformers/transitions, `Authorize` as an exact typed delta at an
//!   exact scope), or terminal — a proven no-remedy claim (the search is
//!   uncapped). Stale, foreign, or conflicting proposals are
//!   [`engine::FlowRefusal`]s outside the tri-state and touch nothing.
//! - Effects commit when dispatch begins (release appends the may-effect
//!   commitment; a later failure appends and removes nothing). Audit is
//!   control-plane history ([`audit::AuditEvent`], a derived read model),
//!   not a label field.
//! - [`revision::Revision`] digests the event frontier; every appended batch
//!   advances it. Capabilities (the [`engine::ExecutionToken`], receipts,
//!   step capabilities, approvals) are linear, bound to trajectory + basis
//!   (+ flow/plan/step), and spent on use; one-off grants are issued and
//!   consumed as facts, so a spent grant is unavailable by projection.
//! - `Unknown` is a first-class value of audience, trust, and effects, and an
//!   unregistered tool is evaluable (all-`Unknown` output, `Unknown`
//!   effects). An unprovable flow is not accepted implicitly: it routes
//!   through the authority chain like a breach, and an acknowledge-only gap
//!   needs an `acknowledge_unknown`-competent [`approval::Authority`] to clear
//!   — gradual typing for agent stacks, fail-closed by default.
//!
//! One deliberate deviation from the original notes: the audience fold is
//! **intersection** (most-restrictive readers), not union — see
//! [`dimension::Audience`] for why union would make the sink check vacuous.

pub mod approval;
pub mod audit;
pub mod contract;
pub mod dimension;
pub mod engine;
// The append-only event substrate (the authoritative trajectory state) and
// its derived projections. Public as modules but deliberately not
// re-exported at the root: consumers read trajectory state through the
// `Trajectory` accessors; the raw log is an audit/inspection surface.
pub mod event;
pub mod plan;
pub mod projection;
// Technically public (reusable label algebras) but never re-exported at the
// root: a consumer composes the built-in dimensions, not the raw presets.
pub mod preset;
pub mod remedy;
pub mod request;
pub mod revision;
pub mod transition;
pub mod turn;
pub mod value;

#[cfg(test)]
mod test_strategies;

use std::fmt;

use serde::Serialize;

/// Identifier of a tool exposed to the agent.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
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

// The crate root re-exports two tiers of the public surface. Everything else
// stays reachable through its own module (`baton_core::audit::AuditEvent`, …)
// but is deliberately not hoisted here: those types are read off returned
// values, never constructed by a consumer, so they don't belong in the API
// namespace a caller builds against.

// ── Core ────────────────────────────────────────────────────────────────
// The vocabulary you cannot use baton without: build an engine, run a
// trajectory, evaluate a flow, dispatch it, or handle a block.
pub use contract::{Requirements, Violation};
pub use dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
pub use engine::{
    CanonicalRequest, DispatchReceipt, DuplicateContract, Emitted, ExecutionToken, FlowOutcome, FlowPermit,
    FlowRefusal, PolicyEngine, Pursuit, RejectedToken, StallCause, ToolContract,
};
pub use request::{ArgumentName, ArgumentSchema, ArgumentTree, EmissionRequest, ToolRequest};
pub use revision::{Revision, ValueId};
pub use turn::{DispatchInFlight, Speaker, Trajectory};
pub use value::{OpaqueValue, UnknownValue, ValueLabel};

// ── Feature ─────────────────────────────────────────────────────────────
// Named only when you opt into the corresponding capability: the response
// sink, remediation, transformers, action constraints, or waivers.
pub use approval::{
    AncestrySnapshot, Authority, AuthorityFn, AuthorityMode, PendingApproval, Ruling, TrajectoryView, ValueView,
};
pub use audit::{AuthorityName, TransitionFailure};
pub use contract::{AttentionRule, AudienceRule};
pub use engine::{
    BlockReason, ContractRefused, EmissionPursuit, RegistrationRefused, RegistryFrozen, ResponsePolicy, StepCapability,
    StepOutcome, StepRefused,
};
pub use plan::{NonEmptyVec, RemedyPlan};
pub use remedy::{
    Authorization, AuthorizationDelta, AuthorizationScope, DeltaCoordinate, LabelRaise, PlannedRemedy, ReductionTarget,
};
pub use revision::{FlowId, PlanId};
pub use transition::{
    ActionTransition, AuthorityMandate, DuplicateRegistration, LabelPredicate, RegisteredTransformer,
    TransformerDescriptor, TransformerError, TransformerFn,
};
pub use value::TransformerRef;
