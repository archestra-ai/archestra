//! Derived projections over the append-only [`EventSet`].
//!
//! Pure functions recomputed from the events on every call — nothing is
//! cached, so rebuild equivalence holds by construction and determinism is
//! exactly replay determinism. Labels are *recomputed* from each value's
//! admission-time inputs (the fold over its dependency projections), never
//! copied from the store, so agreement with the materialized read models is
//! a real check of the algebra, not of a copy.
//!
//! Two kinds of projection live here, and the distinction matters when
//! reading the parity suite:
//!
//! - **Independently recomputed** ([`value_labels`], [`provenance`],
//!   [`committed_effects`], [`audit_events`], [`confirmation_available`],
//!   [`grant_availability`]) — these re-derive from the facts what the
//!   read models compute at admission time, so agreeing with them is a real
//!   check.
//! - **The shared flow fold** ([`apply_flow_fact`]) — the *single* writer of
//!   the pending-action and pending-emission slots. `Trajectory` applies it
//!   per admitted batch (incremental) and [`pending_action`] /
//!   [`pending_emission`] fold it over the whole log (bulk). There is
//!   deliberately no second implementation to cross-check against: writing
//!   one would recreate the very duplication this module exists to remove.
//!   What parity checks here is that bulk replay reproduces incremental
//!   maintenance — exactly the property the cutover depends on.

use std::collections::{BTreeMap, BTreeSet};

use crate::ToolName;
use crate::audit::AuditEvent;
use crate::dimension::Effects;
use crate::event::{EventSet, Fact, ValueOrigin};
use crate::request::{PendingAction, PendingEmission};
use crate::revision::{GrantId, TurnId, ValueId};
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
                // Recomputed from the source label and the granted delta —
                // never the fact's own copy — so rebuild equivalence can
                // detect a recorded `raised` inconsistent with the raise.
                ValueOrigin::Endorsed { source, delta, .. } => delta.raise(
                    labels
                        .get(source)
                        .expect("endorse sources are admitted before their derivations"),
                ),
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

/// Materialize one admitted fact into the pending-slot read models — the
/// **only** writer of either slot, so the log is authoritative for the action
/// and emission lifecycles by construction (admission already refused any
/// fact contradicting them).
///
/// [`Trajectory::commit`](crate::turn::Trajectory) applies this per admitted
/// batch; [`flow_slots`] folds it over an entire log. Same function, so the
/// two can only disagree if a slot is written without a fact or facts are
/// replayed out of order — which is what the parity suite pins.
pub(crate) fn apply_flow_fact(
    pending: &mut Option<PendingAction>,
    pending_emission: &mut Option<PendingEmission>,
    fact: &Fact,
) {
    match fact {
        Fact::ActionProposed {
            action,
            flow,
            request,
            effects,
        } => {
            *pending = Some(PendingAction::proposed(
                *action,
                *flow,
                request.clone(),
                effects.clone(),
            ));
        }
        Fact::ActionConstrained { to_tool, effects, .. } => {
            pending
                .as_mut()
                .expect("admission guarantees a live action")
                .constrain(to_tool.clone(), effects.clone());
        }
        Fact::ArgumentSubstituted { from, to, .. } => {
            pending
                .as_mut()
                .expect("admission guarantees a live action")
                .substitute_argument(*from, *to);
        }
        Fact::GrowthAccepted { effects, .. } => {
            pending
                .as_mut()
                .expect("admission guarantees a live action")
                .accept_growth(effects.clone());
        }
        Fact::ActionReleased { .. } => {
            pending
                .as_mut()
                .expect("admission guarantees a live action")
                .mark_released();
        }
        Fact::ActionCompleted { .. } | Fact::DispatchFailed { .. } | Fact::ActionAbandoned { .. } => {
            *pending = None;
        }
        Fact::EmissionProposed { flow, request } => {
            *pending_emission = Some(PendingEmission::proposed(*flow, request.clone()));
        }
        Fact::EmissionBodySubstituted { from, to, .. } => {
            pending_emission
                .as_mut()
                .expect("admission guarantees a live emission")
                .substitute_body(*from, *to);
        }
        Fact::EmissionAbandoned { .. } | Fact::ResponseEmitted { .. } => {
            *pending_emission = None;
        }
        _ => {}
    }
}

/// Both flow slots, folded from the log in one pass. The two slots are
/// independent (a blocked emission never clears a pending action) but share
/// one fold, so they are derived together.
pub fn flow_slots(events: &EventSet) -> (Option<PendingAction>, Option<PendingEmission>) {
    let mut pending = None;
    let mut pending_emission = None;
    for event in events.events() {
        apply_flow_fact(&mut pending, &mut pending_emission, &event.fact);
    }
    (pending, pending_emission)
}

/// The live pending action, rebuilt from proposal/reduction/lifecycle facts —
/// including its `current` argument tree, replayed through the same
/// `substitute` the live path uses.
pub fn pending_action(events: &EventSet) -> Option<PendingAction> {
    flow_slots(events).0
}

/// The live pending emission, rebuilt from its proposal and body-substitution
/// facts.
pub fn pending_emission(events: &EventSet) -> Option<PendingEmission> {
    flow_slots(events).1
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

/// The control-plane audit history, synthesized from the facts: typed facts
/// build their own record, audit-only history rides `Fact::ControlPlane`
/// verbatim, and every other fact contributes nothing.
pub fn audit_events(events: &EventSet) -> Vec<AuditEvent> {
    events
        .events()
        .iter()
        .filter_map(|event| match &event.fact {
            Fact::EffectsCommitted { action, effects } => Some(AuditEvent::EffectsCommitted {
                action: *action,
                effects: effects.clone(),
            }),
            Fact::DispatchFailed { action } => Some(AuditEvent::DispatchFailed { action: *action }),
            Fact::AuthorizationApplied {
                transition,
                authorization,
                authority,
                resolved,
                derived,
                labels,
            } => Some(AuditEvent::AuthorizationApplied {
                transition: *transition,
                authorization: authorization.clone(),
                authority: authority.clone(),
                resolved: resolved.clone(),
                derived: *derived,
                labels: labels.clone(),
            }),
            Fact::AuthorizationDenied {
                authorization,
                authority,
                reason,
            } => Some(AuditEvent::AuthorizationDenied {
                authorization: authorization.clone(),
                authority: authority.clone(),
                reason: reason.clone(),
            }),
            Fact::ControlPlane { event } => Some(event.clone()),
            _ => None,
        })
        .collect()
}

/// Every derived read model of one trajectory, projected from the log in one
/// place. This is the sole build path for derived state: the engine holds one
/// of these and rebuilds it after each admitted batch, so there is no
/// hand-maintained field to drift.
#[derive(Debug)]
pub struct TrajectoryView {
    value_labels: BTreeMap<ValueId, ValueLabel>,
    provenance: BTreeMap<ValueId, Provenance>,
    committed_effects: Effects,
    audit: Vec<AuditEvent>,
    pending_action: Option<PendingAction>,
    pending_emission: Option<PendingEmission>,
    confirmation_available: Option<(TurnId, ToolName)>,
    grant_availability: BTreeMap<GrantId, crate::remedy::Authorization>,
}

impl TrajectoryView {
    /// Project every read model from the log. The one build path.
    pub fn project(events: &EventSet) -> Self {
        let (pending_action, pending_emission) = flow_slots(events);
        Self {
            value_labels: value_labels(events),
            provenance: provenance(events),
            committed_effects: committed_effects(events),
            audit: audit_events(events),
            pending_action,
            pending_emission,
            confirmation_available: confirmation_available(events),
            grant_availability: grant_availability(events),
        }
    }

    pub fn label(&self, value: ValueId) -> Option<&ValueLabel> {
        self.value_labels.get(&value)
    }

    pub fn value_labels(&self) -> &BTreeMap<ValueId, ValueLabel> {
        &self.value_labels
    }

    pub fn provenance_of(&self, value: ValueId) -> Option<&Provenance> {
        self.provenance.get(&value)
    }

    pub fn provenance(&self) -> &BTreeMap<ValueId, Provenance> {
        &self.provenance
    }

    /// The monotone committed effect surface.
    pub fn committed_effects(&self) -> &Effects {
        &self.committed_effects
    }

    pub fn audit(&self) -> &[AuditEvent] {
        &self.audit
    }

    pub fn pending_action(&self) -> Option<&PendingAction> {
        self.pending_action.as_ref()
    }

    pub fn pending_emission(&self) -> Option<&PendingEmission> {
        self.pending_emission.as_ref()
    }

    /// The confirmation currently in force, if any.
    pub fn confirmation_available(&self) -> Option<&(TurnId, ToolName)> {
        self.confirmation_available.as_ref()
    }

    pub fn grant_availability(&self) -> &BTreeMap<GrantId, crate::remedy::Authorization> {
        &self.grant_availability
    }
}
