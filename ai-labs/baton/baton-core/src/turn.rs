//! Turns, the trajectory, and its engine-owned admission paths.
//!
//! A trajectory owns all per-conversation state: the immutable value store,
//! the turn sequence (which references values, never free strings), the
//! monotone control-plane state (past effects + audit), the pending action
//! slot, and the [`Revision`] that advances on every mutation. Capabilities
//! bind to the revision, so *any* state change — a new value, a constrained
//! action, an audit event, a turn — invalidates everything minted before it.
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
use crate::audit::{AuditEvent, TrajectoryState};
use crate::dimension::UserId;
use crate::engine::{CanonicalRequest, DispatchReceipt, ExecutionToken, ReceiptParts, RejectedToken};
use crate::event::{EventSet, Fact, ValueOrigin};
use crate::plan::{NonEmptyVec, RemedyPlan};
use crate::remedy::PlannedRemedy;
use crate::request::{ActionState, EmissionRequest, PendingAction, PendingEmission, ToolRequest};
use crate::revision::{ActionId, FlowId, PlanId, Revision, TransitionId, TurnId, ValueId};
use crate::value::{OpaqueValue, StoredValue, UnknownValue, ValueLabel, ValueStore};

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
    turns: Vec<Turn>,
    store: ValueStore,
    state: TrajectoryState,
    revision: Revision,
    pending: Option<PendingAction>,
    next_action: u64,
    next_flow: u64,
    next_transition: u64,
    /// The remedy plans minted for the current blocked flow, if any. Bound to
    /// the revision they were computed against; any state change stales them.
    plans: Vec<RemedyPlan>,
    next_plan: u64,
    /// The (at most one) pending emission, independent of the pending
    /// tool-action slot: a blocked emission never clears a pending action,
    /// and vice versa.
    pending_emission: Option<PendingEmission>,
    /// The confirming turn most recently spent by an action release. A
    /// receipt-declared failure closes the action without appending a turn,
    /// so without this marker the confirming turn would become the newest
    /// turn again and its confirmation would resurrect.
    spent_confirmation: Option<TurnId>,
    /// Shadow substrate: every mutation dual-records its facts here as one
    /// batch (built before any legacy write, appended in the same
    /// transaction that advances the revision). Reads stay on the legacy
    /// fields until the projection cutover.
    events: EventSet,
}

impl Default for Trajectory {
    fn default() -> Self {
        Self::new()
    }
}

impl Trajectory {
    pub fn new() -> Self {
        Self {
            id: TrajectoryId::next(),
            turns: Vec::new(),
            store: ValueStore::default(),
            state: TrajectoryState::default(),
            revision: Revision::INITIAL,
            pending: None,
            pending_emission: None,
            next_action: 0,
            next_flow: 0,
            next_transition: 0,
            plans: Vec::new(),
            next_plan: 0,
            spent_confirmation: None,
            events: EventSet::default(),
        }
    }

    /// The append-only event set this trajectory dual-records into (shadow
    /// phase: derived projections are parity-tested against the legacy
    /// fields, which remain authoritative until the cutover).
    pub fn events(&self) -> &EventSet {
        &self.events
    }

    pub fn id(&self) -> TrajectoryId {
        self.id
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    pub fn turns(&self) -> &[Turn] {
        &self.turns
    }

    pub fn store(&self) -> &ValueStore {
        &self.store
    }

    /// The monotone control-plane state: past effects and the audit log.
    pub fn state(&self) -> &TrajectoryState {
        &self.state
    }

    pub fn pending_action(&self) -> Option<&PendingAction> {
        self.pending.as_ref()
    }

    pub fn pending_emission(&self) -> Option<&PendingEmission> {
        self.pending_emission.as_ref()
    }

    /// The remedy plans of the most recent remediable block. Only plans
    /// whose `basis` equals the current revision are applicable.
    pub fn plans(&self) -> &[RemedyPlan] {
        &self.plans
    }

    /// Convenience lookup in the value store.
    pub fn value(&self, id: ValueId) -> Result<&StoredValue, UnknownValue> {
        self.store.get(id)
    }

    /// Admit a message at the explicit trust boundary and append its turn.
    /// The label is trusted input from the embedding harness — this is the
    /// only caller-labeled admission path.
    pub fn ingress(&mut self, speaker: Speaker, label: ValueLabel, body: OpaqueValue) -> ValueId {
        let turn_id = TurnId::new(self.turns.len() as u64);
        let value = self.store.next_id();
        let actor = Actor::User(speaker.0);
        let batch = vec![
            Fact::ValueAdmitted {
                value,
                origin: ValueOrigin::Ingress {
                    turn: turn_id,
                    label: label.clone(),
                },
            },
            Fact::TurnAppended {
                turn: turn_id,
                actor: actor.clone(),
            },
        ];
        let admitted = self.store.admit_ingress(turn_id, label, body);
        debug_assert_eq!(admitted, value);
        self.turns.push(Turn { actor, value: admitted });
        self.commit(batch);
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
        // Prevalidate the dependency sets (the same check admission runs)
        // before building the batch, so refusal writes nothing anywhere.
        self.store.fold_labels(reads.iter().chain(control.iter()))?;
        let value = self.store.next_id();
        let batch = vec![Fact::ValueAdmitted {
            value,
            origin: ValueOrigin::ModelOutput {
                reads: reads.clone(),
                control: control.clone(),
            },
        }];
        let admitted = self
            .store
            .admit_model_output(body, reads, control)
            .expect("dependencies prevalidated above");
        debug_assert_eq!(admitted, value);
        self.commit(batch);
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
        if parts.revision != self.revision {
            debug!(minted_at = %parts.revision, current = %self.revision, "release: rejected (stale token)");
            return Err(RejectedToken::Stale {
                minted_at: parts.revision,
                current: self.revision,
            });
        }
        let rendered = match &self.pending {
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
        if self.pending_confirmation().is_some() {
            batch.push(Fact::ConfirmationSpent {
                turn: TurnId::new((self.turns.len() - 1) as u64),
            });
        }
        batch.push(Fact::ActionReleased { action: parts.action });
        // The commitment itself materializes from the batch's
        // `EffectsCommitted` fact in `commit`; only the audit record is
        // appended directly here (its projection cutover is a later slice).
        self.state.record(AuditEvent::EffectsCommitted {
            action: parts.action,
            effects: parts.proposed_effects.clone(),
        });
        self.spend_confirmation();
        self.pending
            .as_mut()
            .expect("pending action validated above")
            .mark_released();
        self.commit(batch);
        debug!(action = %parts.action, "release: effects committed, action released");

        let canonical = CanonicalRequest {
            action: parts.action,
            tool: parts.tool.clone(),
            rendered,
        };
        let receipt = DispatchReceipt::from_token_parts(parts, self.revision);
        Ok((canonical, receipt))
    }

    /// Admit the dispatched tool's output by consuming the receipt: the value
    /// enters under `combine(intrinsic, fold(arguments), fold(control))`, the
    /// tool turn is appended, and the action closes.
    pub fn record_output(&mut self, receipt: DispatchReceipt, body: OpaqueValue) -> Result<ValueId, RejectedToken> {
        let parts = self.validate_receipt(receipt)?;
        let turn_id = TurnId::new(self.turns.len() as u64);
        let value = self.store.next_id();
        let batch = vec![
            Fact::ValueAdmitted {
                value,
                origin: ValueOrigin::ToolOutput {
                    action: parts.action,
                    intrinsic: parts.intrinsic.clone(),
                    arguments: parts.arguments.clone(),
                    control: parts.control.clone(),
                },
            },
            Fact::TurnAppended {
                turn: turn_id,
                actor: Actor::Tool(parts.tool.clone()),
            },
            Fact::ActionCompleted {
                action: parts.action,
                output: value,
            },
        ];
        let admitted = self
            .store
            .admit_tool_output(parts.action, parts.intrinsic, parts.arguments, parts.control, body)
            .expect("receipt dependencies were validated at evaluate time");
        debug_assert_eq!(admitted, value);
        self.turns.push(Turn {
            actor: Actor::Tool(parts.tool),
            value,
        });
        self.pending = None;
        self.commit(batch);
        debug!(action = %parts.action, %value, "record_output: recorded tool result");
        Ok(value)
    }

    /// Declare the dispatch failed and close the action. The effects
    /// committed at release stay — failure never removes them — and a
    /// confirmation spent at release stays spent, so the confirming turn
    /// cannot authorize a second attempt.
    pub fn record_failure(&mut self, receipt: DispatchReceipt) -> Result<(), RejectedToken> {
        let parts = self.validate_receipt(receipt)?;
        let batch = vec![Fact::DispatchFailed { action: parts.action }];
        self.state.record(AuditEvent::DispatchFailed { action: parts.action });
        self.pending = None;
        self.commit(batch);
        debug!(action = %parts.action, "record_failure: dispatch failed, action closed");
        Ok(())
    }

    fn validate_receipt(&self, receipt: DispatchReceipt) -> Result<ReceiptParts, RejectedToken> {
        let parts = receipt.into_parts();
        if parts.trajectory != self.id {
            debug!(minted_for = %parts.trajectory, this = %self.id, "receipt rejected (foreign trajectory)");
            return Err(RejectedToken::ForeignTrajectory {
                minted_for: parts.trajectory,
                this: self.id,
            });
        }
        if parts.revision != self.revision {
            debug!(minted_at = %parts.revision, current = %self.revision, "receipt rejected (stale)");
            return Err(RejectedToken::Stale {
                minted_at: parts.revision,
                current: self.revision,
            });
        }
        match &self.pending {
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
        self.store.fold_labels(reads.iter().chain(control.iter()))?;
        let turn_id = TurnId::new(self.turns.len() as u64);
        let value = self.store.next_id();
        let batch = vec![
            Fact::ValueAdmitted {
                value,
                origin: ValueOrigin::ModelOutput {
                    reads: reads.clone(),
                    control: control.clone(),
                },
            },
            Fact::TurnAppended {
                turn: turn_id,
                actor: Actor::Assistant,
            },
            Fact::ResponseEmitted { value },
        ];
        let admitted = self
            .store
            .admit_model_output(OpaqueValue::new(rendered.clone()), reads, control)
            .expect("dependencies prevalidated above");
        debug_assert_eq!(admitted, value);
        self.turns.push(Turn {
            actor: Actor::Assistant,
            value,
        });
        // An emitted response settles any pending emission (the fact batch's
        // ResponseEmitted closes the live emission in the event log).
        self.pending_emission = None;
        self.commit(batch);
        Ok((value, rendered))
    }

    /// Explicitly abandon the pending action (e.g. the harness dropped its
    /// token). Clears the slot and advances the revision, so the dropped
    /// token can never be spent.
    pub fn abandon_pending(&mut self) {
        if let Some(pending) = self.pending.take() {
            self.commit(vec![Fact::ActionAbandoned { action: pending.id() }]);
        }
    }

    /// The user confirmation currently in force, if any: the newest turn's,
    /// only if that turn is a user turn, and only if an action release has
    /// not already spent it. "A confirmation authorizes the immediately
    /// following action, never a later one."
    pub fn pending_confirmation(&self) -> Option<&ToolName> {
        let newest = TurnId::new(self.turns.len().checked_sub(1)? as u64);
        if self.spent_confirmation == Some(newest) {
            return None;
        }
        match self.turns.last() {
            Some(Turn {
                actor: Actor::User(UserTurn {
                    confirms: Some(tool), ..
                }),
                ..
            }) => Some(tool),
            _ => None,
        }
    }

    pub(crate) fn spend_confirmation(&mut self) {
        if self.pending_confirmation().is_some() {
            let newest = TurnId::new((self.turns.len() - 1) as u64);
            self.spent_confirmation = Some(newest);
        }
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
        let batch = vec![Fact::ActionProposed {
            action: id,
            flow,
            tool: request.tool.clone(),
            effects: proposed_effects.clone(),
        }];
        self.pending = Some(PendingAction::proposed(id, flow, request, proposed_effects));
        self.commit(batch);
        id
    }

    pub(crate) fn clear_pending(&mut self) {
        if let Some(pending) = self.pending.take() {
            self.commit(vec![Fact::ActionAbandoned { action: pending.id() }]);
        }
    }

    /// Retain a remediable emission proposal as the pending emission,
    /// opening its checked flow.
    pub(crate) fn set_pending_emission(&mut self, request: EmissionRequest) -> FlowId {
        let flow = FlowId::new(self.next_flow);
        self.next_flow += 1;
        let batch = vec![Fact::EmissionProposed { flow }];
        self.pending_emission = Some(PendingEmission::proposed(flow, request));
        self.commit(batch);
        flow
    }

    pub(crate) fn clear_pending_emission(&mut self) {
        if let Some(pending) = self.pending_emission.take() {
            self.commit(vec![Fact::EmissionAbandoned { flow: pending.flow() }]);
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
        let basis = self.revision;
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
        let batch = vec![Fact::ControlPlane { event: event.clone() }];
        self.state.record(event);
        self.commit(batch);
    }

    /// Audit an applied check-transient authorization: one typed audit event
    /// and its fact, one batch, one advance.
    pub(crate) fn record_applied_authorization(
        &mut self,
        transition: TransitionId,
        authorization: crate::remedy::Authorization,
        authority: crate::audit::AuthorityName,
        resolved: Vec<crate::contract::Violation>,
    ) {
        let batch = vec![Fact::AuthorizationApplied {
            authorization: authorization.clone(),
            authority: authority.clone(),
            resolved: resolved.clone(),
            derived: None,
        }];
        self.state.record(AuditEvent::AuthorizationApplied {
            transition,
            authorization,
            authority,
            resolved,
            derived: None,
            labels: None,
        });
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
        let batch = vec![Fact::AuthorizationDenied {
            authorization: authorization.clone(),
            authority: authority.clone(),
            reason: reason.clone(),
        }];
        self.state.record(AuditEvent::AuthorizationDenied {
            authorization,
            authority,
            reason,
        });
        self.commit(batch);
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
            .store
            .get(source)
            .expect("transform source validated by the engine")
            .label()
            .clone();
        let derived = self.store.next_id();
        let batch = vec![
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
        ];
        let admitted = self
            .store
            .admit_transformed(source, transition, transformer.clone(), declared_output.clone(), body)
            .expect("transform source validated by the engine");
        debug_assert_eq!(admitted, derived);
        self.substitute_into(site, source, derived);
        self.state.record(AuditEvent::ValueTransition {
            transition,
            transformer,
            source,
            derived: Some(derived),
            input,
            declared_output,
            outcome: crate::audit::TransitionOutcome::Applied,
        });
        self.commit(batch);
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
            .store
            .get(source)
            .expect("transform source validated by the engine")
            .label()
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
        let batch = vec![Fact::ControlPlane { event: event.clone() }];
        self.state.record(event);
        self.commit(batch);
    }

    /// Apply a validated `ConstrainAction` step as one transaction.
    pub(crate) fn apply_constraint(&mut self, to_tool: ToolName, effects: crate::dimension::Effects) {
        let transition = self.mint_transition();
        let pending = self.pending.as_mut().expect("pending action validated by the engine");
        let action = pending.id();
        let batch = vec![Fact::ActionConstrained {
            action,
            to_tool: to_tool.clone(),
            effects: effects.clone(),
        }];
        pending.constrain(to_tool, effects);
        self.state.record(AuditEvent::ActionConstrained {
            transition,
            action,
            outcome: crate::audit::TransitionOutcome::Applied,
        });
        self.commit(batch);
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
        let pending = self.pending.as_mut().expect("pending action validated by the engine");
        let action = pending.id();
        let acquisition = crate::remedy::Authorization::new(
            crate::remedy::AuthorizationDelta::single(crate::remedy::DeltaCoordinate::AcquireEffects(effects.clone())),
            crate::remedy::AuthorizationScope::PendingAction { action },
        )
        .expect("the engine accepts only non-empty growths");
        let batch = vec![
            Fact::GrowthAccepted {
                action,
                effects: effects.clone(),
                authority: authority.clone(),
            },
            Fact::AuthorizationApplied {
                authorization: acquisition.clone(),
                authority: authority.clone(),
                resolved: resolved.clone(),
                derived: None,
            },
        ];
        pending.accept_growth(effects);
        self.state.record(AuditEvent::AuthorizationApplied {
            transition,
            authorization: acquisition,
            authority,
            resolved,
            derived: None,
            labels: None,
        });
        self.commit(batch);
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
        let source_value = self.store.get(source).expect("endorse source validated by the engine");
        let input = source_value.label().clone();
        let body = source_value.body().clone();
        let raise_grant = crate::remedy::Authorization::new(
            crate::remedy::AuthorizationDelta::single(crate::remedy::DeltaCoordinate::RaiseLabel(delta.clone())),
            crate::remedy::AuthorizationScope::DerivedValue { source },
        )
        .expect("the engine endorses only non-empty raises");
        let derived = self.store.next_id();
        let batch = vec![
            Fact::ValueAdmitted {
                value: derived,
                origin: ValueOrigin::Endorsed {
                    source,
                    authority: authority.clone(),
                    delta: delta.clone(),
                    raised: raised.clone(),
                },
            },
            self.substitution_fact(site, source, derived),
            Fact::AuthorizationApplied {
                authorization: raise_grant.clone(),
                authority: authority.clone(),
                resolved: Vec::new(),
                derived: Some(derived),
            },
        ];
        let admitted = self
            .store
            .admit_endorsed(source, authority.clone(), delta.clone(), raised.clone(), body)
            .expect("endorse source validated by the engine");
        debug_assert_eq!(admitted, derived);
        self.substitute_into(site, source, derived);
        self.state.record(AuditEvent::AuthorizationApplied {
            transition,
            authorization: raise_grant,
            authority,
            resolved: Vec::new(),
            derived: Some(derived),
            labels: Some(crate::audit::RaiseLabels { input, raised }),
        });
        self.commit(batch);
        derived
    }

    /// The substitution fact for a derivation at `site`.
    fn substitution_fact(&self, site: ReductionSite, from: ValueId, to: ValueId) -> Fact {
        match site {
            ReductionSite::Action => Fact::ArgumentSubstituted {
                action: self
                    .pending
                    .as_ref()
                    .expect("pending action validated by the engine")
                    .id(),
                from,
                to,
            },
            ReductionSite::Emission => Fact::EmissionBodySubstituted {
                flow: self
                    .pending_emission
                    .as_ref()
                    .expect("pending emission validated by the engine")
                    .flow(),
                from,
                to,
            },
        }
    }

    /// Substitute a derived value into the pending target at `site`.
    fn substitute_into(&mut self, site: ReductionSite, from: ValueId, to: ValueId) {
        match site {
            ReductionSite::Action => self
                .pending
                .as_mut()
                .expect("pending action validated by the engine")
                .substitute_argument(from, to),
            ReductionSite::Emission => self
                .pending_emission
                .as_mut()
                .expect("pending emission validated by the engine")
                .substitute_body(from, to),
        }
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
                tool: ToolName::new("seed.dispatch"),
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
            .get(source)
            .expect("seed_transformed source admitted")
            .body()
            .clone();
        let transformer = crate::value::TransformerRef {
            id: "seed".to_owned(),
            version: 0,
        };
        let derived = self.store.next_id();
        let batch = vec![Fact::ValueAdmitted {
            value: derived,
            origin: ValueOrigin::Transformed {
                source,
                transition,
                transformer: transformer.clone(),
                declared: output.clone(),
            },
        }];
        let admitted = self
            .store
            .admit_transformed(source, transition, transformer, output, body)
            .expect("seed_transformed source admitted");
        debug_assert_eq!(admitted, derived);
        self.commit(batch);
        derived
    }

    /// Every public mutation advances the revision exactly once, as one
    /// transaction.
    fn advance(&mut self) {
        self.revision = self.revision.next();
    }

    /// One mutation = one event batch + one revision advance, atomically.
    /// The batch is built before any legacy write and mirrors validations
    /// that already passed, so an admission conflict here is a crate bug —
    /// it fails loudly rather than letting the log and the legacy state
    /// diverge. Admitted facts are then materialized into the
    /// [`TrajectoryState`] read model — the log is the only writer of the
    /// committed effect surface.
    fn commit(&mut self, facts: Vec<Fact>) {
        let admitted_from = self.events.events().len();
        self.events
            .append_batch(facts)
            .expect("shadow facts mirror an already-validated mutation");
        for event in &self.events.events()[admitted_from..] {
            self.state.apply(&event.fact);
        }
        self.advance();
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

        // A release spends it without appending a turn; it must not resurrect.
        trajectory.spend_confirmation();
        assert_eq!(trajectory.pending_confirmation(), None);
    }
}
