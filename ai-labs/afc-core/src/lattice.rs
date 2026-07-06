//! The lattice: `meet` (how labels combine) and `flows_to` (whether a value may reach a sink).
//!
//! These two functions are the whole security argument. Everything else — rules, engine, checker —
//! is bookkeeping on top of them.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::directory::DirectorySnapshot;
use crate::label::{
    DimCompat, DimRegistry, DimValue, Integrity, Label, Readers, Subject, merge_provenance,
};

/// The classification of a flow attempt.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum FlowClass {
    Ok,
    Leak,
    NeedsPolicy,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum FlowSide {
    Value,
    Sink,
}

/// The result of `flows_to`.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum FlowVerdict {
    /// The value may reach the sink.
    Ok,
    /// The value's audience/dimension is too broad for the sink — a confidentiality leak.
    Leak { dim: String },
    /// The label is under-determined (unknown audience, or a dimension the value lacks); a policy
    /// must decide. This is what `on_unknown` rules match.
    NeedsPolicy { side: FlowSide, field: String },
}

impl FlowVerdict {
    pub fn class(&self) -> FlowClass {
        match self {
            FlowVerdict::Ok => FlowClass::Ok,
            FlowVerdict::Leak { .. } => FlowClass::Leak,
            FlowVerdict::NeedsPolicy { .. } => FlowClass::NeedsPolicy,
        }
    }
}

/// Bundles the two contexts `meet`/`flows_to` need: the directory (to expand groups) and the
/// dimension registry (to know each dimension's compat mode).
#[derive(Clone, Copy)]
pub struct Lattice<'a> {
    pub dir: &'a DirectorySnapshot,
    pub dims: &'a DimRegistry,
}

impl<'a> Lattice<'a> {
    pub fn new(dir: &'a DirectorySnapshot, dims: &'a DimRegistry) -> Self {
        Lattice { dir, dims }
    }

    /// Greatest lower bound: the *most restrictive* combination of two labels.
    ///
    /// WHY this shape: combining data must never widen what may be done with the result. So readers
    /// shrink to the (expanded) intersection, integrity can only worsen, and each dimension moves
    /// toward its more-restrictive value. Propagation is safe precisely because `meet` can only tighten.
    pub fn meet(&self, a: &Label, b: &Label) -> Label {
        let readers = self.meet_readers(&a.readers, &b.readers);
        let integrity = meet_integrity(a.integrity, b.integrity);
        let dims = self.meet_dims(a, b);
        let (provenance, merge_trunc) = merge_provenance(&a.provenance, &b.provenance);
        Label {
            readers,
            integrity,
            dims,
            provenance,
            provenance_truncated: a.provenance_truncated || b.provenance_truncated || merge_trunc,
        }
    }

    fn meet_readers(&self, a: &Readers, b: &Readers) -> Readers {
        match (a, b) {
            // WHY sticky: an unknown audience cannot be intersected, and guessing would be the one
            // way `meet` could *widen*. Unknown stays Unknown, and `flows_to` blocks it as NeedsPolicy.
            (Readers::Unknown, _) | (_, Readers::Unknown) => Readers::Unknown,
            (Readers::Known(sa), Readers::Known(sb)) => {
                let ea = self.dir.expand(sa);
                let eb = self.dir.expand(sb);
                Readers::Known(ea.intersection(&eb).cloned().collect())
            }
        }
    }

    fn meet_dims(
        &self,
        a: &Label,
        b: &Label,
    ) -> std::collections::BTreeMap<String, DimValue> {
        let mut out = std::collections::BTreeMap::new();
        let ids: BTreeSet<&String> = a.dims.keys().chain(b.dims.keys()).collect();
        for id in ids {
            match (a.dims.get(id), b.dims.get(id)) {
                (Some(va), Some(vb)) => {
                    out.insert(id.clone(), self.meet_dim_value(id, va, vb));
                }
                // WHY drop-on-absent: a dimension present on only one side is *unknown* on the other,
                // and unknown is sticky (mirrors Readers::Unknown). Omitting it keeps the result
                // under-determined, so `flows_to` returns NeedsPolicy rather than silently adopting the
                // one known value — which would let `meet` open a flow the lone operand could not.
                (Some(_), None) | (None, Some(_)) => {}
                (None, None) => unreachable!("id came from the union of both key sets"),
            }
        }
        out
    }

    fn meet_dim_value(&self, id: &str, a: &DimValue, b: &DimValue) -> DimValue {
        match self.dims.get(id).map(|d| d.compat) {
            Some(DimCompat::AtMost) => {
                let decl = self.dims.get(id).expect("compat came from this decl");
                match (decl.rank(a), decl.rank(b)) {
                    (Some(ra), Some(rb)) => {
                        if ra >= rb {
                            a.clone()
                        } else {
                            b.clone()
                        }
                    }
                    // An out-of-order value is a type error the checker flags; fail closed at runtime.
                    _ => DimValue::Conflict,
                }
            }
            // Exact (or an undeclared dimension, which the checker also flags): equal keeps, unequal
            // collapses to Conflict so the combined value can flow to neither original sink.
            _ => {
                if a == b {
                    a.clone()
                } else {
                    DimValue::Conflict
                }
            }
        }
    }

    /// Whether `value` may flow to `sink`.
    ///
    /// Confidentiality direction: everyone who can read the sink must already be allowed to read the
    /// value — `expand(sink.readers) ⊆ expand(value.readers)`. Dimensions are checked per their
    /// compat mode. Integrity is deliberately *not* checked here: taint is governed by rules
    /// (`std.no_tainted_consequential`), not by the confidentiality flow.
    pub fn flows_to(&self, value: &Label, sink: &Label) -> FlowVerdict {
        match (&value.readers, &sink.readers) {
            (Readers::Unknown, _) => {
                return FlowVerdict::NeedsPolicy {
                    side: FlowSide::Value,
                    field: "readers".to_string(),
                };
            }
            (_, Readers::Unknown) => {
                return FlowVerdict::NeedsPolicy {
                    side: FlowSide::Sink,
                    field: "readers".to_string(),
                };
            }
            (Readers::Known(v), Readers::Known(s)) => {
                let ev = self.dir.expand(v);
                let es = self.dir.expand(s);
                if !es.is_subset(&ev) {
                    return FlowVerdict::Leak {
                        dim: "readers".to_string(),
                    };
                }
            }
        }

        for (id, sink_val) in &sink.dims {
            match value.dims.get(id) {
                None => {
                    return FlowVerdict::NeedsPolicy {
                        side: FlowSide::Value,
                        field: id.clone(),
                    };
                }
                Some(vv) => {
                    if !self.dim_ok(id, vv, sink_val) {
                        return FlowVerdict::Leak { dim: id.clone() };
                    }
                }
            }
        }

        FlowVerdict::Ok
    }

    fn dim_ok(&self, id: &str, value: &DimValue, sink_max: &DimValue) -> bool {
        match self.dims.get(id).map(|d| d.compat) {
            Some(DimCompat::AtMost) => {
                let decl = self.dims.get(id).expect("compat came from this decl");
                match (decl.rank(value), decl.rank(sink_max)) {
                    (Some(rv), Some(rs)) => rv <= rs,
                    _ => false,
                }
            }
            _ => value == sink_max && !matches!(value, DimValue::Conflict),
        }
    }
}

fn meet_integrity(a: Integrity, b: Integrity) -> Integrity {
    // Ordering per spec: any Tainted wins, else any Unknown, else Clean. Tainted dominates Unknown.
    match (a, b) {
        (Integrity::Tainted, _) | (_, Integrity::Tainted) => Integrity::Tainted,
        (Integrity::Unknown, _) | (_, Integrity::Unknown) => Integrity::Unknown,
        (Integrity::Clean, Integrity::Clean) => Integrity::Clean,
    }
}

/// Expand a reader set to its concrete users (helper for rule evaluation / checker).
pub fn expand_readers(readers: &Readers, dir: &DirectorySnapshot) -> Option<BTreeSet<Subject>> {
    match readers {
        Readers::Unknown => None,
        Readers::Known(s) => Some(dir.expand(s)),
    }
}
