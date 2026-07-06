//! Propagation: labeled values, the value store, and how a completion inherits its inputs' labels.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::label::Label;
use crate::lattice::Lattice;

/// A value paired with its security label.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Labeled<T> {
    pub value: T,
    pub label: Label,
}

impl<T> Labeled<T> {
    pub fn new(value: T, label: Label) -> Self {
        Labeled { value, label }
    }
}

/// An opaque chunk of model-visible content.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Chunk(pub String);

/// A handle into the [`ValueStore`].
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct ValueId(pub String);

/// An input to a model call: either inline content (label known here) or a reference whose label
/// lives in the [`ValueStore`] and is applied when the ref is dereferenced at a call site.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ModelInput {
    Inline(Labeled<Chunk>),
    Ref(ValueId),
}

/// Holds labeled values behind [`ValueId`]s so a reference can carry a label without inlining content.
#[derive(Clone, Debug, Default)]
pub struct ValueStore {
    values: BTreeMap<ValueId, Labeled<Chunk>>,
}

impl ValueStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&mut self, id: ValueId, value: Labeled<Chunk>) {
        self.values.insert(id, value);
    }

    pub fn get(&self, id: &ValueId) -> Option<&Labeled<Chunk>> {
        self.values.get(id)
    }

    /// Dereference a ref to the label to apply at a call site. `None` if the id is unknown.
    pub fn label_of(&self, id: &ValueId) -> Option<&Label> {
        self.values.get(id).map(|v| &v.label)
    }
}

/// Label a completion by folding `meet` over the labels of its **inline** inputs only.
///
/// Refs are excluded on purpose: a ref's content never entered the model context, so it cannot have
/// influenced the completion and must not raise the completion's confidentiality. A ref's label is
/// applied separately, at the point the ref is dereferenced as a tool-call argument.
pub fn label_completion(inputs: &[ModelInput], out: Chunk, lattice: &Lattice) -> Labeled<Chunk> {
    let mut label: Option<Label> = None;
    for input in inputs {
        if let ModelInput::Inline(chunk) = input {
            label = Some(match label {
                None => chunk.label.clone(),
                Some(acc) => lattice.meet(&acc, &chunk.label),
            });
        }
    }
    // No inline inputs contributed → the completion depends on nothing confidential: public.
    Labeled::new(out, label.unwrap_or_else(Label::public))
}
