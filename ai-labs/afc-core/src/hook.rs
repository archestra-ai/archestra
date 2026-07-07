//! External hooks: label sources that can only tighten, and egress governance for sending content to
//! a hook. All in-process — a hook is a trait object, never a network call.

use crate::label::{DimValue, Label};
use crate::lattice::{FlowVerdict, Lattice};
use crate::value::{Chunk, Labeled};

/// A tightening hint from a label source. It is *only* ever consumed via `meet`, so it can lower a
/// value's ceiling but never raise it.
pub struct LabelHint(pub Label);

/// A source of extra label information about a chunk (a classifier, a scanner, …).
///
/// It receives the current `base` label and returns a hint. The framework applies the hint with
/// [`apply_label_source`], whose only operation is `meet`.
pub trait LabelSource {
    fn hint(&self, base: &Label, chunk: &Chunk) -> LabelHint;
}

/// Apply a label source to a value.
///
/// WHY this is the whole tighten-only guarantee: the sole way a hint reaches the label is
/// `meet(base, hint)`, and `meet` can only move down the lattice. A malicious source that returns a
/// *wider* hint still cannot loosen the result — `meet` discards the widening. Loosening is therefore
/// unrepresentable at this boundary, not merely rejected at runtime.
pub fn apply_label_source(
    source: &dyn LabelSource,
    base: &Label,
    chunk: &Chunk,
    lattice: &Lattice,
) -> Label {
    let LabelHint(hint) = source.hint(base, chunk);
    lattice.meet(base, &hint)
}

/// A keyword-driven risk classifier. Raises the `risk` dimension to `high` when a keyword hits.
///
/// It tightens by cloning the base and overwriting `risk`; because `meet` takes the max on an
/// `at_most` dimension, this can only raise risk, never lower it. Tightening a dimension the value was
/// never classified on is (correctly) impossible — the base must already carry `risk`.
pub struct FakeRiskBert {
    keywords: Vec<String>,
}

impl FakeRiskBert {
    pub fn new(keywords: Vec<String>) -> Self {
        FakeRiskBert { keywords }
    }
}

impl LabelSource for FakeRiskBert {
    fn hint(&self, base: &Label, chunk: &Chunk) -> LabelHint {
        let mut hint = base.clone();
        if self.keywords.iter().any(|k| chunk.0.contains(k)) {
            hint.dims.insert("risk".to_string(), DimValue::val("high"));
        }
        LabelHint(hint)
    }
}

/// An egress hook with its own label ceiling.
pub struct Hook {
    pub id: String,
    pub label: Label,
}

impl Hook {
    pub fn new(id: impl Into<String>, label: Label) -> Self {
        Hook {
            id: id.into(),
            label,
        }
    }

    /// Governance for sending content to a hook: the value may be sent only if it flows to the hook's
    /// label, exactly like any other sink. An owner-only value cannot be handed to an org-wide hook.
    pub fn accepts(&self, value: &Labeled<Chunk>, lattice: &Lattice) -> FlowVerdict {
        lattice.flows_to(&value.label, &self.label)
    }
}
