use std::collections::BTreeSet;

use tracing::debug;

use crate::approval::{AncestrySnapshot, AuthorityMode, PendingApproval, Ruling, TrajectoryView};
use crate::audit::{AuditEvent, AuthorityName};
use crate::contract::Violation;
use crate::dimension::Effects;
use crate::remedy::{
    Authorization, AuthorizationScope, DeltaCoordinate, LabelRaise, Lift, PlannedRemedy, ReductionTarget,
};
use crate::request::ToolRequest;
use crate::revision::{FlowId, PlanId, ValueId};
use crate::transition::ActionTransition;
use crate::turn::{ReductionSite, Trajectory};
use crate::value::ValueLabel;

use super::PolicyEngine;
use super::capability::{
    BlockReason, Emitted, FlowOutcome, FlowPermit, StepCapability, StepOutcome, StepRefused, ToolContract,
};
use super::planning::SimFlow;

/// The result of routing a grant through the competent authorities: the first
/// resolving inline ruling, a deferral to an external authority, or no ruling
/// at all (every competent authority was inline and abstained).
pub(super) enum RoutedRuling {
    Approved(AuthorityName),
    Denied { authority: AuthorityName, reason: String },
    External(AuthorityName),
    NoRuling,
}

/// A routed grant-bearing step after the shared shell handled denial,
/// external deferral, and abstention. Only the approved continuation is left
/// to the caller — each grant kind advances its own state machine.
enum RoutedStep {
    Approved {
        authority: AuthorityName,
        resolved: Vec<Violation>,
    },
    NeedsApproval(PendingApproval),
    Terminal(FlowOutcome<FlowPermit>),
}

/// Which pending flow a stored plan targets. Plans bind a [`FlowId`]; the
/// two pending slots (tool action, emission) are independent, so the flow
/// resolves to exactly one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlowKind {
    Action,
    Emission,
}

impl FlowKind {
    fn site(self) -> ReductionSite {
        match self {
            Self::Action => ReductionSite::Action,
            Self::Emission => ReductionSite::Emission,
        }
    }
}

/// The stored plan `plan` names, or the refusal.
fn stored_plan(trajectory: &Trajectory, plan: PlanId) -> Result<&crate::plan::RemedyPlan, StepRefused> {
    trajectory
        .plans()
        .iter()
        .find(|p| p.id == plan)
        .ok_or(StepRefused::UnknownPlan { plan })
}

/// Which pending slot targets the checked flow `flow`, or the refusal.
fn pending_flow_kind(trajectory: &Trajectory, flow: FlowId) -> Result<FlowKind, StepRefused> {
    match (trajectory.pending_action(), trajectory.pending_emission()) {
        (Some(pending), _) if pending.flow() == flow => Ok(FlowKind::Action),
        (_, Some(pending)) if pending.flow() == flow => Ok(FlowKind::Emission),
        _ => Err(StepRefused::FlowNotPending { flow }),
    }
}

/// The check-transient lift an authorization applies, reconstructed from its
/// atomic coordinates (the acknowledge coordinate contributes no lift — its
/// facts are cleared by the recheck's presence-of-a-lift rule).
fn lift_of(ask: &Authorization) -> Lift {
    let mut lift = Lift::empty();
    for coordinate in ask.delta().coordinates() {
        match coordinate {
            DeltaCoordinate::ExceptPriorEffects(effects) => lift.prior_effects = Some(effects.clone()),
            DeltaCoordinate::StandInConfirmation => lift.confirms = true,
            DeltaCoordinate::ReleaseControl(deps) => lift.control_release = deps.clone(),
            DeltaCoordinate::RaiseLabel(_)
            | DeltaCoordinate::AcquireEffects(_)
            | DeltaCoordinate::AcknowledgeUnknown(_) => {}
        }
    }
    lift
}

/// The durable raise an authorization mints, if it carries one.
fn raise_of(ask: &Authorization) -> Option<LabelRaise> {
    ask.delta().coordinates().find_map(|coordinate| match coordinate {
        DeltaCoordinate::RaiseLabel(raise) => Some(raise.clone()),
        _ => None,
    })
}

/// The surface growth an authorization acquires, if it carries one.
fn acquisition_of(ask: &Authorization) -> Option<Effects> {
    ask.delta().coordinates().find_map(|coordinate| match coordinate {
        DeltaCoordinate::AcquireEffects(effects) => Some(effects.clone()),
        _ => None,
    })
}

impl PolicyEngine {
    /// Mint the linear capability for one stored plan step. Pure — binding
    /// happens against the current revision; any later state change stales
    /// the capability.
    pub fn mint_step(&self, trajectory: &Trajectory, plan: PlanId, step: usize) -> Result<StepCapability, StepRefused> {
        let stored = stored_plan(trajectory, plan)?;
        if stored.basis != trajectory.revision() {
            return Err(StepRefused::StalePlan {
                basis: stored.basis,
                current: trajectory.revision(),
            });
        }
        if stored.engine != self.id {
            return Err(StepRefused::ForeignEngine {
                minted_by: stored.engine,
                this: self.id,
            });
        }
        stored.steps.get(step).ok_or(StepRefused::NoSuchStep { plan, step })?;
        // Only the head step is executable: the remainder of a plan is
        // predictive and is replaced by the recheck after each applied
        // remedy, so applying it out of order would route authorities on
        // targets the earlier steps were supposed to remove.
        if step != 0 {
            return Err(StepRefused::NotNextStep { step });
        }
        pending_flow_kind(trajectory, stored.flow)?;
        Ok(StepCapability {
            plan,
            step,
            flow: stored.flow,
            trajectory: trajectory.id(),
            revision: trajectory.revision(),
            engine: self.id,
        })
    }

    /// Consume a step capability and apply its remedy. Binding failures
    /// (foreign trajectory, stale revision) refuse without touching state;
    /// reduction failures are audited and advance the revision, staling
    /// every sibling capability and plan. On success the original flow is
    /// re-evaluated — allowing, re-planning with fresh predictions, or
    /// blocking terminally.
    #[tracing::instrument(level = "debug", skip_all, fields(plan = %capability.plan, step = capability.step))]
    pub fn apply_step(
        &self,
        trajectory: &mut Trajectory,
        capability: StepCapability,
    ) -> Result<StepOutcome, StepRefused> {
        if capability.engine != self.id {
            return Err(StepRefused::ForeignEngine {
                minted_by: capability.engine,
                this: self.id,
            });
        }
        if capability.trajectory != trajectory.id() {
            return Err(StepRefused::ForeignTrajectory {
                minted_for: capability.trajectory,
                this: trajectory.id(),
            });
        }
        if capability.revision != trajectory.revision() {
            return Err(StepRefused::StalePlan {
                basis: capability.revision,
                current: trajectory.revision(),
            });
        }
        let stored = stored_plan(trajectory, capability.plan)?;
        let step = stored
            .steps
            .get(capability.step)
            .ok_or(StepRefused::NoSuchStep {
                plan: capability.plan,
                step: capability.step,
            })?
            .clone();
        if capability.step != 0 {
            return Err(StepRefused::NotNextStep { step: capability.step });
        }
        let kind = pending_flow_kind(trajectory, capability.flow)?;

        match step {
            PlannedRemedy::Reduce(ReductionTarget::DeriveValue { source, transformer }) => {
                let registered = self
                    .transformers
                    .iter()
                    .find(|t| t.descriptor.transformer == transformer)
                    .expect("plans reference only registered transformers");
                let source_value = trajectory.value(source).expect("plans reference only admitted values");
                // The registered reduction relation, rechecked live: a failed
                // relation creates no value and no substitution.
                if let Err(failure) = registered.accepts(&source_value) {
                    trajectory.fail_transform(
                        source,
                        registered.descriptor.transformer.clone(),
                        registered.descriptor.output.clone(),
                        failure.clone(),
                    );
                    return Ok(StepOutcome::Failed(failure));
                }
                let body = match (registered.run)(source_value.body()) {
                    Ok(body) => body,
                    Err(error) => {
                        let failure = crate::audit::TransitionFailure::TransformerError { message: error.message };
                        trajectory.fail_transform(
                            source,
                            registered.descriptor.transformer.clone(),
                            registered.descriptor.output.clone(),
                            failure.clone(),
                        );
                        return Ok(StepOutcome::Failed(failure));
                    }
                };
                trajectory.apply_transform(
                    source,
                    registered.descriptor.transformer.clone(),
                    registered.descriptor.output.clone(),
                    body,
                    kind.site(),
                );
                // The fail-closed recheck is an execution invariant, not a
                // plan step: re-evaluating the original flow allows,
                // re-plans with fresh predictions, or blocks.
                Ok(StepOutcome::Advanced(self.recheck(trajectory, kind)))
            }
            PlannedRemedy::Reduce(ReductionTarget::NarrowAction { transition }) => {
                debug_assert_eq!(kind, FlowKind::Action, "narrowing is enumerated only for tool flows");
                let registered = self
                    .action_transitions
                    .iter()
                    .find(|t| t.id == transition)
                    .expect("plans reference only registered action transitions");
                let pending = trajectory
                    .pending_action()
                    .expect("a tool flow's pending action was resolved above");
                let checked = pending.current().clone();
                let recipients = SimFlow::of(trajectory, &checked, self.contracts.get(&checked.tool))
                    .expect("pending action dependencies stay admitted")
                    .recipients;
                // The same structural gate the planner filtered candidates
                // with, rechecked live against the current registries.
                // The target tool's requirements — including an unstated one,
                // which the recheck escalates as `RequirementsUnknown` — are
                // adopted by the re-evaluation below, not mirrored here: the
                // postcondition simulation this replaced could only predict
                // what the mandatory recheck now re-derives from the contract.
                match self.constrain_gate(registered, pending, &checked, trajectory.store(), &recipients) {
                    Ok(_) => {}
                    Err(failure) => {
                        trajectory.record_event(AuditEvent::StepFailed {
                            plan: capability.plan,
                            step: capability.step as u64,
                            failure: failure.clone(),
                        });
                        return Ok(StepOutcome::Failed(failure));
                    }
                }
                trajectory.apply_constraint(registered.to_tool.clone(), registered.effects.clone());
                Ok(StepOutcome::Advanced(self.recheck(trajectory, kind)))
            }
            PlannedRemedy::Authorize {
                authorization, targets, ..
            } => {
                // The authority rules on the step's declared targets: for an
                // ordinary step the residual at its peel, for a terminal-
                // rescue raise the projected post-release residual a masking
                // control dependency hides from the actual vector.
                Ok(
                    match self.route_step_grant(trajectory, &capability, kind, authorization.clone(), targets) {
                        RoutedStep::Approved { authority, resolved } => match &authorization.scope() {
                            AuthorizationScope::DerivedValue { source } => {
                                let raise =
                                    raise_of(&authorization).expect("a derived-value authorization carries a raise");
                                StepOutcome::Advanced(self.endorse_permit(trajectory, *source, raise, authority, kind))
                            }
                            AuthorizationScope::PendingAction { .. } => {
                                debug_assert_eq!(
                                    kind,
                                    FlowKind::Action,
                                    "acquisition is enumerated only for tool flows"
                                );
                                let effects = acquisition_of(&authorization)
                                    .expect("an action-scoped authorization carries an acquisition");
                                StepOutcome::Advanced(self.accept_permit(trajectory, effects, authority, resolved))
                            }
                            AuthorizationScope::PolicyCheck { .. } => StepOutcome::Advanced(self.lift_permit(
                                trajectory,
                                kind,
                                lift_of(&authorization),
                                authorization.clone(),
                                authority,
                                resolved,
                            )),
                        },
                        RoutedStep::NeedsApproval(pending) => StepOutcome::NeedsApproval(pending),
                        RoutedStep::Terminal(outcome) => StepOutcome::Advanced(outcome),
                    },
                )
            }
        }
    }

    /// The fail-closed recheck after an applied remedy: re-evaluate the
    /// pending flow's immutable original. Re-entry of the flow whose remedy
    /// just applied is structurally never a refusal (the pending slot holds
    /// this very flow and its dependencies stay admitted).
    fn recheck(&self, trajectory: &mut Trajectory, kind: FlowKind) -> FlowOutcome<FlowPermit> {
        match kind {
            FlowKind::Action => {
                let original = trajectory
                    .pending_action()
                    .expect("the applied remedy's action stays pending")
                    .original()
                    .clone();
                self.evaluate(trajectory, original)
                    .expect("re-entry of the pending action is never a refusal")
                    .map_allowed(FlowPermit::Execute)
            }
            FlowKind::Emission => {
                let original = trajectory
                    .pending_emission()
                    .expect("the applied remedy's emission stays pending")
                    .original()
                    .clone();
                self.evaluate_emission(trajectory, original)
                    .expect("re-entry of the pending emission is never a refusal")
                    .map_allowed(FlowPermit::Emit)
            }
        }
    }

    /// The kind-matched terminal: a terminal policy block clears exactly the
    /// blocked flow's pending slot.
    fn terminal_for(
        &self,
        trajectory: &mut Trajectory,
        kind: FlowKind,
        violations: Vec<Violation>,
        reason: BlockReason,
    ) -> FlowOutcome<FlowPermit> {
        match kind {
            FlowKind::Action => self.terminal(trajectory, violations, reason),
            FlowKind::Emission => self.terminal_emission(trajectory, violations, reason),
        }
    }

    /// The routing shell every grant-bearing step shares. Consults the
    /// competent authorities through a read-only view taken (and dropped)
    /// before any mutation, so an inline ruling cannot observe its own
    /// effects; a denial is audited under its typed authorization and blocks
    /// terminally; an external deferral audits `ApprovalRequested` *first*
    /// and only then mints the approval, so the approval is bound to the
    /// post-audit revision (`record_event` advances it — the order is
    /// load-bearing); an all-inline abstention blocks with no ruling.
    fn route_step_grant(
        &self,
        trajectory: &mut Trajectory,
        capability: &StepCapability,
        kind: FlowKind,
        grant: Authorization,
        resolved: Vec<Violation>,
    ) -> RoutedStep {
        let routed = {
            let view = TrajectoryView::new(trajectory.view());
            self.route_grant(&grant, &resolved, &view)
        };
        match routed {
            RoutedRuling::Approved(authority) => RoutedStep::Approved { authority, resolved },
            RoutedRuling::Denied { authority, reason } => {
                trajectory.record_denied_authorization(grant.clone(), authority.clone(), reason.clone());
                RoutedStep::Terminal(self.terminal_for(
                    trajectory,
                    kind,
                    resolved,
                    BlockReason::DeniedByAuthority { authority, reason },
                ))
            }
            RoutedRuling::External(authority) => {
                trajectory.record_event(AuditEvent::ApprovalRequested {
                    plan: capability.plan,
                    authority: authority.clone(),
                    resolved: resolved.clone(),
                });
                let basis = self.flow_basis(trajectory, kind);
                let ancestry = AncestrySnapshot::of(trajectory.view(), basis);
                RoutedStep::NeedsApproval(PendingApproval::new(
                    capability.plan,
                    capability.flow,
                    grant,
                    authority,
                    resolved,
                    ancestry,
                    trajectory.id(),
                    trajectory.revision(),
                    self.id,
                ))
            }
            RoutedRuling::NoRuling => {
                RoutedStep::Terminal(self.terminal_for(trajectory, kind, resolved, BlockReason::NoAuthorityRuled))
            }
        }
    }

    /// The value ids an approval's ancestry snapshot walks: the pending
    /// flow's argument (or body) leaves plus its control dependencies.
    fn flow_basis(&self, trajectory: &Trajectory, kind: FlowKind) -> Vec<ValueId> {
        match kind {
            FlowKind::Action => {
                let checked = trajectory
                    .pending_action()
                    .expect("a tool flow's pending action was resolved by the caller")
                    .current();
                checked
                    .arguments
                    .leaves()
                    .into_iter()
                    .chain(checked.control.iter().copied())
                    .collect()
            }
            FlowKind::Emission => {
                let checked = trajectory
                    .pending_emission()
                    .expect("an emission flow's pending emission was resolved by the caller")
                    .current();
                checked
                    .body
                    .leaves()
                    .into_iter()
                    .chain(checked.control.iter().copied())
                    .collect()
            }
        }
    }

    /// Consult competent authorities for `grant` in routing order and return
    /// the first resolving ruling. Inline authorities decide synchronously;
    /// an abstention (`None`) falls through to the next competent authority.
    /// The first competent external authority defers to an out-of-process
    /// ruling. `NoRuling` means every competent authority was inline and every
    /// one abstained.
    pub(super) fn route_grant(
        &self,
        grant: &Authorization,
        resolved: &[Violation],
        view: &TrajectoryView,
    ) -> RoutedRuling {
        for authority in self.competent_authorities(grant) {
            match &authority.mode {
                AuthorityMode::Inline(decide) => match decide(grant, resolved, view) {
                    Some(Ruling::Approve { .. }) => return RoutedRuling::Approved(authority.name.clone()),
                    Some(Ruling::Deny { reason }) => {
                        return RoutedRuling::Denied {
                            authority: authority.name.clone(),
                            reason,
                        };
                    }
                    None => continue,
                },
                AuthorityMode::External => return RoutedRuling::External(authority.name.clone()),
            }
        }
        RoutedRuling::NoRuling
    }

    /// Consume a pending approval with the authority's ruling. Binding
    /// failures refuse without touching state. A denial is audited and
    /// blocks terminally; an approval advances the granted authorization's
    /// state machine and rechecks the flow fail-closed.
    pub fn apply_approval(
        &self,
        trajectory: &mut Trajectory,
        pending: PendingApproval,
        ruling: Ruling,
    ) -> Result<FlowOutcome<FlowPermit>, StepRefused> {
        let parts = pending.into_parts();
        if parts.engine != self.id {
            return Err(StepRefused::ForeignEngine {
                minted_by: parts.engine,
                this: self.id,
            });
        }
        if parts.trajectory != trajectory.id() {
            return Err(StepRefused::ForeignTrajectory {
                minted_for: parts.trajectory,
                this: trajectory.id(),
            });
        }
        if parts.revision != trajectory.revision() {
            return Err(StepRefused::StalePlan {
                basis: parts.revision,
                current: trajectory.revision(),
            });
        }
        let kind = pending_flow_kind(trajectory, parts.flow)?;
        match ruling {
            // Dispatch on the authorization's scope: a durable raise mints the
            // endorsed value; an action-scoped acquisition records the growth
            // marker and re-evaluates; a check-scoped lift (or acknowledgment)
            // rechecks and permits.
            Ruling::Approve { .. } => match &parts.grant.scope() {
                AuthorizationScope::DerivedValue { source } => {
                    let raise = raise_of(&parts.grant).expect("a derived-value grant carries a raise");
                    Ok(self.endorse_permit(trajectory, *source, raise, parts.authority, kind))
                }
                AuthorizationScope::PendingAction { .. } => {
                    debug_assert_eq!(kind, FlowKind::Action, "acquisition is enumerated only for tool flows");
                    let effects = acquisition_of(&parts.grant).expect("an action-scoped grant carries an acquisition");
                    Ok(self.accept_permit(trajectory, effects, parts.authority, parts.resolved))
                }
                AuthorizationScope::PolicyCheck { .. } => {
                    let lift = lift_of(&parts.grant);
                    Ok(self.lift_permit(trajectory, kind, lift, parts.grant, parts.authority, parts.resolved))
                }
            },
            Ruling::Deny { reason } => {
                trajectory.record_denied_authorization(parts.grant.clone(), parts.authority.clone(), reason.clone());
                Ok(self.terminal_for(
                    trajectory,
                    kind,
                    parts.resolved,
                    BlockReason::DeniedByAuthority {
                        authority: parts.authority,
                        reason,
                    },
                ))
            }
        }
    }

    /// A granted check-scoped authorization: recheck the flow fail-closed
    /// under its lift, audit the application, and carry the flow out — mint
    /// the execution token for a tool flow, emit atomically for an emission
    /// flow. The lift is check-transient, so the carried-out check *is* the
    /// one the lift covered (a full re-evaluation would lose it).
    fn lift_permit(
        &self,
        trajectory: &mut Trajectory,
        kind: FlowKind,
        delta: Lift,
        authorization: Authorization,
        authority: AuthorityName,
        resolved: Vec<Violation>,
    ) -> FlowOutcome<FlowPermit> {
        match kind {
            FlowKind::Action => {
                let pending = trajectory
                    .pending_action()
                    .expect("a tool flow's pending action was resolved by the caller");
                let action = pending.id();
                let checked = pending.current().clone();
                let original = pending.original().clone();
                // The pending action's proposed effects are the single source of truth
                // for what release commits — never re-derive them from the contract
                // (a constrain or an Accept→Waive sequence would be silently undone).
                let proposed_effects = pending.proposed_effects().clone();
                let contract = self.contracts.get(&checked.tool);
                let sim =
                    SimFlow::of(trajectory, &checked, contract).expect("pending action dependencies stay admitted");
                let remaining = sim.violations(Some(&delta));
                if !remaining.is_empty() {
                    debug!("lift did not clear its targeted checks, failing closed");
                    return self.terminal(trajectory, remaining, BlockReason::PostconditionFailed);
                }
                let transition = trajectory.mint_transition();
                trajectory.record_applied_authorization(transition, authorization, authority, resolved);
                let intrinsic = match contract {
                    Some(c) => c.output_label.clone(),
                    None => ValueLabel::unknown(),
                };
                self.permit(trajectory, Some(action), original, checked, intrinsic, proposed_effects)
                    .map_allowed(FlowPermit::Execute)
            }
            FlowKind::Emission => {
                let checked = trajectory
                    .pending_emission()
                    .expect("an emission flow's pending emission was resolved by the caller")
                    .current()
                    .clone();
                let sim = SimFlow::of_emission(trajectory, &checked, self.response_policy.as_ref())
                    .expect("pending emission dependencies stay admitted");
                let remaining = sim.violations(Some(&delta));
                if !remaining.is_empty() {
                    debug!("lift did not clear its targeted checks, failing closed");
                    return self.terminal_emission(trajectory, remaining, BlockReason::PostconditionFailed);
                }
                let transition = trajectory.mint_transition();
                trajectory.record_applied_authorization(transition, authorization, authority, resolved);
                let (value, rendered) = trajectory
                    .emit_response(&checked.body, checked.control)
                    .expect("pending emission dependencies stay admitted");
                FlowOutcome::AllowedNow(FlowPermit::Emit(Emitted { value, rendered }))
            }
        }
    }

    /// A granted acceptance: record the authorized growth on the pending action
    /// (auditing the authority) as one transaction, then re-evaluate. The
    /// marker suppresses the surface-growth soft-ban on the recheck; the effect
    /// still commits at release, never here. Fails closed if the acceptance does
    /// not clear the growth it targeted; any unrelated residual is left for the
    /// re-evaluation to route (an Accept→Waive composite becomes two steps).
    fn accept_permit(
        &self,
        trajectory: &mut Trajectory,
        effects: Effects,
        authority: AuthorityName,
        resolved: Vec<Violation>,
    ) -> FlowOutcome<FlowPermit> {
        let pending = trajectory
            .pending_action()
            .expect("caller validated the pending action");
        let checked = pending.current().clone();
        let contract = self.contracts.get(&checked.tool);
        let mut after = SimFlow::of(trajectory, &checked, contract).expect("pending action dependencies stay admitted");
        after.accepted_effects = after.accepted_effects.clone().combine(effects.clone());
        if after
            .violations(None)
            .iter()
            .any(|v| matches!(v, Violation::Breach(crate::contract::Breach::SurfaceGrowth { .. })))
        {
            debug!("acceptance did not clear the surface growth, failing closed");
            return self.terminal(trajectory, after.violations(None), BlockReason::PostconditionFailed);
        }
        // Attribute to the acquire authority only the surface growth it actually
        // acquired — a co-resident breach (e.g. a trust breach it cannot clear)
        // is a separate step's concern and must not appear as resolved by Accept.
        let acquired: Vec<Violation> = resolved
            .into_iter()
            .filter(|v| matches!(v, Violation::Breach(crate::contract::Breach::SurfaceGrowth { .. })))
            .collect();
        trajectory.accept_growth(effects, authority, acquired);
        self.recheck(trajectory, FlowKind::Action)
    }

    /// A granted endorsement: mint the durable relabel of `source` — its bytes
    /// under a label raised by `delta` — auditing the authority, then
    /// re-evaluate. The raise is monotone (`raised_to`/`admitting` only lift a
    /// label), so the re-evaluation is the fail-closed recheck: a residual on
    /// another leaf (a multi-source breach) routes the next step, and an
    /// under-covered flow is never permitted. Each endorse raises a distinct
    /// leaf to a passing label, so the re-entry terminates.
    fn endorse_permit(
        &self,
        trajectory: &mut Trajectory,
        source: ValueId,
        delta: LabelRaise,
        authority: AuthorityName,
        kind: FlowKind,
    ) -> FlowOutcome<FlowPermit> {
        let raised = {
            let source_label = trajectory.label(source).expect("plans reference only admitted values");
            delta.raise(source_label)
        };
        trajectory.endorse_value(source, authority, delta, raised, kind.site());
        self.recheck(trajectory, kind)
    }

    /// The structural gate a constrain must pass, identical at planning and
    /// application: the narrowing holds, the target contract exists and
    /// declares exactly the transition's effects, and its argument schema
    /// does not widen the resolved recipient set.
    pub(super) fn constrain_gate<'a>(
        &'a self,
        transition: &ActionTransition,
        pending: &crate::request::PendingAction,
        checked: &ToolRequest,
        store: &crate::value::ValueStore,
        base_recipients: &BTreeSet<crate::dimension::UserId>,
    ) -> Result<(&'a ToolContract, BTreeSet<crate::dimension::UserId>), crate::audit::TransitionFailure> {
        transition.narrows(pending)?;
        let Some(target) = self.contracts.get(&transition.to_tool) else {
            return Err(crate::audit::TransitionFailure::ReductionRefused);
        };
        if target.effects != transition.effects {
            return Err(crate::audit::TransitionFailure::ReductionRefused);
        }
        let Ok(recipients) = target.arguments.resolve_recipients(&checked.arguments, store) else {
            return Err(crate::audit::TransitionFailure::ReductionRefused);
        };
        if !recipients.is_subset(base_recipients) {
            return Err(crate::audit::TransitionFailure::ReductionRefused);
        }
        Ok((target, recipients))
    }
}
