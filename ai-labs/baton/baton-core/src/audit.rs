//! Audit as control-plane history, and the monotone trajectory state.
//!
//! Audit lives outside labels: at value granularity, referencing a
//! value twice would duplicate its history, and a *failed* transition has no
//! output label to record its failure on. Instead every transition attempt —
//! applied or failed — appends one [`AuditEvent`] to append-only trajectory
//! state.
//!
//! Raw bytes and content digests deliberately do not appear here: the audit
//! record names identities, labels, and outcomes only.

use std::fmt;

use serde::Serialize;

use crate::contract::Violation;
use crate::dimension::Effects;
use crate::remedy::Authorization;
use crate::revision::{ActionId, PlanId, TransitionId, ValueId};
use crate::value::{TransformerRef, ValueLabel};

/// The exact before/after labels of a durable raise, carried on its audit
/// record so the record is self-contained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RaiseLabels {
    /// The source value's label at the moment of the grant.
    pub input: ValueLabel,
    /// The label the authorized derived value was minted under.
    pub raised: ValueLabel,
}

/// Name of a registered authority.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct AuthorityName(String);

impl AuthorityName {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AuthorityName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Why a transition attempt did not apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum TransitionFailure {
    /// The registered reduction relation does not hold for the current
    /// state: a transformer's label predicate did not match its source, or
    /// an action transition's structural narrowing gate refused (wrong
    /// source tool, widened effects or recipients, missing target contract).
    ReductionRefused,
    /// The transformer implementation reported an error.
    TransformerError { message: String },
}

impl fmt::Display for TransitionFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReductionRefused => write!(f, "the registered reduction relation does not hold"),
            Self::TransformerError { message } => write!(f, "transformer failed: {message}"),
        }
    }
}

/// Outcome of one transition attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum TransitionOutcome {
    Applied,
    Failed(TransitionFailure),
}

/// One control-plane audit record. Failures append an event but create no
/// derived value or action.
///
/// Wording discipline (see the design note): a value transition is *admitted
/// under the transition declared by its registered transformer* — the engine
/// never verified the content itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum AuditEvent {
    ValueTransition {
        transition: TransitionId,
        transformer: TransformerRef,
        source: ValueId,
        /// `Some` iff the transition applied.
        derived: Option<ValueId>,
        input: ValueLabel,
        declared_output: ValueLabel,
        outcome: TransitionOutcome,
    },
    ActionConstrained {
        transition: TransitionId,
        action: ActionId,
        outcome: TransitionOutcome,
    },
    /// An authority granted and the engine applied a typed authorization —
    /// an exact delta at an exact scope. `derived` names the authorized
    /// derived value a durable grant minted (the raise is the authority's
    /// fiat, not a verified property of the bytes) and `labels` its exact
    /// before/after labels, so the audit record is self-contained; a check-
    /// or action-scoped grant mints none and carries none.
    AuthorizationApplied {
        transition: TransitionId,
        authorization: Authorization,
        authority: AuthorityName,
        resolved: Vec<Violation>,
        derived: Option<ValueId>,
        labels: Option<RaiseLabels>,
    },
    /// An authority denied a typed authorization.
    AuthorizationDenied {
        authorization: Authorization,
        authority: AuthorityName,
        reason: String,
    },
    /// Dispatch began: the action's proposed effects were committed to the
    /// monotone past-effects state *before* release.
    EffectsCommitted { action: ActionId, effects: Effects },
    /// The harness declared the dispatch failed. The effects committed at
    /// release stay: after dispatch starts, a timeout or crash cannot prove
    /// an effect did not happen.
    DispatchFailed { action: ActionId },
    /// A plan step's application was refused (its precondition posture no
    /// longer held). The remaining plan is discarded.
    StepFailed {
        plan: PlanId,
        step: u64,
        failure: TransitionFailure,
    },
    /// A grant-bearing step (waiver, acknowledgment, accept, or endorse)
    /// reached an external authority: the ruling is pending re-entry.
    ApprovalRequested {
        plan: PlanId,
        authority: AuthorityName,
        resolved: Vec<Violation>,
    },
}

impl fmt::Display for AuditEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ValueTransition {
                transformer,
                source,
                derived,
                outcome,
                ..
            } => match (derived, outcome) {
                (Some(derived), _) => {
                    write!(f, "{source} -> {derived} admitted under transition by {transformer}")
                }
                (None, TransitionOutcome::Failed(failure)) => {
                    write!(f, "transition of {source} by {transformer} failed: {failure}")
                }
                (None, TransitionOutcome::Applied) => {
                    write!(f, "transition of {source} by {transformer} applied")
                }
            },
            Self::ActionConstrained { action, outcome, .. } => match outcome {
                TransitionOutcome::Applied => write!(f, "{action} constrained"),
                TransitionOutcome::Failed(failure) => write!(f, "constraining {action} failed: {failure}"),
            },
            Self::AuthorizationApplied {
                authorization,
                authority,
                derived,
                labels,
                ..
            } => match (derived, labels) {
                (Some(derived), Some(labels)) => write!(
                    f,
                    "{authorization} granted by {authority}, minted {derived}: {} -> {}",
                    labels.input, labels.raised
                ),
                (Some(derived), None) => write!(f, "{authorization} granted by {authority}, minted {derived}"),
                (None, _) => write!(f, "{authorization} granted by {authority}"),
            },
            Self::AuthorizationDenied {
                authorization,
                authority,
                reason,
            } => {
                write!(f, "{authorization} denied by {authority}: {reason}")
            }
            Self::EffectsCommitted { action, effects } => {
                write!(f, "{action} dispatching, effects committed: {effects}")
            }
            Self::DispatchFailed { action } => {
                write!(f, "{action} dispatch failed; committed effects stay")
            }
            Self::StepFailed { plan, step, failure } => {
                write!(f, "{plan} step {step} refused: {failure}")
            }
            Self::ApprovalRequested { plan, authority, .. } => {
                write!(f, "{plan}: approval requested from {authority}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::Effect;
    use crate::event::EventSet;
    use crate::projection::committed_effects;

    /// Commit `effects` as a real dispatch would — propose, commit, release,
    /// fail — since admission refuses a commitment for an action that was
    /// never proposed. The commitment fact is the only thing the effect
    /// surface is derived from; the rest is the lifecycle it must ride.
    fn commit(events: &mut EventSet, action: u64, effects: Effects) {
        let action = crate::revision::ActionId::new(action);
        events
            .append_batch(vec![
                crate::event::Fact::ActionProposed {
                    action,
                    flow: crate::revision::FlowId::new(action.index()),
                    request: crate::request::ToolRequest::new(
                        crate::ToolName::new("seed.dispatch"),
                        crate::request::ArgumentTree::empty(),
                        std::collections::BTreeSet::new(),
                    ),
                    effects: effects.clone(),
                },
                crate::event::Fact::EffectsCommitted { action, effects },
                crate::event::Fact::ActionReleased { action },
                crate::event::Fact::DispatchFailed { action },
            ])
            .expect("the synthetic dispatch is a well-formed lifecycle");
    }

    #[test]
    fn effects_only_accumulate() {
        let mut events = EventSet::default();
        commit(&mut events, 0, Effects::declared([Effect::Egress]));
        commit(&mut events, 1, Effects::none());
        assert_eq!(committed_effects(&events), Effects::declared([Effect::Egress]));

        commit(&mut events, 2, Effects::declared([Effect::Mutation]));
        assert_eq!(
            committed_effects(&events),
            Effects::declared([Effect::Egress, Effect::Mutation])
        );
    }

    #[test]
    fn unknown_effects_absorb_permanently() {
        let mut events = EventSet::default();
        commit(&mut events, 0, Effects::UNKNOWN);
        commit(&mut events, 1, Effects::none());
        assert_eq!(committed_effects(&events), Effects::UNKNOWN);
    }
}
