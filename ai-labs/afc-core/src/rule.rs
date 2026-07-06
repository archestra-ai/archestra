//! The internal rule IR and its evaluation.
//!
//! Rules are the *only* place judgments live. The engine merges matched outcomes mechanically; it
//! never hardcodes what a leak or a taint means. The stdlib rules `std.no_leak` and
//! `std.no_tainted_consequential` are ordinary IR values emitted by the surface compiler.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::label::{DimId, DimValue, Integrity, Label, Readers, Subject};
use crate::lattice::{FlowClass, Lattice, expand_readers};

pub type ToolId = String;
pub type ApproverId = String;
pub type RuleId = String;

/// A capability a tool exercises. Read produces labels; write/egress/consequential consume them.
/// The engine attaches no privilege to these tags — only rules do, via [`Predicate::HasEffect`].
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub enum Effect {
    Read,
    Write,
    Egress,
    Consequential,
}

/// A concrete tool-call argument value.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ArgValue {
    Str(String),
    Int(i64),
    Subject(Subject),
}

/// Static type of an argument, used by the checker to type-check `ArgCmp` against a tool schema.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ArgType {
    Str,
    Int,
    Subject,
}

/// A typed path to a tool-call argument (flat field name for this prototype).
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct TypedPath {
    pub field: String,
    pub ty: ArgType,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum CmpOp {
    Eq,
    Ne,
    In,
}

/// The right-hand side of a comparison predicate.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ValueExpr {
    Lit(ArgValue),
    Set(Vec<ArgValue>),
}

/// A readers-valued expression, for the `Subset` predicate.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ReadersExpr {
    ValueReaders,
    SinkReaders,
    Lit(Readers),
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Predicate {
    HasEffect(Effect),
    /// True when `flows_to(value, sink)` classifies as the given class. This is how the confidentiality
    /// and unknown-audience judgments enter the rule system without the engine knowing what a leak is.
    FlowIs(FlowClass),
    IntegrityIs(Integrity),
    Subset(ReadersExpr, ReadersExpr),
    DimCmp {
        dim: DimId,
        op: CmpOp,
        value: DimValue,
    },
    ArgCmp(TypedPath, CmpOp, ValueExpr),
    ToolIs(ToolId),
    And(Vec<Predicate>),
    Or(Vec<Predicate>),
    Not(Box<Predicate>),
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Outcome {
    Forbid,
    Escalate(Vec<ApproverId>),
    Warn,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum RuleOrigin {
    Stdlib,
    Org,
    Connector,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Rule {
    pub id: RuleId,
    pub when: Predicate,
    pub then: Outcome,
    pub origin: RuleOrigin,
}

/// The principal on whose behalf a call is made.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Principal {
    pub subject: Subject,
    pub dims: BTreeMap<DimId, DimValue>,
}

/// Everything a predicate can observe about one tool call.
pub struct EvalCtx<'a> {
    pub tool: &'a ToolId,
    pub effects: &'a BTreeSet<Effect>,
    pub value: &'a Label,
    pub sink: &'a Label,
    pub principal: &'a Principal,
    pub args: &'a BTreeMap<String, ArgValue>,
    pub lattice: Lattice<'a>,
}

impl Predicate {
    pub fn eval(&self, ctx: &EvalCtx) -> bool {
        match self {
            Predicate::HasEffect(e) => ctx.effects.contains(e),
            Predicate::FlowIs(class) => ctx.lattice.flows_to(ctx.value, ctx.sink).class() == *class,
            Predicate::IntegrityIs(i) => ctx.value.integrity == *i,
            Predicate::Subset(a, b) => {
                match (eval_readers(a, ctx), eval_readers(b, ctx)) {
                    (Some(ea), Some(eb)) => ea.is_subset(&eb),
                    // An unknown side cannot witness a subset relation.
                    _ => false,
                }
            }
            Predicate::DimCmp { dim, op, value } => {
                let lhs = ctx.value.dims.get(dim);
                cmp_dim(lhs, *op, value)
            }
            Predicate::ArgCmp(path, op, expr) => {
                let lhs = ctx.args.get(&path.field);
                cmp_arg(lhs, *op, expr)
            }
            Predicate::ToolIs(t) => ctx.tool == t,
            Predicate::And(ps) => ps.iter().all(|p| p.eval(ctx)),
            Predicate::Or(ps) => ps.iter().any(|p| p.eval(ctx)),
            Predicate::Not(p) => !p.eval(ctx),
        }
    }
}

fn eval_readers(expr: &ReadersExpr, ctx: &EvalCtx) -> Option<BTreeSet<Subject>> {
    match expr {
        ReadersExpr::ValueReaders => expand_readers(&ctx.value.readers, ctx.lattice.dir),
        ReadersExpr::SinkReaders => expand_readers(&ctx.sink.readers, ctx.lattice.dir),
        ReadersExpr::Lit(r) => expand_readers(r, ctx.lattice.dir),
    }
}

fn cmp_dim(lhs: Option<&DimValue>, op: CmpOp, rhs: &DimValue) -> bool {
    match op {
        CmpOp::Eq => lhs == Some(rhs),
        CmpOp::Ne => lhs != Some(rhs),
        CmpOp::In => lhs == Some(rhs),
    }
}

fn cmp_arg(lhs: Option<&ArgValue>, op: CmpOp, rhs: &ValueExpr) -> bool {
    match (op, rhs) {
        (CmpOp::Eq, ValueExpr::Lit(v)) => lhs == Some(v),
        (CmpOp::Ne, ValueExpr::Lit(v)) => lhs.is_some() && lhs != Some(v),
        (CmpOp::In, ValueExpr::Set(vs)) => lhs.is_some_and(|l| vs.contains(l)),
        // Shape mismatch (e.g. `In` over a literal): never matches.
        _ => false,
    }
}
