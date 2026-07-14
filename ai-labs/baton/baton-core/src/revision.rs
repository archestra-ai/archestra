//! Control-plane identifiers and the trajectory revision counter.
//!
//! A [`Revision`] covers *all* trajectory state — values, actions, effects,
//! audit, and turns. Every mutation advances it, so any capability bound to a
//! revision is invalidated by any concurrent state change, not merely by an
//! appended turn.
//!
//! The identifiers are plain data, not capabilities: forging one buys nothing,
//! because every use goes through the trajectory-owned store or an unforgeable
//! capability. They are `Serialize`-only all the same, matching
//! [`crate::turn::TrajectoryId`] — nothing needs to deserialize them, so
//! nothing may.

use std::fmt;

use serde::Serialize;

/// Monotone counter over one trajectory's whole state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Revision(u64);

impl Revision {
    pub const INITIAL: Self = Self(0);

    #[must_use]
    pub fn next(self) -> Self {
        // Loud exhaustion beats a silent wrap that would let an ancient
        // capability alias a fresh revision.
        Self(self.0.checked_add(1).expect("revision space exhausted"))
    }

    /// Test setup: a revision at an arbitrary position, so exhaustion is
    /// reachable without `u64::MAX` mutations.
    #[cfg(test)]
    pub(crate) const fn at(revision: u64) -> Self {
        Self(revision)
    }
}

impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "rev#{}", self.0)
    }
}

macro_rules! sequential_id {
    ($(#[$doc:meta])* $vis:vis $name:ident, $display:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        $vis struct $name(u64);

        impl $name {
            pub fn new(index: u64) -> Self {
                Self(index)
            }

            pub fn index(self) -> u64 {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!($display, "#{}"), self.0)
            }
        }
    };
}

sequential_id!(
    /// Identity of one stored value within its trajectory. Identifies
    /// *provenance*, not byte equality: two byte-identical values may carry
    /// different labels and derivations.
    pub ValueId,
    "value"
);

sequential_id!(
    /// Position of one turn within its trajectory. Surfaced only through
    /// [`crate::value::Provenance`] when inspecting a value's history — not
    /// re-exported at the crate root.
    pub TurnId,
    "turn"
);

sequential_id!(
    /// Identity of one pending action within its trajectory.
    pub ActionId,
    "action"
);

sequential_id!(
    /// Identity of one remedy plan minted for one blocked flow.
    pub PlanId,
    "plan"
);

sequential_id!(
    /// Identity of one transition step within its trajectory's history.
    pub TransitionId,
    "transition"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_strictly_increases_from_any_reached_revision() {
        let mut revision = Revision::INITIAL;
        for _ in 0..64 {
            let advanced = revision.next();
            assert!(advanced > revision);
            revision = advanced;
        }
    }

    #[test]
    #[should_panic]
    fn next_at_the_maximum_revision_panics_instead_of_wrapping() {
        let _ = Revision::at(u64::MAX).next();
    }
}
