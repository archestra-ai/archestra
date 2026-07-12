//! Control-plane identifiers and the trajectory revision counter.
//!
//! A [`Revision`] covers *all* trajectory state — values, actions, effects,
//! audit, and turns. Every mutation advances it, so any capability bound to a
//! revision is invalidated by any concurrent state change, not merely by an
//! appended turn (the old `basis: usize` head-position check covered only
//! turns).
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
}

impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "rev#{}", self.0)
    }
}

macro_rules! sequential_id {
    ($(#[$doc:meta])* $name:ident, $display:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(u64);

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
    ValueId,
    "value"
);

sequential_id!(
    /// Position of one turn within its trajectory.
    TurnId,
    "turn"
);

sequential_id!(
    /// Identity of one pending action within its trajectory.
    ActionId,
    "action"
);

sequential_id!(
    /// Identity of one remedy plan minted for one blocked flow.
    PlanId,
    "plan"
);

sequential_id!(
    /// Identity of one transition step within its trajectory's history.
    TransitionId,
    "transition"
);
