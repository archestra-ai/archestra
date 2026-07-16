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
//! Admission is the trust boundary. [`Trajectory::ingress`](crate::turn::Trajectory::ingress)
//! is the only path that accepts a caller-supplied label; every other
//! admission derives its label inside the crate from the admission fact's
//! declared dependencies (which are mandatory — their completeness is the
//! embedding harness's obligation). There is no general `insert(bytes, label)`.
//!
//! Labels and provenance are **not stored here**: they are projected from the
//! event log ([`crate::projection`]), and [`ValueRef`] composes them with the
//! bytes for reading. The store holds bodies alone.

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;
use tracing::trace;

use crate::audit::AuthorityName;
use crate::dimension::{Audience, Trust, UserId};
use crate::remedy::LabelRaise;
use crate::revision::{ActionId, TransitionId, TurnId, ValueId};

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
/// ([`crate::projection::committed_effects`]), not a property of a value.
/// Audit is likewise control-plane history, not a label field.
// PartialOrd/Ord are structural (container keys only), never a policy order.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
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

    /// Trusted data readable by exactly `readers` — the everyday label for an
    /// internal system's output.
    pub fn trusted_readers(readers: impl IntoIterator<Item = UserId>) -> Self {
        Self {
            audience: Audience::readers(readers),
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
        delta: LabelRaise,
    },
}

/// One admitted value, composed for reading: its bytes borrowed from the
/// store, its label and provenance borrowed from the trajectory's projection.
///
/// Nothing stores this. A value's label and provenance are *derived* from its
/// admission fact ([`crate::projection::value_labels`],
/// [`crate::projection::provenance`]); embedding copies beside the bytes would
/// be a second representation to keep in step. All three are fixed at
/// admission and never change, so the borrow is stable for as long as the
/// trajectory is not mutated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ValueRef<'a> {
    body: &'a OpaqueValue,
    label: &'a ValueLabel,
    provenance: &'a Provenance,
}

impl<'a> ValueRef<'a> {
    pub(crate) fn new(body: &'a OpaqueValue, label: &'a ValueLabel, provenance: &'a Provenance) -> Self {
        Self {
            body,
            label,
            provenance,
        }
    }

    pub fn body(&self) -> &'a OpaqueValue {
        self.body
    }

    pub fn label(&self) -> &'a ValueLabel {
        self.label
    }

    pub fn provenance(&self) -> &'a Provenance {
        self.provenance
    }
}

/// A dependency named a value the store has never admitted — a caller bug,
/// reported loudly rather than folded into `Unknown`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("value {id} does not exist in this trajectory's store")]
pub struct UnknownValue {
    pub id: ValueId,
}

/// The append-only, trajectory-local store of value **bytes**.
///
/// Bytes only: a value's label and provenance are derived from its admission
/// fact by [`crate::projection`], which is the single place either is
/// computed. The store's sole job is to hold what the log deliberately does
/// not — the opaque bodies — and to hand out the next id so a mutation can
/// name its value in the batch it is about to admit.
#[derive(Debug, Default)]
pub struct ValueStore {
    bodies: Vec<OpaqueValue>,
}

impl ValueStore {
    pub fn body(&self, id: ValueId) -> Result<&OpaqueValue, UnknownValue> {
        self.bodies.get(id_index(id)).ok_or(UnknownValue { id })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.bodies.len()
    }

    /// The id the next admission will mint. Lets a trajectory mutation build
    /// its event batch — which names the value — before any state is written.
    pub(crate) fn next_id(&self) -> ValueId {
        ValueId::new(self.bodies.len() as u64)
    }

    /// Store one value's bytes. The admission *fact* — which carries the
    /// origin every label and provenance is derived from — is the trajectory's
    /// job; ids stay in lockstep because each `ValueAdmitted` fact pairs with
    /// exactly one call here.
    pub(crate) fn admit(&mut self, body: OpaqueValue) -> ValueId {
        let id = ValueId::new(self.bodies.len() as u64);
        trace!(%id, "value bytes stored");
        self.bodies.push(body);
        id
    }
}

fn id_index(id: ValueId) -> usize {
    // ValueIds are minted sequentially by `admit`, so the id *is* the index.
    // A foreign trajectory's id past our length fails `body` loudly.
    id.index() as usize
}

#[cfg(test)]
mod tests {
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
