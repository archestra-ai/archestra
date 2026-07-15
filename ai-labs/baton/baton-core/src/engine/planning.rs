use std::collections::{BTreeMap, BTreeSet};

use crate::ToolName;
use crate::approval::{Authority, AuthorityMode};
use crate::contract::{AudienceRule, Fixability, Requirements, Unprovable, Verdict, Violation};
use crate::dimension::{Effects, KnownTrust};
use crate::plan::{ExitKind, Justification, NonEmptyVec, Posture, TransitionKind, TransitionSpec};
use crate::request::ToolRequest;
use crate::revision::ValueId;
use crate::transition::{ActionTransition, EndorseDelta, ProposedGrant, RegisteredTransformer, TransientWaiver};
use crate::turn::Trajectory;
use crate::value::{UnknownValue, ValueLabel};

use super::capability::ToolContract;
use super::{MAX_PLANS, PolicyEngine};

/// A successful joint-cleanability probe: the per-leaf raises — each with the
/// projected residual at its own peel, the vector its ruling authority is
/// shown — and the final waiver (release + residual lift + acknowledged
/// facts). The raise list may be empty: a non-monotone subset release can be
/// clean on its own.
struct JointRescue {
    endorse: Vec<(ValueId, EndorseDelta, Vec<Violation>)>,
    delta: TransientWaiver,
}

/// Exhaustive-subset bound for the rescue's release search; a larger control
/// set refuses the rescue outright (fail-closed).
const RESCUE_EXHAUSTIVE_MAX: usize = 12;

/// A constrain candidate that passed [`PolicyEngine::constrain_gate`]: the
/// transition with its target contract and the recipients resolved under the
/// target's schema.
struct ConstrainCandidate<'a> {
    transition: &'a ActionTransition,
    target: &'a ToolContract,
    recipients: BTreeSet<crate::dimension::UserId>,
}

impl PolicyEngine {
    /// Deterministic bounded plan enumeration: candidate step sequences in the
    /// canonical order Sanitize? -> Constrain? -> Endorse* -> Accept? ->
    /// Waiver?, each subset instantiated from the registries in registration
    /// order, kept iff the predicted final posture is clean, capped at
    /// [`MAX_PLANS`].
    pub(super) fn enumerate_plans(
        &self,
        trajectory: &Trajectory,
        checked: &ToolRequest,
        contract: Option<&ToolContract>,
        pending: &crate::request::PendingAction,
    ) -> Vec<(NonEmptyVec<TransitionSpec>, Posture)> {
        let base = match SimFlow::of(trajectory, checked, contract) {
            Ok(base) => base,
            // A dependency vanished mid-evaluation cannot happen (the store
            // is append-only and we validated already), but fail closed.
            Err(_) => return Vec::new(),
        };

        // Candidate transform steps: non-recipient argument leaves x
        // registered transformers whose precondition matches, in (leaf,
        // registration) order.
        let recipient_leaves: BTreeSet<ValueId> = contract
            .and_then(|c| {
                c.arguments
                    .recipients
                    .as_ref()
                    .and_then(|role| checked.arguments.top_level(role))
            })
            .map(|subtree| subtree.leaves())
            .unwrap_or_default();
        let mut transforms: Vec<(ValueId, &RegisteredTransformer)> = Vec::new();
        for leaf in checked.arguments.leaves() {
            if recipient_leaves.contains(&leaf) {
                continue;
            }
            let label = &base.leaf_labels[&leaf];
            for transformer in &self.transformers {
                if transformer.descriptor.precondition.matches(label) && transformer.descriptor.output != *label {
                    transforms.push((leaf, transformer));
                }
            }
        }

        // Candidate constrain steps: registered action transitions from this
        // tool that pass the same structural gate the applier rechecks
        // (`constrain_gate`), carried with their target contract and resolved
        // recipients.
        let constrains: Vec<ConstrainCandidate<'_>> = self
            .action_transitions
            .iter()
            .filter_map(|t| {
                self.constrain_gate(t, pending, checked, trajectory.store(), &base.recipients)
                    .ok()
                    .map(|(target, recipients)| ConstrainCandidate {
                        transition: t,
                        target,
                        recipients,
                    })
            })
            .collect();

        let mut plans: Vec<(NonEmptyVec<TransitionSpec>, Posture)> = Vec::new();
        let transform_options: Vec<Option<&(ValueId, &RegisteredTransformer)>> =
            std::iter::once(None).chain(transforms.iter().map(Some)).collect();
        let constrain_options: Vec<Option<&ConstrainCandidate<'_>>> =
            std::iter::once(None).chain(constrains.iter().map(Some)).collect();

        // Generate the full candidate cartesian so `select_fair` sees every
        // applicable category before trimming to MAX_PLANS — any pre-trim cap
        // (on the plan pool or the candidate lists) can drop the sole clearing
        // route of a category and starve it, and confirming a category has no
        // clearing route requires trying all its candidates. The cartesian is
        // bounded by the construction-time registries times the request's leaf
        // count; the latter's quadratic scaling is a documented follow-up.
        for transform in &transform_options {
            for constrain in &constrain_options {
                let mut sim = base.clone();
                let mut steps: Vec<TransitionSpec> = Vec::new();

                if let Some((leaf, transformer)) = transform {
                    let precondition = Posture {
                        remaining: sim.violations(None),
                    };
                    sim.leaf_labels.insert(*leaf, transformer.descriptor.output.clone());
                    steps.push(TransitionSpec {
                        precondition,
                        postcondition: Posture {
                            remaining: sim.violations(None),
                        },
                        kind: TransitionKind::Derive {
                            source: *leaf,
                            justification: Justification::Content(transformer.descriptor.transformer.clone()),
                        },
                    });
                }
                if let Some(ConstrainCandidate {
                    transition,
                    target,
                    recipients,
                }) = constrain
                {
                    let precondition = Posture {
                        remaining: sim.violations(None),
                    };
                    sim.tool = transition.to_tool.clone();
                    sim.adopt_requires(&target.requires);
                    sim.recipients = recipients.clone();
                    // The constrain narrows the proposed effects, so any surface
                    // growth is recomputed against the reduced set — an Accept
                    // then authorizes only the residual growth (a full constrain
                    // to no-egress leaves none).
                    sim.proposed_effects = transition.effects.clone();
                    steps.push(TransitionSpec {
                        precondition,
                        postcondition: Posture {
                            remaining: sim.violations(None),
                        },
                        kind: TransitionKind::ConstrainAction {
                            transition: transition.id.clone(),
                        },
                    });
                }

                let mut remaining = sim.violations(None);

                // Criterion (2): peel a confidentiality sink breach into Endorse
                // steps — one durable relabel per arg leaf whose own label fails
                // the sink requirement (multi-source). Computed on the
                // post-reduction residual, so a sanitizer's reduction shrinks what
                // the authority must vouch. A control-borne residual is left to
                // the control-release waiver below. All contributing leaves must
                // be endorsable, else this branch cannot clear the breach.
                let endorse = endorse_steps(&sim, &remaining);
                let endorsable = endorse.iter().all(|(leaf, delta)| {
                    self.can_authorize(&ProposedGrant::Endorse {
                        source: *leaf,
                        delta: delta.clone(),
                    })
                });
                if endorsable {
                    for (leaf, delta) in endorse {
                        let precondition = Posture {
                            remaining: remaining.clone(),
                        };
                        let raised = delta.raise(&sim.leaf_labels[&leaf]);
                        sim.leaf_labels.insert(leaf, raised);
                        let targets = precondition.remaining.clone();
                        remaining = sim.violations(None);
                        steps.push(TransitionSpec {
                            precondition,
                            postcondition: Posture {
                                remaining: remaining.clone(),
                            },
                            kind: TransitionKind::Derive {
                                source: leaf,
                                justification: Justification::Fiat { delta, targets },
                            },
                        });
                    }
                }

                // Criterion (1): peel any surface growth into an Accept step
                // before a waiver handles the confidentiality residual. Accept
                // composes additively with a waiver — they are separate steps to
                // separate competences (acquire_effects vs the lift dims).
                if let Some(growth) = surface_growth_of(&remaining) {
                    let grant = ProposedGrant::Accept {
                        effects: growth.clone(),
                    };
                    if !self.can_authorize(&grant) {
                        // No authority can acquire this effect: this branch
                        // cannot reach a clean posture, so it yields no plan.
                        continue;
                    }
                    let precondition = Posture {
                        remaining: remaining.clone(),
                    };
                    sim.accepted_effects = sim.accepted_effects.clone().combine(growth.clone());
                    remaining = sim.violations(None);
                    steps.push(TransitionSpec {
                        precondition,
                        postcondition: Posture {
                            remaining: remaining.clone(),
                        },
                        kind: TransitionKind::AcceptGrowth { effects: growth },
                    });
                }

                if remaining.is_empty() {
                    if let Some(steps) = NonEmptyVec::from_vec(steps) {
                        push_plan(&mut plans, steps, Posture::clean());
                    }
                    continue;
                }

                // A final waiver for whatever remains. Prefer the narrower
                // control-release variant when the taint is control-borne.
                let precondition = Posture {
                    remaining: remaining.clone(),
                };
                for delta in self.waiver_candidates(&sim, &remaining) {
                    if !sim.violations(Some(&delta)).is_empty() {
                        continue;
                    }
                    let grant = grant_for(&delta, &remaining);
                    if !self.can_authorize(&grant) {
                        continue;
                    }
                    let mut waiver_steps = steps.clone();
                    waiver_steps.push(TransitionSpec {
                        precondition: precondition.clone(),
                        postcondition: Posture::clean(),
                        kind: TransitionKind::ApplyWaiver { delta },
                    });
                    let steps = NonEmptyVec::from_vec(waiver_steps).expect("waiver step just pushed");
                    push_plan(&mut plans, steps, Posture::clean());
                    break;
                }
            }
        }
        select_fair(plans, MAX_PLANS)
    }

    /// Terminal rescue: a joint Endorse×control-release solve, consulted only
    /// when ordinary enumeration yields no plan — so existing plan sets are
    /// untouched, and a rescue route exists only where the flow was terminal.
    ///
    /// Ordinary enumeration peels Endorse from the *unreleased* residual and
    /// measures a control release against the release-all raw vector, both of
    /// which assume releasing control monotonically improves adequacy. That is
    /// false when a control dep masks an argument's `Unknown` in the trust
    /// fold: the valid plan must endorse against the *projected post-release*
    /// residual and then release. This solver searches release candidates for
    /// joint cleanability: project the release, derive per-leaf Endorse
    /// deltas from the projection (a candidate may need none — releasing a
    /// non-monotone *subset* can be clean on its own, which the release-all
    /// anchored ordinary solver misses), compose an Accept for any projected
    /// growth and the final waiver (carrying its acknowledge-only facts),
    /// and keep the candidate iff every grant is authorizable and the
    /// projection then clears.
    pub(super) fn rescue_plans(
        &self,
        trajectory: &Trajectory,
        checked: &ToolRequest,
        contract: Option<&ToolContract>,
    ) -> Vec<(NonEmptyVec<TransitionSpec>, Posture)> {
        let base = match SimFlow::of(trajectory, checked, contract) {
            Ok(base) => base,
            Err(_) => return Vec::new(),
        };
        if base.control_labels.is_empty() {
            return Vec::new();
        }
        let ids: Vec<ValueId> = base.control_labels.keys().copied().collect();
        let Some(rescue) = self.minimal_joint_release(&base, &ids) else {
            return Vec::new();
        };

        // The plan's postures are the *actual* flow at each application point
        // (apply-time preconditions compare against reality); an Endorse step
        // may leave the actual posture unchanged while the mask holds — its
        // effect is visible only in the projection its `targets` carry.
        let mut sim = base;
        let mut steps = Vec::new();
        let mut remaining = sim.violations(None);
        for (leaf, delta, targets) in &rescue.endorse {
            let precondition = Posture {
                remaining: remaining.clone(),
            };
            let raised = delta.raise(&sim.leaf_labels[leaf]);
            sim.leaf_labels.insert(*leaf, raised);
            remaining = sim.violations(None);
            steps.push(TransitionSpec {
                precondition,
                postcondition: Posture {
                    remaining: remaining.clone(),
                },
                kind: TransitionKind::Derive {
                    source: *leaf,
                    justification: Justification::Fiat {
                        delta: delta.clone(),
                        targets: targets.clone(),
                    },
                },
            });
        }
        if let Some(growth) = surface_growth_of(&remaining) {
            let precondition = Posture {
                remaining: remaining.clone(),
            };
            sim.accepted_effects = sim.accepted_effects.clone().combine(growth.clone());
            remaining = sim.violations(None);
            steps.push(TransitionSpec {
                precondition,
                postcondition: Posture {
                    remaining: remaining.clone(),
                },
                kind: TransitionKind::AcceptGrowth { effects: growth },
            });
        }
        if !sim.violations(Some(&rescue.delta)).is_empty() {
            return Vec::new();
        }
        steps.push(TransitionSpec {
            precondition: Posture {
                remaining: remaining.clone(),
            },
            postcondition: Posture::clean(),
            kind: TransitionKind::ApplyWaiver { delta: rescue.delta },
        });
        match NonEmptyVec::from_vec(steps) {
            Some(steps) => vec![(steps, Posture::clean())],
            None => Vec::new(),
        }
    }

    /// The smallest release whose joint composition clears the projection:
    /// an exhaustive size-ascending subset search, deterministic, whose first
    /// hit is size-minimal (hence inclusion-minimal — any feasible proper
    /// subset would have been probed earlier). The space is bounded by the
    /// request's own control set — agent-shaped, not adversarial — and hard-
    /// capped: past [`RESCUE_EXHAUSTIVE_MAX`] deps the rescue *refuses*
    /// (fail-closed terminal). No partial search substitutes — a greedy
    /// anchored anywhere inherits exactly the non-monotone blindness this
    /// solver exists to fix, and the monotone cases a greedy could still
    /// clear are ordinary enumeration's domain. The empty release is not
    /// probed for the same reason: an unreleased endorse-plus-waiver solve is
    /// ordinary enumeration's domain, and the rescue only runs when that came
    /// up empty.
    fn minimal_joint_release(&self, base: &SimFlow, ids: &[ValueId]) -> Option<JointRescue> {
        let n = ids.len();
        if n > RESCUE_EXHAUSTIVE_MAX {
            return None;
        }
        let mut masks: Vec<u32> = (1..(1u32 << n)).collect();
        masks.sort_by_key(|mask| (mask.count_ones(), *mask));
        for mask in masks {
            let release: BTreeSet<ValueId> = ids
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, id)| *id)
                .collect();
            if let Some(rescue) = self.joint_rescue(base, &release) {
                return Some(rescue);
            }
        }
        None
    }

    /// One joint-cleanability probe for a release candidate. `None` when any
    /// required grant has no competent authority or the composed remedies do
    /// not clear the projection. An empty endorse set is a valid solve: a
    /// non-monotone subset release can be clean on its own.
    fn joint_rescue(&self, base: &SimFlow, release: &BTreeSet<ValueId>) -> Option<JointRescue> {
        let mut projected = base.clone();
        projected.control_labels.retain(|id, _| !release.contains(id));
        // `violations(None)`, not `violations(Some(_))`: the projection must
        // keep acknowledge-only facts (they route the final grant to an
        // `acknowledge_unknown` competence) and the growth breach.
        // Peel one raise at a time and re-derive: a single raise can clear
        // more than its own deficit (raising one leaf to the bottom bar
        // re-masks the remaining `Unknown`s in the min-fold), so applying an
        // up-front batch would over-endorse. Each step's targets are the
        // projected residual at its own peel, so an authority is never shown
        // deficits an earlier raise already cleared and never asked for a
        // raise the fold no longer needs. Terminates: every step strictly
        // raises one leaf's label, bounded by leaves × dimensions.
        let mut endorse = Vec::new();
        let mut residual = projected.violations(None);
        while let Some((leaf, delta)) = endorse_steps(&projected, &residual).into_iter().next() {
            if !self.can_authorize(&ProposedGrant::Endorse {
                source: leaf,
                delta: delta.clone(),
            }) {
                return None;
            }
            let raised = delta.raise(&projected.leaf_labels[&leaf]);
            projected.leaf_labels.insert(leaf, raised);
            endorse.push((leaf, delta, residual));
            residual = projected.violations(None);
        }
        if let Some(growth) = surface_growth_of(&residual) {
            if !self.can_authorize(&ProposedGrant::Accept {
                effects: growth.clone(),
            }) {
                return None;
            }
            projected.accepted_effects = projected.accepted_effects.clone().combine(growth);
            residual = projected.violations(None);
        }
        let mut delta = needed_delta(&residual);
        delta.control_release = release.clone();
        if !self.can_authorize(&grant_for(&delta, &residual)) {
            return None;
        }
        if !projected.violations(Some(&delta)).is_empty() {
            return None;
        }
        Some(JointRescue { endorse, delta })
    }

    /// Deterministic waiver candidates for a remaining violation set: the
    /// scoped control-release variant first when releasing control shrinks the
    /// residual, then the plain delta. The waiver clears only the non-relabel
    /// dims (prior effects, confirmation, control release); trust/audience route
    /// to Endorse steps peeled before this.
    fn waiver_candidates(&self, sim: &SimFlow, remaining: &[Violation]) -> Vec<TransientWaiver> {
        let mut candidates = Vec::new();
        if let Some(release) = self.minimal_control_release(sim) {
            let after = sim.violations(Some(&TransientWaiver {
                control_release: release.clone(),
                ..TransientWaiver::empty()
            }));
            let mut delta = needed_delta(&after);
            delta.control_release = release;
            candidates.push(delta);
        }
        let plain = needed_delta(remaining);
        if !candidates.contains(&plain) {
            candidates.push(plain);
        }
        candidates
    }

    /// The least-privilege control-release set: an inclusion-minimal set of
    /// control deps whose release shrinks the residual *violation set* as far as
    /// releasing every control dep would. `None` when releasing control changes
    /// nothing (the breach is arg-borne, not control-borne). Measured on the
    /// violation set, not a waiver delta — so a control-borne trust/audience
    /// breach, which produces no waiver delta, still yields a release.
    /// Take the best reduction (release all), then remove redundant deps to a
    /// fixpoint: a dep can become redundant only after a *later* dep is dropped
    /// (one control masking another's contribution to the fold — e.g. Suspicious
    /// masking Unknown in the trust fold), which a single pass never revisits.
    /// At the fixpoint no single dep is removable while still reaching `full`, so
    /// the set is inclusion-minimal (D4). At most O(control²) probes.
    fn minimal_control_release(&self, sim: &SimFlow) -> Option<BTreeSet<ValueId>> {
        let ids: Vec<ValueId> = sim.control_labels.keys().copied().collect();
        if ids.is_empty() {
            return None;
        }
        let residual = |set: &BTreeSet<ValueId>| -> Vec<Violation> {
            sim.violations(Some(&TransientWaiver {
                control_release: set.clone(),
                ..TransientWaiver::empty()
            }))
        };
        // Compare like with like: both baselines go through `violations(Some(_))`,
        // which filters acknowledge-only facts, so the difference is purely the
        // control release (not the acknowledge-only filtering that separates
        // `violations(None)` from `violations(Some(_))`).
        let none = residual(&BTreeSet::new());
        let all: BTreeSet<ValueId> = ids.iter().copied().collect();
        let full = residual(&all);
        if full == none {
            return None;
        }
        let mut minimal = all;
        loop {
            let mut progressed = false;
            for id in &ids {
                if !minimal.contains(id) {
                    continue;
                }
                let mut candidate = minimal.clone();
                candidate.remove(id);
                if residual(&candidate) == full {
                    minimal = candidate;
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        Some(minimal)
    }

    /// Authorities competent for `grant`, in routing order: inline before
    /// external (a deterministic answer beats a round-trip to a human), each in
    /// registration order. An inline authority may still abstain at ruling
    /// time, which falls through to the next authority in this order.
    pub(super) fn competent_authorities<'a>(&'a self, grant: &'a ProposedGrant) -> impl Iterator<Item = &'a Authority> {
        let inline = self
            .authorities
            .iter()
            .filter(move |a| matches!(a.mode, AuthorityMode::Inline(_)) && a.mandate.covers(grant));
        let external = self
            .authorities
            .iter()
            .filter(move |a| matches!(a.mode, AuthorityMode::External) && a.mandate.covers(grant));
        inline.chain(external)
    }

    /// Is any authority competent for `grant`? A grant step (waiver, accept, or
    /// acknowledgment) is enumerated only when one exists; the actual ruling —
    /// which an inline authority may abstain from, falling through to the next —
    /// happens at application.
    fn can_authorize(&self, grant: &ProposedGrant) -> bool {
        self.competent_authorities(grant).next().is_some()
    }
}

/// Trim enumerated candidates to `cap`, guaranteeing the best (fewest-step, then
/// earliest) route of each applicable [`ExitKind`] survives before remaining
/// slots fill in enumeration order — so the cap never starves a category.
/// Enumeration order is otherwise preserved, and a pool already within `cap` is
/// returned unchanged.
pub(super) fn select_fair(
    plans: Vec<(NonEmptyVec<TransitionSpec>, Posture)>,
    cap: usize,
) -> Vec<(NonEmptyVec<TransitionSpec>, Posture)> {
    if plans.len() <= cap {
        return plans;
    }
    let categories: Vec<ExitKind> = plans.iter().map(|(steps, _)| ExitKind::decisive(steps)).collect();
    let mut keep = vec![false; plans.len()];
    let mut kept = 0usize;
    // Pass 1: the fewest-step (then earliest) route of each category.
    for cat in categories.iter().copied().collect::<BTreeSet<_>>() {
        if kept >= cap {
            break;
        }
        if let Some(best) = (0..plans.len())
            .filter(|&i| categories[i] == cat)
            .min_by_key(|&i| (plans[i].0.len(), i))
        {
            keep[best] = true;
            kept += 1;
        }
    }
    // Pass 2: fill remaining slots in enumeration order.
    for slot in keep.iter_mut() {
        if kept >= cap {
            break;
        }
        if !*slot {
            *slot = true;
            kept += 1;
        }
    }
    plans
        .into_iter()
        .zip(keep)
        .filter_map(|(plan, keep)| keep.then_some(plan))
        .collect()
}

fn push_plan(
    plans: &mut Vec<(NonEmptyVec<TransitionSpec>, Posture)>,
    steps: NonEmptyVec<TransitionSpec>,
    final_postcondition: Posture,
) {
    if plans.iter().all(|(existing, _)| *existing != steps) {
        plans.push((steps, final_postcondition));
    }
}

/// The pure simulation state of one flow's check: per-leaf argument labels
/// (so a transform can be predicted by swapping one), the control fold, and
/// the sink parameters. Prediction (planning) and validation (application)
/// share this so a plan's postconditions mean exactly what the recheck
/// computes.
#[derive(Debug, Clone)]
pub(crate) struct SimFlow {
    pub(crate) leaf_labels: BTreeMap<ValueId, ValueLabel>,
    /// Control dependencies kept individually (not pre-folded) so a scoped
    /// `control_release` can exclude exactly the named deps and attribution can
    /// ask which single dep carries a breach dimension.
    pub(crate) control_labels: BTreeMap<ValueId, ValueLabel>,
    pub(crate) tool: ToolName,
    pub(crate) requires: Requirements,
    pub(crate) recipients: BTreeSet<crate::dimension::UserId>,
    pub(crate) past_effects: Effects,
    /// The effects this call proposes (the contract's, or the pending action's
    /// possibly-constrained effects on re-entry). Criterion (1) checks whether
    /// committing them would grow the past surface.
    pub(crate) proposed_effects: Effects,
    /// Surface growth already acquired for the pending action; suppresses the
    /// growth soft-ban for the effects it covers.
    pub(crate) accepted_effects: Effects,
    pub(crate) confirmed: Option<ToolName>,
    /// Violations independent of the check (a missing contract).
    pub(crate) extra: Vec<Violation>,
}

impl SimFlow {
    pub(crate) fn of(
        trajectory: &Trajectory,
        checked: &ToolRequest,
        contract: Option<&ToolContract>,
    ) -> Result<Self, UnknownValue> {
        let store = trajectory.store();
        let mut leaf_labels = BTreeMap::new();
        for leaf in checked.arguments.leaves() {
            leaf_labels.insert(leaf, store.get(leaf)?.label().clone());
        }
        let mut control_labels = BTreeMap::new();
        for id in checked.control.iter() {
            control_labels.insert(*id, store.get(*id)?.label().clone());
        }
        let (recipients, extra) = match contract {
            Some(c) => (c.arguments.resolve_recipients(&checked.arguments, store)?, Vec::new()),
            None => (
                BTreeSet::new(),
                vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: checked.tool.clone(),
                })],
            ),
        };
        // Proposed and accepted effects come from the pending action when one
        // exists (its proposed_effects reflect any constrain narrowing; its
        // accepted_effects any prior Accept), else the contract's declaration.
        let (proposed_effects, accepted_effects) = match trajectory.pending_action() {
            Some(pending) => (pending.proposed_effects().clone(), pending.accepted_effects().clone()),
            None => (
                contract.map(|c| c.effects.clone()).unwrap_or(Effects::UNKNOWN),
                Effects::none(),
            ),
        };
        let mut sim = Self {
            leaf_labels,
            control_labels,
            tool: checked.tool.clone(),
            requires: Requirements::default(),
            recipients,
            past_effects: trajectory.state().past_effects().clone(),
            proposed_effects,
            accepted_effects,
            confirmed: trajectory.pending_confirmation().cloned(),
            extra,
        };
        if let Some(c) = contract {
            sim.adopt_requires(&c.requires);
        }
        Ok(sim)
    }

    /// Adopt a contract's requirement declaration: known requirements are
    /// checked; unknown ones (None) contribute the RequirementsUnknown fact
    /// instead. Keeps `extra` consistent when a constrain retargets the sim.
    pub(crate) fn adopt_requires(&mut self, requires: &Option<Requirements>) {
        self.extra
            .retain(|v| !matches!(v, Violation::Unprovable(Unprovable::RequirementsUnknown)));
        match requires {
            Some(requires) => self.requires = requires.clone(),
            None => {
                self.requires = Requirements::default();
                self.extra.push(Violation::Unprovable(Unprovable::RequirementsUnknown));
            }
        }
    }

    /// The folded flow label — tracing context only, never a check input.
    pub(super) fn flow_label(&self) -> ValueLabel {
        ValueLabel::fold(self.leaf_labels.values().cloned())
            .combine(ValueLabel::fold(self.control_labels.values().cloned()))
    }

    /// The violations this flow would report, optionally under a
    /// check-transient waiver. A waiver lifts exactly its declared
    /// dimensions and acknowledges acknowledge-only facts on the record.
    pub(crate) fn violations(&self, waiver: Option<&TransientWaiver>) -> Vec<Violation> {
        let released = waiver.map(|w| &w.control_release);
        let control = ValueLabel::fold(self.control_labels.iter().filter_map(|(id, label)| {
            if released.is_some_and(|set| set.contains(id)) {
                None
            } else {
                Some(label.clone())
            }
        }));
        // Trust and audience are not liftable here: raising a value's
        // confidentiality label is a durable Endorse relabel that mints a new
        // leaf value (folded above), not a transient whole-flow lift.
        let flow = ValueLabel::fold(self.leaf_labels.values().cloned()).combine(control);
        let mut past = self.past_effects.clone();
        let mut confirmed = self.confirmed.clone();
        if let Some(w) = waiver {
            if let Some(waived) = &w.prior_effects {
                past = past.waiving(waived);
            }
            if w.confirms {
                confirmed = Some(self.tool.clone());
            }
        }
        let mut remaining = self.extra.clone();
        match self
            .requires
            .check_flow(&flow, &past, confirmed.as_ref(), &self.tool, &self.recipients)
        {
            Verdict::Allow => {}
            Verdict::Escalate(violations) => remaining.extend(violations),
        }
        // Criterion (1): the growth check is over the *committed* surface, not
        // the waiver-adjusted `past` — a waiver lifts a prior-effect sink check,
        // not what the call would commit. An Accept marker (accepted_effects)
        // suppresses growth it already acquired.
        let effective_past = self.past_effects.clone().combine(self.accepted_effects.clone());
        if let Some(growth) = self.proposed_effects.growth_over(&effective_past) {
            remaining.push(Violation::Breach(crate::contract::Breach::SurfaceGrowth { growth }));
        }
        if waiver.is_some() {
            remaining.retain(|v| v.fixability() != Fixability::AcknowledgeOnly);
        }
        remaining
    }
}

/// The typed grant a residual asks an authority to authorize. A non-empty
/// lift is a [`ProposedGrant::Waive`]; an empty lift over an acknowledge-only
/// residual is a [`ProposedGrant::Acknowledge`], which routes on the explicit
/// `acknowledge_unknown` capability rather than being covered by every mandate.
pub(super) fn grant_for(delta: &TransientWaiver, resolved: &[Violation]) -> ProposedGrant {
    // Acknowledge-only facts (unknown effects, a missing contract) are cleared
    // by the presence of *any* waiver on the recheck, so a non-empty lift that
    // rides alongside them must still carry them — otherwise a lift-only
    // mandate would launder an unknown it has no competence to acknowledge.
    let acknowledged: Vec<Unprovable> = resolved
        .iter()
        .filter(|violation| violation.fixability() == Fixability::AcknowledgeOnly)
        .filter_map(|violation| match violation {
            Violation::Unprovable(fact) => Some(fact.clone()),
            Violation::Breach(_) => None,
        })
        .collect();
    if delta == &TransientWaiver::empty() {
        ProposedGrant::Acknowledge { facts: acknowledged }
    } else {
        ProposedGrant::Waive {
            waiver: delta.clone(),
            acknowledged,
        }
    }
}

/// The surface growth in a violation set, if any — the effects an Accept step
/// must acquire. There is at most one (the growth check pushes a single
/// `SurfaceGrowth`).
fn surface_growth_of(violations: &[Violation]) -> Option<Effects> {
    violations.iter().find_map(|violation| match violation {
        Violation::Breach(crate::contract::Breach::SurfaceGrowth { growth }) => Some(growth.clone()),
        _ => None,
    })
}

/// The delta that would cover the grant-fixable *non-relabel* gaps in
/// `violations`: prior effects and confirmation. Trust and audience are no
/// longer waived — they route to Endorse steps — and acknowledge-only,
/// surface-growth, and structural members contribute no lift.
fn needed_delta(violations: &[Violation]) -> TransientWaiver {
    use crate::contract::Breach;
    let mut delta = TransientWaiver::empty();
    for violation in violations {
        match violation {
            Violation::Breach(Breach::ForbiddenPriorEffects { effects }) => {
                delta
                    .prior_effects
                    .get_or_insert_with(BTreeSet::new)
                    .extend(effects.iter().copied());
            }
            Violation::Breach(Breach::ConfirmationMissing { .. } | Breach::ConfirmationForOtherTool { .. }) => {
                delta.confirms = true;
            }
            // Trust/audience route to Endorse; surface growth to Accept;
            // acknowledge-only and structural members contribute no lift.
            Violation::Breach(
                Breach::TrustBelow { .. }
                | Breach::AudienceExceeds { .. }
                | Breach::AudienceNotPublic { .. }
                | Breach::UndeclaredRecipients
                | Breach::SurfaceGrowth { .. },
            )
            | Violation::Unprovable(
                Unprovable::TrustUnknown
                | Unprovable::AudienceUnknown
                | Unprovable::EffectsUnknown
                | Unprovable::RequirementsUnknown
                | Unprovable::NoContract { .. },
            ) => {}
        }
    }
    delta
}

/// The Endorse steps that clear a confidentiality sink breach: one durable
/// relabel per argument leaf whose *own* label fails the sink's trust/audience
/// requirement, each raising exactly that leaf to meet it. Multi-source — an
/// aggregate breach carried by several leaves yields several steps. A
/// control-borne breach yields none (no arg leaf fails): that is the
/// control-release waiver's concern. Sufficient and minimal because the
/// audience fold is intersection and the trust fold is meet, so once every
/// contributing leaf passes, the fold passes.
fn endorse_steps(sim: &SimFlow, violations: &[Violation]) -> Vec<(ValueId, EndorseDelta)> {
    use crate::contract::Breach;
    let trust_req: Option<KnownTrust> = violations.iter().find_map(|v| match v {
        Violation::Breach(Breach::TrustBelow { required, .. }) => Some(*required),
        Violation::Unprovable(Unprovable::TrustUnknown) => sim.requires.trust,
        _ => None,
    });
    let mut readers = BTreeSet::new();
    for v in violations {
        match v {
            Violation::Breach(Breach::AudienceExceeds { outside }) => readers.extend(outside.iter().cloned()),
            // An unknown flow audience needs a vouch for whatever the sink
            // exposes to: the resolved recipients, or the declared readers. A
            // public sink has no finite reader set to vouch — no endorse step
            // can clear it (`AudienceNotPublic` likewise contributes none).
            Violation::Unprovable(Unprovable::AudienceUnknown) => match &sim.requires.audience {
                AudienceRule::FromRecipients => readers.extend(sim.recipients.iter().cloned()),
                AudienceRule::Readers(declared) => readers.extend(declared.iter().cloned()),
                AudienceRule::Public | AudienceRule::Unrestricted => {}
            },
            _ => {}
        }
    }
    let audience_req = if readers.is_empty() { None } else { Some(readers) };
    if trust_req.is_none() && audience_req.is_none() {
        return Vec::new();
    }
    let full = EndorseDelta {
        trust: trust_req,
        audience: audience_req,
    };
    let mut steps = Vec::new();
    for (leaf, label) in &sim.leaf_labels {
        // The minimal per-leaf delta: only the dimensions this leaf actually
        // fails, and for audience only the readers it does not already admit —
        // never the whole aggregate witness (a leaf that already admits some of
        // the required readers must not ask an authority to re-vouch them, which
        // could inflate the grant past a competent mandate).
        let audience = full
            .audience
            .as_ref()
            .map(|readers| label.audience.missing_readers(readers));
        let delta = EndorseDelta {
            trust: full.trust.filter(|req| label.trust.raised_to(*req) != label.trust),
            audience: audience.filter(|deficit| !deficit.is_empty()),
        };
        if !delta.is_empty() {
            steps.push((*leaf, delta));
        }
    }
    steps
}
