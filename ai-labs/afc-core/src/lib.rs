//! # afc-core
//!
//! The judgment-free kernel of AFC (Agent Flow Control): an information-flow-control layer for agent
//! tool calls. This crate holds the security types ([`label`]), the lattice ([`lattice`]), label
//! propagation ([`value`]), the internal rule IR ([`rule`]), the enforcement engine ([`engine`]),
//! declassification ([`declassify`]), approvers ([`approver`]), external hooks ([`hook`]), and the
//! static checker ([`checker`]).
//!
//! The design commitments, restated because they are load-bearing:
//! - **The engine hardcodes no judgments.** What counts as a leak or a taint lives in compiled
//!   [`Rule`](rule::Rule)s; the engine only merges matched outcomes (forbid-wins, then escalate).
//! - **Tightening is the only safe direction.** `meet` moves down the lattice; label sources and
//!   declassification are the only sanctioned relaxations, and both are constrained so loosening is
//!   unrepresentable (see [`hook`]) or type-guarded (see [`declassify`]).

pub mod approver;
pub mod checker;
pub mod declassify;
pub mod directory;
pub mod engine;
pub mod hook;
pub mod label;
pub mod lattice;
pub mod rule;
pub mod value;

pub use directory::DirectorySnapshot;
pub use engine::{
    AllowVia, CallSite, Clock, CounterClock, Decision, DecisionKind, DecisionRecord, Engine,
    Remedy, ResultLabelSpec, ResultResolver, RuleEngine,
};
pub use label::{
    DimCompat, DimDecl, DimId, DimRegistry, DimValue, Integrity, Label, Readers, SourceRef, Subject,
};
pub use lattice::{FlowClass, FlowSide, FlowVerdict, Lattice};
pub use rule::{
    ArgType, ArgValue, CmpOp, Effect, EvalCtx, Outcome, Predicate, Principal, ReadersExpr, Rule,
    RuleOrigin, ToolId, TypedPath, ValueExpr,
};
pub use value::{Chunk, Labeled, ModelInput, ValueId, ValueStore, label_completion};
