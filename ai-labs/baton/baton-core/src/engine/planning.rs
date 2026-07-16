use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::ToolName;
use crate::approval::{Authority, AuthorityMode};
use crate::audit::AuthorityName;
use crate::contract::{AudienceRule, Fixability, Requirements, Unprovable, Verdict, Violation};
use crate::dimension::{Effect, Effects, KnownTrust, UserId};
use crate::plan::NonEmptyVec;
use crate::remedy::{
    Authorization, AuthorizationDelta, AuthorizationScope, DeltaCoordinate, LabelRaise, Lift, PlannedRemedy,
    ReductionTarget,
};
use crate::request::{ArgumentTree, EmissionRequest, ToolRequest};
use crate::revision::{ActionId, FlowId, ValueId};
use crate::transition::{ActionTransition, effects_narrow};
use crate::turn::Trajectory;
use crate::value::{TransformerRef, UnknownValue, ValueLabel, ValueStore};

use super::PolicyEngine;
use super::capability::{RESPONSE_SINK, ResponsePolicy, ToolContract};

/// A successful joint-cleanability probe: the per-leaf raises — each with the
/// projected residual at its own peel, the vector its ruling authority is
/// shown — and the final waiver (release + residual lift + acknowledged
/// facts). The raise list may be empty: a non-monotone subset release can be
/// clean on its own.
struct JointRescue {
    endorse: Vec<(ValueId, LabelRaise, Vec<Violation>)>,
    delta: Lift,
}

/// What the search needs to know about one checked flow beyond its
/// [`SimFlow`]: the value store and argument tree (recipient resolution for
/// narrowing hops), the acquisition target (`None` for an emission — it
/// proposes no effects), whether narrowing applies at all (an emission has no
/// tool identity to narrow), and the checked flow the lifts scope to.
struct SearchCtx<'a> {
    store: &'a ValueStore,
    tree: &'a ArgumentTree<ValueId>,
    acquire: Option<ActionId>,
    flow: FlowId,
    narrows: bool,
}

/// One candidate plan, carried with its dominance-group identity.
struct Candidate {
    steps: NonEmptyVec<PlannedRemedy>,
    group: GroupKey,
}

/// Plans predict the same resulting flow iff their derivation sequences and
/// final tool identity agree — only then are their authorization vectors
/// comparable. A content-changing `Reduce` versus a content-preserving
/// `Authorize` (or two different transformers) are different outcomes, so
/// they never dominate one another.
#[derive(Clone, PartialEq, Eq)]
struct GroupKey {
    derives: Vec<(ValueId, TransformerRef)>,
    tool: ToolName,
}

/// One reachable reduce-state of the exhaustive search: the simulated flow
/// after a sequence of `Reduce` steps, the steps taken, the leaves the
/// current contract excludes from transformation (its recipients), and the
/// semantic states this route has passed through (path-local cycle
/// detection — the walk's only pruning).
#[derive(Clone)]
struct ReduceState {
    sim: SimFlow,
    steps: Vec<PlannedRemedy>,
    derives: Vec<(ValueId, TransformerRef)>,
    recipient_leaves: BTreeSet<ValueId>,
    path: BTreeSet<StateKey>,
}

/// The semantic identity of a reduce-state: the per-leaf labels, the tool
/// identity, and the proposed effects. Requirements and recipients are
/// functions of the tool's contract over the fixed request tree, so they
/// need no separate coordinate. Deduplication is deliberately per-route
/// only (a route never revisits its own semantic state): a global
/// visited-set keyed on anything order-insensitive would prune routes whose
/// continuations differ — expansion is path-sensitive, so a state reached
/// by `A,B` and by `B,A` admits different follow-up moves under the cycle
/// check. Order-permuted routes stay distinct plans: only a plan's head is
/// executable and every application rechecks, so the step order is part of
/// the prediction, never a presentation detail to normalize away.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct StateKey {
    labels: Vec<(ValueId, ValueLabel)>,
    tool: ToolName,
    proposed_effects: Effects,
}

impl StateKey {
    fn of(sim: &SimFlow) -> Self {
        Self {
            labels: sim.leaf_labels.iter().map(|(id, label)| (*id, label.clone())).collect(),
            tool: sim.tool.clone(),
            proposed_effects: sim.proposed_effects.clone(),
        }
    }
}

impl PolicyEngine {
    /// The nondominated frontier of remedy plans for one blocked tool flow:
    /// an exhaustive reachable-state search over the registered reducers
    /// (any number of derived leaves, chained action transitions — complete
    /// for the reduce/authorize space), the deterministic authorize peels
    /// per state, the joint Endorse×control-release rescue solve (which
    /// contributes all incomparable releases of the *smallest successful
    /// cardinality* — see the size-first note on `minimal_joint_releases`),
    /// then irreducibility and dominance filtering. Terminal — an empty
    /// return — is a *proven* claim over the registered capability space in
    /// all cases: there is no generation bound, and the rescue sweep runs
    /// every subset size before concluding nothing unlocks.
    pub(super) fn plan_frontier(
        &self,
        trajectory: &Trajectory,
        checked: &ToolRequest,
        contract: Option<&ToolContract>,
        pending: &crate::request::PendingAction,
    ) -> Vec<NonEmptyVec<PlannedRemedy>> {
        let base = match SimFlow::of(trajectory, checked, contract) {
            Ok(base) => base,
            // A dependency vanished mid-evaluation cannot happen (the store
            // is append-only and we validated already), but fail closed.
            Err(_) => return Vec::new(),
        };
        let ctx = SearchCtx {
            store: trajectory.store(),
            tree: &checked.arguments,
            acquire: Some(pending.id()),
            flow: pending.flow(),
            narrows: true,
        };
        self.frontier(&base, recipient_leaves_for(contract, ctx.tree), &ctx)
    }

    /// The plan frontier for a pending emission: the same pipeline over the
    /// body tree, with no narrowing (an emission has no tool identity to
    /// narrow) and no acquisition (an emission proposes no effects).
    pub(super) fn emission_plan_frontier(
        &self,
        trajectory: &Trajectory,
        checked: &EmissionRequest,
        flow: FlowId,
    ) -> Vec<NonEmptyVec<PlannedRemedy>> {
        let base = match SimFlow::of_emission(trajectory, checked, self.response_policy.as_ref()) {
            Ok(base) => base,
            Err(_) => return Vec::new(),
        };
        let ctx = SearchCtx {
            store: trajectory.store(),
            tree: &checked.body,
            acquire: None,
            flow,
            narrows: false,
        };
        self.frontier(&base, BTreeSet::new(), &ctx)
    }

    /// Generate every candidate (reduce-state peels plus the rescue solve in
    /// one pool), then filter: irreducibility (no removable step may leave an
    /// unlocking sequence), dominance (drop any plan another plan unlocks
    /// with strictly less authorization), and a deterministic serialization —
    /// fewest steps first, then generation order (a deterministic breadth-
    /// first walk over the registries in registration order).
    fn frontier(
        &self,
        base: &SimFlow,
        base_recipient_leaves: BTreeSet<ValueId>,
        ctx: &SearchCtx<'_>,
    ) -> Vec<NonEmptyVec<PlannedRemedy>> {
        let mut candidates: Vec<Candidate> = Vec::new();
        for state in self.reduce_states(base, base_recipient_leaves, ctx) {
            self.peel_state(&state, ctx, &mut candidates);
        }
        candidates.extend(self.rescue_candidates(base, ctx));

        // Structural dedup: exactly the same ordered remedy sequence
        // (ignoring the violation vectors shown to authorities) generated
        // twice keeps its first occurrence. Equal-multiset, different-order
        // plans are deliberately NOT collapsed: their asks are equal, but
        // the executable head and the recheck sequence differ — the
        // head-only contract makes order observable, so both orderings are
        // distinct predictions in the frontier (mutually non-dominating:
        // same group, equal ask vectors). Execution converges regardless,
        // because every applied head re-plans.
        let mut deduped: Vec<Candidate> = Vec::new();
        for candidate in candidates {
            if !deduped
                .iter()
                .any(|kept| kept.group == candidate.group && same_step_sequence(&kept.steps, &candidate.steps))
            {
                deduped.push(candidate);
            }
        }

        // Irreducibility: removing any single step must break the predicted
        // unlock — replay the remaining original sequence verbatim against
        // the base simulation.
        deduped.retain(|candidate| {
            let steps: Vec<&PlannedRemedy> = candidate.steps.iter().collect();
            debug_assert!(
                self.replay_unlocks(base, ctx, &steps),
                "every generated plan must predict a clean flow"
            );
            (0..steps.len()).all(|removed| {
                let reduced: Vec<&PlannedRemedy> = steps
                    .iter()
                    .enumerate()
                    .filter_map(|(i, step)| (i != removed).then_some(*step))
                    .collect();
                !self.replay_unlocks(base, ctx, &reduced)
            })
        });

        // Nondominated frontier: within one outcome group, drop any plan
        // whose authorization ask another plan strictly undercuts.
        let asks: Vec<AskVector> = deduped.iter().map(|c| AskVector::of(&c.steps)).collect();
        let mut keep = vec![true; deduped.len()];
        for i in 0..deduped.len() {
            for j in 0..deduped.len() {
                if i != j && deduped[i].group == deduped[j].group && ask_cmp(&asks[j], &asks[i]) == Some(Ordering::Less)
                {
                    keep[i] = false;
                    break;
                }
            }
        }
        let mut plans: Vec<NonEmptyVec<PlannedRemedy>> = deduped
            .into_iter()
            .zip(keep)
            .filter_map(|(candidate, keep)| keep.then_some(candidate.steps))
            .collect();
        plans.sort_by_key(NonEmptyVec::len);
        plans
    }

    /// Breadth-first walk of every reduce-route reachable from the checked
    /// flow: a transformer application to any non-recipient leaf, or a gated
    /// action transition from the current tool, in registration order.
    /// The only pruning is path-local: a route never revisits its own
    /// semantic state, so every route is a simple path over the finite state
    /// space (leaf labels range over {original} ∪ registered outputs, tools
    /// over registered contracts) and the walk terminates because finitely
    /// many simple paths exist. Every simple path is explored — the
    /// exponential worst case is the accepted price of a complete frontier,
    /// exactly like the rescue subset sweep. No global visited-set, no step
    /// reordering: an order-insensitive prune would drop continuations that
    /// are cyclic on one ordering's path but simple on another's, and a
    /// reorder would fabricate a step sequence the walk never verified —
    /// each emitted route keeps its discovered order verbatim.
    fn reduce_states(
        &self,
        base: &SimFlow,
        base_recipient_leaves: BTreeSet<ValueId>,
        ctx: &SearchCtx<'_>,
    ) -> Vec<ReduceState> {
        let base_key = StateKey::of(base);
        let mut queue = VecDeque::from([ReduceState {
            sim: base.clone(),
            steps: Vec::new(),
            derives: Vec::new(),
            recipient_leaves: base_recipient_leaves,
            path: BTreeSet::from([base_key]),
        }]);
        let mut states = Vec::new();
        while let Some(mut state) = queue.pop_front() {
            let leaves: Vec<ValueId> = state.sim.leaf_labels.keys().copied().collect();
            for leaf in leaves {
                if state.recipient_leaves.contains(&leaf) {
                    continue;
                }
                for transformer in &self.transformers {
                    let label = &state.sim.leaf_labels[&leaf];
                    if !transformer.descriptor.precondition.matches(label) || transformer.descriptor.output == *label {
                        continue;
                    }
                    let mut next = state.clone();
                    next.sim.leaf_labels.insert(leaf, transformer.descriptor.output.clone());
                    if !Self::enter(&mut next) {
                        continue;
                    }
                    next.steps.push(PlannedRemedy::Reduce(ReductionTarget::DeriveValue {
                        source: leaf,
                        transformer: transformer.descriptor.transformer.clone(),
                    }));
                    next.derives.push((leaf, transformer.descriptor.transformer.clone()));
                    queue.push_back(next);
                }
            }
            if ctx.narrows {
                for transition in &self.action_transitions {
                    let Some((target, recipients)) = self.sim_constrain_gate(&state.sim, transition, ctx) else {
                        continue;
                    };
                    let mut next = state.clone();
                    next.sim.tool = transition.to_tool.clone();
                    // Retargeting re-decides the target's requirement fact: a
                    // narrow may move to a tool whose requirements are unstated
                    // (escalates) or away from one (the stale unknown drops).
                    next.sim.adopt_requires(&target.requires);
                    next.sim.recipients = recipients;
                    // The narrow shrinks the proposed effects, so any surface
                    // growth is recomputed against the reduced set — an
                    // acquire then authorizes only the residual growth.
                    next.sim.proposed_effects = transition.effects.clone();
                    next.recipient_leaves = recipient_leaves_for(Some(target), ctx.tree);
                    if !Self::enter(&mut next) {
                        continue;
                    }
                    next.steps.push(PlannedRemedy::Reduce(ReductionTarget::NarrowAction {
                        transition: transition.id.clone(),
                    }));
                    queue.push_back(next);
                }
            }
            // The dominance-group identity is order-insensitive by design
            // (per-leaf derivation chains + final tool): stable-sort the
            // route's derive pairs by leaf so interleavings land in one
            // group, where equal ask vectors keep both orderings in the
            // frontier. The steps themselves are never reordered.
            state.derives.sort_by_key(|(leaf, _)| *leaf);
            states.push(state);
        }
        states
    }

    /// Record one walk move onto `next`: refuse a route that revisits its
    /// own semantic state (cycle); otherwise extend the route's path.
    fn enter(next: &mut ReduceState) -> bool {
        let key = StateKey::of(&next.sim);
        if next.path.contains(&key) {
            return false;
        }
        next.path.insert(key);
        true
    }

    /// The simulation-level narrowing gate, mirroring the applier's
    /// [`constrain_gate`](PolicyEngine::constrain_gate) one hop at a time:
    /// the transition must leave the state's current tool, verifiably narrow
    /// its current proposed effects, target a registered contract declaring
    /// exactly the transition's effects, and never widen the resolved
    /// recipient set.
    fn sim_constrain_gate<'a>(
        &'a self,
        sim: &SimFlow,
        transition: &ActionTransition,
        ctx: &SearchCtx<'_>,
    ) -> Option<(&'a ToolContract, BTreeSet<UserId>)> {
        if transition.from_tool != sim.tool || !effects_narrow(&sim.proposed_effects, &transition.effects) {
            return None;
        }
        let target = self.contracts.get(&transition.to_tool)?;
        if target.effects != transition.effects {
            return None;
        }
        let recipients = target.arguments.resolve_recipients(ctx.tree, ctx.store).ok()?;
        recipients.is_subset(&sim.recipients).then_some((target, recipients))
    }

    /// The deterministic authorize peels for one reduce-state: durable raises
    /// for the arg-borne confidentiality residual, an acquisition for any
    /// surface growth, then — when a residual remains — one candidate plan
    /// per clearing lift alternative (the least-privilege control-release
    /// variant and the plain lift are genuinely different asks; dominance,
    /// not enumeration order, decides between them).
    fn peel_state(&self, state: &ReduceState, ctx: &SearchCtx<'_>, out: &mut Vec<Candidate>) {
        let group = GroupKey {
            derives: state.derives.clone(),
            tool: state.sim.tool.clone(),
        };
        let mut sim = state.sim.clone();
        let mut steps = state.steps.clone();
        let mut remaining = sim.violations(None);

        // Criterion (2): peel a confidentiality sink breach into durable
        // raises — one relabel per arg leaf whose own label fails the sink
        // requirement (multi-source). Computed on the post-reduction
        // residual, so a reducer's derivation shrinks what the authority must
        // vouch. A control-borne residual is left to the control-release lift
        // below. All contributing leaves must have a competent route, else
        // this state cannot clear the breach.
        let endorse = endorse_steps(&sim, &remaining);
        let raise_steps: Option<Vec<PlannedRemedy>> = {
            let mut probe = sim.clone();
            let mut residual = remaining.clone();
            endorse
                .iter()
                .map(|(leaf, delta)| {
                    let step = self.authorize_step(raise_authorization(*leaf, delta), residual.clone())?;
                    let raised = delta.raise(&probe.leaf_labels[leaf]);
                    probe.leaf_labels.insert(*leaf, raised);
                    residual = probe.violations(None);
                    Some(step)
                })
                .collect()
        };
        if let Some(raise_steps) = raise_steps {
            for (leaf, delta) in endorse {
                let raised = delta.raise(&sim.leaf_labels[&leaf]);
                sim.leaf_labels.insert(leaf, raised);
            }
            remaining = sim.violations(None);
            steps.extend(raise_steps);
        }

        // Criterion (1): peel any surface growth into an acquire step before
        // a lift handles the confidentiality residual. Acquire composes
        // additively with a lift — they are separate steps to separate
        // competences (acquire_effects vs the lift dims).
        if let Some(growth) = surface_growth_of(&remaining) {
            // No acquisition target (an emission flow), or no competent
            // acquirer: this state cannot reach a clean residual.
            let Some(action) = ctx.acquire else {
                return;
            };
            let grant = acquire_authorization(action, &growth);
            let Some(step) = self.authorize_step(grant, remaining.clone()) else {
                return;
            };
            sim.accepted_effects = sim.accepted_effects.clone().combine(growth);
            remaining = sim.violations(None);
            steps.push(step);
        }

        if remaining.is_empty() {
            if let Some(steps) = NonEmptyVec::from_vec(steps) {
                out.push(Candidate { steps, group });
            }
            return;
        }

        // A final lift for whatever remains: every clearing, authorizable
        // alternative becomes its own candidate.
        for delta in self.waiver_candidates(&sim, &remaining) {
            if !sim.violations(Some(&delta)).is_empty() {
                continue;
            }
            let grant = authorization_for(&delta, &remaining, ctx.flow);
            let Some(step) = self.authorize_step(grant, remaining.clone()) else {
                continue;
            };
            let mut lift_steps = steps.clone();
            lift_steps.push(step);
            let steps = NonEmptyVec::from_vec(lift_steps).expect("lift step just pushed");
            out.push(Candidate {
                steps,
                group: group.clone(),
            });
        }
    }

    /// The planned authorize step for `authorization`, carrying the competent
    /// routes identified now (prediction metadata — application still resolves
    /// the ruling authority live) and the violations the step asks its
    /// authority to clear. `None` when no registered authority is competent.
    fn authorize_step(&self, authorization: Authorization, targets: Vec<Violation>) -> Option<PlannedRemedy> {
        let routes: Vec<AuthorityName> = self
            .competent_authorities(&authorization)
            .map(|authority| authority.name.clone())
            .collect();
        NonEmptyVec::from_vec(routes).map(|routes| PlannedRemedy::Authorize {
            authorization,
            routes,
            targets,
        })
    }

    /// The joint Endorse×control-release rescue solve, part of the one
    /// candidate pool.
    ///
    /// The ordinary peels derive Endorse from the *unreleased* residual and
    /// measure a control release against the release-all raw vector, both of
    /// which assume releasing control monotonically improves adequacy. That
    /// is false when a control dep masks an argument's `Unknown` in the trust
    /// fold: the valid plan must endorse against the *projected post-release*
    /// residual and then release. This solver searches release candidates for
    /// joint cleanability: project the release, derive per-leaf Endorse
    /// deltas from the projection (a candidate may need none — releasing a
    /// non-monotone *subset* can be clean on its own, which the release-all
    /// anchored ordinary solver misses), compose an Accept for any projected
    /// growth and the final waiver (carrying its acknowledge-only facts),
    /// and keep the candidate iff every grant is authorizable and the
    /// projection then clears.
    fn rescue_candidates(&self, base: &SimFlow, ctx: &SearchCtx<'_>) -> Vec<Candidate> {
        if base.control_labels.is_empty() {
            return Vec::new();
        }
        let ids: Vec<ValueId> = base.control_labels.keys().copied().collect();
        let group = GroupKey {
            derives: Vec::new(),
            tool: base.tool.clone(),
        };
        self.minimal_joint_releases(base, &ids, ctx.acquire, ctx.flow)
            .into_iter()
            .filter_map(|rescue| {
                // A rescue raise's `targets` are the *projected post-release*
                // residual at its own peel — the vector its ruling authority
                // is shown; the actual flow may not mention the deficit at
                // all while a masking control dependency holds.
                let mut sim = base.clone();
                let mut steps = Vec::new();
                for (leaf, delta, targets) in &rescue.endorse {
                    let step = self.authorize_step(raise_authorization(*leaf, delta), targets.clone())?;
                    let raised = delta.raise(&sim.leaf_labels[leaf]);
                    sim.leaf_labels.insert(*leaf, raised);
                    steps.push(step);
                }
                let mut remaining = sim.violations(None);
                if let Some(growth) = surface_growth_of(&remaining) {
                    let action = ctx.acquire?;
                    let grant = acquire_authorization(action, &growth);
                    let step = self.authorize_step(grant, remaining.clone())?;
                    sim.accepted_effects = sim.accepted_effects.clone().combine(growth);
                    remaining = sim.violations(None);
                    steps.push(step);
                }
                if !sim.violations(Some(&rescue.delta)).is_empty() {
                    return None;
                }
                let grant = authorization_for(&rescue.delta, &remaining, ctx.flow);
                let step = self.authorize_step(grant, remaining)?;
                steps.push(step);
                NonEmptyVec::from_vec(steps).map(|steps| Candidate {
                    steps,
                    group: group.clone(),
                })
            })
            .collect()
    }

    /// Every minimum-cardinality release whose joint composition clears the
    /// projection: sizes ascending through a streaming lexicographic
    /// combination generator, collecting *all* successes of the first
    /// successful size. Size-first semantics, not the full inclusion-minimal
    /// antichain: each returned set is inclusion-minimal (every proper
    /// subset was probed at a smaller size and failed) and same-size sets
    /// are mutually incomparable, but cleanability is non-monotone, so a
    /// *larger* inclusion-minimal release with no successful proper subset
    /// is deliberately not enumerated — doing so would forfeit the early
    /// exit and sweep the lattice even when a one-value release exists.
    /// The complete sweep still happens whenever *nothing* succeeds, which
    /// is exactly the `Terminal` proof. There is
    /// no width or count bound: a flow with no successful release at any size
    /// sweeps the full subset lattice — exponential in the request's own
    /// control-set size, and exactly the proof behind a `Terminal` claim
    /// (accepted prototype trade; a silent bound would turn "no remedy
    /// exists" into "none was found where we looked"). The empty release is
    /// not probed: an unreleased endorse-plus-waiver solve is the ordinary
    /// peels' domain, and its candidates are already in the pool.
    fn minimal_joint_releases(
        &self,
        base: &SimFlow,
        ids: &[ValueId],
        acquire: Option<ActionId>,
        flow: FlowId,
    ) -> Vec<JointRescue> {
        for size in 1..=ids.len() {
            let hits: Vec<JointRescue> = Combinations::new(ids.len(), size)
                .filter_map(|combo| {
                    let release: BTreeSet<ValueId> = combo.iter().map(|&i| ids[i]).collect();
                    self.joint_rescue(base, &release, acquire, flow)
                })
                .collect();
            if !hits.is_empty() {
                return hits;
            }
        }
        Vec::new()
    }

    /// One joint-cleanability probe for a release candidate. `None` when any
    /// required grant has no competent authority or the composed remedies do
    /// not clear the projection. An empty endorse set is a valid solve: a
    /// non-monotone subset release can be clean on its own.
    fn joint_rescue(
        &self,
        base: &SimFlow,
        release: &BTreeSet<ValueId>,
        acquire: Option<ActionId>,
        flow: FlowId,
    ) -> Option<JointRescue> {
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
            if !self.can_authorize(&raise_authorization(leaf, &delta)) {
                return None;
            }
            let raised = delta.raise(&projected.leaf_labels[&leaf]);
            projected.leaf_labels.insert(leaf, raised);
            endorse.push((leaf, delta, residual));
            residual = projected.violations(None);
        }
        if let Some(growth) = surface_growth_of(&residual) {
            let action = acquire?;
            if !self.can_authorize(&acquire_authorization(action, &growth)) {
                return None;
            }
            projected.accepted_effects = projected.accepted_effects.clone().combine(growth);
            residual = projected.violations(None);
        }
        let mut delta = needed_delta(&residual);
        delta.control_release = release.clone();
        if !self.can_authorize(&authorization_for(&delta, &residual, flow)) {
            return None;
        }
        if !projected.violations(Some(&delta)).is_empty() {
            return None;
        }
        Some(JointRescue { endorse, delta })
    }

    /// Replay a step sequence verbatim against the base simulation and
    /// report whether it predicts a clean flow. Every reduce step re-checks
    /// its registered relation against the replayed state (a transformer
    /// whose precondition no longer matches, or a transition whose gate no
    /// longer holds, breaks the prediction); authorize steps apply their
    /// coordinates; the final check runs under the last lift, if any.
    fn replay_unlocks(&self, base: &SimFlow, ctx: &SearchCtx<'_>, steps: &[&PlannedRemedy]) -> bool {
        let mut sim = base.clone();
        let mut lift: Option<Lift> = None;
        for step in steps {
            match step {
                PlannedRemedy::Reduce(ReductionTarget::DeriveValue { source, transformer }) => {
                    let Some(registered) = self
                        .transformers
                        .iter()
                        .find(|t| t.descriptor.transformer == *transformer)
                    else {
                        return false;
                    };
                    let Some(label) = sim.leaf_labels.get(source) else {
                        return false;
                    };
                    if !registered.descriptor.precondition.matches(label) {
                        return false;
                    }
                    sim.leaf_labels.insert(*source, registered.descriptor.output.clone());
                }
                PlannedRemedy::Reduce(ReductionTarget::NarrowAction { transition }) => {
                    let Some(registered) = self.action_transitions.iter().find(|t| t.id == *transition) else {
                        return false;
                    };
                    let Some((target, recipients)) = self.sim_constrain_gate(&sim, registered, ctx) else {
                        return false;
                    };
                    sim.tool = registered.to_tool.clone();
                    sim.adopt_requires(&target.requires);
                    sim.recipients = recipients;
                    sim.proposed_effects = registered.effects.clone();
                }
                PlannedRemedy::Authorize { authorization, .. } => {
                    for coordinate in authorization.delta().coordinates() {
                        match (coordinate, authorization.scope()) {
                            (DeltaCoordinate::RaiseLabel(raise), AuthorizationScope::DerivedValue { source }) => {
                                let Some(label) = sim.leaf_labels.get(source) else {
                                    return false;
                                };
                                let raised = raise.raise(label);
                                sim.leaf_labels.insert(*source, raised);
                            }
                            (DeltaCoordinate::AcquireEffects(effects), _) => {
                                sim.accepted_effects = sim.accepted_effects.clone().combine(effects.clone());
                            }
                            (lift_coordinate, _) => {
                                let entry = lift.get_or_insert_with(Lift::empty);
                                match lift_coordinate {
                                    DeltaCoordinate::ExceptPriorEffects(effects) => {
                                        entry
                                            .prior_effects
                                            .get_or_insert_with(BTreeSet::new)
                                            .extend(effects.iter().copied());
                                    }
                                    DeltaCoordinate::StandInConfirmation => entry.confirms = true,
                                    DeltaCoordinate::ReleaseControl(deps) => {
                                        entry.control_release.extend(deps.iter().copied());
                                    }
                                    // Acknowledged facts are cleared by the
                                    // presence of any lift on the recheck.
                                    DeltaCoordinate::AcknowledgeUnknown(_) => {}
                                    DeltaCoordinate::RaiseLabel(_) | DeltaCoordinate::AcquireEffects(_) => {
                                        unreachable!("matched above")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        sim.violations(lift.as_ref()).is_empty()
    }

    /// Deterministic waiver candidates for a remaining violation set: the
    /// scoped control-release variant when releasing control shrinks the
    /// residual, and the plain delta. The waiver clears only the non-relabel
    /// dims (prior effects, confirmation, control release); trust/audience route
    /// to Endorse steps peeled before this.
    fn waiver_candidates(&self, sim: &SimFlow, remaining: &[Violation]) -> Vec<Lift> {
        let mut candidates = Vec::new();
        if let Some(release) = self.minimal_control_release(sim) {
            let after = sim.violations(Some(&Lift {
                control_release: release.clone(),
                ..Lift::empty()
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
            sim.violations(Some(&Lift {
                control_release: set.clone(),
                ..Lift::empty()
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
    pub(super) fn competent_authorities<'a>(&'a self, ask: &'a Authorization) -> impl Iterator<Item = &'a Authority> {
        let inline = self
            .authorities
            .iter()
            .filter(move |a| matches!(a.mode, AuthorityMode::Inline(_)) && a.mandate.authorizes(ask));
        let external = self
            .authorities
            .iter()
            .filter(move |a| matches!(a.mode, AuthorityMode::External) && a.mandate.authorizes(ask));
        inline.chain(external)
    }

    /// Is any authority competent for `grant`? A grant step (waiver, accept, or
    /// acknowledgment) is enumerated only when one exists; the actual ruling —
    /// which an inline authority may abstain from, falling through to the next —
    /// happens at application.
    fn can_authorize(&self, ask: &Authorization) -> bool {
        self.competent_authorities(ask).next().is_some()
    }
}

/// The leaves the contract's recipients role occupies in the request tree —
/// excluded as transform candidates (deriving a recipient would change who
/// receives, not what flows).
fn recipient_leaves_for(contract: Option<&ToolContract>, tree: &ArgumentTree<ValueId>) -> BTreeSet<ValueId> {
    contract
        .and_then(|c| c.arguments.recipients.as_ref().and_then(|role| tree.top_level(role)))
        .map(|subtree| subtree.leaves())
        .unwrap_or_default()
}

/// Streaming k-of-n index combinations in lexicographic order. The caller
/// enumerates sizes ascending; nothing here bounds n (no fixed-width mask).
struct Combinations {
    indices: Vec<usize>,
    n: usize,
    done: bool,
}

impl Combinations {
    fn new(n: usize, k: usize) -> Self {
        Self {
            indices: (0..k).collect(),
            n,
            done: k == 0 || k > n,
        }
    }
}

impl Iterator for Combinations {
    type Item = Vec<usize>;

    fn next(&mut self) -> Option<Vec<usize>> {
        if self.done {
            return None;
        }
        let current = self.indices.clone();
        let k = self.indices.len();
        let mut i = k;
        loop {
            if i == 0 {
                self.done = true;
                break;
            }
            i -= 1;
            if self.indices[i] != i + self.n - k {
                self.indices[i] += 1;
                for j in i + 1..k {
                    self.indices[j] = self.indices[j - 1] + 1;
                }
                break;
            }
        }
        Some(current)
    }
}

/// Structural identity of two step sequences: the same remedies in the same
/// order, ignoring the violation vectors shown to authorities (`targets`) —
/// prediction metadata that differs by generation path, not by what the plan
/// asks or does. Routes are a deterministic function of the authorization, so
/// they never differ between shape-identical steps. Deliberately
/// order-sensitive: a permuted sequence is a different prediction (different
/// executable head, different recheck sequence) and stays in the frontier.
fn same_step_sequence(a: &NonEmptyVec<PlannedRemedy>, b: &NonEmptyVec<PlannedRemedy>) -> bool {
    fn step_eq(x: &PlannedRemedy, y: &PlannedRemedy) -> bool {
        match (x, y) {
            (PlannedRemedy::Reduce(t1), PlannedRemedy::Reduce(t2)) => t1 == t2,
            (
                PlannedRemedy::Authorize { authorization: a1, .. },
                PlannedRemedy::Authorize { authorization: a2, .. },
            ) => a1 == a2,
            _ => false,
        }
    }
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| step_eq(x, y))
}

/// The total authorization a plan asks for, folded into one comparable
/// vector of atomic coordinates. Scope targets are pinned by validated
/// construction (a raise lives at its derived value, an acquisition at the
/// one pending action, lifts at the one policy check), so the vector keys on
/// coordinate kind — plus the raised leaf for raises.
#[derive(Default)]
pub(super) struct AskVector {
    raises: BTreeMap<ValueId, LabelRaise>,
    acquire: Option<Effects>,
    except: Option<BTreeSet<Effect>>,
    confirm: bool,
    release: Option<BTreeSet<ValueId>>,
    acknowledged: Option<Vec<Unprovable>>,
}

impl AskVector {
    pub(super) fn of(steps: &NonEmptyVec<PlannedRemedy>) -> Self {
        let mut vector = Self::default();
        for step in steps.iter() {
            let PlannedRemedy::Authorize { authorization, .. } = step else {
                continue;
            };
            for coordinate in authorization.delta().coordinates() {
                match (coordinate, authorization.scope()) {
                    (DeltaCoordinate::RaiseLabel(raise), AuthorizationScope::DerivedValue { source }) => {
                        let entry = vector.raises.entry(*source).or_default();
                        entry.trust = entry.trust.max(raise.trust);
                        if let Some(readers) = &raise.audience {
                            entry
                                .audience
                                .get_or_insert_with(BTreeSet::new)
                                .extend(readers.iter().cloned());
                        }
                    }
                    (DeltaCoordinate::RaiseLabel(_), _) => unreachable!("validated construction pins raise scope"),
                    (DeltaCoordinate::AcquireEffects(effects), _) => {
                        vector.acquire = Some(match vector.acquire.take() {
                            Some(acquired) => acquired.combine(effects.clone()),
                            None => effects.clone(),
                        });
                    }
                    (DeltaCoordinate::ExceptPriorEffects(effects), _) => {
                        vector
                            .except
                            .get_or_insert_with(BTreeSet::new)
                            .extend(effects.iter().copied());
                    }
                    (DeltaCoordinate::StandInConfirmation, _) => vector.confirm = true,
                    (DeltaCoordinate::ReleaseControl(deps), _) => {
                        vector
                            .release
                            .get_or_insert_with(BTreeSet::new)
                            .extend(deps.iter().copied());
                    }
                    (DeltaCoordinate::AcknowledgeUnknown(facts), _) => {
                        vector
                            .acknowledged
                            .get_or_insert_with(Vec::new)
                            .extend(facts.iter().cloned());
                    }
                }
            }
        }
        vector
    }
}

/// The typed partial order over authorization asks: `Less` means the left
/// plan asks for strictly less than the right on some coordinate and no more
/// on any other — it dominates. A missing coordinate asks less than any
/// present one; within a kind, trust compares by level, the set-valued
/// coordinates by inclusion, a confirmation stand-in by presence; coordinates
/// of different kinds never compare. `None` is incomparability: conflicting
/// directions, or set pairs neither of which contains the other.
pub(super) fn ask_cmp(a: &AskVector, b: &AskVector) -> Option<Ordering> {
    let mut acc = Ordering::Equal;
    let leaves: BTreeSet<ValueId> = a.raises.keys().chain(b.raises.keys()).copied().collect();
    for leaf in leaves {
        let step = match (a.raises.get(&leaf), b.raises.get(&leaf)) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Less,
            (Some(_), None) => Ordering::Greater,
            (Some(x), Some(y)) => {
                // Trust levels are totally ordered (`None` asks nothing);
                // audiences compare by reader-set inclusion.
                let trust = x.trust.cmp(&y.trust);
                let audience = option_set_cmp(&x.audience, &y.audience)?;
                combine_orders(trust, audience)?
            }
        };
        acc = combine_orders(acc, step)?;
    }
    acc = combine_orders(acc, option_effects_cmp(&a.acquire, &b.acquire)?)?;
    acc = combine_orders(acc, option_set_cmp(&a.except, &b.except)?)?;
    acc = combine_orders(acc, a.confirm.cmp(&b.confirm))?;
    acc = combine_orders(acc, option_set_cmp(&a.release, &b.release)?)?;
    acc = combine_orders(acc, acknowledged_cmp(&a.acknowledged, &b.acknowledged)?)?;
    Some(acc)
}

/// Merge one coordinate's ordering into the running product order:
/// conflicting strict directions are incomparable.
fn combine_orders(acc: Ordering, next: Ordering) -> Option<Ordering> {
    match (acc, next) {
        (Ordering::Equal, next) => Some(next),
        (acc, Ordering::Equal) => Some(acc),
        (acc, next) if acc == next => Some(acc),
        _ => None,
    }
}

/// `None < Some`; two sets compare by inclusion, incomparable otherwise.
fn option_set_cmp<T: Ord>(a: &Option<BTreeSet<T>>, b: &Option<BTreeSet<T>>) -> Option<Ordering> {
    match (a, b) {
        (None, None) => Some(Ordering::Equal),
        (None, Some(_)) => Some(Ordering::Less),
        (Some(_), None) => Some(Ordering::Greater),
        (Some(x), Some(y)) => set_cmp(x, y),
    }
}

fn set_cmp<T: Ord>(a: &BTreeSet<T>, b: &BTreeSet<T>) -> Option<Ordering> {
    match (a == b, a.is_subset(b), b.is_subset(a)) {
        (true, ..) => Some(Ordering::Equal),
        (false, true, _) => Some(Ordering::Less),
        (false, _, true) => Some(Ordering::Greater),
        _ => None,
    }
}

/// Effects order: declared sets by inclusion; anything declared is less than
/// `Unknown` (acquiring an unknown surface asks for everything).
fn option_effects_cmp(a: &Option<Effects>, b: &Option<Effects>) -> Option<Ordering> {
    match (a, b) {
        (None, None) => Some(Ordering::Equal),
        (None, Some(_)) => Some(Ordering::Less),
        (Some(_), None) => Some(Ordering::Greater),
        (Some(x), Some(y)) => match (x.declared_set(), y.declared_set()) {
            (Some(x), Some(y)) => set_cmp(&x, &y),
            (Some(_), None) => Some(Ordering::Less),
            (None, Some(_)) => Some(Ordering::Greater),
            (None, None) => Some(Ordering::Equal),
        },
    }
}

/// Acknowledgment order: presence asks for the acknowledge competence even
/// with no facts; fact lists compare as sets by inclusion.
fn acknowledged_cmp(a: &Option<Vec<Unprovable>>, b: &Option<Vec<Unprovable>>) -> Option<Ordering> {
    let subset = |x: &Vec<Unprovable>, y: &Vec<Unprovable>| x.iter().all(|fact| y.contains(fact));
    match (a, b) {
        (None, None) => Some(Ordering::Equal),
        (None, Some(_)) => Some(Ordering::Less),
        (Some(_), None) => Some(Ordering::Greater),
        (Some(x), Some(y)) => match (subset(x, y), subset(y, x)) {
            (true, true) => Some(Ordering::Equal),
            (true, false) => Some(Ordering::Less),
            (false, true) => Some(Ordering::Greater),
            (false, false) => None,
        },
    }
}

/// The pure simulation state of one flow's check: per-leaf argument labels
/// (so a transform can be predicted by swapping one), the control fold, and
/// the sink parameters. Prediction (planning) and validation (application)
/// share this so a plan's predictions mean exactly what the recheck
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
        let view = trajectory.view();
        let mut leaf_labels = BTreeMap::new();
        for leaf in checked.arguments.leaves() {
            leaf_labels.insert(leaf, view.fold_labels([&leaf])?);
        }
        let mut control_labels = BTreeMap::new();
        for id in checked.control.iter() {
            control_labels.insert(*id, view.fold_labels([id])?);
        }
        let (recipients, extra) = match contract {
            Some(c) => (
                c.arguments.resolve_recipients(&checked.arguments, trajectory.store())?,
                Vec::new(),
            ),
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
            past_effects: trajectory.past_effects().clone(),
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

    /// The simulation state of one emission flow's check, under the reserved
    /// response sink and the registered [`ResponsePolicy`]. An emission
    /// proposes no effects and acquires none; its recipients are the policy's
    /// declared readers. `confirmed` is deliberately `None`: a user
    /// confirmation names a tool and never satisfies the response sink's
    /// attention rule — only an authority's confirmation stand-in can.
    pub(crate) fn of_emission(
        trajectory: &Trajectory,
        checked: &EmissionRequest,
        policy: Option<&ResponsePolicy>,
    ) -> Result<Self, UnknownValue> {
        let view = trajectory.view();
        let mut leaf_labels = BTreeMap::new();
        for leaf in checked.body.leaves() {
            leaf_labels.insert(leaf, view.fold_labels([&leaf])?);
        }
        let mut control_labels = BTreeMap::new();
        for id in checked.control.iter() {
            control_labels.insert(*id, view.fold_labels([id])?);
        }
        let (requires, recipients, extra) = match policy {
            Some(policy) => (policy.requires.clone(), policy.readers.clone(), Vec::new()),
            None => (
                Requirements::default(),
                BTreeSet::new(),
                vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: ToolName::new(RESPONSE_SINK),
                })],
            ),
        };
        Ok(Self {
            leaf_labels,
            control_labels,
            tool: ToolName::new(RESPONSE_SINK),
            requires,
            recipients,
            past_effects: trajectory.past_effects().clone(),
            proposed_effects: Effects::none(),
            accepted_effects: Effects::none(),
            confirmed: None,
            extra,
        })
    }

    /// The folded flow label — tracing context only, never a check input.
    pub(super) fn flow_label(&self) -> ValueLabel {
        ValueLabel::fold(self.leaf_labels.values().cloned())
            .combine(ValueLabel::fold(self.control_labels.values().cloned()))
    }

    /// The violations this flow would report, optionally under a
    /// check-transient lift. A lift loosens exactly its declared dimensions
    /// and acknowledges acknowledge-only facts on the record.
    pub(crate) fn violations(&self, waiver: Option<&Lift>) -> Vec<Violation> {
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
        // Criterion (1) — the effects instance of the general no-widening law
        // (`widening_over`, the dimension interface's dual of adequacy).
        // Trust and audience enforce theirs at admission by construction (the
        // conservative fold absorbs a wider declared output); effects are
        // trajectory state, so their instance binds here. The check is over
        // the *committed* surface, not the waiver-adjusted `past` — a waiver
        // lifts a prior-effect sink check, not what the call would commit. An
        // Accept marker (accepted_effects) suppresses growth it already
        // acquired.
        let effective_past = self.past_effects.clone().combine(self.accepted_effects.clone());
        if let Some(growth) = self.proposed_effects.widening_over(&effective_past) {
            remaining.push(Violation::Breach(crate::contract::Breach::SurfaceGrowth { growth }));
        }
        if waiver.is_some() {
            remaining.retain(|v| v.fixability() != Fixability::AcknowledgeOnly);
        }
        remaining
    }
}

/// The typed authorization a check-transient residual asks for: the lift's
/// atomic coordinates plus any acknowledge-only facts it clears, scoped to
/// one policy check of `flow`. Acknowledge-only facts (unknown effects, a
/// missing contract) are cleared by the presence of *any* lift on the
/// recheck, so a non-empty lift that rides alongside them must still carry
/// the acknowledge coordinate — otherwise a lift-only mandate would launder
/// an unknown it has no competence to acknowledge. An empty lift is a pure
/// acknowledgment, which routes on the explicit `acknowledge_unknown`
/// capability rather than being covered by every mandate.
pub(super) fn authorization_for(delta: &Lift, resolved: &[Violation], flow: FlowId) -> Authorization {
    let acknowledged: Vec<Unprovable> = resolved
        .iter()
        .filter(|violation| violation.fixability() == Fixability::AcknowledgeOnly)
        .filter_map(|violation| match violation {
            Violation::Unprovable(fact) => Some(fact.clone()),
            Violation::Breach(_) => None,
        })
        .collect();
    let mut coordinates = Vec::new();
    if let Some(effects) = &delta.prior_effects {
        coordinates.push(DeltaCoordinate::ExceptPriorEffects(effects.clone()));
    }
    if delta.confirms {
        coordinates.push(DeltaCoordinate::StandInConfirmation);
    }
    if !delta.control_release.is_empty() {
        coordinates.push(DeltaCoordinate::ReleaseControl(delta.control_release.clone()));
    }
    if !acknowledged.is_empty() || coordinates.is_empty() {
        coordinates.push(DeltaCoordinate::AcknowledgeUnknown(acknowledged));
    }
    Authorization::new(
        AuthorizationDelta::product(coordinates).expect("at least one coordinate by construction"),
        AuthorizationScope::PolicyCheck { flow },
    )
    .expect("the planner lifts only non-empty coordinates at their check scope")
}

/// The durable raise authorization an endorse of `source` asks for.
pub(super) fn raise_authorization(source: ValueId, delta: &LabelRaise) -> Authorization {
    Authorization::new(
        AuthorizationDelta::single(DeltaCoordinate::RaiseLabel(delta.clone())),
        AuthorizationScope::DerivedValue { source },
    )
    .expect("the planner raises only non-empty deltas at their derived-value scope")
}

/// The action-scoped acquisition authorization for a surface growth.
pub(super) fn acquire_authorization(action: ActionId, growth: &Effects) -> Authorization {
    Authorization::new(
        AuthorizationDelta::single(DeltaCoordinate::AcquireEffects(growth.clone())),
        AuthorizationScope::PendingAction { action },
    )
    .expect("a surface-growth witness is never empty")
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
fn needed_delta(violations: &[Violation]) -> Lift {
    use crate::contract::Breach;
    let mut delta = Lift::empty();
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
fn endorse_steps(sim: &SimFlow, violations: &[Violation]) -> Vec<(ValueId, LabelRaise)> {
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
    let full = LabelRaise {
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
        let delta = LabelRaise {
            trust: full.trust.filter(|req| label.trust.raised_to(*req) != label.trust),
            audience: audience.filter(|deficit| !deficit.is_empty()),
        };
        if !delta.is_empty() {
            steps.push((*leaf, delta));
        }
    }
    steps
}
