//! The append-only event substrate: scoped facts and the `EventSet`.
//!
//! The authoritative trajectory state: every public
//! [`Trajectory`](crate::turn::Trajectory) mutation prevalidates, then
//! appends one atomic batch of facts here. Every read goes through the pure
//! projections ([`crate::projection`]) — the single build path for derived
//! state, so nothing can drift from the log.
//!
//! The algebra is `L' = L ∪ {event}` with union as the combine. Under the
//! single-writer `&mut Trajectory` discipline the set is totally ordered by
//! [`EventId`], so union degenerates to ordered append with idempotent
//! duplicate admission: replaying an already-admitted event (same id, same
//! content) is a no-op, the same id with different content is refused, and a
//! fact that contradicts the admitted lifecycle (a second release, a
//! completion before release) is refused at admission. Facts only grow;
//! nothing is ever removed.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;

use crate::ToolName;
use crate::audit::{AuditEvent, AuthorityName, RaiseLabels};
use crate::contract::Violation;
use crate::dimension::Effects;
use crate::remedy::LabelRaise;
use crate::remedy::{Authorization, AuthorizationScope};
use crate::revision::{ActionId, FlowId, GrantId, TransitionId, TurnId, ValueId};
use crate::turn::Actor;
use crate::value::{TransformerRef, ValueLabel};

/// Position of one event within its trajectory's totally ordered set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct EventId(u64);

impl EventId {
    pub fn index(self) -> u64 {
        self.0
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "event#{}", self.0)
    }
}

/// The event frontier a batch was appended against: the number of batches
/// accepted before it. The trajectory revision becomes a digest of this
/// frontier at the projection cutover; during the shadow phase the two
/// advance in lockstep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Basis(u64);

impl Basis {
    pub fn index(self) -> u64 {
        self.0
    }
}

impl fmt::Display for Basis {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "basis#{}", self.0)
    }
}

/// What a fact is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Subject {
    Value(ValueId),
    Action(ActionId),
    Turn(TurnId),
    /// One policy check of the named flow.
    Check(FlowId),
    /// One issued one-off grant.
    Grant(GrantId),
    Trajectory,
}

/// Where a fact applies: the state a projection must consult it for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Scope {
    /// Local to one value (admission, derivation).
    Value,
    /// Local to one checked flow's lifecycle (a tool action or a pending
    /// emission).
    Action,
    /// Trajectory-wide monotone state (committed effects, spent
    /// confirmations, turns, control-plane history).
    Trajectory,
}

/// Who caused a fact to be admitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Issuer {
    /// The embedding harness, at the explicit trust boundary.
    Harness,
    /// The engine's own mediation machinery.
    Engine,
    /// A registered authority's grant.
    Authority(AuthorityName),
}

/// How an admitted value came to exist, carrying exactly the admission-time
/// label *inputs* (never the computed fold), so the label projection is the
/// thing that computes the fold — a stored copy could disagree with the
/// algebra, an input cannot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ValueOrigin {
    /// Caller-labeled admission at the trust boundary.
    Ingress { turn: TurnId, label: ValueLabel },
    /// Model output under its mandatory dependency fold.
    ModelOutput {
        reads: BTreeSet<ValueId>,
        control: BTreeSet<ValueId>,
    },
    /// Dispatched tool output: `combine(intrinsic, fold(args), fold(control))`.
    ToolOutput {
        action: ActionId,
        intrinsic: ValueLabel,
        arguments: BTreeSet<ValueId>,
        control: BTreeSet<ValueId>,
    },
    /// Registered transformer derivation under its declared output label.
    Transformed {
        source: ValueId,
        transition: TransitionId,
        transformer: TransformerRef,
        declared: ValueLabel,
    },
    /// Authority fiat relabel: `source`'s bytes under the label `delta`
    /// raises `source`'s to. The raised label itself is deliberately absent —
    /// it is derivable (`delta.raise(source_label)`), and storing it too
    /// would be a second representation that could contradict the first.
    Endorsed {
        source: ValueId,
        authority: AuthorityName,
        delta: LabelRaise,
    },
}

/// One scoped fact. The vocabulary mirrors what the legacy mutations record
/// today; the remedy-vocabulary slice retypes the control-plane entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Fact {
    ValueAdmitted {
        value: ValueId,
        origin: ValueOrigin,
    },
    TurnAppended {
        turn: TurnId,
        actor: Actor,
        /// The value the turn contributed. A turn *is* `(actor, value)`, so the
        /// fact names both — without it the turn sequence would not be
        /// derivable from the log alone.
        value: ValueId,
    },
    ActionProposed {
        action: ActionId,
        /// The checked flow the proposal opens; check facts and check-scoped
        /// grants bind to it.
        flow: FlowId,
        /// The immutable original proposal — the pending-action read model
        /// (identity basis for idempotent re-entry, current constrained form)
        /// materializes from this and the later reduction facts.
        request: crate::request::ToolRequest,
        effects: Effects,
    },
    ActionConstrained {
        action: ActionId,
        to_tool: ToolName,
        effects: Effects,
    },
    /// A derivation replaced `from` with `to` in the pending action's
    /// current argument tree (transform or endorse substitution).
    ArgumentSubstituted {
        action: ActionId,
        from: ValueId,
        to: ValueId,
    },
    /// An authority acquired a surface growth for the action; the effect
    /// still commits at release.
    GrowthAccepted {
        action: ActionId,
        effects: Effects,
        authority: AuthorityName,
    },
    /// Dispatch boundary: the action's proposed effects joined the monotone
    /// past *before* release.
    EffectsCommitted {
        action: ActionId,
        effects: Effects,
    },
    /// A user confirmation was consumed by an action release.
    ConfirmationSpent {
        turn: TurnId,
    },
    ActionReleased {
        action: ActionId,
    },
    ActionCompleted {
        action: ActionId,
        output: ValueId,
    },
    DispatchFailed {
        action: ActionId,
    },
    ActionAbandoned {
        action: ActionId,
    },
    /// One policy evaluation of the named flow ran. A new occurrence is
    /// admitted per evaluation — identical-proposal re-entry included —
    /// mirroring the unconditional plan-storage revision advance it will
    /// replace at the projection cutover. `action` names the pending action
    /// a tool flow targets; an emission flow's check carries `None`.
    CheckPerformed {
        flow: FlowId,
        action: Option<ActionId>,
    },
    /// An emission proposal opened the named flow (its check came back
    /// remediable, so the proposal is retained as the pending emission).
    EmissionProposed {
        flow: FlowId,
        /// The immutable original proposal the pending-emission read model
        /// materializes from.
        request: crate::request::EmissionRequest,
    },
    /// A derivation replaced `from` with `to` in the pending emission's
    /// current body tree.
    EmissionBodySubstituted {
        flow: FlowId,
        from: ValueId,
        to: ValueId,
    },
    /// The pending emission was abandoned (terminal block or explicit
    /// abandonment) without emitting.
    EmissionAbandoned {
        flow: FlowId,
    },
    /// A checked response was emitted as `value`, closing any pending
    /// emission.
    ResponseEmitted {
        value: ValueId,
    },
    /// A check-scoped authorization was issued as a one-off grant. Durable
    /// and action-scoped grants need no grant object (they mint a value or a
    /// growth marker); only the one-off kind has an availability to consume.
    GrantIssued {
        grant: GrantId,
        authorization: Authorization,
        authority: AuthorityName,
    },
    /// A one-off grant was consumed by its policy check. References the
    /// exact grant, flow, and (for a tool flow) the pending action, so a
    /// second consumption is refusable at admission and auditable after.
    GrantConsumed {
        grant: GrantId,
        flow: FlowId,
        action: Option<ActionId>,
    },
    /// An authority granted and the engine applied a typed authorization:
    /// an exact delta at an exact scope. `derived` names the authorized
    /// derived value a durable grant minted and `labels` its exact
    /// before/after labels — the fact is self-contained so the audit
    /// projection synthesizes its record from it alone.
    AuthorizationApplied {
        transition: TransitionId,
        authorization: Authorization,
        authority: AuthorityName,
        resolved: Vec<Violation>,
        derived: Option<ValueId>,
        labels: Option<RaiseLabels>,
    },
    /// An authority denied a typed authorization.
    AuthorizationDenied {
        authorization: Authorization,
        authority: AuthorityName,
        reason: String,
    },
    /// Control-plane history with no structural projection yet (failed
    /// transitions, approval round-trips, waivers, denials) — carried
    /// verbatim in the shadow phase; the remedy-vocabulary slice replaces
    /// these with typed authorization facts.
    ControlPlane {
        event: AuditEvent,
    },
}

impl Fact {
    fn subject(&self) -> Subject {
        match self {
            Self::ValueAdmitted { value, .. } | Self::ResponseEmitted { value } => Subject::Value(*value),
            Self::TurnAppended { turn, .. } | Self::ConfirmationSpent { turn } => Subject::Turn(*turn),
            Self::ActionProposed { action, .. }
            | Self::ActionConstrained { action, .. }
            | Self::ArgumentSubstituted { action, .. }
            | Self::GrowthAccepted { action, .. }
            | Self::EffectsCommitted { action, .. }
            | Self::ActionReleased { action }
            | Self::ActionCompleted { action, .. }
            | Self::DispatchFailed { action }
            | Self::ActionAbandoned { action } => Subject::Action(*action),
            Self::GrantIssued { grant, .. } | Self::GrantConsumed { grant, .. } => Subject::Grant(*grant),
            Self::CheckPerformed { flow, .. }
            | Self::EmissionProposed { flow, .. }
            | Self::EmissionBodySubstituted { flow, .. }
            | Self::EmissionAbandoned { flow } => Subject::Check(*flow),
            Self::AuthorizationApplied { authorization, .. } | Self::AuthorizationDenied { authorization, .. } => {
                match &authorization.scope() {
                    AuthorizationScope::DerivedValue { source } => Subject::Value(*source),
                    AuthorizationScope::PendingAction { action } => Subject::Action(*action),
                    AuthorizationScope::PolicyCheck { flow } => Subject::Check(*flow),
                }
            }
            Self::ControlPlane { .. } => Subject::Trajectory,
        }
    }

    fn scope(&self) -> Scope {
        match self {
            Self::ValueAdmitted { .. } => Scope::Value,
            Self::ActionProposed { .. }
            | Self::ActionConstrained { .. }
            | Self::ArgumentSubstituted { .. }
            | Self::GrowthAccepted { .. }
            | Self::ActionReleased { .. }
            | Self::ActionCompleted { .. }
            | Self::DispatchFailed { .. }
            | Self::ActionAbandoned { .. }
            | Self::CheckPerformed { .. }
            | Self::EmissionProposed { .. }
            | Self::EmissionBodySubstituted { .. }
            | Self::EmissionAbandoned { .. }
            | Self::GrantIssued { .. }
            | Self::GrantConsumed { .. } => Scope::Action,
            Self::AuthorizationApplied { authorization, .. } | Self::AuthorizationDenied { authorization, .. } => {
                match &authorization.scope() {
                    AuthorizationScope::DerivedValue { .. } => Scope::Value,
                    AuthorizationScope::PendingAction { .. } => Scope::Action,
                    AuthorizationScope::PolicyCheck { .. } => Scope::Action,
                }
            }
            Self::TurnAppended { .. }
            | Self::EffectsCommitted { .. }
            | Self::ConfirmationSpent { .. }
            | Self::ResponseEmitted { .. }
            | Self::ControlPlane { .. } => Scope::Trajectory,
        }
    }

    fn issuer(&self) -> Issuer {
        match self {
            Self::ValueAdmitted {
                origin: ValueOrigin::Ingress { .. },
                ..
            } => Issuer::Harness,
            Self::ValueAdmitted {
                origin: ValueOrigin::Endorsed { authority, .. },
                ..
            } => Issuer::Authority(authority.clone()),
            Self::GrowthAccepted { authority, .. }
            | Self::GrantIssued { authority, .. }
            | Self::AuthorizationApplied { authority, .. }
            | Self::AuthorizationDenied { authority, .. } => Issuer::Authority(authority.clone()),
            _ => Issuer::Engine,
        }
    }
}

/// One admitted event: an identified, scoped fact bound to the frontier it
/// was appended against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    pub id: EventId,
    pub subject: Subject,
    pub scope: Scope,
    pub issuer: Issuer,
    pub basis: Basis,
    pub fact: Fact,
}

/// Why an event or batch was refused at admission.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EventConflict {
    #[error("event {id} was already admitted with different content")]
    IdCollision { id: EventId },
    #[error("event {id} skips ahead of the frontier")]
    NonContiguous { id: EventId },
    #[error("event {id} carries basis {basis:?} outside the canonical batch order")]
    NonCanonicalBasis { id: EventId, basis: Basis },
    #[error("value {value} was already admitted")]
    DuplicateValue { value: ValueId },
    #[error("turn {turn} was already appended")]
    DuplicateTurn { turn: TurnId },
    #[error("{action}: fact contradicts its admitted lifecycle")]
    ActionLifecycle { action: ActionId },
    #[error("another action is live; {action} cannot be proposed")]
    ActionSlotOccupied { action: ActionId },
    #[error("confirmation of {turn} was already spent")]
    ConfirmationAlreadySpent { turn: TurnId },
    #[error("emission {flow}: fact contradicts its admitted lifecycle")]
    EmissionLifecycle { flow: FlowId },
    #[error("grant {grant} was already issued")]
    GrantAlreadyIssued { grant: GrantId },
    #[error("grant {grant} was never issued")]
    UnknownGrant { grant: GrantId },
    #[error("grant {grant} was already consumed")]
    GrantAlreadyConsumed { grant: GrantId },
    #[error("another emission is live; {flow} cannot be proposed")]
    EmissionSlotOccupied { flow: FlowId },
    #[error("an empty batch records no fact and cannot advance the frontier")]
    EmptyBatch,
    #[error("grant {grant} is not check-scoped; only one-off grants have an availability")]
    GrantNotCheckScoped { grant: GrantId },
    #[error("grant {grant} was issued for {issued}, not {consumed}")]
    GrantScopeMismatch {
        grant: GrantId,
        issued: FlowId,
        consumed: FlowId,
    },
    #[error("{turn} is not an admitted confirming user turn")]
    UnknownConfirmation { turn: TurnId },
    #[error("turn {turn} contributes value {value}, which was never admitted")]
    UnknownTurnValue { turn: TurnId, value: ValueId },
}

/// Lifecycle a live action has reached, tracked for conflict refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
enum ActionPhase {
    Open,
    Released,
}

/// The append-only, totally ordered event set of one trajectory.
///
/// `Serialize`-only like the rest of the trajectory state. Never exposes a
/// removal or mutation path; the only writes are [`EventSet::admit`] (one
/// event, replay-idempotent) and [`EventSet::append_batch`] (one mutation's
/// facts, advancing the frontier once).
#[derive(Debug, Default, Serialize)]
pub struct EventSet {
    events: Vec<Event>,
    /// Number of accepted batches — the frontier the revision digest will
    /// derive from at cutover.
    batches: u64,
    // Admission indexes, derivable from `events` (rebuilt on replay); kept
    // in lockstep so conflict refusal is O(log n) instead of a rescan.
    #[serde(skip)]
    admitted_values: BTreeSet<ValueId>,
    #[serde(skip)]
    admitted_turns: BTreeSet<TurnId>,
    /// Admitted user turns that carry a confirmation — the only turns a
    /// `ConfirmationSpent` may reference.
    #[serde(skip)]
    confirming_turns: BTreeSet<TurnId>,
    #[serde(skip)]
    spent_confirmations: BTreeSet<TurnId>,
    #[serde(skip)]
    live_action: Option<(ActionId, ActionPhase)>,
    #[serde(skip)]
    live_emission: Option<FlowId>,
    /// Issued one-off grants and the checked flow each is scoped to.
    #[serde(skip)]
    issued_grants: BTreeMap<GrantId, FlowId>,
    #[serde(skip)]
    consumed_grants: BTreeSet<GrantId>,
}

impl EventSet {
    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// The current frontier: the number of accepted batches.
    pub fn frontier(&self) -> Basis {
        Basis(self.batches)
    }

    fn next_id(&self) -> EventId {
        EventId(self.events.len() as u64)
    }

    /// Admit one event. Idempotent on exact replay: an already-admitted
    /// event (same id, same content) is a no-op; the same id with different
    /// content, a gap past the frontier, a non-canonical basis, or a fact
    /// contradicting the admitted lifecycle is refused, and refusal changes
    /// nothing.
    ///
    /// Crate-internal on purpose: there is no public write surface into an
    /// event set — engine-owned batches are the only admission path, so a
    /// forged event (wrong basis, unknown endorse source, fabricated
    /// issuer/scope) is unrepresentable outside the crate rather than merely
    /// refused. Test-only today — replay exists for the event-algebra
    /// property tests; a future rehydration API must validate a foreign log
    /// through this same path.
    #[cfg(test)]
    pub(crate) fn admit(&mut self, event: Event) -> Result<(), EventConflict> {
        match event.id.0.cmp(&(self.events.len() as u64)) {
            std::cmp::Ordering::Less => {
                let admitted = &self.events[event.id.0 as usize];
                if *admitted == event {
                    Ok(())
                } else {
                    Err(EventConflict::IdCollision { id: event.id })
                }
            }
            std::cmp::Ordering::Greater => Err(EventConflict::NonContiguous { id: event.id }),
            std::cmp::Ordering::Equal => {
                // Canonical bases: the first event of a batch sits at the
                // current frontier, later events of the same batch repeat it.
                let expected_next = self.batches;
                let expected_same = self.events.last().map(|last| last.basis.0);
                if event.basis.0 != expected_next && Some(event.basis.0) != expected_same {
                    return Err(EventConflict::NonCanonicalBasis {
                        id: event.id,
                        basis: event.basis,
                    });
                }
                self.check_fact(&event.fact)?;
                self.index_fact(&event.fact);
                // Replay reconstructs the frontier from the admitted events'
                // bases: every batch has at least one event (empty batches
                // are refused), so the highest basis + 1 is the batch count.
                let after = event.basis.0.checked_add(1).expect("frontier overflow: refuse to wrap");
                self.batches = self.batches.max(after);
                self.events.push(event);
                Ok(())
            }
        }
    }

    /// Append one mutation's facts as one atomic batch and advance the
    /// frontier once. All facts are validated against the admitted state
    /// (plus the earlier facts of the same batch) before any is admitted, so
    /// a refused batch changes nothing. Crate-internal like [`Self::admit`]:
    /// batches enter only through engine-owned mutations.
    pub(crate) fn append_batch(&mut self, facts: Vec<Fact>) -> Result<(), EventConflict> {
        if facts.is_empty() {
            return Err(EventConflict::EmptyBatch);
        }
        self.check_batch(&facts)?;
        let basis = self.frontier();
        for fact in facts {
            let event = Event {
                id: self.next_id(),
                subject: fact.subject(),
                scope: fact.scope(),
                issuer: fact.issuer(),
                basis,
                fact,
            };
            self.index_fact(&event.fact);
            self.events.push(event);
        }
        self.batches = self.batches.checked_add(1).expect("frontier overflow: refuse to wrap");
        Ok(())
    }

    /// Validate a whole batch against a copy of the admission indexes, so
    /// refusal leaves the set untouched.
    fn check_batch(&self, facts: &[Fact]) -> Result<(), EventConflict> {
        let mut probe = ProbeState {
            admitted_values: self.admitted_values.clone(),
            admitted_turns: self.admitted_turns.clone(),
            confirming_turns: self.confirming_turns.clone(),
            spent_confirmations: self.spent_confirmations.clone(),
            live_action: self.live_action,
            live_emission: self.live_emission,
            issued_grants: self.issued_grants.clone(),
            consumed_grants: self.consumed_grants.clone(),
        };
        for fact in facts {
            probe.check(fact)?;
            probe.index(fact);
        }
        Ok(())
    }

    #[cfg(test)]
    fn check_fact(&self, fact: &Fact) -> Result<(), EventConflict> {
        ProbeState {
            admitted_values: self.admitted_values.clone(),
            admitted_turns: self.admitted_turns.clone(),
            confirming_turns: self.confirming_turns.clone(),
            spent_confirmations: self.spent_confirmations.clone(),
            live_action: self.live_action,
            live_emission: self.live_emission,
            issued_grants: self.issued_grants.clone(),
            consumed_grants: self.consumed_grants.clone(),
        }
        .check(fact)
    }

    fn index_fact(&mut self, fact: &Fact) {
        let mut state = ProbeState {
            admitted_values: std::mem::take(&mut self.admitted_values),
            admitted_turns: std::mem::take(&mut self.admitted_turns),
            confirming_turns: std::mem::take(&mut self.confirming_turns),
            spent_confirmations: std::mem::take(&mut self.spent_confirmations),
            live_action: self.live_action,
            live_emission: self.live_emission,
            issued_grants: std::mem::take(&mut self.issued_grants),
            consumed_grants: std::mem::take(&mut self.consumed_grants),
        };
        state.index(fact);
        self.admitted_values = state.admitted_values;
        self.admitted_turns = state.admitted_turns;
        self.confirming_turns = state.confirming_turns;
        self.spent_confirmations = state.spent_confirmations;
        self.live_action = state.live_action;
        self.live_emission = state.live_emission;
        self.issued_grants = state.issued_grants;
        self.consumed_grants = state.consumed_grants;
    }
}

/// The admission indexes as plain data, so batch validation can run against
/// a scratch copy.
struct ProbeState {
    admitted_values: BTreeSet<ValueId>,
    admitted_turns: BTreeSet<TurnId>,
    confirming_turns: BTreeSet<TurnId>,
    spent_confirmations: BTreeSet<TurnId>,
    live_action: Option<(ActionId, ActionPhase)>,
    live_emission: Option<FlowId>,
    issued_grants: BTreeMap<GrantId, FlowId>,
    consumed_grants: BTreeSet<GrantId>,
}

impl ProbeState {
    fn check(&self, fact: &Fact) -> Result<(), EventConflict> {
        match fact {
            Fact::ValueAdmitted { value, .. } => match self.admitted_values.contains(value) {
                true => Err(EventConflict::DuplicateValue { value: *value }),
                false => Ok(()),
            },
            // A turn *is* `(actor, value)`, so the value it names must already
            // be admitted (the same batch admits it first) — otherwise the turn
            // projection resolves to a value that does not exist.
            Fact::TurnAppended { turn, value, .. } => {
                match (self.admitted_turns.contains(turn), self.admitted_values.contains(value)) {
                    (true, _) => Err(EventConflict::DuplicateTurn { turn: *turn }),
                    (false, false) => Err(EventConflict::UnknownTurnValue {
                        turn: *turn,
                        value: *value,
                    }),
                    (false, true) => Ok(()),
                }
            }
            Fact::ActionProposed { action, .. } => match self.live_action {
                Some(_) => Err(EventConflict::ActionSlotOccupied { action: *action }),
                None => Ok(()),
            },
            Fact::ActionConstrained { action, .. }
            | Fact::ArgumentSubstituted { action, .. }
            | Fact::GrowthAccepted { action, .. }
            | Fact::EffectsCommitted { action, .. } => self.requires_live(*action, ActionPhase::Open),
            // A tool flow's check requires its live action; an emission
            // flow's check its live emission.
            Fact::CheckPerformed { action, flow } => match action {
                Some(action) => self.requires_live(*action, ActionPhase::Open),
                None => self.requires_live_emission(*flow),
            },
            Fact::EmissionProposed { flow, .. } => match self.live_emission {
                Some(_) => Err(EventConflict::EmissionSlotOccupied { flow: *flow }),
                None => Ok(()),
            },
            Fact::EmissionBodySubstituted { flow, .. } | Fact::EmissionAbandoned { flow } => {
                self.requires_live_emission(*flow)
            }
            Fact::ActionReleased { action } => self.requires_live(*action, ActionPhase::Open),
            Fact::ActionCompleted { action, .. } | Fact::DispatchFailed { action } => {
                self.requires_live(*action, ActionPhase::Released)
            }
            // Abandonment is legal only from `Open`: a released action has an
            // outstanding dispatch and closes only through its receipt.
            Fact::ActionAbandoned { action } => self.requires_live(*action, ActionPhase::Open),
            Fact::ConfirmationSpent { turn } => match (
                self.confirming_turns.contains(turn),
                self.spent_confirmations.contains(turn),
            ) {
                (false, _) => Err(EventConflict::UnknownConfirmation { turn: *turn }),
                (true, true) => Err(EventConflict::ConfirmationAlreadySpent { turn: *turn }),
                (true, false) => Ok(()),
            },
            Fact::GrantIssued {
                grant, authorization, ..
            } => {
                if self.issued_grants.contains_key(grant) {
                    return Err(EventConflict::GrantAlreadyIssued { grant: *grant });
                }
                // Only one-off (check-scoped) authorizations have an
                // availability; durable and action-scoped grants mint a value
                // or a growth marker instead.
                match authorization.scope() {
                    AuthorizationScope::PolicyCheck { .. } => Ok(()),
                    _ => Err(EventConflict::GrantNotCheckScoped { grant: *grant }),
                }
            }
            Fact::GrantConsumed { grant, flow, action } => {
                let issued = match self.issued_grants.get(grant) {
                    None => return Err(EventConflict::UnknownGrant { grant: *grant }),
                    Some(issued) => *issued,
                };
                if self.consumed_grants.contains(grant) {
                    return Err(EventConflict::GrantAlreadyConsumed { grant: *grant });
                }
                if issued != *flow {
                    return Err(EventConflict::GrantScopeMismatch {
                        grant: *grant,
                        issued,
                        consumed: *flow,
                    });
                }
                match action {
                    Some(action) => self.requires_live(*action, ActionPhase::Open),
                    None => Ok(()),
                }
            }
            Fact::ResponseEmitted { .. }
            | Fact::AuthorizationApplied { .. }
            | Fact::AuthorizationDenied { .. }
            | Fact::ControlPlane { .. } => Ok(()),
        }
    }

    fn requires_live(&self, action: ActionId, phase: ActionPhase) -> Result<(), EventConflict> {
        match self.live_action {
            Some((live, live_phase)) if live == action && live_phase == phase => Ok(()),
            _ => Err(EventConflict::ActionLifecycle { action }),
        }
    }

    fn requires_live_emission(&self, flow: FlowId) -> Result<(), EventConflict> {
        match self.live_emission {
            Some(live) if live == flow => Ok(()),
            _ => Err(EventConflict::EmissionLifecycle { flow }),
        }
    }

    fn index(&mut self, fact: &Fact) {
        match fact {
            Fact::ValueAdmitted { value, .. } => {
                self.admitted_values.insert(*value);
            }
            Fact::TurnAppended { turn, actor, .. } => {
                self.admitted_turns.insert(*turn);
                if matches!(actor, Actor::User(crate::turn::UserTurn { confirms: Some(_), .. })) {
                    self.confirming_turns.insert(*turn);
                }
            }
            Fact::ActionProposed { action, .. } => {
                self.live_action = Some((*action, ActionPhase::Open));
            }
            Fact::ActionReleased { action } => {
                self.live_action = Some((*action, ActionPhase::Released));
            }
            Fact::ActionCompleted { .. } | Fact::DispatchFailed { .. } | Fact::ActionAbandoned { .. } => {
                self.live_action = None;
            }
            Fact::ConfirmationSpent { turn } => {
                self.spent_confirmations.insert(*turn);
            }
            Fact::EmissionProposed { flow, .. } => {
                self.live_emission = Some(*flow);
            }
            // An emitted response settles any pending emission; an
            // abandonment clears it.
            Fact::EmissionAbandoned { .. } | Fact::ResponseEmitted { .. } => {
                self.live_emission = None;
            }
            Fact::GrantIssued {
                grant, authorization, ..
            } => {
                if let AuthorizationScope::PolicyCheck { flow } = authorization.scope() {
                    self.issued_grants.insert(*grant, *flow);
                }
            }
            Fact::GrantConsumed { grant, .. } => {
                self.consumed_grants.insert(*grant);
            }
            Fact::ActionConstrained { .. }
            | Fact::ArgumentSubstituted { .. }
            | Fact::GrowthAccepted { .. }
            | Fact::EffectsCommitted { .. }
            | Fact::CheckPerformed { .. }
            | Fact::EmissionBodySubstituted { .. }
            | Fact::AuthorizationApplied { .. }
            | Fact::AuthorizationDenied { .. }
            | Fact::ControlPlane { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::Effects;
    use crate::revision::{ActionId, TurnId, ValueId};
    use crate::turn::{Actor, UserTurn};
    use crate::value::ValueLabel;

    fn ingress_fact(index: u64, label: ValueLabel) -> Fact {
        Fact::ValueAdmitted {
            value: ValueId::new(index),
            origin: ValueOrigin::Ingress {
                turn: TurnId::new(index),
                label,
            },
        }
    }

    fn turn_fact(index: u64) -> Fact {
        Fact::TurnAppended {
            turn: TurnId::new(index),
            actor: Actor::User(UserTurn {
                id: crate::dimension::UserId::new("alice"),
                confirms: None,
            }),
            value: ValueId::new(index),
        }
    }

    fn confirming_turn_fact(index: u64) -> Fact {
        Fact::TurnAppended {
            turn: TurnId::new(index),
            actor: Actor::User(UserTurn {
                id: crate::dimension::UserId::new("alice"),
                confirms: Some(crate::ToolName::new("db.drop")),
            }),
            value: ValueId::new(index),
        }
    }

    fn proposal(action: u64) -> Fact {
        Fact::ActionProposed {
            action: ActionId::new(action),
            flow: crate::revision::FlowId::new(action),
            request: crate::request::ToolRequest::new(
                crate::ToolName::new("email.send"),
                crate::request::ArgumentTree::empty(),
                std::collections::BTreeSet::new(),
            ),
            effects: Effects::none(),
        }
    }

    #[test]
    fn replaying_an_admitted_event_is_a_noop() {
        let mut set = EventSet::default();
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity()), turn_fact(0)])
            .unwrap();
        let snapshot: Vec<Event> = set.events().to_vec();
        for event in &snapshot {
            set.admit(event.clone()).unwrap();
        }
        assert_eq!(set.events(), snapshot.as_slice());
        assert_eq!(set.frontier(), Basis(1));
    }

    #[test]
    fn same_id_with_different_content_is_refused() {
        let mut set = EventSet::default();
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity())]).unwrap();
        let mut forged = set.events()[0].clone();
        forged.fact = ingress_fact(0, ValueLabel::unknown());
        assert_eq!(set.admit(forged), Err(EventConflict::IdCollision { id: EventId(0) }));
        assert_eq!(set.events().len(), 1);
    }

    #[test]
    fn skipping_ahead_of_the_frontier_is_refused() {
        let mut set = EventSet::default();
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity())]).unwrap();
        let mut ahead = set.events()[0].clone();
        ahead.id = EventId(5);
        assert_eq!(set.admit(ahead), Err(EventConflict::NonContiguous { id: EventId(5) }));
    }

    #[test]
    fn a_forged_basis_is_refused() {
        let mut set = EventSet::default();
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity())]).unwrap();
        // A basis copied from a later frontier cannot inflate the count.
        let mut inflated = EventSet::default();
        let mut forged = set.events()[0].clone();
        forged.basis = Basis(2);
        assert_eq!(
            inflated.admit(forged),
            Err(EventConflict::NonCanonicalBasis {
                id: EventId(0),
                basis: Basis(2),
            })
        );
        assert_eq!(inflated.frontier(), Basis(0));
        // A regressing basis is refused too.
        set.append_batch(vec![turn_fact(0)]).unwrap();
        let mut regressed = set.events()[1].clone();
        regressed.id = EventId(2);
        regressed.basis = Basis(0);
        assert_eq!(
            set.admit(regressed),
            Err(EventConflict::NonCanonicalBasis {
                id: EventId(2),
                basis: Basis(0),
            })
        );
    }

    #[test]
    fn lifecycle_conflicts_are_refused() {
        let mut set = EventSet::default();
        set.append_batch(vec![proposal(0)]).unwrap();

        // Completion before release.
        assert!(matches!(
            set.append_batch(vec![Fact::ActionCompleted {
                action: ActionId::new(0),
                output: ValueId::new(0),
            }]),
            Err(EventConflict::ActionLifecycle { .. })
        ));
        // A second proposal while one is live.
        assert!(matches!(
            set.append_batch(vec![proposal(1)]),
            Err(EventConflict::ActionSlotOccupied { .. })
        ));

        set.append_batch(vec![Fact::ActionReleased {
            action: ActionId::new(0),
        }])
        .unwrap();
        // A second release.
        assert!(matches!(
            set.append_batch(vec![Fact::ActionReleased {
                action: ActionId::new(0)
            }]),
            Err(EventConflict::ActionLifecycle { .. })
        ));
    }

    #[test]
    fn double_confirmation_spend_is_refused() {
        let mut set = EventSet::default();
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity()), confirming_turn_fact(0)])
            .unwrap();
        set.append_batch(vec![Fact::ConfirmationSpent { turn: TurnId::new(0) }])
            .unwrap();
        assert!(matches!(
            set.append_batch(vec![Fact::ConfirmationSpent { turn: TurnId::new(0) }]),
            Err(EventConflict::ConfirmationAlreadySpent { .. })
        ));
    }

    /// A spend must reference an admitted confirming user turn: a
    /// never-appended turn and a non-confirming turn are both refused.
    #[test]
    fn confirmation_spend_requires_an_admitted_confirming_turn() {
        let mut set = EventSet::default();
        assert!(matches!(
            set.append_batch(vec![Fact::ConfirmationSpent { turn: TurnId::new(0) }]),
            Err(EventConflict::UnknownConfirmation { .. })
        ));
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity()), turn_fact(0)])
            .unwrap();
        assert!(matches!(
            set.append_batch(vec![Fact::ConfirmationSpent { turn: TurnId::new(0) }]),
            Err(EventConflict::UnknownConfirmation { .. })
        ));
    }

    /// A turn *is* `(actor, value)`: naming a value no fact admitted would
    /// project a turn whose value cannot be resolved, so admission refuses it.
    /// The value may be admitted by an earlier batch or earlier in this one.
    #[test]
    fn a_turn_naming_an_unadmitted_value_is_refused() {
        let mut set = EventSet::default();
        assert_eq!(
            set.append_batch(vec![turn_fact(0)]),
            Err(EventConflict::UnknownTurnValue {
                turn: TurnId::new(0),
                value: ValueId::new(0),
            })
        );
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity()), turn_fact(0)])
            .unwrap();
    }

    #[test]
    fn duplicate_value_admission_is_refused() {
        let mut set = EventSet::default();
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity())]).unwrap();
        assert!(matches!(
            set.append_batch(vec![ingress_fact(0, ValueLabel::identity())]),
            Err(EventConflict::DuplicateValue { .. })
        ));
    }

    #[test]
    fn a_refused_batch_changes_nothing() {
        let mut set = EventSet::default();
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity())]).unwrap();
        let before: Vec<Event> = set.events().to_vec();
        let frontier = set.frontier();

        // Second fact of the batch conflicts; the valid first fact must not
        // land either.
        assert!(
            set.append_batch(vec![
                ingress_fact(1, ValueLabel::identity()),
                ingress_fact(0, ValueLabel::identity()),
            ])
            .is_err()
        );
        assert_eq!(set.events(), before.as_slice());
        assert_eq!(set.frontier(), frontier);
    }

    /// The one-off grant lifecycle at admission: consumption requires
    /// issuance, is keyed by the exact grant, and can happen once — reuse on
    /// the same or any later check, action, or frontier is the same refused
    /// second-consumption fact. Denial issues nothing, so it can never
    /// create availability.
    #[test]
    fn grant_consumption_is_linear_at_admission() {
        use crate::remedy::{Authorization, AuthorizationDelta, AuthorizationScope, DeltaCoordinate};
        let authorization = Authorization::new(
            AuthorizationDelta::single(DeltaCoordinate::StandInConfirmation),
            AuthorizationScope::PolicyCheck {
                flow: crate::revision::FlowId::new(0),
            },
        )
        .unwrap();
        let grant = crate::revision::GrantId::new(0);
        let issued = Fact::GrantIssued {
            grant,
            authorization,
            authority: AuthorityName::new("human"),
        };
        let consumed = Fact::GrantConsumed {
            grant,
            flow: crate::revision::FlowId::new(0),
            action: None,
        };

        // Consuming a never-issued grant is refused.
        let mut set = EventSet::default();
        assert!(matches!(
            set.append_batch(vec![consumed.clone()]),
            Err(EventConflict::UnknownGrant { .. })
        ));

        // Issued then consumed in one batch: admitted; unavailable after.
        set.append_batch(vec![issued.clone(), consumed.clone()]).unwrap();
        assert!(crate::projection::grant_availability(&set).is_empty());

        // A second consumption — same check, a different flow/action, or
        // after unrelated frontier growth — is the same refused fact.
        assert!(matches!(
            set.append_batch(vec![consumed.clone()]),
            Err(EventConflict::GrantAlreadyConsumed { .. })
        ));
        set.append_batch(vec![ingress_fact(0, ValueLabel::identity())]).unwrap();
        assert!(matches!(
            set.append_batch(vec![Fact::GrantConsumed {
                grant,
                flow: crate::revision::FlowId::new(7),
                action: Some(ActionId::new(3)),
            }]),
            Err(EventConflict::GrantAlreadyConsumed { .. })
        ));
        // Re-issuing the same grant identity is likewise refused.
        assert!(matches!(
            set.append_batch(vec![issued]),
            Err(EventConflict::GrantAlreadyIssued { .. })
        ));
    }

    /// Grants are exactly-scoped at admission: only a check-scoped
    /// authorization may be issued as a one-off grant, and consumption must
    /// reference the issued flow (and, where named, the live open action).
    #[test]
    fn grant_admission_enforces_the_issued_scope() {
        use crate::remedy::{Authorization, AuthorizationDelta, AuthorizationScope, DeltaCoordinate};

        // A durable (non-check) authorization has no availability to issue.
        let durable = Authorization::new(
            AuthorizationDelta::single(DeltaCoordinate::RaiseLabel(crate::remedy::LabelRaise {
                trust: Some(crate::dimension::KnownTrust::Trusted),
                audience: None,
            })),
            AuthorizationScope::DerivedValue {
                source: ValueId::new(0),
            },
        )
        .unwrap();
        let mut set = EventSet::default();
        assert!(matches!(
            set.append_batch(vec![Fact::GrantIssued {
                grant: crate::revision::GrantId::new(0),
                authorization: durable,
                authority: AuthorityName::new("human"),
            }]),
            Err(EventConflict::GrantNotCheckScoped { .. })
        ));

        // Consumption against a different flow than the issued scope is
        // refused; the availability survives for the right check.
        let checked = Authorization::new(
            AuthorizationDelta::single(DeltaCoordinate::StandInConfirmation),
            AuthorizationScope::PolicyCheck {
                flow: crate::revision::FlowId::new(7),
            },
        )
        .unwrap();
        let grant = crate::revision::GrantId::new(1);
        set.append_batch(vec![Fact::GrantIssued {
            grant,
            authorization: checked,
            authority: AuthorityName::new("human"),
        }])
        .unwrap();
        assert!(matches!(
            set.append_batch(vec![Fact::GrantConsumed {
                grant,
                flow: crate::revision::FlowId::new(8),
                action: None,
            }]),
            Err(EventConflict::GrantScopeMismatch { .. })
        ));
        // Naming an action requires it to be the live open action.
        assert!(matches!(
            set.append_batch(vec![Fact::GrantConsumed {
                grant,
                flow: crate::revision::FlowId::new(7),
                action: Some(ActionId::new(4)),
            }]),
            Err(EventConflict::ActionLifecycle { .. })
        ));
        assert!(!crate::projection::grant_availability(&set).is_empty());
        set.append_batch(vec![Fact::GrantConsumed {
            grant,
            flow: crate::revision::FlowId::new(7),
            action: None,
        }])
        .unwrap();
        assert!(crate::projection::grant_availability(&set).is_empty());
    }

    /// An empty batch records no fact and cannot advance the frontier.
    #[test]
    fn an_empty_batch_is_refused() {
        let mut set = EventSet::default();
        let frontier = set.frontier();
        assert!(matches!(set.append_batch(Vec::new()), Err(EventConflict::EmptyBatch)));
        assert_eq!(set.frontier(), frontier);
    }

    mod laws {
        use proptest::prelude::*;

        use super::*;
        use crate::test_strategies::arb_value_label;

        /// A contiguous sequence of conflict-free facts: per index one value
        /// admission, an optional turn, and optional control-plane history.
        fn arb_simple_batches() -> impl Strategy<Value = Vec<Vec<Fact>>> {
            prop::collection::vec((arb_value_label(), any::<bool>(), any::<bool>()), 0..12).prop_map(|entries| {
                entries
                    .into_iter()
                    .enumerate()
                    .map(|(index, (label, with_turn, with_history))| {
                        let index = index as u64;
                        let mut batch = vec![ingress_fact(index, label)];
                        if with_turn {
                            batch.push(turn_fact(index));
                        }
                        if with_history {
                            batch.push(Fact::ControlPlane {
                                event: crate::audit::AuditEvent::DispatchFailed {
                                    action: ActionId::new(index),
                                },
                            });
                        }
                        batch
                    })
                    .collect()
            })
        }

        proptest! {
            /// Replaying the full canonical sequence into the same set is a
            /// no-op, and into a fresh set rebuilds an equal set — union
            /// idempotence under the single-writer total order.
            #[test]
            fn replay_is_idempotent_and_rebuilds_equal_sets(batches in arb_simple_batches()) {
                let mut set = EventSet::default();
                for batch in &batches {
                    set.append_batch(batch.clone()).unwrap();
                }
                let canonical: Vec<Event> = set.events().to_vec();

                for event in &canonical {
                    set.admit(event.clone()).unwrap();
                }
                prop_assert_eq!(set.events(), canonical.as_slice());

                let mut rebuilt = EventSet::default();
                for event in &canonical {
                    rebuilt.admit(event.clone()).unwrap();
                }
                prop_assert_eq!(rebuilt.events(), canonical.as_slice());
                // The frontier is replay-derived: a rebuilt set reproduces
                // the authoritative revision, not just the facts.
                prop_assert_eq!(rebuilt.frontier(), set.frontier());
            }

            /// Projections are a pure function of the admitted events:
            /// a rebuilt set projects identically.
            #[test]
            fn projections_are_deterministic_over_replay(batches in arb_simple_batches()) {
                let mut set = EventSet::default();
                for batch in &batches {
                    set.append_batch(batch.clone()).unwrap();
                }
                let mut rebuilt = EventSet::default();
                for event in set.events() {
                    rebuilt.admit(event.clone()).unwrap();
                }
                prop_assert_eq!(
                    crate::projection::value_labels(&set),
                    crate::projection::value_labels(&rebuilt)
                );
                prop_assert_eq!(
                    crate::projection::provenance(&set),
                    crate::projection::provenance(&rebuilt)
                );
                prop_assert_eq!(
                    crate::projection::committed_effects(&set),
                    crate::projection::committed_effects(&rebuilt)
                );
                prop_assert_eq!(
                    crate::projection::confirmation_available(&set),
                    crate::projection::confirmation_available(&rebuilt)
                );
            }
        }
    }
}
