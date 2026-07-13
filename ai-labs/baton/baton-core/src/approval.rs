//! Authorities and process-local external approval.
//!
//! An [`Authority`] is one registered decision-maker: a name, the competence
//! it may exercise ([`AuthorityMandate`]), and a mode.
//!
//! - **Inline** authorities carry a decision function ([`AuthorityFn`]) the
//!   engine runs synchronously during waiver application. A Rust type cannot
//!   prove purity, so an inline fn means "allowed to run inline", not
//!   "formally established pure".
//! - **External** authorities carry no code. The engine plans an `ApplyWaiver`
//!   step routed to one, but never invokes the human, webhook, or judge model
//!   itself: the ruling re-enters through
//!   [`crate::engine::PolicyEngine::apply_approval`] with a [`PendingApproval`]
//!   the engine issued.
//!
//! A [`PendingApproval`] is opaque, linear (non-`Clone`), `Serialize`-only,
//! and bound to the exact trajectory revision, pending action, waiver,
//! targeted violations, and authority registration. Any state change —
//! including a process restart, since nothing can deserialize one —
//! invalidates it.

use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;

use crate::audit::AuthorityName;
use crate::contract::Violation;
use crate::engine::EngineId;
use crate::revision::{ActionId, PlanId, Revision, ValueId};
use crate::transition::{AuthorityMandate, ProposedGrant};
use crate::turn::TrajectoryId;
use crate::value::{Provenance, ValueLabel, ValueStore};

/// A ruling outcome, from an inline or external authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Ruling {
    Approve { reason: String },
    Deny { reason: String },
}

/// A deterministic inline decision function: registered policy over the grant
/// it is asked to authorize, the violations that grant targets, and a
/// read-only view of the trajectory (labels and provenance of the values in
/// scope). `None` abstains — routing falls through to the next competent
/// authority, so abstention keeps the contract total.
pub type AuthorityFn = fn(&ProposedGrant, &[Violation], &TrajectoryView<'_>) -> Option<Ruling>;

/// A read-only projection of the trajectory handed to an inline authority: the
/// label and provenance of any value it needs to judge a grant. Borrowed and
/// taken before any mutation, so an inline ruling cannot observe its own
/// effects.
pub struct TrajectoryView<'a> {
    store: &'a ValueStore,
}

impl<'a> TrajectoryView<'a> {
    pub(crate) fn new(store: &'a ValueStore) -> Self {
        Self { store }
    }

    /// The label of a value the trajectory admitted, if any.
    pub fn label(&self, value: ValueId) -> Option<&ValueLabel> {
        self.store.get(value).ok().map(|stored| stored.label())
    }

    /// The provenance of a value the trajectory admitted, if any.
    pub fn provenance(&self, value: ValueId) -> Option<&Provenance> {
        self.store.get(value).ok().map(|stored| stored.provenance())
    }
}

/// One value's ruling-relevant projection: its label and provenance, never its
/// bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValueView {
    pub label: ValueLabel,
    pub provenance: Provenance,
}

/// An owned, serializable snapshot of the values relevant to a grant, embedded
/// in a [`PendingApproval`] so an out-of-process authority can judge without a
/// live trajectory — a borrow cannot cross the approval boundary. Never bytes.
///
/// Scoped to the operation's *direct* values (the argument leaves and control
/// dependencies), not the transitive provenance closure: a snapshotted value's
/// `Provenance` may name ancestors this snapshot does not carry. Walking that
/// closure so an authority can inspect suspicious ancestry is a later pass
/// (design §5, D3); today the snapshot is the immediate operation scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AncestrySnapshot {
    values: BTreeMap<ValueId, ValueView>,
}

impl AncestrySnapshot {
    /// Snapshot the label and provenance of each admitted value in `ids`,
    /// taken before any mutation. Unknown ids are skipped — the snapshot is
    /// context for a ruling, not a check.
    pub(crate) fn of(store: &ValueStore, ids: impl IntoIterator<Item = ValueId>) -> Self {
        let values = ids
            .into_iter()
            .filter_map(|id| {
                store.get(id).ok().map(|stored| {
                    (
                        id,
                        ValueView {
                            label: stored.label().clone(),
                            provenance: stored.provenance().clone(),
                        },
                    )
                })
            })
            .collect();
        Self { values }
    }

    /// The projection of one value in scope, if the snapshot carries it.
    pub fn get(&self, value: ValueId) -> Option<&ValueView> {
        self.values.get(&value)
    }

    /// Every value in scope, by identity.
    pub fn iter(&self) -> impl Iterator<Item = (ValueId, &ValueView)> {
        self.values.iter().map(|(id, view)| (*id, view))
    }
}

/// A registered decision-maker: a name, the competence it may exercise, and
/// how it decides. Inline authorities decide synchronously; external ones
/// defer to an out-of-process ruling through [`PendingApproval`].
#[derive(Debug, Clone)]
pub struct Authority {
    pub name: AuthorityName,
    /// The largest elevation this authority is competent to grant.
    pub mandate: AuthorityMandate,
    pub mode: AuthorityMode,
}

/// How an [`Authority`] rules. Inline authorities are consulted before
/// external ones during routing (a deterministic answer beats a round-trip to
/// a human).
#[derive(Debug, Clone)]
pub enum AuthorityMode {
    /// Decide synchronously in-process; `None` abstains and falls through.
    Inline(AuthorityFn),
    /// Defer to an out-of-process ruling re-entered through
    /// [`crate::engine::PolicyEngine::apply_approval`].
    External,
}

/// A grant step awaiting an external authority's ruling. Issued by the engine
/// when an `ApplyWaiver` or `AcceptGrowth` step names an external authority;
/// consumed by [`crate::engine::PolicyEngine::apply_approval`], which dispatches
/// on the grant variant.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PendingApproval {
    plan: PlanId,
    action: ActionId,
    grant: ProposedGrant,
    authority: AuthorityName,
    /// The violations this grant targets, as predicted at issuance.
    resolved: Vec<Violation>,
    /// An owned snapshot of the values the grant is judged over — labels and
    /// provenance, never bytes — so the out-of-process authority has context.
    ancestry: AncestrySnapshot,
    trajectory: TrajectoryId,
    revision: Revision,
    engine: EngineId,
}

/// The consumed contents of a [`PendingApproval`]. The plan id stays behind
/// on the serialized approval only — validation binds through the revision
/// and the pending action.
pub(crate) struct ApprovalParts {
    pub(crate) action: ActionId,
    pub(crate) grant: ProposedGrant,
    pub(crate) authority: AuthorityName,
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
        grant: ProposedGrant,
        authority: AuthorityName,
        resolved: Vec<Violation>,
        ancestry: AncestrySnapshot,
        trajectory: TrajectoryId,
        revision: Revision,
        engine: EngineId,
    ) -> Self {
        Self {
            plan,
            action,
            grant,
            authority,
            resolved,
            ancestry,
            trajectory,
            revision,
            engine,
        }
    }

    /// Which authority must rule.
    pub fn authority(&self) -> &AuthorityName {
        &self.authority
    }

    /// The owned snapshot of the values this grant is judged over.
    pub fn ancestry(&self) -> &AncestrySnapshot {
        &self.ancestry
    }

    /// The grant the ruling would authorize (a waiver, an acknowledgment, or an
    /// effect acquisition).
    pub fn grant(&self) -> &ProposedGrant {
        &self.grant
    }

    /// The violations the grant targets.
    pub fn resolves(&self) -> &[Violation] {
        &self.resolved
    }

    pub(crate) fn into_parts(self) -> ApprovalParts {
        ApprovalParts {
            action: self.action,
            grant: self.grant,
            authority: self.authority,
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
            self.grant, self.authority, self.trajectory, self.revision
        )
    }
}
