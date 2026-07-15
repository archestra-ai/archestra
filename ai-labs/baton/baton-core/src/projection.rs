//! Derived projections over the append-only [`EventSet`].
//!
//! Shadow phase: pure functions recomputed from the events on every call —
//! nothing is cached, so rebuild equivalence holds by construction and
//! determinism is exactly replay determinism. Labels are *recomputed* from
//! each value's admission-time inputs (the fold over its dependency
//! projections), never copied from the store, so parity against the legacy
//! truth is a real check of the algebra, not of a copy.

use std::collections::{BTreeMap, BTreeSet};

use crate::ToolName;
use crate::dimension::Effects;
use crate::event::{EventSet, Fact, ValueOrigin};
use crate::request::ActionState;
use crate::revision::{ActionId, GrantId, TurnId, ValueId};
use crate::turn::Actor;
use crate::value::{Provenance, ValueLabel};

/// Per-value labels: each value's label recomputed from its origin — the
/// caller label at ingress, the declared/raised label for transformed and
/// endorsed values, and the conservative dependency fold everywhere else.
pub fn value_labels(events: &EventSet) -> BTreeMap<ValueId, ValueLabel> {
    let mut labels: BTreeMap<ValueId, ValueLabel> = BTreeMap::new();
    let fold = |labels: &BTreeMap<ValueId, ValueLabel>, ids: &BTreeSet<ValueId>| {
        ValueLabel::fold(ids.iter().map(|id| {
            labels
                .get(id)
                .expect("dependencies are admitted before their dependents")
                .clone()
        }))
    };
    for event in events.events() {
        if let Fact::ValueAdmitted { value, origin } = &event.fact {
            let label = match origin {
                ValueOrigin::Ingress { label, .. } => label.clone(),
                ValueOrigin::ModelOutput { reads, control } => fold(&labels, reads).combine(fold(&labels, control)),
                ValueOrigin::ToolOutput {
                    intrinsic,
                    arguments,
                    control,
                    ..
                } => intrinsic
                    .clone()
                    .combine(fold(&labels, arguments))
                    .combine(fold(&labels, control)),
                ValueOrigin::Transformed { declared, .. } => declared.clone(),
                ValueOrigin::Endorsed { raised, .. } => raised.clone(),
            };
            labels.insert(*value, label);
        }
    }
    labels
}

/// Per-value provenance, rebuilt from admission facts.
pub fn provenance(events: &EventSet) -> BTreeMap<ValueId, Provenance> {
    events
        .events()
        .iter()
        .filter_map(|event| match &event.fact {
            Fact::ValueAdmitted { value, origin } => {
                let provenance = match origin {
                    ValueOrigin::Ingress { turn, .. } => Provenance::Ingress { turn: *turn },
                    ValueOrigin::ModelOutput { reads, control } => Provenance::ModelOutput {
                        reads: reads.clone(),
                        control: control.clone(),
                    },
                    ValueOrigin::ToolOutput {
                        action,
                        arguments,
                        control,
                        ..
                    } => Provenance::ToolOutput {
                        action: *action,
                        arguments: arguments.clone(),
                        control: control.clone(),
                    },
                    ValueOrigin::Transformed {
                        source,
                        transition,
                        transformer,
                        ..
                    } => Provenance::Transformed {
                        source: *source,
                        transition: *transition,
                        transformer: transformer.clone(),
                    },
                    ValueOrigin::Endorsed {
                        source,
                        authority,
                        delta,
                        ..
                    } => Provenance::Endorsed {
                        source: *source,
                        authority: authority.clone(),
                        delta: delta.clone(),
                    },
                };
                Some((*value, provenance))
            }
            _ => None,
        })
        .collect()
}

/// The monotone committed effect surface: the union of every commitment
/// fact. Failure facts never remove anything by construction — there is no
/// removing fact.
pub fn committed_effects(events: &EventSet) -> Effects {
    events
        .events()
        .iter()
        .fold(Effects::none(), |past, event| match &event.fact {
            Fact::EffectsCommitted { effects, .. } => past.combine(effects.clone()),
            _ => past,
        })
}

/// The projected view of the live pending action, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingActionView {
    pub action: ActionId,
    pub tool: ToolName,
    pub proposed_effects: Effects,
    pub accepted_effects: Effects,
    pub state: ActionState,
    /// Argument substitutions applied to the current tree, in order.
    pub substitutions: Vec<(ValueId, ValueId)>,
}

/// Derive the pending action from proposal/reduction/lifecycle facts.
pub fn pending_action(events: &EventSet) -> Option<PendingActionView> {
    let mut view: Option<PendingActionView> = None;
    for event in events.events() {
        match &event.fact {
            Fact::ActionProposed {
                action,
                request,
                effects,
                ..
            } => {
                view = Some(PendingActionView {
                    action: *action,
                    tool: request.tool.clone(),
                    proposed_effects: effects.clone(),
                    accepted_effects: Effects::none(),
                    state: ActionState::Proposed,
                    substitutions: Vec::new(),
                });
            }
            Fact::ActionConstrained { to_tool, effects, .. } => {
                let live = view.as_mut().expect("constraint admitted only for a live action");
                live.tool = to_tool.clone();
                live.proposed_effects = effects.clone();
                live.state = ActionState::Constrained;
            }
            Fact::ArgumentSubstituted { from, to, .. } => {
                view.as_mut()
                    .expect("substitution admitted only for a live action")
                    .substitutions
                    .push((*from, *to));
            }
            Fact::GrowthAccepted { effects, .. } => {
                let live = view.as_mut().expect("growth admitted only for a live action");
                live.accepted_effects = live.accepted_effects.clone().combine(effects.clone());
            }
            Fact::ActionReleased { .. } => {
                view.as_mut().expect("release admitted only for a live action").state = ActionState::Released;
            }
            Fact::ActionCompleted { .. } | Fact::DispatchFailed { .. } | Fact::ActionAbandoned { .. } => {
                view = None;
            }
            _ => {}
        }
    }
    view
}

/// The confirmation currently in force: the newest turn's, only if it is a
/// confirming user turn whose confirmation no consumption fact has spent.
pub fn confirmation_available(events: &EventSet) -> Option<(TurnId, ToolName)> {
    let mut newest: Option<(TurnId, Option<ToolName>)> = None;
    let mut spent: BTreeSet<TurnId> = BTreeSet::new();
    for event in events.events() {
        match &event.fact {
            Fact::TurnAppended { turn, actor } => {
                let confirms = match actor {
                    Actor::User(user) => user.confirms.clone(),
                    Actor::Assistant | Actor::Tool(_) => None,
                };
                newest = Some((*turn, confirms));
            }
            Fact::ConfirmationSpent { turn } => {
                spent.insert(*turn);
            }
            _ => {}
        }
    }
    match newest {
        Some((turn, Some(tool))) if !spent.contains(&turn) => Some((turn, tool)),
        _ => None,
    }
}

/// One-off grant availability: issued grants whose consumption fact has not
/// (yet) been admitted. The engine issues and consumes a check-scoped grant
/// in the same batch, so under the current issuance discipline this is empty
/// between mutations — the projection exists because facts only grow: a
/// consumed grant is unavailable by *projection*, never by removal.
pub fn grant_availability(events: &EventSet) -> BTreeMap<GrantId, crate::remedy::Authorization> {
    let mut available = BTreeMap::new();
    for event in events.events() {
        match &event.fact {
            Fact::GrantIssued {
                grant, authorization, ..
            } => {
                available.insert(*grant, authorization.clone());
            }
            Fact::GrantConsumed { grant, .. } => {
                available.remove(grant);
            }
            _ => {}
        }
    }
    available
}

/// The audit view: the ordered events themselves. The control-plane history
/// is the log; a richer typed read model replaces this at the cutover.
pub fn audit(events: &EventSet) -> impl Iterator<Item = &crate::event::Event> {
    events.events().iter()
}
