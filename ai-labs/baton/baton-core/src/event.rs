//! The append-only event substrate: scoped facts and the `EventSet`.
//!
//! Shadow phase (S1 of the compact-architecture plan): every public
//! [`Trajectory`](crate::turn::Trajectory) mutation dual-records its state
//! change here as one atomically appended batch of facts, while all reads
//! stay on the legacy fields. Projections over the set
//! ([`crate::projection`]) are parity-tested against the legacy truth; the
//! cutover that makes them authoritative is a later slice.
//!
//! The algebra is `L' = L ∪ {event}` with union as the combine. Under the
//! single-writer `&mut Trajectory` discipline the set is totally ordered by
//! [`EventId`], so union degenerates to ordered append with idempotent
//! duplicate admission: replaying an already-admitted event (same id, same
//! content) is a no-op, the same id with different content is refused, and a
//! fact that contradicts the admitted lifecycle (a second release, a
//! completion before release) is refused at admission. Facts only grow;
//! nothing is ever removed.

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

use crate::ToolName;
use crate::audit::{AuditEvent, AuthorityName};
use crate::dimension::Effects;
use crate::revision::{ActionId, TransitionId, TurnId, ValueId};
use crate::transition::EndorseDelta;
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
    /// One policy check of a flow. Until the typed flow identity lands
    /// (S2), the checked action names the check.
    Check(ActionId),
    Trajectory,
}

/// Where a fact applies: the state a projection must consult it for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Scope {
    /// Local to one value (admission, derivation).
    Value,
    /// Local to one action's lifecycle.
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
/// label *inputs* (never the computed fold), so the label projection can
/// recompute the fold and be meaningfully parity-tested against the store.
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
    /// Authority fiat relabel: `source`'s bytes under the raised label.
    Endorsed {
        source: ValueId,
        authority: AuthorityName,
        delta: EndorseDelta,
        raised: ValueLabel,
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
    },
    ActionProposed {
        action: ActionId,
        tool: ToolName,
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
    /// replace at the projection cutover.
    CheckPerformed {
        action: ActionId,
    },
    /// A checked response was emitted as `value`.
    ResponseEmitted {
        value: ValueId,
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
            Self::CheckPerformed { action } => Subject::Check(*action),
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
            | Self::CheckPerformed { .. } => Scope::Action,
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
            Self::GrowthAccepted { authority, .. } => Issuer::Authority(authority.clone()),
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
    #[serde(skip)]
    spent_confirmations: BTreeSet<TurnId>,
    #[serde(skip)]
    live_action: Option<(ActionId, ActionPhase)>,
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
    /// content, a gap past the frontier, or a fact contradicting the
    /// admitted lifecycle is refused, and refusal changes nothing.
    pub fn admit(&mut self, event: Event) -> Result<(), EventConflict> {
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
                self.check_fact(&event.fact)?;
                self.index_fact(&event.fact);
                self.events.push(event);
                Ok(())
            }
        }
    }

    /// Append one mutation's facts as one atomic batch and advance the
    /// frontier once. All facts are validated against the admitted state
    /// (plus the earlier facts of the same batch) before any is admitted, so
    /// a refused batch changes nothing.
    pub fn append_batch(&mut self, facts: Vec<Fact>) -> Result<(), EventConflict> {
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
        self.batches += 1;
        Ok(())
    }

    /// Validate a whole batch against a copy of the admission indexes, so
    /// refusal leaves the set untouched.
    fn check_batch(&self, facts: &[Fact]) -> Result<(), EventConflict> {
        let mut probe = ProbeState {
            admitted_values: self.admitted_values.clone(),
            admitted_turns: self.admitted_turns.clone(),
            spent_confirmations: self.spent_confirmations.clone(),
            live_action: self.live_action,
        };
        for fact in facts {
            probe.check(fact)?;
            probe.index(fact);
        }
        Ok(())
    }

    fn check_fact(&self, fact: &Fact) -> Result<(), EventConflict> {
        ProbeState {
            admitted_values: self.admitted_values.clone(),
            admitted_turns: self.admitted_turns.clone(),
            spent_confirmations: self.spent_confirmations.clone(),
            live_action: self.live_action,
        }
        .check(fact)
    }

    fn index_fact(&mut self, fact: &Fact) {
        let mut state = ProbeState {
            admitted_values: std::mem::take(&mut self.admitted_values),
            admitted_turns: std::mem::take(&mut self.admitted_turns),
            spent_confirmations: std::mem::take(&mut self.spent_confirmations),
            live_action: self.live_action,
        };
        state.index(fact);
        self.admitted_values = state.admitted_values;
        self.admitted_turns = state.admitted_turns;
        self.spent_confirmations = state.spent_confirmations;
        self.live_action = state.live_action;
    }
}

/// The admission indexes as plain data, so batch validation can run against
/// a scratch copy.
struct ProbeState {
    admitted_values: BTreeSet<ValueId>,
    admitted_turns: BTreeSet<TurnId>,
    spent_confirmations: BTreeSet<TurnId>,
    live_action: Option<(ActionId, ActionPhase)>,
}

impl ProbeState {
    fn check(&self, fact: &Fact) -> Result<(), EventConflict> {
        match fact {
            Fact::ValueAdmitted { value, .. } => match self.admitted_values.contains(value) {
                true => Err(EventConflict::DuplicateValue { value: *value }),
                false => Ok(()),
            },
            Fact::TurnAppended { turn, .. } => match self.admitted_turns.contains(turn) {
                true => Err(EventConflict::DuplicateTurn { turn: *turn }),
                false => Ok(()),
            },
            Fact::ActionProposed { action, .. } => match self.live_action {
                Some(_) => Err(EventConflict::ActionSlotOccupied { action: *action }),
                None => Ok(()),
            },
            Fact::ActionConstrained { action, .. }
            | Fact::ArgumentSubstituted { action, .. }
            | Fact::GrowthAccepted { action, .. }
            | Fact::EffectsCommitted { action, .. }
            | Fact::CheckPerformed { action } => self.requires_live(*action, ActionPhase::Open),
            Fact::ActionReleased { action } => self.requires_live(*action, ActionPhase::Open),
            Fact::ActionCompleted { action, .. } | Fact::DispatchFailed { action } => {
                self.requires_live(*action, ActionPhase::Released)
            }
            Fact::ActionAbandoned { action } => match self.live_action {
                Some((live, _)) if live == *action => Ok(()),
                _ => Err(EventConflict::ActionLifecycle { action: *action }),
            },
            Fact::ConfirmationSpent { turn } => match self.spent_confirmations.contains(turn) {
                true => Err(EventConflict::ConfirmationAlreadySpent { turn: *turn }),
                false => Ok(()),
            },
            Fact::ResponseEmitted { .. } | Fact::ControlPlane { .. } => Ok(()),
        }
    }

    fn requires_live(&self, action: ActionId, phase: ActionPhase) -> Result<(), EventConflict> {
        match self.live_action {
            Some((live, live_phase)) if live == action && live_phase == phase => Ok(()),
            _ => Err(EventConflict::ActionLifecycle { action }),
        }
    }

    fn index(&mut self, fact: &Fact) {
        match fact {
            Fact::ValueAdmitted { value, .. } => {
                self.admitted_values.insert(*value);
            }
            Fact::TurnAppended { turn, .. } => {
                self.admitted_turns.insert(*turn);
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
            Fact::ActionConstrained { .. }
            | Fact::ArgumentSubstituted { .. }
            | Fact::GrowthAccepted { .. }
            | Fact::EffectsCommitted { .. }
            | Fact::CheckPerformed { .. }
            | Fact::ResponseEmitted { .. }
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
        }
    }

    fn proposal(action: u64) -> Fact {
        Fact::ActionProposed {
            action: ActionId::new(action),
            tool: crate::ToolName::new("email.send"),
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
        set.append_batch(vec![Fact::ConfirmationSpent { turn: TurnId::new(0) }])
            .unwrap();
        assert!(matches!(
            set.append_batch(vec![Fact::ConfirmationSpent { turn: TurnId::new(0) }]),
            Err(EventConflict::ConfirmationAlreadySpent { .. })
        ));
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
