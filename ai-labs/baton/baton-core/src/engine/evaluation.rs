use tracing::debug;

use crate::ToolName;
use crate::contract::{Fixability, Unprovable, Verdict, Violation};
use crate::dimension::Effects;
use crate::plan::NonEmptyVec;
use crate::request::{ResponseRequest, ToolRequest};
use crate::revision::ActionId;
use crate::turn::Trajectory;
use crate::value::ValueLabel;

use super::PolicyEngine;
use super::capability::{
    BlockReason, Blocked, Decision, ExecutionToken, RESPONSE_SINK, ResponseDecision, TerminalBlock,
};
use super::planning::SimFlow;

impl PolicyEngine {
    /// Evaluate one requested flow against exactly its dependencies.
    ///
    /// Takes the trajectory mutably: a permitted evaluation stores the
    /// pending action, and decision-time audit (policy-audited unknowns)
    /// appends control-plane events. Re-evaluating the same original request
    /// is idempotent re-entry — it reuses the stored pending action; a
    /// *different* proposal while one is pending blocks without touching it.
    ///
    /// A tool with no registered contract is first-class: calling it is
    /// itself unprovable ([`Unprovable::NoContract`]), its output label is
    /// all-`Unknown`, and its proposed effects are `Unknown` (anything may
    /// happen), which then poison exactly the flows that depend on them.
    #[tracing::instrument(level = "debug", skip_all, fields(tool = %request.tool))]
    pub fn evaluate(&self, trajectory: &mut Trajectory, request: ToolRequest) -> Decision {
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
                debug!(action = %pending.id(), "blocked (action already released, dispatch in flight)");
                return Decision::Blocked(Blocked::Terminal(TerminalBlock {
                    violations: Vec::new(),
                    reason: BlockReason::ActionAlreadyPending { pending: pending.id() },
                }));
            }
            Some(pending) if *pending.original() == request => {
                debug!(action = %pending.id(), "re-entry: reusing pending action");
                (pending.current().clone(), Some(pending.id()))
            }
            Some(pending) => {
                debug!(pending = %pending.id(), "blocked (another action already pending)");
                return Decision::Blocked(Blocked::Terminal(TerminalBlock {
                    violations: Vec::new(),
                    reason: BlockReason::ActionAlreadyPending { pending: pending.id() },
                }));
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
                debug!(value = %unknown.id, "blocked (unknown value referenced)");
                return self.terminal(
                    trajectory,
                    Vec::new(),
                    BlockReason::UnknownValueReferenced { value: unknown.id },
                );
            }
        };
        debug!(has_contract = contract.is_some(), flow = %sim.flow_label(), "contract lookup");
        let intrinsic = contract
            .map(|c| c.output_label.clone())
            .unwrap_or_else(ValueLabel::unknown);
        let proposed_effects = sim.proposed_effects.clone();
        let violations = sim.violations(None);

        if violations.is_empty() {
            debug!("permitted (no violations)");
            return self.permit(
                trajectory,
                existing_action,
                request,
                checked_request,
                intrinsic,
                proposed_effects,
            );
        }
        debug!(violations = ?violations, "triaging violations");

        // Axis: fixability. A structural violation is an integration bug
        // nothing may override — block before any disposition.
        if violations.iter().any(|v| v.fixability() == Fixability::Structural) {
            debug!("blocked (structural fix required)");
            return self.terminal(trajectory, violations, BlockReason::RequiresStructuralFix);
        }

        // Everything else — provable breaches and unprovable facts alike —
        // routes through the remedy chain. A grant-fixable gap routes to a
        // waiver; an acknowledge-only unprovable to an `acknowledge_unknown`
        // authority (see `enumerate_plans` and `grant_for`). There is no
        // implicit accept: an unprovable with no competent authority blocks.
        // The pending action is the plans' shared target, so it must exist
        // before planning.
        let action = match existing_action {
            Some(action) => action,
            None => trajectory.set_pending(request, proposed_effects),
        };
        let mut drafts = self.enumerate_plans(
            trajectory,
            &checked_request,
            contract,
            trajectory.pending_action().expect("pending action set above"),
        );
        if drafts.is_empty() {
            // Terminal rescue: only a flow ordinary enumeration cannot clear
            // consults the joint Endorse×control-release solver, so plan sets
            // for remediable flows are untouched.
            drafts = self.rescue_plans(trajectory, &checked_request, contract);
        }
        match NonEmptyVec::from_vec(trajectory.store_plans(action, self.id, drafts)) {
            Some(plans) => {
                debug!(count = plans.len(), "blocked (remediable)");
                Decision::Blocked(Blocked::Remediable { violations, plans })
            }
            None => {
                debug!("blocked (no remedy)");
                self.terminal(trajectory, violations, BlockReason::NoRemedy)
            }
        }
    }

    /// The completely mediated response sink: check the response's explicit
    /// and control flow against the [`ResponsePolicy`](crate::engine::ResponsePolicy), and on success admit
    /// the rendered response (an assistant turn) and return the exact bytes
    /// to emit. Revision-bound via `request.basis`; blocked responses touch
    /// nothing (in particular, they never clear a pending tool action).
    ///
    /// The response is the front door: strict emit-or-terminal, no remediation
    /// (a value too dirty to show is relabeled upstream, before the response is
    /// composed). Without a registered response policy the emission is
    /// unprovable, like a tool with no contract, and blocks terminally.
    #[tracing::instrument(level = "debug", skip_all)]
    pub fn evaluate_response(&self, trajectory: &mut Trajectory, request: ResponseRequest) -> ResponseDecision {
        let blocked =
            |violations, reason| ResponseDecision::Blocked(Blocked::Terminal(TerminalBlock { violations, reason }));

        if request.basis != trajectory.revision() {
            debug!(composed_at = %request.basis, current = %trajectory.revision(), "response blocked (stale basis)");
            return blocked(
                Vec::new(),
                BlockReason::StaleResponse {
                    composed_at: request.basis,
                    current: trajectory.revision(),
                },
            );
        }
        let flow = match request.flow_labels(trajectory.store()) {
            Ok(labels) => labels,
            Err(unknown) => {
                return blocked(Vec::new(), BlockReason::UnknownValueReferenced { value: unknown.id });
            }
        };

        let sink = ToolName::new(RESPONSE_SINK);
        let verdict = match &self.response_policy {
            Some(policy) => policy.requires.check_flow(
                &flow.flow(),
                trajectory.state().past_effects(),
                None,
                &sink,
                &policy.readers,
            ),
            None => Verdict::Escalate(vec![Violation::Unprovable(Unprovable::NoContract {
                tool: sink.clone(),
            })]),
        };
        let violations = match verdict {
            Verdict::Allow => Vec::new(),
            Verdict::Escalate(violations) => violations,
        };

        if violations.iter().any(|v| v.fixability() == Fixability::Structural) {
            debug!("response blocked (structural fix required)");
            return blocked(violations, BlockReason::RequiresStructuralFix);
        }
        // Strict emit-or-terminal: any residual violation — breach or
        // unprovable fact — blocks the front door. Nothing is acknowledged or
        // waived here; dirty values are relabeled upstream.
        if !violations.is_empty() {
            debug!("response blocked (no remedy)");
            return blocked(violations, BlockReason::NoRemedy);
        }

        let (value, rendered) = trajectory
            .emit_response(&request.body, request.control)
            .expect("response dependencies were validated by flow_labels above");
        debug!(%value, "response emitted");
        ResponseDecision::Emitted { value, rendered }
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
    ) -> Decision {
        let action = match existing_action {
            Some(action) => action,
            None => trajectory.set_pending(original, proposed_effects.clone()),
        };
        Decision::Permitted(ExecutionToken {
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

    /// A terminal block clears the pending slot: the flow cannot proceed, so
    /// holding the action open would only wedge the trajectory.
    pub(super) fn terminal(
        &self,
        trajectory: &mut Trajectory,
        violations: Vec<Violation>,
        reason: BlockReason,
    ) -> Decision {
        trajectory.clear_pending();
        Decision::Blocked(Blocked::Terminal(TerminalBlock { violations, reason }))
    }
}
