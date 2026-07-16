//! Turns, the trajectory, and its engine-owned admission paths.
//!
//! A trajectory owns all per-conversation state, authoritative in its
//! append-only event log: every public mutation prevalidates, then commits
//! one atomic batch of facts. Every derived read model — labels, provenance,
//! the turn sequence, the committed effect surface, the audit history, the
//! pending slots — is a [`TrajectoryProjection`] of that log, rebuilt in one
//! place after each batch; the value store holds nothing but the opaque
//! bodies the log deliberately omits. The [`Revision`] is the digest of the
//! event frontier — it advances once per accepted batch, so capabilities
//! bound to it are invalidated by *any* state change — a new value, a
//! constrained action, an audit record, a turn.
//!
//! Admission is engine-owned: [`Trajectory::ingress`] is the only
//! caller-labeled path (the explicit trust boundary); a model output's label
//! is computed from its mandatory dependency sets; a tool result enters only
//! by consuming the [`ExecutionToken`](crate::engine::ExecutionToken) the
//! policy minted for it.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tracing::debug;

use std::collections::BTreeSet;

use crate::ToolName;
use crate::audit::AuditEvent;
use crate::dimension::UserId;
use crate::engine::{CanonicalRequest, DispatchReceipt, ExecutionToken, ReceiptParts, RejectedToken};
use crate::event::{EventSet, Fact, ValueOrigin};
use crate::plan::{NonEmptyVec, RemedyPlan};
use crate::projection::TrajectoryProjection;
use crate::remedy::PlannedRemedy;
use crate::request::{ActionState, EmissionRequest, PendingAction, PendingEmission, ToolRequest};
use crate::revision::{ActionId, FlowId, PlanId, Revision, TransitionId, TurnId, ValueId};
use crate::value::{OpaqueValue, UnknownValue, ValueLabel, ValueRef, ValueStore};

/// A user's contribution to a turn: who spoke, and whether they explicitly
/// confirmed one named tool. The `confirms` field is structural, not a label:
/// only user turns carry it, so "only the user confirms" holds by construction
/// rather than by a runtime check — an assistant or tool actor has no such
/// field to forge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserTurn {
    pub id: UserId,
    pub confirms: Option<ToolName>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Actor {
    User(UserTurn),
    Assistant,
    Tool(ToolName),
}

/// Who may author an ingress turn: only a user. Tool results are deliberately
/// absent: they enter a trajectory only through [`Trajectory::record_output`].
/// Assistant output is likewise absent: it is admitted through
/// [`Trajectory::admit_model_output`] under its dependency fold and crosses the
/// mediation boundary only through the checked response sink — a caller-labeled
/// assistant turn would bypass that check.
///
/// ```compile_fail
/// // The bypass is unrepresentable: `Speaker` has no assistant constructor.
/// let speaker = baton_core::Speaker::Assistant;
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Speaker(UserTurn);

impl Speaker {
    pub fn user(id: UserId) -> Self {
        Self(UserTurn { id, confirms: None })
    }

    /// A user message that explicitly confirms one named tool. The
    /// confirmation is valid only while this is the newest turn and it has
    /// not been spent by an action release — see
    /// [`Trajectory::pending_confirmation`].
    pub fn confirming(id: UserId, tool: ToolName) -> Self {
        Self(UserTurn {
            id,
            confirms: Some(tool),
        })
    }
}

/// One turn: who acted, and the stored value they contributed. The label
/// lives on the value, not the turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Turn {
    pub actor: Actor,
    pub value: ValueId,
}

/// Which pending target a derivation substitutes into: the (at most one)
/// pending tool action's argument tree, or the (at most one) pending
/// emission's body tree. The two slots are independent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReductionSite {
    Action,
    Emission,
}

/// Abandonment refused: the pending action was already released, so a
/// dispatch is in flight — it closes only through its receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{action} is released with a dispatch in flight; close it through its receipt")]
pub struct DispatchInFlight {
    pub action: ActionId,
}

/// Identity of one trajectory instance, unique within the process; every
/// capability is bound to it so an authorization cannot cross trajectories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct TrajectoryId(u64);

impl TrajectoryId {
    fn next() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}

impl fmt::Display for TrajectoryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "trajectory#{}", self.0)
    }
}

/// All state of one agent conversation, mediated by the engine.
#[derive(Debug)]
pub struct Trajectory {
    id: TrajectoryId,
    /// The authoritative append-only state: every mutation prevalidates, then
    /// commits one atomic batch of facts here.
    events: EventSet,
    /// Every derived read model, reprojected from `events` after each batch —
    /// the one build path, so no field can drift from the log.
    view: TrajectoryProjection,
    /// The opaque bodies, which the log deliberately does not carry.
    store: ValueStore,
    next_action: u64,
    next_flow: u64,
    next_transition: u64,
    next_grant: u64,
    /// Side cache of the remedy plans minted for the current blocked flow:
    /// predictions, not state — storing them appends nothing and advances
    /// nothing (the per-evaluation `CheckPerformed` fact supplies the
    /// advance); they bind to the basis they were computed against, so any
    /// state change stales them.
    plans: Vec<RemedyPlan>,
    next_plan: u64,
}

impl Default for Trajectory {
    fn default() -> Self {
        Self::new()
    }
}

impl Trajectory {
    /// A fresh trajectory with a process-unique identity — every capability
    /// binds to it, so this must never be derived (`TrajectoryId::default()`
    /// would hand every trajectory the same id).
    pub fn new() -> Self {
        Self {
            id: TrajectoryId::next(),
            events: EventSet::default(),
            view: TrajectoryProjection::default(),
            store: ValueStore::default(),
            next_action: 0,
            next_flow: 0,
            next_transition: 0,
            next_grant: 0,
            plans: Vec::new(),
            next_plan: 0,
        }
    }

    /// The append-only event set — the authoritative state; every reader
    /// surface below is a projection of it.
    pub fn events(&self) -> &EventSet {
        &self.events
    }

    /// The derived read models, reprojected from the log after each batch.
    pub fn view(&self) -> &TrajectoryProjection {
        &self.view
    }

    pub fn id(&self) -> TrajectoryId {
        self.id
    }

    /// The revision is the digest of the event frontier: it advances exactly
    /// when a batch of facts is accepted, so every capability bound to it is
    /// invalidated by any state change.
    pub fn revision(&self) -> Revision {
        Revision::of_frontier(self.events.frontier())
    }

    pub fn turns(&self) -> &[Turn] {
        self.view.turns()
    }

    /// The monotone committed effect surface.
    pub fn past_effects(&self) -> &crate::dimension::Effects {
        self.view.committed_effects()
    }

    /// The control-plane audit history.
    pub fn audit(&self) -> &[AuditEvent] {
        self.view.audit()
    }

    pub fn pending_action(&self) -> Option<&PendingAction> {
        self.view.pending_action()
    }

    pub fn pending_emission(&self) -> Option<&PendingEmission> {
        self.view.pending_emission()
    }

    /// The remedy plans of the most recent remediable block. Only plans
    /// whose `basis` equals the current revision are applicable.
    pub fn plans(&self) -> &[RemedyPlan] {
        &self.plans
    }

    /// One admitted value: its bytes from the store, its label and provenance
    /// from the projection.
    pub fn value(&self, id: ValueId) -> Result<ValueRef<'_>, UnknownValue> {
        Ok(ValueRef::new(
            self.store.body(id)?,
            self.view.label(id).ok_or(UnknownValue { id })?,
            self.view.provenance_of(id).ok_or(UnknownValue { id })?,
        ))
    }

    /// The label of an admitted value.
    pub(crate) fn label(&self, id: ValueId) -> Result<&ValueLabel, UnknownValue> {
        self.view.label(id).ok_or(UnknownValue { id })
    }

    /// The bodies, for rendering an argument tree. Labels and provenance live
    /// in the projection, never here.
    pub fn store(&self) -> &ValueStore {
        &self.store
    }

    /// Admit a message at the explicit trust boundary and append its turn.
    /// The label is trusted input from the embedding harness — this is the
    /// only caller-labeled admission path.
    pub fn ingress(&mut self, speaker: Speaker, label: ValueLabel, body: OpaqueValue) -> ValueId {
        let turn_id = self.next_turn_id();
        let value = self.store.next_id();
        self.commit(vec![
            Fact::ValueAdmitted {
                value,
                origin: ValueOrigin::Ingress { turn: turn_id, label },
            },
            Fact::TurnAppended {
                turn: turn_id,
                actor: Actor::User(speaker.0),
                value,
            },
        ]);
        self.store_body(value, body);
        value
    }

    /// Admit a model output as a value (no turn: a model step becomes part of
    /// the conversation only when a checked response emits it, and reaches a
    /// tool only through a checked request). Its label is the conservative
    /// fold of the mandatory read and control dependency sets.
    pub fn admit_model_output(
        &mut self,
        body: OpaqueValue,
        reads: BTreeSet<ValueId>,
        control: BTreeSet<ValueId>,
    ) -> Result<ValueId, UnknownValue> {
        // Prevalidate the dependency sets before building the batch, so a
        // refusal writes nothing anywhere.
        self.view.fold_labels(reads.iter().chain(control.iter()))?;
        let value = self.store.next_id();
        self.commit(vec![Fact::ValueAdmitted {
            value,
            origin: ValueOrigin::ModelOutput { reads, control },
        }]);
        self.store_body(value, body);
        Ok(value)
    }

    /// Begin dispatch by consuming the execution token: the two-phase
    /// boundary. Commits the action's proposed effects to the monotone past
    /// *before* anything runs (a may-effect record: a later timeout or crash
    /// cannot prove an effect did not happen), spends any pending
    /// confirmation, marks the action released, and hands back the owned
    /// [`CanonicalRequest`] — rendered from the exact checked tree — together
    /// with the linear [`DispatchReceipt`] that must close the action.
    ///
    /// The token is consumed either way; a token minted for another
    /// trajectory, for a revision the trajectory has moved past, or for an
    /// action that is no longer pending is rejected, and the flow must be
    /// re-evaluated against the real state.
    pub fn release(&mut self, token: ExecutionToken) -> Result<(CanonicalRequest, DispatchReceipt), RejectedToken> {
        let parts = token.into_parts();
        if parts.trajectory != self.id {
            debug!(minted_for = %parts.trajectory, this = %self.id, "release: rejected (foreign trajectory)");
            return Err(RejectedToken::ForeignTrajectory {
                minted_for: parts.trajectory,
                this: self.id,
            });
        }
        if parts.revision != self.revision() {
            debug!(minted_at = %parts.revision, current = %self.revision(), "release: rejected (stale token)");
            return Err(RejectedToken::Stale {
                minted_at: parts.revision,
                current: self.revision(),
            });
        }
        let rendered = match self.view.pending_action() {
            // Only a not-yet-released action may be released: a `Released`
            // action already has a dispatch in flight, so a second release
            // would render and commit twice. (The token's revision binding
            // normally prevents a second token, but `release` itself advances
            // the revision, so this state guard is the actual defense.)
            Some(pending) if pending.id() == parts.action && pending.state() != ActionState::Released => {
                crate::request::render(&pending.current().arguments, &self.store)
                    .expect("pending action dependencies were validated at evaluate time")
            }
            _ => {
                debug!(action = %parts.action, "release: rejected (action not pending or already released)");
                return Err(RejectedToken::ActionNotPending { action: parts.action });
            }
        };

        // Dispatch boundary: commit may-effects before release.
        let mut batch = vec![Fact::EffectsCommitted {
            action: parts.action,
            effects: parts.proposed_effects.clone(),
        }];
        if let Some((turn, _)) = self.view.confirmation_available() {
            batch.push(Fact::ConfirmationSpent { turn: *turn });
        }
        batch.push(Fact::ActionReleased { action: parts.action });
        self.commit(batch);
        debug!(action = %parts.action, "release: effects committed, action released");

        let canonical = CanonicalRequest {
            action: parts.action,
            tool: parts.tool.clone(),
            rendered,
        };
        let receipt = DispatchReceipt::from_token_parts(parts);
        Ok((canonical, receipt))
    }

    /// Admit the dispatched tool's output by consuming the receipt: the value
    /// enters under `combine(intrinsic, fold(arguments), fold(control))`, the
    /// tool turn is appended, and the action closes.
    pub fn record_output(&mut self, receipt: DispatchReceipt, body: OpaqueValue) -> Result<ValueId, RejectedToken> {
        let parts = self.validate_receipt(receipt)?;
        let turn_id = self.next_turn_id();
        let value = self.store.next_id();
        self.commit(vec![
            Fact::ValueAdmitted {
                value,
                origin: ValueOrigin::ToolOutput {
                    action: parts.action,
                    intrinsic: parts.intrinsic,
                    arguments: parts.arguments,
                    control: parts.control,
                },
            },
            Fact::TurnAppended {
                turn: turn_id,
                actor: Actor::Tool(parts.tool),
                value,
            },
            Fact::ActionCompleted {
                action: parts.action,
                output: value,
            },
        ]);
        self.store_body(value, body);
        debug!(action = %parts.action, %value, "record_output: recorded tool result");
        Ok(value)
    }

    /// Declare the dispatch failed and close the action. The effects
    /// committed at release stay — failure never removes them — and a
    /// confirmation spent at release stays spent, so the confirming turn
    /// cannot authorize a second attempt.
    pub fn record_failure(&mut self, receipt: DispatchReceipt) -> Result<(), RejectedToken> {
        let parts = self.validate_receipt(receipt)?;
        self.commit(vec![Fact::DispatchFailed { action: parts.action }]);
        debug!(action = %parts.action, "record_failure: dispatch failed, action closed");
        Ok(())
    }

    /// A receipt is validated by lifecycle, not revision: it closes a
    /// dispatch that already happened, so an unrelated mutation after
    /// release (a checked emission, a new value) must not wedge the released
    /// action — only foreign, wrong-action, or already-closed receipts are
    /// refused.
    fn validate_receipt(&self, receipt: DispatchReceipt) -> Result<ReceiptParts, RejectedToken> {
        let parts = receipt.into_parts();
        if parts.trajectory != self.id {
            debug!(minted_for = %parts.trajectory, this = %self.id, "receipt rejected (foreign trajectory)");
            return Err(RejectedToken::ForeignTrajectory {
                minted_for: parts.trajectory,
                this: self.id,
            });
        }
        match self.view.pending_action() {
            Some(pending) if pending.id() == parts.action && pending.state() == ActionState::Released => Ok(parts),
            _ => {
                debug!(action = %parts.action, "receipt rejected (action not pending/released)");
                Err(RejectedToken::ActionNotPending { action: parts.action })
            }
        }
    }

    /// Admit and emit a checked response: the rendered bytes become a value
    /// derived from the body tree's leaves and the control dependencies, and
    /// an assistant turn references it. Only the engine's response sink calls
    /// this, after the flow check passed.
    pub(crate) fn emit_response(
        &mut self,
        body: &crate::request::ArgumentTree<ValueId>,
        control: BTreeSet<ValueId>,
    ) -> Result<(ValueId, String), UnknownValue> {
        let rendered = crate::request::render(body, &self.store)?;
        let reads = body.leaves();
        self.view.fold_labels(reads.iter().chain(control.iter()))?;
        let turn_id = self.next_turn_id();
        let value = self.store.next_id();
        // The batch's ResponseEmitted fact settles any pending emission.
        self.commit(vec![
            Fact::ValueAdmitted {
                value,
                origin: ValueOrigin::ModelOutput { reads, control },
            },
            Fact::TurnAppended {
                turn: turn_id,
                actor: Actor::Assistant,
                value,
            },
            Fact::ResponseEmitted { value },
        ]);
        self.store_body(value, OpaqueValue::new(rendered.clone()));
        Ok((value, rendered))
    }

    /// Explicitly abandon the pending action (e.g. the harness dropped its
    /// token). Clears the slot and advances the revision, so the dropped
    /// token can never be spent. Legal only while the action is still open:
    /// a released action has a dispatch in flight and closes only through
    /// its receipt ([`Trajectory::record_output`] /
    /// [`Trajectory::record_failure`]) — abandoning it would let the same
    /// request re-evaluate and dispatch a second time. No pending action is
    /// a no-op.
    pub fn abandon_pending(&mut self) -> Result<(), DispatchInFlight> {
        match self.view.pending_action().map(|p| (p.id(), p.state())) {
            Some((action, ActionState::Released)) => Err(DispatchInFlight { action }),
            Some((action, _)) => {
                self.commit(vec![Fact::ActionAbandoned { action }]);
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// The user confirmation currently in force, if any: the newest turn's,
    /// only if that turn is a user turn, and only if an action release has
    /// not already spent it. "A confirmation authorizes the immediately
    /// following action, never a later one."
    pub fn pending_confirmation(&self) -> Option<&ToolName> {
        self.view.confirmation_available().map(|(_, tool)| tool)
    }

    pub(crate) fn set_pending(
        &mut self,
        request: ToolRequest,
        proposed_effects: crate::dimension::Effects,
    ) -> ActionId {
        let id = ActionId::new(self.next_action);
        self.next_action += 1;
        let flow = FlowId::new(self.next_flow);
        self.next_flow += 1;
        self.commit(vec![Fact::ActionProposed {
            action: id,
            flow,
            request,
            effects: proposed_effects,
        }]);
        id
    }

    pub(crate) fn clear_pending(&mut self) {
        if let Some(action) = self.view.pending_action().map(PendingAction::id) {
            self.commit(vec![Fact::ActionAbandoned { action }]);
        }
    }

    /// Retain a remediable emission proposal as the pending emission,
    /// opening its checked flow.
    pub(crate) fn set_pending_emission(&mut self, request: EmissionRequest) -> FlowId {
        let flow = FlowId::new(self.next_flow);
        self.next_flow += 1;
        self.commit(vec![Fact::EmissionProposed { flow, request }]);
        flow
    }

    pub(crate) fn clear_pending_emission(&mut self) {
        if let Some(flow) = self.view.pending_emission().map(PendingEmission::flow) {
            self.commit(vec![Fact::EmissionAbandoned { flow }]);
        }
    }

    /// Explicitly abandon the pending emission (e.g. the harness gave up on
    /// remediating it). Clears the slot and advances the revision.
    pub fn abandon_pending_emission(&mut self) {
        self.clear_pending_emission();
    }

    /// Replace the stored remedy plans with freshly enumerated drafts,
    /// assigning ids and stamping the post-advance revision as their basis.
    pub(crate) fn store_plans(
        &mut self,
        flow: FlowId,
        action: Option<ActionId>,
        engine: crate::engine::EngineId,
        drafts: Vec<NonEmptyVec<PlannedRemedy>>,
    ) -> Vec<RemedyPlan> {
        // The check fact is a new occurrence per evaluation (re-entry
        // included): it mirrors this unconditional advance 1:1 so the
        // frontier can replace the revision at cutover without weakening
        // cross-evaluation staleness.
        self.commit(vec![Fact::CheckPerformed { flow, action }]);
        let basis = self.revision();
        self.plans = drafts
            .into_iter()
            .map(|steps| {
                let id = PlanId::new(self.next_plan);
                self.next_plan += 1;
                RemedyPlan {
                    id,
                    flow,
                    steps,
                    basis,
                    engine,
                }
            })
            .collect();
        self.plans.clone()
    }

    pub(crate) fn record_event(&mut self, event: AuditEvent) {
        self.commit(vec![Fact::ControlPlane { event }]);
    }

    /// Record an applied check-scoped authorization as its full one-off
    /// grant lifecycle in one batch: issued, consumed by exactly this check
    /// (referencing the flow and, for a tool flow, the pending action), and
    /// audited. Consumption is keyed by the grant at event admission, so a
    /// second consumption of the same grant is unrepresentable.
    pub(crate) fn record_applied_authorization(
        &mut self,
        transition: TransitionId,
        authorization: crate::remedy::Authorization,
        authority: crate::audit::AuthorityName,
        resolved: Vec<crate::contract::Violation>,
    ) {
        let grant = crate::revision::GrantId::new(self.next_grant);
        self.next_grant += 1;
        let crate::remedy::AuthorizationScope::PolicyCheck { flow } = *authorization.scope() else {
            unreachable!(
                "only check-scoped authorizations ride this path; durable and action scopes mint their value/marker instead"
            );
        };
        let action = self
            .view
            .pending_action()
            .filter(|pending| pending.flow() == flow)
            .map(PendingAction::id);
        let batch = vec![
            Fact::GrantIssued {
                grant,
                authorization: authorization.clone(),
                authority: authority.clone(),
            },
            Fact::GrantConsumed { grant, flow, action },
            Fact::AuthorizationApplied {
                transition,
                authorization,
                authority,
                resolved,
                derived: None,
                labels: None,
            },
        ];
        self.commit(batch);
    }

    /// Audit a denied authorization: one typed audit event and its fact, one
    /// batch, one advance.
    pub(crate) fn record_denied_authorization(
        &mut self,
        authorization: crate::remedy::Authorization,
        authority: crate::audit::AuthorityName,
        reason: String,
    ) {
        self.commit(vec![Fact::AuthorizationDenied {
            authorization,
            authority,
            reason,
        }]);
    }

    /// Apply a validated content-justified `Derive` step as one transaction: admit the
    /// derived value under the declared output label, substitute it into the
    /// pending action's current argument tree, and audit the transition. The
    /// source keeps its own label and its slot in the immutable original
    /// proposal.
    pub(crate) fn apply_transform(
        &mut self,
        source: ValueId,
        transformer: crate::value::TransformerRef,
        declared_output: ValueLabel,
        body: OpaqueValue,
        site: ReductionSite,
    ) -> ValueId {
        let transition = self.mint_transition();
        let input = self
            .label(source)
            .expect("transform source validated by the engine")
            .clone();
        let derived = self.store.next_id();
        self.commit(vec![
            Fact::ValueAdmitted {
                value: derived,
                origin: ValueOrigin::Transformed {
                    source,
                    transition,
                    transformer: transformer.clone(),
                    declared: declared_output.clone(),
                },
            },
            self.substitution_fact(site, source, derived),
            Fact::ControlPlane {
                event: AuditEvent::ValueTransition {
                    transition,
                    transformer,
                    source,
                    derived: Some(derived),
                    input,
                    declared_output,
                    outcome: crate::audit::TransitionOutcome::Applied,
                },
            },
        ]);
        self.store_body(derived, body);
        derived
    }

    /// Audit a failed content-justified `Derive` step: an event, no derived value, and
    /// a revision advance that stales every sibling capability and plan.
    pub(crate) fn fail_transform(
        &mut self,
        source: ValueId,
        transformer: crate::value::TransformerRef,
        declared_output: ValueLabel,
        failure: crate::audit::TransitionFailure,
    ) {
        let transition = self.mint_transition();
        let input = self
            .label(source)
            .expect("transform source validated by the engine")
            .clone();
        let event = AuditEvent::ValueTransition {
            transition,
            transformer,
            source,
            derived: None,
            input,
            declared_output,
            outcome: crate::audit::TransitionOutcome::Failed(failure),
        };
        self.commit(vec![Fact::ControlPlane { event }]);
    }

    /// Apply a validated `ConstrainAction` step as one transaction.
    pub(crate) fn apply_constraint(&mut self, to_tool: ToolName, effects: crate::dimension::Effects) {
        let transition = self.mint_transition();
        let action = self
            .view
            .pending_action()
            .expect("pending action validated by the engine")
            .id();
        self.commit(vec![
            Fact::ActionConstrained {
                action,
                to_tool,
                effects,
            },
            Fact::ControlPlane {
                event: AuditEvent::ActionConstrained {
                    transition,
                    action,
                    outcome: crate::audit::TransitionOutcome::Applied,
                },
            },
        ]);
    }

    /// Apply a granted `AcceptGrowth` step as one transaction: record the
    /// authorized surface growth on the pending action and audit the authority.
    /// The effect still commits at release like any other proposed effect.
    pub(crate) fn accept_growth(
        &mut self,
        effects: crate::dimension::Effects,
        authority: crate::audit::AuthorityName,
        resolved: Vec<crate::contract::Violation>,
    ) {
        let transition = self.mint_transition();
        let action = self
            .view
            .pending_action()
            .expect("pending action validated by the engine")
            .id();
        let acquisition = crate::remedy::Authorization::new(
            crate::remedy::AuthorizationDelta::single(crate::remedy::DeltaCoordinate::AcquireEffects(effects.clone())),
            crate::remedy::AuthorizationScope::PendingAction { action },
        )
        .expect("the engine accepts only non-empty growths");
        self.commit(vec![
            Fact::GrowthAccepted {
                action,
                effects,
                authority: authority.clone(),
            },
            Fact::AuthorizationApplied {
                transition,
                authorization: acquisition,
                authority,
                resolved,
                derived: None,
                labels: None,
            },
        ]);
    }

    /// Apply a granted fiat `Derive` (Endorse) step as one transaction: admit a new
    /// value carrying `source`'s bytes under the authority-`raised` label,
    /// substitute it into the pending action's current argument tree, and audit
    /// the authority. The bytes are unchanged (a no-op relabel); the source
    /// keeps its own label and its slot in the immutable original proposal.
    pub(crate) fn endorse_value(
        &mut self,
        source: ValueId,
        authority: crate::audit::AuthorityName,
        delta: crate::remedy::LabelRaise,
        raised: ValueLabel,
        site: ReductionSite,
    ) -> ValueId {
        let transition = self.mint_transition();
        let source_value = self.value(source).expect("endorse source validated by the engine");
        let input = source_value.label().clone();
        let body = source_value.body().clone();
        let raise_grant = crate::remedy::Authorization::new(
            crate::remedy::AuthorizationDelta::single(crate::remedy::DeltaCoordinate::RaiseLabel(delta.clone())),
            crate::remedy::AuthorizationScope::DerivedValue { source },
        )
        .expect("the engine endorses only non-empty raises");
        let derived = self.store.next_id();
        self.commit(vec![
            Fact::ValueAdmitted {
                value: derived,
                origin: ValueOrigin::Endorsed {
                    source,
                    authority: authority.clone(),
                    delta,
                },
            },
            self.substitution_fact(site, source, derived),
            Fact::AuthorizationApplied {
                transition,
                authorization: raise_grant,
                authority,
                resolved: Vec::new(),
                derived: Some(derived),
                labels: Some(crate::audit::RaiseLabels { input, raised }),
            },
        ]);
        self.store_body(derived, body);
        derived
    }

    /// The substitution fact for a derivation at `site`.
    fn substitution_fact(&self, site: ReductionSite, from: ValueId, to: ValueId) -> Fact {
        match site {
            ReductionSite::Action => Fact::ArgumentSubstituted {
                action: self
                    .view
                    .pending_action()
                    .expect("pending action validated by the engine")
                    .id(),
                from,
                to,
            },
            ReductionSite::Emission => Fact::EmissionBodySubstituted {
                flow: self
                    .view
                    .pending_emission()
                    .expect("pending emission validated by the engine")
                    .flow(),
                from,
                to,
            },
        }
    }

    /// The id the next appended turn will carry.
    fn next_turn_id(&self) -> TurnId {
        TurnId::new(self.view.turns().len() as u64)
    }

    /// Store an admitted value's bytes. Called immediately after the batch
    /// carrying its `ValueAdmitted` fact, so the store index and the log stay
    /// in lockstep.
    fn store_body(&mut self, value: ValueId, body: OpaqueValue) {
        let stored = self.store.admit(body);
        debug_assert_eq!(stored, value, "store index diverged from the admission facts");
    }

    pub(crate) fn mint_transition(&mut self) -> TransitionId {
        let id = TransitionId::new(self.next_transition);
        self.next_transition += 1;
        id
    }

    /// Test setup: establish that `effects` were already committed in this
    /// trajectory's past, as a prior dispatch would have. Lets a test whose
    /// subject is the confidentiality axis exercise an egress-bearing sink
    /// without criterion (1) (surface growth) firing on the first egress.
    ///
    /// Recorded as an honest synthetic dispatch — proposal, commitment,
    /// release, declared failure, one batch — so the log stays the single
    /// source of the committed effect surface even for seeded fixtures (and
    /// the seed advances the revision like the real dispatch it stands for).
    #[cfg(test)]
    pub(crate) fn seed_committed_effects(&mut self, effects: crate::dimension::Effects) {
        let action = ActionId::new(self.next_action);
        self.next_action += 1;
        let flow = FlowId::new(self.next_flow);
        self.next_flow += 1;
        self.commit(vec![
            Fact::ActionProposed {
                action,
                flow,
                request: ToolRequest::new(
                    ToolName::new("seed.dispatch"),
                    crate::request::ArgumentTree::empty(),
                    BTreeSet::new(),
                ),
                effects: effects.clone(),
            },
            Fact::EffectsCommitted { action, effects },
            Fact::ActionReleased { action },
            Fact::DispatchFailed { action },
        ]);
    }

    /// Test setup: admit a derived value under `output`, attributed to `source`
    /// via a real `Provenance::Transformed`, without a pending action or plan.
    /// Builds a multi-level provenance chain so a D3 test can exercise the
    /// transitive ancestry walk (a value laundered below the fold whose
    /// suspicious ancestor is several edges back).
    #[cfg(test)]
    pub(crate) fn seed_transformed(&mut self, source: ValueId, output: ValueLabel) -> ValueId {
        let transition = self.mint_transition();
        let body = self
            .store
            .body(source)
            .expect("seed_transformed source admitted")
            .clone();
        let transformer = crate::value::TransformerRef {
            id: "seed".to_owned(),
            version: 0,
        };
        let derived = self.store.next_id();
        self.commit(vec![Fact::ValueAdmitted {
            value: derived,
            origin: ValueOrigin::Transformed {
                source,
                transition,
                transformer,
                declared: output,
            },
        }]);
        self.store_body(derived, body);
        derived
    }

    /// One mutation = one atomically appended event batch (which is the
    /// revision advance: the revision digests the frontier), then one full
    /// reprojection. The batch mirrors validations that already passed, so an
    /// admission conflict here is a crate bug — it fails loudly.
    ///
    /// Reprojecting everything is deliberate: updating the projection
    /// incrementally would be a second fold over the facts, and a second fold
    /// is exactly the thing that can disagree with the first. It costs
    /// O(dependency edges) per mutation — see [`crate::projection`] for why
    /// that is cubic, not quadratic, on dependency-dense trajectories.
    fn commit(&mut self, facts: Vec<Fact>) {
        self.events
            .append_batch(facts)
            .expect("facts mirror an already-validated mutation");
        self.view = TrajectoryProjection::project(&self.events);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::Trust;

    #[test]
    fn ingress_appends_turn_and_advances_revision() {
        let mut trajectory = Trajectory::new();
        let before = trajectory.revision();
        let value = trajectory.ingress(
            Speaker::user(UserId::new("alice")),
            ValueLabel::identity(),
            OpaqueValue::new("hello"),
        );
        assert_eq!(trajectory.turns().len(), 1);
        assert_eq!(trajectory.turns()[0].value, value);
        assert!(trajectory.revision() > before);
    }

    #[test]
    fn model_output_admits_value_without_a_turn() {
        let mut trajectory = Trajectory::new();
        let raw = trajectory.ingress(
            Speaker::user(UserId::new("alice")),
            ValueLabel {
                trust: Trust::SUSPICIOUS,
                ..ValueLabel::identity()
            },
            OpaqueValue::new("web page"),
        );
        let before = trajectory.revision();
        let derived = trajectory
            .admit_model_output(OpaqueValue::new("summary"), BTreeSet::from([raw]), BTreeSet::new())
            .unwrap();
        assert_eq!(trajectory.turns().len(), 1);
        assert!(trajectory.revision() > before);
        assert_eq!(trajectory.value(derived).unwrap().label().trust, Trust::SUSPICIOUS);
    }

    #[test]
    fn confirmation_lasts_exactly_one_turn() {
        let mut trajectory = Trajectory::new();
        trajectory.ingress(
            Speaker::confirming(UserId::new("alice"), ToolName::new("db.drop")),
            ValueLabel::identity(),
            OpaqueValue::new("yes, drop it"),
        );
        assert_eq!(trajectory.pending_confirmation(), Some(&ToolName::new("db.drop")));

        trajectory.ingress(
            Speaker::user(UserId::new("alice")),
            ValueLabel::identity(),
            OpaqueValue::new("unrelated"),
        );
        assert_eq!(trajectory.pending_confirmation(), None);
    }

    #[test]
    fn confirmation_survives_value_admission_but_not_spending() {
        let mut trajectory = Trajectory::new();
        let raw = trajectory.ingress(
            Speaker::confirming(UserId::new("alice"), ToolName::new("db.drop")),
            ValueLabel::identity(),
            OpaqueValue::new("yes"),
        );
        // A remedy-style value admission advances revision but appends no turn.
        trajectory
            .admit_model_output(OpaqueValue::new("derived"), BTreeSet::from([raw]), BTreeSet::new())
            .unwrap();
        assert_eq!(trajectory.pending_confirmation(), Some(&ToolName::new("db.drop")));

        // A release spends it without appending a turn (the ConfirmationSpent
        // fact is the consumption of the confirming turn's implicit grant);
        // it must not resurrect.
        let newest = TurnId::new((trajectory.turns().len() - 1) as u64);
        trajectory.commit(vec![Fact::ConfirmationSpent { turn: newest }]);
        assert_eq!(trajectory.pending_confirmation(), None);
    }
}
