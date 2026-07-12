//! Policy rules and process-local external approval.
//!
//! The old `Authority` trait combined mandate discovery, synchronous
//! execution, attribution, and adjudication. It is split into two surfaces:
//!
//! - **Policy rules** run inline during waiver application. A Rust type
//!   cannot prove purity, so `PolicyRuleFn` means "allowed to run inline",
//!   not "formally established pure" — it is a plain function pointer of
//!   registered policy over the structural request state.
//! - **External adjudicators** ([`crate::transition::Adjudicator`]) are
//!   registered metadata. The engine may plan an `ApplyWaiver` step for one,
//!   but never invokes the human, webhook, or judge model itself:
//!   adjudication re-enters through
//!   [`crate::engine::PolicyEngine::apply_approval`] with a
//!   [`PendingApproval`] the engine issued.
//!
//! A [`PendingApproval`] is opaque, linear (non-`Clone`), `Serialize`-only,
//! and bound to the exact trajectory revision, pending action, waiver delta,
//! targeted violations, and adjudicator registration. Any state change —
//! including a process restart, since nothing can deserialize one —
//! invalidates it.

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

use crate::audit::AdjudicatorName;
use crate::contract::Violation;
use crate::engine::EngineId;
use crate::revision::{ActionId, PlanId, Revision, ValueId};
use crate::transition::WaiverDelta;
use crate::turn::TrajectoryId;

/// An adjudication outcome, from a policy rule or an external adjudicator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Ruling {
    Approve { reason: String },
    Deny { reason: String },
}

/// A deterministic inline decision function: registered policy over the
/// waiver delta it is asked to grant and the violations that delta targets.
/// `None` means the rule abstains (it should not be consulted for deltas
/// outside its mandate, but abstention keeps the contract total).
pub type PolicyRuleFn = fn(&WaiverDelta, &[Violation]) -> Option<Ruling>;

/// An inline policy rule: name, mandate, and its decision function. Routing
/// prefers rules over external adjudicators — a deterministic answer beats a
/// round-trip to a human.
#[derive(Debug, Clone)]
pub struct PolicyRule {
    pub name: AdjudicatorName,
    /// The largest delta this rule is competent to grant.
    pub mandate: WaiverDelta,
    pub decide: PolicyRuleFn,
}

/// A waiver step awaiting an external adjudicator's ruling. Issued by the
/// engine when an `ApplyWaiver` step names an external adjudicator; consumed
/// by [`crate::engine::PolicyEngine::apply_approval`].
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PendingApproval {
    plan: PlanId,
    action: ActionId,
    delta: WaiverDelta,
    adjudicator: AdjudicatorName,
    /// The violations this waiver targets, as predicted at issuance.
    resolved: Vec<Violation>,
    /// Values whose labels the delta attests over, for the adjudicator's
    /// context (identities only — never bytes).
    basis_values: BTreeSet<ValueId>,
    trajectory: TrajectoryId,
    revision: Revision,
    engine: EngineId,
}

/// The consumed contents of a [`PendingApproval`]. The plan id stays behind
/// on the serialized approval only — validation binds through the revision
/// and the pending action.
pub(crate) struct ApprovalParts {
    pub(crate) action: ActionId,
    pub(crate) delta: WaiverDelta,
    pub(crate) adjudicator: AdjudicatorName,
    pub(crate) resolved: Vec<Violation>,
    pub(crate) trajectory: TrajectoryId,
    pub(crate) revision: Revision,
    pub(crate) engine: EngineId,
}

impl PendingApproval {
    #[expect(
        clippy::too_many_arguments,
        reason = "crate-internal constructor mirroring the binding fields"
    )]
    pub(crate) fn new(
        plan: PlanId,
        action: ActionId,
        delta: WaiverDelta,
        adjudicator: AdjudicatorName,
        resolved: Vec<Violation>,
        basis_values: BTreeSet<ValueId>,
        trajectory: TrajectoryId,
        revision: Revision,
        engine: EngineId,
    ) -> Self {
        Self {
            plan,
            action,
            delta,
            adjudicator,
            resolved,
            basis_values,
            trajectory,
            revision,
            engine,
        }
    }

    /// Which adjudicator must rule.
    pub fn adjudicator(&self) -> &AdjudicatorName {
        &self.adjudicator
    }

    /// The delta the ruling would grant.
    pub fn delta(&self) -> &WaiverDelta {
        &self.delta
    }

    /// The violations the waiver targets.
    pub fn resolves(&self) -> &[Violation] {
        &self.resolved
    }

    pub(crate) fn into_parts(self) -> ApprovalParts {
        ApprovalParts {
            action: self.action,
            delta: self.delta,
            adjudicator: self.adjudicator,
            resolved: self.resolved,
            trajectory: self.trajectory,
            revision: self.revision,
            engine: self.engine,
        }
    }
}

impl fmt::Display for PendingApproval {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "approval of {} by {} pending on {} at {}",
            self.delta, self.adjudicator, self.trajectory, self.revision
        )
    }
}
