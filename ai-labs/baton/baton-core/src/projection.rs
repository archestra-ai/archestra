//! Derived projections over the append-only [`EventSet`] — the **one** build
//! path for every read model of a trajectory.
//!
//! Pure functions of the log: a value's label is *computed here* from its
//! admission fact's inputs, the pending slots are folded here from their
//! lifecycle facts, the audit history is synthesized here from the facts that
//! record it. Nothing recomputes them anywhere else, so nothing can drift —
//! the class of bug a second, hand-maintained representation invites is
//! unrepresentable rather than tested for.
//!
//! [`Trajectory`](crate::turn::Trajectory) holds one [`TrajectoryProjection`]
//! and rebuilds it in full after each admitted batch. That costs O(dependency
//! edges) per mutation — [`value_labels`] refolds every historical value's
//! whole dependency set — so a trajectory of `n` values each citing Θ(n)
//! predecessors is cubic over its life, where admission-time folding was
//! quadratic. A deliberate trade at prototype scale: an incremental update
//! would be a second fold, which is precisely what this module exists to
//! avoid.

use std::collections::{BTreeMap, BTreeSet};

use crate::ToolName;
use crate::audit::AuditEvent;
use crate::dimension::Effects;
use crate::event::{EventSet, Fact, ValueOrigin};
use crate::request::{PendingAction, PendingEmission};
use crate::revision::{GrantId, TurnId, ValueId};
use crate::turn::{Actor, Turn};
use crate::value::{Provenance, UnknownValue, ValueLabel};

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
                // The contract's intrinsic label can only worsen the causal
                // fold, never override it.
                ValueOrigin::ToolOutput {
                    intrinsic,
                    arguments,
                    control,
                    ..
                } => {
                    let dependencies = fold(&labels, arguments).combine(fold(&labels, control));
                    let label = intrinsic.clone().combine(dependencies.clone());
                    // The general no-widening law, trust/audience instances:
                    // unaided admission never exposes more than the causal
                    // dependency fold — a contract-declared wider output
                    // (trust laundering, audience widening) is absorbed by the
                    // combine above, so the invariant holds by construction
                    // (the fold's worst-wins resolution of Unknown is not a
                    // widening — see `Trust::widening_over`). Only a
                    // *validated* transformer derivation or an
                    // *authority-granted* endorsement may sit below the fold.
                    // The effects instance binds at the flow check
                    // (`Effects::widening_over`). Always-on: this is the
                    // admission half of the no-widening law, cheap and
                    // load-bearing.
                    assert!(
                        label.trust.widening_over(&dependencies.trust).is_none()
                            && label.audience.widening_over(&dependencies.audience).is_none(),
                        "tool-output admission widened the dependency fold"
                    );
                    label
                }
                ValueOrigin::Transformed { declared, .. } => declared.clone(),
                // The authority's raise, applied to the source's label. The
                // fact carries the delta, not the result: one representation.
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

/// The turn sequence: who acted and the value they contributed, in log order.
pub fn turns(events: &EventSet) -> Vec<Turn> {
    events
        .events()
        .iter()
        .filter_map(|event| match &event.fact {
            Fact::TurnAppended { actor, value, .. } => Some(Turn {
                actor: actor.clone(),
                value: *value,
            }),
            _ => None,
        })
        .collect()
}

/// The values a provenance names as its direct ancestors — the edges the
/// closure walk follows.
fn provenance_parents(provenance: &Provenance) -> Vec<ValueId> {
    match provenance {
        Provenance::Ingress { .. } => Vec::new(),
        Provenance::ModelOutput { reads, control } => reads.iter().chain(control).copied().collect(),
        Provenance::ToolOutput { arguments, control, .. } => arguments.iter().chain(control).copied().collect(),
        Provenance::Transformed { source, .. } | Provenance::Endorsed { source, .. } => vec![*source],
    }
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

/// Fold one fact into the pending slots. Private to [`flow_slots`]: the slots
/// exist only as a projection, so this runs over the whole log or not at all
/// (admission has already refused any fact contradicting a lifecycle).
fn apply_flow_fact(pending: &mut Option<PendingAction>, pending_emission: &mut Option<PendingEmission>, fact: &Fact) {
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
            Fact::TurnAppended { turn, actor, .. } => {
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
/// place — the sole build path for derived state.
///
/// Named a *projection*, not a view, to keep it distinct from
/// [`crate::approval::TrajectoryView`], which is the narrow read-only slice an
/// inline authority is handed.
#[derive(Debug)]
pub struct TrajectoryProjection {
    value_labels: BTreeMap<ValueId, ValueLabel>,
    provenance: BTreeMap<ValueId, Provenance>,
    turns: Vec<Turn>,
    committed_effects: Effects,
    audit: Vec<AuditEvent>,
    pending_action: Option<PendingAction>,
    pending_emission: Option<PendingEmission>,
    confirmation_available: Option<(TurnId, ToolName)>,
    grant_availability: BTreeMap<GrantId, crate::remedy::Authorization>,
}

impl Default for TrajectoryProjection {
    /// The projection of an empty log.
    fn default() -> Self {
        Self::project(&EventSet::default())
    }
}

impl TrajectoryProjection {
    /// Project every read model from the log. The one build path.
    pub fn project(events: &EventSet) -> Self {
        let (pending_action, pending_emission) = flow_slots(events);
        Self {
            value_labels: value_labels(events),
            provenance: provenance(events),
            turns: turns(events),
            committed_effects: committed_effects(events),
            audit: audit_events(events),
            pending_action,
            pending_emission,
            confirmation_available: confirmation_available(events),
            grant_availability: grant_availability(events),
        }
    }

    /// The label of an admitted value. `None` is a caller naming a value this
    /// trajectory never admitted — see [`Self::fold_labels`], which reports it.
    pub fn label(&self, value: ValueId) -> Option<&ValueLabel> {
        self.value_labels.get(&value)
    }

    pub fn provenance_of(&self, value: ValueId) -> Option<&Provenance> {
        self.provenance.get(&value)
    }

    /// How many values the log has admitted. Ids are minted sequentially, so
    /// this is also one past the highest admitted [`ValueId`].
    pub fn admitted_values(&self) -> usize {
        self.value_labels.len()
    }

    /// Fold the labels of `ids`. Fails loudly on an unknown id: silently
    /// treating a missing dependency as `Unknown` would hide a caller bug.
    pub fn fold_labels<'a>(&self, ids: impl IntoIterator<Item = &'a ValueId>) -> Result<ValueLabel, UnknownValue> {
        let mut folded = ValueLabel::identity();
        for id in ids {
            folded = folded.combine(self.label(*id).ok_or(UnknownValue { id: *id })?.clone());
        }
        Ok(folded)
    }

    /// Every value reachable from `seeds` by following provenance edges — the
    /// transitive ancestry, seeds included. A visited-set graph walk; it
    /// terminates because provenance names only already-admitted values (minted
    /// with a lower id), so the ancestry graph is a DAG. Powers the D3 ruling
    /// context so an authority can inspect an endorsed value's suspicious
    /// ancestors, not just the immediate operation scope.
    pub fn provenance_closure(&self, seeds: impl IntoIterator<Item = ValueId>) -> BTreeSet<ValueId> {
        let mut seen = BTreeSet::new();
        let mut queue: Vec<ValueId> = seeds.into_iter().collect();
        while let Some(id) = queue.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Some(provenance) = self.provenance_of(id) {
                queue.extend(provenance_parents(provenance));
            }
        }
        seen
    }

    pub fn turns(&self) -> &[Turn] {
        &self.turns
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::{Audience, Trust, UserId};
    use crate::event::EventSet;
    use crate::revision::TransitionId;
    use crate::value::TransformerRef;

    fn readers(names: &[&str]) -> Audience {
        Audience::readers(names.iter().map(|n| UserId::new(*n)))
    }

    /// Admit one value-admission fact and hand back the id it names.
    fn admit(events: &mut EventSet, id: u64, origin: ValueOrigin) -> ValueId {
        let value = ValueId::new(id);
        events
            .append_batch(vec![Fact::ValueAdmitted { value, origin }])
            .expect("test facts are well formed");
        value
    }

    fn ingress(events: &mut EventSet, id: u64, label: ValueLabel) -> ValueId {
        admit(
            events,
            id,
            ValueOrigin::Ingress {
                turn: TurnId::new(id),
                label,
            },
        )
    }

    #[test]
    fn ingress_wears_the_caller_label() {
        let mut events = EventSet::default();
        let label = ValueLabel {
            audience: readers(&["alice"]),
            trust: Trust::TRUSTED,
        };
        let id = ingress(&mut events, 0, label.clone());
        assert_eq!(value_labels(&events).get(&id), Some(&label));
    }

    #[test]
    fn model_output_folds_reads_and_control() {
        let mut events = EventSet::default();
        let clean = ingress(&mut events, 0, ValueLabel::identity());
        let tainted = ingress(
            &mut events,
            1,
            ValueLabel {
                audience: readers(&["alice"]),
                trust: Trust::SUSPICIOUS,
            },
        );
        let derived = admit(
            &mut events,
            2,
            ValueOrigin::ModelOutput {
                reads: BTreeSet::from([clean]),
                control: BTreeSet::from([tainted]),
            },
        );
        let labels = value_labels(&events);
        let label = &labels[&derived];
        assert_eq!(label.trust, Trust::SUSPICIOUS);
        assert_eq!(label.audience, readers(&["alice"]));
    }

    #[test]
    fn tool_output_keeps_intrinsic_taint_despite_clean_inputs() {
        let mut events = EventSet::default();
        let clean = ingress(&mut events, 0, ValueLabel::identity());
        let out = admit(
            &mut events,
            1,
            ValueOrigin::ToolOutput {
                action: crate::revision::ActionId::new(0),
                intrinsic: ValueLabel {
                    audience: Audience::PUBLIC,
                    trust: Trust::SUSPICIOUS,
                },
                arguments: BTreeSet::from([clean]),
                control: BTreeSet::new(),
            },
        );
        assert_eq!(value_labels(&events)[&out].trust, Trust::SUSPICIOUS);
    }

    #[test]
    fn identity_intrinsic_cannot_improve_tainted_dependencies() {
        let mut events = EventSet::default();
        let tainted = ingress(
            &mut events,
            0,
            ValueLabel {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
            },
        );
        let out = admit(
            &mut events,
            1,
            ValueOrigin::ToolOutput {
                action: crate::revision::ActionId::new(0),
                intrinsic: ValueLabel::identity(),
                arguments: BTreeSet::from([tainted]),
                control: BTreeSet::new(),
            },
        );
        assert_eq!(value_labels(&events)[&out].trust, Trust::SUSPICIOUS);
    }

    /// The general no-widening law holds at tool-output admission by
    /// construction: a declared wider output (trusted over a suspicious fold,
    /// public over a bounded fold) is absorbed by the conservative combine —
    /// the derived label never widens the dependency fold on any value
    /// dimension. The effects instance binds at the flow check instead
    /// (effects are trajectory state, not a value dimension).
    #[test]
    fn tool_output_admission_never_widens_the_dependency_fold() {
        let mut events = EventSet::default();
        let bounded_suspicious = ingress(
            &mut events,
            0,
            ValueLabel {
                audience: readers(&["alice"]),
                trust: Trust::SUSPICIOUS,
            },
        );
        let fold = value_labels(&events)[&bounded_suspicious].clone();
        let out = admit(
            &mut events,
            1,
            ValueOrigin::ToolOutput {
                action: crate::revision::ActionId::new(0),
                intrinsic: ValueLabel {
                    audience: Audience::PUBLIC,
                    trust: Trust::TRUSTED,
                },
                arguments: BTreeSet::from([bounded_suspicious]),
                control: BTreeSet::new(),
            },
        );
        let labels = value_labels(&events);
        let admitted = &labels[&out];
        assert_eq!(admitted, &fold);
        assert!(admitted.trust.widening_over(&fold.trust).is_none());
        assert!(admitted.audience.widening_over(&fold.audience).is_none());
    }

    /// The fold's worst-wins resolution is not a widening: an intrinsically
    /// suspicious output over an unknown dependency admits at known
    /// `Suspicious` (so it satisfies a `Suspicious` floor the unknown input
    /// could not) without tripping the no-widening invariant — becoming
    /// known-bad grants nothing upward.
    #[test]
    fn suspicious_intrinsic_over_unknown_fold_is_not_a_widening() {
        let mut events = EventSet::default();
        let unknown_dep = ingress(
            &mut events,
            0,
            ValueLabel {
                audience: readers(&["alice"]),
                trust: Trust::UNKNOWN,
            },
        );
        let out = admit(
            &mut events,
            1,
            ValueOrigin::ToolOutput {
                action: crate::revision::ActionId::new(0),
                intrinsic: ValueLabel {
                    audience: readers(&["alice"]),
                    trust: Trust::SUSPICIOUS,
                },
                arguments: BTreeSet::from([unknown_dep]),
                control: BTreeSet::new(),
            },
        );
        let labels = value_labels(&events);
        let admitted = &labels[&out];
        // Worst wins: the known-bad judgement resolves the unknown downward.
        assert_eq!(admitted.trust, Trust::SUSPICIOUS);
        assert!(matches!(
            admitted.trust.at_least(crate::dimension::KnownTrust::Suspicious),
            crate::preset::Adequacy::Holds
        ));
        assert!(admitted.trust.widening_over(&Trust::UNKNOWN).is_none());
    }

    #[test]
    fn transformed_value_wears_declared_label_and_source_is_untouched() {
        let mut events = EventSet::default();
        let raw = ingress(
            &mut events,
            0,
            ValueLabel {
                audience: readers(&["alice"]),
                trust: Trust::SUSPICIOUS,
            },
        );
        let derived = admit(
            &mut events,
            1,
            ValueOrigin::Transformed {
                source: raw,
                transition: TransitionId::new(0),
                transformer: TransformerRef {
                    id: "pii.redact".into(),
                    version: 1,
                },
                declared: ValueLabel::identity(),
            },
        );
        let labels = value_labels(&events);
        assert_eq!(labels[&derived], ValueLabel::identity());
        assert_eq!(labels[&raw].trust, Trust::SUSPICIOUS);
    }

    #[test]
    fn folding_an_unknown_dependency_fails_loudly() {
        let projection = TrajectoryProjection::project(&EventSet::default());
        let missing = ValueId::new(41);
        assert_eq!(
            projection.fold_labels([&missing]).unwrap_err(),
            UnknownValue { id: missing }
        );
    }

    /// Admission prevalidates against the projection *before* committing, so
    /// naming an unknown dependency is refused and writes nothing — no fact,
    /// no revision advance, no body.
    #[test]
    fn admitting_an_unknown_dependency_is_refused_without_touching_state() {
        let mut trajectory = crate::turn::Trajectory::new();
        let before = trajectory.revision();
        let missing = ValueId::new(41);

        let err = trajectory
            .admit_model_output(
                crate::value::OpaqueValue::new("x"),
                BTreeSet::from([missing]),
                BTreeSet::new(),
            )
            .unwrap_err();

        assert_eq!(err, UnknownValue { id: missing });
        assert_eq!(trajectory.revision(), before, "a refused admission advances nothing");
        assert!(
            trajectory.events().events().is_empty(),
            "a refused admission appends nothing"
        );
    }

    /// The ancestry walk follows provenance edges transitively, so a value
    /// laundered below the fold still names its suspicious ancestor.
    #[test]
    fn provenance_closure_reaches_transitive_ancestors() {
        let mut events = EventSet::default();
        let raw = ingress(
            &mut events,
            0,
            ValueLabel {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
            },
        );
        let redacted = admit(
            &mut events,
            1,
            ValueOrigin::Transformed {
                source: raw,
                transition: TransitionId::new(0),
                transformer: TransformerRef {
                    id: "pii.redact".into(),
                    version: 1,
                },
                declared: ValueLabel::identity(),
            },
        );
        let summary = admit(
            &mut events,
            2,
            ValueOrigin::ModelOutput {
                reads: BTreeSet::from([redacted]),
                control: BTreeSet::new(),
            },
        );
        let projection = TrajectoryProjection::project(&events);
        assert_eq!(
            projection.provenance_closure([summary]),
            BTreeSet::from([summary, redacted, raw])
        );
    }
}
