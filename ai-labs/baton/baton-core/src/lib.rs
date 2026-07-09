//! # baton-core
//!
//! A prototype information-flow policy engine for LLM agent trajectories, in
//! the language-based IFC tradition (Sabelfeld/Myers): instead of asking "did
//! this prompt pass a filter?", ask "can this value, derived from these
//! sources, legally flow into this sink?".
//!
//! The moving parts:
//!
//! - Every turn in a [`turn::Trajectory`] carries a [`label::Label`] — a
//!   product of independent dimensions ([`dimension`]), each with its own
//!   combine algebra. Turns never walk alone: there is no API to append an
//!   unlabeled turn, and a tool result only enters by consuming the
//!   [`engine::Permit`] the policy minted for it.
//! - The context label is the fold of all turn labels
//!   ([`turn::Trajectory::context_label`]). Taint propagates through the fold,
//!   not through per-call bookkeeping.
//! - Tools declare a [`contract::ToolContract`]: [`contract::Requirements`]
//!   over the context label, plus an output label their results wear. The
//!   sink check is the design notes' `(Requirements − Label)`: an empty diff
//!   permits, a non-empty one escalates as typed [`contract::Violation`]s.
//! - An [`authority::Authority`] (human in the loop, judge model, webhook...)
//!   adjudicates escalations. An approval waives violations *for that flow
//!   only* and every waiver is recorded as an audited declassification; the
//!   context itself is never loosened.
//! - `Unknown` is a first-class value of audience, trust, and effects, and an
//!   unregistered tool is evaluable (all-`Unknown` output). What `Unknown`
//!   means at a sink is an explicit policy choice
//!   ([`engine::UnknownPolicy`]), so a deployment can annotate five
//!   high-risk tools, leave the rest unknown, and still catch the obvious
//!   flows — gradual typing for agent stacks.
//!
//! One deliberate deviation from the original notes: the audience fold is
//! **intersection** (most-restrictive readers), not union — see
//! [`dimension::Audience`] for why union would make the sink check vacuous.

pub mod authority;
pub mod contract;
pub mod dimension;
pub mod engine;
pub mod label;
pub mod preset;
pub mod turn;

use std::fmt;

/// Identifier of a tool exposed to the agent.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ToolName(String);

impl ToolName {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

pub use authority::{Authority, AuthorityName, Ruling};
pub use contract::{
    AttentionRule, AudienceRule, Breach, Requirements, ToolContract, ToolRequest, Unprovable, Verdict, Violation,
};
pub use dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
pub use engine::{
    BlockReason, Decision, DuplicateContract, Permit, PolicyEngine, RejectedPermit, TaintPolicy, UnknownPolicy,
};
pub use label::{AuditEntry, Grant, Label};
pub use turn::{Actor, LabeledTurn, Speaker, Trajectory, TrajectoryId, Turn};
