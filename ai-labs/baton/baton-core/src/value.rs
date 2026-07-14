//! Immutable labeled values: the trajectory-local store, provenance, and the
//! per-value label.
//!
//! This is the value-granular core: each value carries its own [`ValueLabel`]
//! and [`Provenance`]. A flow is checked against the fold of exactly the
//! values it depends on — explicitly (arguments) and via control (whatever
//! selected the invocation) — so a raw value elsewhere in the trajectory does
//! not taint an unrelated sink, but still taints any action derived from it
//! (the "sanitize after a raw read" property).
//!
//! All values are immutable. A transformer creates a new value with new
//! identity and provenance; it never mutates or relabels its source.
//!
//! Admission is the trust boundary. [`ValueStore::admit_ingress`] is the only
//! path that accepts a caller-supplied label; every other admission computes
//! its label inside the crate as the conservative fold of the declared
//! dependencies (which are mandatory — their completeness is the embedding
//! harness's obligation). There is no general `insert(bytes, label)`.

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;
use tracing::trace;

use crate::audit::AuthorityName;
use crate::dimension::{Audience, Trust};
use crate::revision::{ActionId, TransitionId, TurnId, ValueId};
use crate::transition::EndorseDelta;

/// Bytes the engine never inspects — except where a contract's argument role
/// (e.g. recipients) requires a typed reading, which is explicit at the use
/// site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct OpaqueValue(String);

impl OpaqueValue {
    pub fn new(body: impl Into<String>) -> Self {
        Self(body.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The label one value wears: the data dimensions only.
///
/// Effects are deliberately absent — they are monotone *trajectory* state
/// ([`crate::audit::TrajectoryState`]), not a property of a value. Audit is
/// likewise control-plane history, not a label field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValueLabel {
    pub audience: Audience,
    pub trust: Trust,
}

impl ValueLabel {
    /// Identity of [`ValueLabel::combine`]: neutral in every dimension.
    pub fn identity() -> Self {
        Self {
            audience: Audience::PUBLIC,
            trust: Trust::TRUSTED,
        }
    }

    /// Label for a value whose provenance is entirely unestablished.
    pub fn unknown() -> Self {
        Self {
            audience: Audience::UNKNOWN,
            trust: Trust::UNKNOWN,
        }
    }

    /// The per-dimension taint fold — a commutative, idempotent semilattice
    /// (see [`crate::dimension`]).
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        Self {
            audience: self.audience.combine(other.audience),
            trust: self.trust.combine(other.trust),
        }
    }

    #[must_use]
    pub fn fold(labels: impl IntoIterator<Item = Self>) -> Self {
        labels.into_iter().fold(Self::identity(), Self::combine)
    }
}

impl fmt::Display for ValueLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "audience={} trust={}", self.audience, self.trust)
    }
}

/// Reference to a registered transformer: immutable identity plus version.
/// Provenance and attribution data — registration itself lives in the engine's
/// transformer registry.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct TransformerRef {
    pub id: String,
    pub version: u32,
}

impl fmt::Display for TransformerRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/v{}", self.id, self.version)
    }
}

/// How a value came to exist. Identifies derivation, not byte equality.
/// `Serialize`-only: it embeds trajectory-local ids, which nothing may mint
/// from the outside.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Provenance {
    /// Entered at the explicit trust boundary (a user or harness message).
    Ingress { turn: TurnId },
    /// Produced by a model step that read `reads` and whose invocation was
    /// selected under `control`.
    ModelOutput {
        reads: BTreeSet<ValueId>,
        control: BTreeSet<ValueId>,
    },
    /// Returned by a dispatched tool action.
    ToolOutput {
        action: ActionId,
        arguments: BTreeSet<ValueId>,
        control: BTreeSet<ValueId>,
    },
    /// Derived by a registered transformer under a declared transition.
    Transformed {
        source: ValueId,
        transition: TransitionId,
        transformer: TransformerRef,
    },
    /// Minted by an authority's fiat relabel (Endorse): `source`'s bytes under
    /// a label raised by `delta`. Attributed to the vouching authority, not to
    /// any content transform — the raise is justified by the authority alone.
    Endorsed {
        source: ValueId,
        authority: AuthorityName,
        delta: EndorseDelta,
    },
}

/// One immutable stored value. Fields are private: a value's body, label, and
/// provenance are fixed at admission and never change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredValue {
    body: OpaqueValue,
    label: ValueLabel,
    provenance: Provenance,
}

impl StoredValue {
    pub fn body(&self) -> &OpaqueValue {
        &self.body
    }

    pub fn label(&self) -> &ValueLabel {
        &self.label
    }

    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }
}

/// A dependency named a value the store has never admitted — a caller bug,
/// reported loudly rather than folded into `Unknown`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("value {id} does not exist in this trajectory's store")]
pub struct UnknownValue {
    pub id: ValueId,
}

/// The append-only, trajectory-local value store.
///
/// Admission methods compute labels internally from mandatory dependency
/// sets; only [`admit_ingress`](ValueStore::admit_ingress) accepts a label
/// from the caller, because ingress *is* the trust boundary.
#[derive(Debug, Default)]
pub struct ValueStore {
    values: Vec<StoredValue>,
}

impl ValueStore {
    pub fn get(&self, id: ValueId) -> Result<&StoredValue, UnknownValue> {
        self.values.get(id_index(id)).ok_or(UnknownValue { id })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.values.len()
    }

    /// Every value reachable from `seeds` by following provenance edges — the
    /// transitive ancestry, seeds included. A visited-set graph walk; it
    /// terminates because provenance names only already-admitted values (minted with a
    /// lower id by `push`), so the ancestry graph is a DAG. Powers the D3
    /// ruling context so an authority can inspect an endorsed value's suspicious
    /// ancestors, not just the immediate operation scope.
    pub(crate) fn provenance_closure(&self, seeds: impl IntoIterator<Item = ValueId>) -> BTreeSet<ValueId> {
        let mut seen = BTreeSet::new();
        let mut queue: Vec<ValueId> = seeds.into_iter().collect();
        while let Some(id) = queue.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Ok(stored) = self.get(id) {
                queue.extend(provenance_parents(stored.provenance()));
            }
        }
        seen
    }

    /// Fold the labels of `ids`. Fails loudly on an unknown id: silently
    /// treating a missing dependency as `Unknown` would hide a caller bug.
    pub fn fold_labels<'a>(&self, ids: impl IntoIterator<Item = &'a ValueId>) -> Result<ValueLabel, UnknownValue> {
        let mut folded = ValueLabel::identity();
        for id in ids {
            folded = folded.combine(self.get(*id)?.label().clone());
        }
        Ok(folded)
    }

    /// Admit a value at the explicit trust boundary. The label is trusted
    /// input from the embedding harness — this is the only caller-labeled
    /// admission path.
    pub(crate) fn admit_ingress(&mut self, turn: TurnId, label: ValueLabel, body: OpaqueValue) -> ValueId {
        self.push(body, label, Provenance::Ingress { turn })
    }

    /// Admit a model output. Its label is the conservative fold of every
    /// declared read and control dependency — the caller supplies the
    /// dependency sets (mandatory; completeness is the harness's mediation
    /// obligation), never the label.
    pub(crate) fn admit_model_output(
        &mut self,
        body: OpaqueValue,
        reads: BTreeSet<ValueId>,
        control: BTreeSet<ValueId>,
    ) -> Result<ValueId, UnknownValue> {
        let label = self.fold_labels(reads.iter().chain(control.iter()))?;
        Ok(self.push(body, label, Provenance::ModelOutput { reads, control }))
    }

    /// Admit a dispatched tool's output:
    /// `combine(intrinsic, fold(arguments), fold(control))`. The intrinsic
    /// label is the tool contract's declared per-result provenance; it can
    /// only worsen the fold, never override the dependencies.
    pub(crate) fn admit_tool_output(
        &mut self,
        action: ActionId,
        intrinsic: ValueLabel,
        arguments: BTreeSet<ValueId>,
        control: BTreeSet<ValueId>,
        body: OpaqueValue,
    ) -> Result<ValueId, UnknownValue> {
        let label = intrinsic.combine(self.fold_labels(arguments.iter().chain(control.iter()))?);
        Ok(self.push(
            body,
            label,
            Provenance::ToolOutput {
                action,
                arguments,
                control,
            },
        ))
    }

    /// Admit a transformer's derived value under its *declared* output label —
    /// the only admission below the conservative fold. The caller (the engine's
    /// transition machinery) has already validated the registered transition;
    /// the source keeps its own label untouched.
    pub(crate) fn admit_transformed(
        &mut self,
        source: ValueId,
        transition: TransitionId,
        transformer: TransformerRef,
        declared_output: ValueLabel,
        body: OpaqueValue,
    ) -> Result<ValueId, UnknownValue> {
        self.get(source)?;
        Ok(self.push(
            body,
            declared_output,
            Provenance::Transformed {
                source,
                transition,
                transformer,
            },
        ))
    }

    /// Admit an authority's endorsed value: `source`'s bytes under the
    /// authority-raised `label`, attributed to the vouching authority. Like
    /// [`Self::admit_transformed`] it sits below the conservative fold — here
    /// justified by the authority's competence, not by content — and leaves the
    /// source's own label untouched. The engine's transition machinery has
    /// already routed the grant to a competent authority.
    pub(crate) fn admit_endorsed(
        &mut self,
        source: ValueId,
        authority: AuthorityName,
        delta: EndorseDelta,
        label: ValueLabel,
        body: OpaqueValue,
    ) -> Result<ValueId, UnknownValue> {
        self.get(source)?;
        Ok(self.push(
            body,
            label,
            Provenance::Endorsed {
                source,
                authority,
                delta,
            },
        ))
    }

    fn push(&mut self, body: OpaqueValue, label: ValueLabel, provenance: Provenance) -> ValueId {
        let id = ValueId::new(self.values.len() as u64);
        trace!(%id, %label, "value admitted");
        self.values.push(StoredValue {
            body,
            label,
            provenance,
        });
        id
    }
}

/// The values a provenance names as its direct ancestors — the edges the
/// closure walk follows.
fn provenance_parents(provenance: &Provenance) -> Vec<ValueId> {
    match provenance {
        Provenance::Ingress { .. } => Vec::new(),
        Provenance::ModelOutput { reads, control } => reads.iter().chain(control).copied().collect(),
        Provenance::ToolOutput { arguments, control, .. } => arguments.iter().chain(control).copied().collect(),
        Provenance::Transformed { source, .. } | Provenance::Endorsed { source, .. } => vec![*source],
    }
}

fn id_index(id: ValueId) -> usize {
    // ValueIds are minted sequentially by `push`, so the id *is* the index.
    // A foreign trajectory's id past our length fails `get` loudly.
    id.index() as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::{Audience, Trust, UserId};

    fn readers(names: &[&str]) -> Audience {
        Audience::readers(names.iter().map(|n| UserId::new(*n)))
    }

    #[test]
    fn ingress_wears_the_caller_label() {
        let mut store = ValueStore::default();
        let label = ValueLabel {
            audience: readers(&["alice"]),
            trust: Trust::TRUSTED,
        };
        let id = store.admit_ingress(TurnId::new(0), label.clone(), OpaqueValue::new("hi"));
        assert_eq!(store.get(id).unwrap().label(), &label);
    }

    #[test]
    fn model_output_folds_reads_and_control() {
        let mut store = ValueStore::default();
        let clean = store.admit_ingress(TurnId::new(0), ValueLabel::identity(), OpaqueValue::new("clean"));
        let tainted = store.admit_ingress(
            TurnId::new(1),
            ValueLabel {
                audience: readers(&["alice"]),
                trust: Trust::SUSPICIOUS,
            },
            OpaqueValue::new("tainted"),
        );

        let derived = store
            .admit_model_output(
                OpaqueValue::new("summary"),
                BTreeSet::from([clean]),
                BTreeSet::from([tainted]),
            )
            .unwrap();
        let label = store.get(derived).unwrap().label();
        assert_eq!(label.trust, Trust::SUSPICIOUS);
        assert_eq!(label.audience, readers(&["alice"]));
    }

    #[test]
    fn tool_output_keeps_intrinsic_taint_despite_clean_inputs() {
        let mut store = ValueStore::default();
        let clean = store.admit_ingress(TurnId::new(0), ValueLabel::identity(), OpaqueValue::new("query"));
        let out = store
            .admit_tool_output(
                ActionId::new(0),
                ValueLabel {
                    audience: Audience::PUBLIC,
                    trust: Trust::SUSPICIOUS,
                },
                BTreeSet::from([clean]),
                BTreeSet::new(),
                OpaqueValue::new("page"),
            )
            .unwrap();
        assert_eq!(store.get(out).unwrap().label().trust, Trust::SUSPICIOUS);
    }

    #[test]
    fn identity_intrinsic_cannot_improve_tainted_dependencies() {
        let mut store = ValueStore::default();
        let tainted = store.admit_ingress(
            TurnId::new(0),
            ValueLabel {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
            },
            OpaqueValue::new("raw"),
        );
        let out = store
            .admit_tool_output(
                ActionId::new(0),
                ValueLabel::identity(),
                BTreeSet::from([tainted]),
                BTreeSet::new(),
                OpaqueValue::new("processed"),
            )
            .unwrap();
        assert_eq!(store.get(out).unwrap().label().trust, Trust::SUSPICIOUS);
    }

    #[test]
    fn transformed_value_wears_declared_label_and_source_is_untouched() {
        let mut store = ValueStore::default();
        let raw = store.admit_ingress(
            TurnId::new(0),
            ValueLabel {
                audience: readers(&["alice"]),
                trust: Trust::SUSPICIOUS,
            },
            OpaqueValue::new("raw"),
        );
        let derived = store
            .admit_transformed(
                raw,
                TransitionId::new(0),
                TransformerRef {
                    id: "pii.redact".into(),
                    version: 1,
                },
                ValueLabel::identity(),
                OpaqueValue::new("redacted"),
            )
            .unwrap();

        assert_eq!(store.get(derived).unwrap().label(), &ValueLabel::identity());
        assert_eq!(store.get(raw).unwrap().label().trust, Trust::SUSPICIOUS);
    }

    #[test]
    fn unknown_dependency_fails_loudly() {
        let mut store = ValueStore::default();
        let missing = ValueId::new(41);
        let err = store
            .admit_model_output(OpaqueValue::new("x"), BTreeSet::from([missing]), BTreeSet::new())
            .unwrap_err();
        assert_eq!(err, UnknownValue { id: missing });
    }

    mod laws {
        use proptest::prelude::*;

        use super::super::ValueLabel;
        use crate::test_strategies::arb_value_label;

        proptest! {
            #[test]
            fn combine_is_associative(a in arb_value_label(), b in arb_value_label(), c in arb_value_label()) {
                prop_assert_eq!(
                    a.clone().combine(b.clone()).combine(c.clone()),
                    a.combine(b.combine(c))
                );
            }

            #[test]
            fn combine_is_commutative(a in arb_value_label(), b in arb_value_label()) {
                prop_assert_eq!(a.clone().combine(b.clone()), b.combine(a));
            }

            #[test]
            fn combine_is_idempotent(a in arb_value_label()) {
                prop_assert_eq!(a.clone().combine(a.clone()), a);
            }

            #[test]
            fn identity_is_neutral(a in arb_value_label()) {
                prop_assert_eq!(ValueLabel::identity().combine(a.clone()), a.clone());
                prop_assert_eq!(a.clone().combine(ValueLabel::identity()), a);
            }
        }
    }
}
