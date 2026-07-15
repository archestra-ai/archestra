use tracing::debug;

use crate::contract::{Fixability, Violation};
use crate::dimension::Effects;
use crate::plan::NonEmptyVec;
use crate::request::{EmissionRequest, ToolRequest};
use crate::revision::ActionId;
use crate::turn::Trajectory;
use crate::value::ValueLabel;

use super::PolicyEngine;
use super::capability::{BlockReason, Emitted, ExecutionToken, FlowOutcome, FlowRefusal};
use super::planning::SimFlow;

impl PolicyEngine {
    /// Evaluate one requested tool flow against exactly its dependencies.
    ///
    /// Takes the trajectory mutably: a checked evaluation stores the pending
    /// action, and decision-time audit appends control-plane events.
    /// Re-evaluating the same original request is idempotent re-entry — it
    /// reuses the stored pending action. An invalid, stale, or conflicting
    /// proposal is a [`FlowRefusal`], outside the policy tri-state and
    /// touching nothing: a *different* proposal while one is pending, a
    /// released action's re-entry (dispatch in flight), or a reference to a
    /// value this trajectory never admitted.
    ///
    /// A tool with no registered contract is first-class: calling it is
    /// itself unprovable ([`Unprovable::NoContract`](crate::contract::Unprovable::NoContract)), its output label is
    /// all-`Unknown`, and its proposed effects are `Unknown` (anything may
    /// happen), which then poison exactly the flows that depend on them.
    #[tracing::instrument(level = "debug", skip_all, fields(tool = %request.tool))]
    pub fn evaluate(
        &self,
        trajectory: &mut Trajectory,
        request: ToolRequest,
    ) -> Result<FlowOutcome<ExecutionToken>, FlowRefusal> {
        // The first evaluation freezes the registries: routing is resolved
        // live, so a later registration would change which authority rules
        // an already-minted plan.
        self.freeze();
        // Pending-slot discipline: at most one action, idempotent re-entry
        // against the immutable original, everything else refused.
        let (checked_request, existing_action) = match trajectory.pending_action() {
            // A released action has a dispatch in flight (its execution token
            // was consumed by `release`, and a receipt is outstanding).
            // Re-permitting it would mint a second token at the same revision
            // and enable a double dispatch — refuse until the receipt closes
            // the action via record_output/record_failure.
            Some(pending)
                if *pending.original() == request && pending.state() == crate::request::ActionState::Released =>
            {
                debug!(action = %pending.id(), "refused (action already released, dispatch in flight)");
                return Err(FlowRefusal::ActionAlreadyPending { pending: pending.id() });
            }
            Some(pending) if *pending.original() == request => {
                debug!(action = %pending.id(), "re-entry: reusing pending action");
                (pending.current().clone(), Some(pending.id()))
            }
            Some(pending) => {
                debug!(pending = %pending.id(), "refused (another action already pending)");
                return Err(FlowRefusal::ActionAlreadyPending { pending: pending.id() });
            }
            None => (request.clone(), None),
        };

        // One source of truth for what the flow reports: the same `SimFlow`
        // the planner predicts with and `apply_step` validates against.
        // Construction happens only after the pending-slot gate above, so a
        // pending action feeding it is always this very request's re-entry
        // (its proposed/accepted effects reflect any constrain narrowing or
        // prior Accept).
        let contract = self.contracts.get(&checked_request.tool);
        let sim = match SimFlow::of(trajectory, &checked_request, contract) {
            Ok(sim) => sim,
            Err(unknown) => {
                debug!(value = %unknown.id, "refused (unknown value referenced)");
                return Err(FlowRefusal::UnknownValueReferenced { value: unknown.id });
            }
        };
        debug!(has_contract = contract.is_some(), flow = %sim.flow_label(), "contract lookup");
        let intrinsic = contract
            .map(|c| c.output_label.clone())
            .unwrap_or_else(ValueLabel::unknown);
        let proposed_effects = sim.proposed_effects.clone();
        let violations = sim.violations(None);

        if violations.is_empty() {
            debug!("allowed (no violations)");
            return Ok(self.permit(
                trajectory,
                existing_action,
                request,
                checked_request,
                intrinsic,
                proposed_effects,
            ));
        }
        debug!(violations = ?violations, "triaging violations");

        // Axis: fixability. A structural violation is an integration bug
        // nothing may override — block before any disposition.
        if violations.iter().any(|v| v.fixability() == Fixability::Structural) {
            debug!("blocked (structural fix required)");
            return Ok(self.terminal(trajectory, violations, BlockReason::RequiresStructuralFix));
        }

        // Everything else — provable breaches and unprovable facts alike —
        // routes through the remedy chain. A grant-fixable gap routes to a
        // check-scoped lift; an acknowledge-only unprovable to an
        // `acknowledge_unknown` authority. There is no implicit accept: an
        // unprovable with no competent authority blocks. The pending action
        // is the plans' shared target, so it must exist before planning.
        let action = match existing_action {
            Some(action) => action,
            None => trajectory.set_pending(request, proposed_effects),
        };
        let pending = trajectory.pending_action().expect("pending action set above");
        let flow = pending.flow();
        // The nondominated frontier: ordinary peels (complete over the
        // reduce/authorize space) and the joint rescue solve (all
        // incomparable releases of the smallest successful cardinality —
        // see `minimal_joint_releases`) share one candidate pool, and an
        // empty return is a proven no-remedy claim over the registered
        // capability space (the rescue sweep is exhaustive on failure).
        let drafts = self.plan_frontier(trajectory, &checked_request, contract, pending);
        match NonEmptyVec::from_vec(trajectory.store_plans(flow, Some(action), self.id, drafts)) {
            Some(plans) => {
                debug!(count = plans.len(), "blocked (remediable)");
                Ok(FlowOutcome::Remediable { violations, plans })
            }
            None => {
                debug!("blocked (no remedy)");
                Ok(self.terminal(trajectory, violations, BlockReason::NoRemedy))
            }
        }
    }

    /// Evaluate one assistant emission through the same pipeline as any tool
    /// sink, under the reserved sink name
    /// [`RESPONSE_SINK`](super::capability::RESPONSE_SINK) and the registered
    /// [`ResponsePolicy`](super::ResponsePolicy). Core never infers that a
    /// turn is "final": the caller proposes an emission whenever assistant
    /// output is about to cross the mediation boundary.
    ///
    /// `AllowedNow` emits atomically: the rendered bytes — produced from the
    /// exact checked tree — become a value and an assistant turn, and the
    /// harness sends them and nothing else. A remediable emission keeps its
    /// proposal in the pending-emission slot (independent of the tool-action
    /// slot; a blocked emission never clears a pending action) with its
    /// remedy plans; unchecked bytes are never admitted. Without a
    /// registered response policy the emission is unprovable, like a tool
    /// with no contract, and fails closed through the same remedy chain.
    ///
    /// A fresh proposal composed against a revision the trajectory has moved
    /// past is refused ([`FlowRefusal::StaleBasis`]); once pending, re-entry
    /// identity is the request content.
    #[tracing::instrument(level = "debug", skip_all)]
    pub fn evaluate_emission(
        &self,
        trajectory: &mut Trajectory,
        request: EmissionRequest,
    ) -> Result<FlowOutcome<Emitted>, FlowRefusal> {
        self.freeze();
        // Pending-slot discipline, per emission kind: idempotent re-entry
        // against the immutable original, a different proposal refused.
        let (checked, existing_flow) = match trajectory.pending_emission() {
            Some(pending) if *pending.original() == request => {
                debug!(flow = %pending.flow(), "re-entry: reusing pending emission");
                (pending.current().clone(), Some(pending.flow()))
            }
            Some(pending) => {
                debug!(pending = %pending.flow(), "refused (another emission already pending)");
                return Err(FlowRefusal::EmissionAlreadyPending { flow: pending.flow() });
            }
            None => {
                if request.basis != trajectory.revision() {
                    debug!(composed_at = %request.basis, current = %trajectory.revision(), "refused (stale basis)");
                    return Err(FlowRefusal::StaleBasis {
                        composed_at: request.basis,
                        current: trajectory.revision(),
                    });
                }
                (request.clone(), None)
            }
        };

        let sim = match SimFlow::of_emission(trajectory, &checked, self.response_policy.as_ref()) {
            Ok(sim) => sim,
            Err(unknown) => {
                debug!(value = %unknown.id, "refused (unknown value referenced)");
                return Err(FlowRefusal::UnknownValueReferenced { value: unknown.id });
            }
        };
        debug!(has_policy = self.response_policy.is_some(), flow = %sim.flow_label(), "emission check");
        let violations = sim.violations(None);

        if violations.is_empty() {
            let (value, rendered) = trajectory
                .emit_response(&checked.body, checked.control.clone())
                .expect("emission dependencies were validated by the flow simulation above");
            debug!(%value, "emitted");
            return Ok(FlowOutcome::AllowedNow(Emitted { value, rendered }));
        }
        debug!(violations = ?violations, "triaging emission violations");

        if violations.iter().any(|v| v.fixability() == Fixability::Structural) {
            debug!("emission blocked (structural fix required)");
            return Ok(self.terminal_emission(trajectory, violations, BlockReason::RequiresStructuralFix));
        }

        let flow = match existing_flow {
            Some(flow) => flow,
            None => trajectory.set_pending_emission(request),
        };
        let drafts = self.emission_plan_frontier(trajectory, &checked, flow);
        match NonEmptyVec::from_vec(trajectory.store_plans(flow, None, self.id, drafts)) {
            Some(plans) => {
                debug!(count = plans.len(), "emission blocked (remediable)");
                Ok(FlowOutcome::Remediable { violations, plans })
            }
            None => {
                debug!("emission blocked (no remedy)");
                Ok(self.terminal_emission(trajectory, violations, BlockReason::NoRemedy))
            }
        }
    }

    /// Mint the execution token, storing the pending action first if this is
    /// a fresh proposal. Minting happens after every mutation, so the token
    /// is bound to the trajectory's final revision.
    pub(super) fn permit(
        &self,
        trajectory: &mut Trajectory,
        existing_action: Option<ActionId>,
        original: ToolRequest,
        checked_request: ToolRequest,
        intrinsic: ValueLabel,
        proposed_effects: Effects,
    ) -> FlowOutcome<ExecutionToken> {
        let action = match existing_action {
            Some(action) => action,
            None => trajectory.set_pending(original, proposed_effects.clone()),
        };
        FlowOutcome::AllowedNow(ExecutionToken {
            action,
            tool: checked_request.tool.clone(),
            intrinsic,
            arguments: checked_request.arguments.leaves(),
            control: checked_request.control,
            proposed_effects,
            trajectory: trajectory.id(),
            revision: trajectory.revision(),
        })
    }

    /// A terminal block clears the pending action slot: the flow cannot
    /// proceed, so holding the action open would only wedge the trajectory.
    pub(super) fn terminal<P>(
        &self,
        trajectory: &mut Trajectory,
        violations: Vec<Violation>,
        reason: BlockReason,
    ) -> FlowOutcome<P> {
        trajectory.clear_pending();
        FlowOutcome::Terminal { violations, reason }
    }

    /// A terminal emission block clears the pending emission slot — and only
    /// that slot: a blocked emission never clears a pending tool action.
    pub(super) fn terminal_emission<P>(
        &self,
        trajectory: &mut Trajectory,
        violations: Vec<Violation>,
        reason: BlockReason,
    ) -> FlowOutcome<P> {
        trajectory.clear_pending_emission();
        FlowOutcome::Terminal { violations, reason }
    }
}
