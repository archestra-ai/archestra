//! Remedy plans: the generic envelope over the closed typed transitions.
//!
//! A plan is a *prediction, not a permit*: it names the steps that would make
//! a blocked flow legal and the posture predicted after each. Nothing here
//! changes state — application happens step by step through linear,
//! revision-bound capabilities minted by the engine, each independently
//! competence-checked, audited, and followed by a full re-evaluation of the
//! original flow. If the trajectory moved, a step failed, or a predicted
//! postcondition does not hold, the remaining plan is discarded and the
//! engine blocks or replans.

use serde::Serialize;

use crate::contract::Violation;
use crate::dimension::Effects;
use crate::engine::EngineId;
use crate::revision::{ActionId, PlanId, Revision, ValueId};
use crate::transition::{EndorseDelta, TransientWaiver};
use crate::value::TransformerRef;

/// A vector that provably holds at least one element. "Remediable with zero
/// plans" is unrepresentable — a block with no plan is the explicit
/// [`crate::engine::Blocked::Terminal`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct NonEmptyVec<T>(Vec<T>);

impl<T> NonEmptyVec<T> {
    pub fn new(first: T, mut rest: Vec<T>) -> Self {
        rest.insert(0, first);
        Self(rest)
    }

    /// `None` iff `items` is empty.
    pub fn from_vec(items: Vec<T>) -> Option<Self> {
        if items.is_empty() { None } else { Some(Self(items)) }
    }

    pub fn first(&self) -> &T {
        self.0.first().expect("non-empty by construction")
    }

    pub fn get(&self, index: usize) -> Option<&T> {
        self.0.get(index)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    pub fn iter(&self) -> std::slice::Iter<'_, T> {
        self.0.iter()
    }
}

impl<'a, T> IntoIterator for &'a NonEmptyVec<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

/// One closed, typed transition. The variants enforce different conservation
/// laws (see design note §6): a value transform creates derived values but
/// cannot touch actions or past effects; an action constraint replaces the
/// pending action through a registered mapping but cannot rewrite values; a
/// waiver changes no stored state at all — it transiently loosens exactly its
/// bound check and appends audit history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum TransitionKind {
    TransformValue {
        source: ValueId,
        transformer: TransformerRef,
    },
    ConstrainAction {
        transition: TransformerRef,
    },
    ApplyWaiver {
        delta: TransientWaiver,
    },
    /// An authority acquires the surface growth `effects` on the pending action
    /// (criterion (1)). Like a waiver it changes no stored value; unlike one it
    /// records an authorized-growth marker the recheck consults, and the effect
    /// still commits at release.
    AcceptGrowth {
        effects: Effects,
    },
    /// An authority durably raises `source`'s label by `delta` (Endorse). Like
    /// a transform it mints a derived value and substitutes it into the flow;
    /// unlike one the raise is authority-justified, not content-justified.
    ///
    /// A plan is a *prediction*: when this step is predicted after a Transform in
    /// the same plan, `source` is the pre-transform leaf id (the shared `SimFlow`
    /// swaps a leaf's label in place without re-id-ing), but at application the
    /// transform mints a new id and re-enumeration resolves the Endorse against
    /// the transformed descendant. Revision-binding forces that re-enumeration, so
    /// a stale downstream `source` is never applied.
    EndorseValue {
        source: ValueId,
        delta: EndorseDelta,
        /// The violations this endorse asks the authority to clear, as the
        /// authority should see them. For an ordinary enumerated step this is
        /// the residual at the peel (the step's own precondition); for a
        /// terminal-rescue step it is the *projected post-release* residual —
        /// the actual posture may not mention trust at all while a control
        /// dep masks it, and ruling on the masked vector would mislead the
        /// authority.
        targets: Vec<Violation>,
    },
}

/// The category of a remedy route, derived from its decisive step — the most
/// authority-dependent one. Used to present routes and to keep the plan cap
/// from starving any one kind. Variants are ordered by increasing authority
/// dependence (a registration-justified reduction is cheapest; a fiat relabel
/// that erases taint is the priciest), so the decisive step is the `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum ExitKind {
    /// A content-justified relabel by a registered transformer.
    Sanitize,
    /// A registered narrowing of the action (tool, effects, recipients).
    Constrain,
    /// An authority acquired a criterion-(1) surface growth.
    Accept,
    /// An authority lifted a check (prior effects, confirmation, control
    /// release) or acknowledged an unprovable fact.
    WaiverOrAcknowledge,
    /// An authority durably raised a value's label by fiat — taint erased, the
    /// priciest (robustness-dangerous) elevation, so it is the decisive step of
    /// any route that contains it.
    Endorse,
}

impl ExitKind {
    fn of_step(kind: &TransitionKind) -> Self {
        match kind {
            TransitionKind::TransformValue { .. } => Self::Sanitize,
            TransitionKind::ConstrainAction { .. } => Self::Constrain,
            TransitionKind::AcceptGrowth { .. } => Self::Accept,
            TransitionKind::ApplyWaiver { .. } => Self::WaiverOrAcknowledge,
            TransitionKind::EndorseValue { .. } => Self::Endorse,
        }
    }

    /// The decisive category of a step sequence: its most authority-dependent
    /// step.
    pub fn decisive(steps: &NonEmptyVec<TransitionSpec>) -> Self {
        steps
            .iter()
            .map(|step| Self::of_step(&step.kind))
            .max()
            .expect("a plan has at least one step")
    }
}

/// What the flow's evaluation is predicted to report at a point in a plan:
/// the violations that remain, in the check's emission order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Posture {
    pub remaining: Vec<Violation>,
}

impl Posture {
    pub fn clean() -> Self {
        Self { remaining: Vec::new() }
    }

    pub fn is_clean(&self) -> bool {
        self.remaining.is_empty()
    }
}

/// One planned step: its typed transition plus the declared pre- and
/// postcondition postures the engine validates around application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TransitionSpec {
    pub precondition: Posture,
    pub postcondition: Posture,
    pub kind: TransitionKind,
}

/// A predicted route from a blocked flow to a permit. Plain serializable
/// data — holding a plan grants nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemedyPlan {
    pub id: PlanId,
    /// The stored pending action every step targets.
    pub action: ActionId,
    pub steps: NonEmptyVec<TransitionSpec>,
    /// Predicted posture after the last step; clean by construction for
    /// enumerated plans.
    pub final_postcondition: Posture,
    /// The trajectory revision the prediction was computed against. Any
    /// state change invalidates the plan.
    pub basis: Revision,
    /// The engine (registry configuration) that computed the prediction.
    /// Steps resolve transformers, transitions, and authorities from their
    /// registries, so a plan is applicable only on the engine that minted it.
    pub engine: EngineId,
}

impl RemedyPlan {
    /// This route's category — its decisive (most authority-dependent) step.
    pub fn exit_kind(&self) -> ExitKind {
        ExitKind::decisive(&self.steps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_vec_is_never_empty() {
        assert_eq!(NonEmptyVec::<u8>::from_vec(Vec::new()), None);
        let v = NonEmptyVec::new(1, vec![2, 3]);
        assert_eq!(v.len(), 3);
        assert_eq!(*v.first(), 1);
        assert!(!v.is_empty());
    }
}
