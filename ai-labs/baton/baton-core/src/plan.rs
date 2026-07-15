//! Remedy plans: ordered predictions over the two-kind remedy vocabulary.
//!
//! A plan is a *prediction, not a permit*: an ordered, non-empty list of
//! remedies ([`crate::remedy::PlannedRemedy`]) that would make a blocked
//! flow legal. Nothing here changes state — application happens step by step
//! through linear, revision-bound capabilities minted by the engine, each
//! independently competence-checked, audited, and followed by a full
//! re-evaluation of the original flow (the recheck is an execution
//! invariant, not a plan step). If the trajectory moved or a step failed,
//! the remaining plan is discarded and the engine blocks or replans with
//! fresh predictions.

use serde::Serialize;

use crate::engine::EngineId;
use crate::remedy::PlannedRemedy;
use crate::revision::{FlowId, PlanId, Revision};

/// A vector that provably holds at least one element. "Remediable with zero
/// plans" is unrepresentable — a block with no plan is the explicit
/// [`crate::engine::FlowOutcome::Terminal`].
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

/// A predicted route from a blocked flow to a permit. Plain serializable
/// data — holding a plan grants nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemedyPlan {
    pub id: PlanId,
    /// The checked flow every step targets.
    pub flow: FlowId,
    /// The predicted remedy sequence. Only the head step is executable;
    /// the remainder is prediction — applying the head triggers the full
    /// recheck, which re-plans (or permits, or blocks) from the new state.
    pub steps: NonEmptyVec<PlannedRemedy>,
    /// The trajectory revision the prediction was computed against. Any
    /// state change invalidates the plan.
    pub basis: Revision,
    /// The engine (registry configuration) that computed the prediction.
    /// Steps resolve transformers, transitions, and authorities from its
    /// registries, so a plan is applicable only on the engine that minted it.
    pub engine: EngineId,
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
