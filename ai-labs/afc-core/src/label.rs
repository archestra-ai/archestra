//! Labels and their algebraic pieces.
//!
//! A [`Label`] is the security type carried by every value in the system: who may read it
//! ([`Readers`]), whether it is trustworthy ([`Integrity`]), and any org-declared
//! [dimensions](DimValue) such as `region` or `risk`.
//!
//! Invariant — **labels are normalized**: [`Readers::Known`] contains only [`Subject::User`].
//! Groups (`Team`/`Org`) are expanded to their users via the directory at the moment a label is
//! constructed (see `afc-demo` resolvers and the surface compiler). This is what makes `meet` an
//! honest lattice operation: the expanded reader intersection of a value with itself is that same
//! value, so `meet` is idempotent structurally rather than only up to directory expansion.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// A principal or group that can appear in an ACL.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub enum Subject {
    User(String),
    Team(String),
    Org(String),
    /// Everyone — the top of the confidentiality lattice (largest audience).
    Any,
}

/// The audience allowed to read a value.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Readers {
    Known(BTreeSet<Subject>),
    /// We do not know the audience. `flows_to` turns this into `NeedsPolicy` rather than guessing.
    Unknown,
}

impl Readers {
    /// Convenience constructor for a normalized owner-only reader set.
    pub fn users<I: IntoIterator<Item = String>>(users: I) -> Self {
        Readers::Known(users.into_iter().map(Subject::User).collect())
    }
}

/// Trust level of a value's content.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Integrity {
    Clean,
    Tainted,
    Unknown,
}

pub type DimId = String;

/// A value on an org-declared dimension.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub enum DimValue {
    Val(String),
    /// The result of meeting two incompatible `Exact` values. It matches no sink, so a value that
    /// ever reaches `Conflict` on a dimension can flow nowhere on that dimension — fail-closed.
    Conflict,
}

impl DimValue {
    pub fn val(s: impl Into<String>) -> Self {
        DimValue::Val(s.into())
    }
}

/// How two values on a dimension combine and compare.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum DimCompat {
    /// Values must be identical to flow.
    Exact,
    /// Total order; a value flows to a sink iff `value <= sink_max`. `meet` takes the max.
    AtMost,
}

/// Declaration of a dimension: its compat mode and (for `AtMost`) its total order, least
/// restrictive first.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct DimDecl {
    pub compat: DimCompat,
    pub order: Vec<String>,
}

impl DimDecl {
    /// Position of a value in the declared order. `None` if the value is not declared (a type error
    /// the checker reports) or is `Conflict`.
    pub fn rank(&self, v: &DimValue) -> Option<usize> {
        match v {
            DimValue::Val(s) => self.order.iter().position(|o| o == s),
            DimValue::Conflict => None,
        }
    }
}

/// Registry of all declared dimensions, needed to `meet`/compare dimension values.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DimRegistry(pub BTreeMap<DimId, DimDecl>);

impl DimRegistry {
    pub fn get(&self, id: &str) -> Option<&DimDecl> {
        self.0.get(id)
    }
    pub fn contains(&self, id: &str) -> bool {
        self.0.contains_key(id)
    }
    pub fn ids(&self) -> impl Iterator<Item = &DimId> {
        self.0.keys()
    }
}

/// A provenance breadcrumb: which source contributed to a value.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct SourceRef(pub String);

/// Provenance is capped so a long propagation chain cannot grow labels without bound.
pub const PROVENANCE_CAP: usize = 32;

/// The security type carried by every value.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Label {
    pub readers: Readers,
    pub integrity: Integrity,
    pub dims: BTreeMap<DimId, DimValue>,
    pub provenance: Vec<SourceRef>,
    /// Set when provenance hit [`PROVENANCE_CAP`] and older entries were dropped.
    pub provenance_truncated: bool,
}

impl Label {
    /// A fully public, clean, dimensionless label — the top of the lattice.
    pub fn public() -> Self {
        Label {
            readers: Readers::Known(BTreeSet::from([Subject::Any])),
            integrity: Integrity::Clean,
            dims: BTreeMap::new(),
            provenance: Vec::new(),
            provenance_truncated: false,
        }
    }

    /// A wholly unknown label — unknown audience and unknown integrity. This is what an unlabeled
    /// tool result gets (tier 4 of `label_result`), and it is what drives `on_unknown` denials.
    pub fn unknown() -> Self {
        Label {
            readers: Readers::Unknown,
            integrity: Integrity::Unknown,
            dims: BTreeMap::new(),
            provenance: Vec::new(),
            provenance_truncated: false,
        }
    }

    pub fn with_dim(mut self, id: impl Into<DimId>, v: DimValue) -> Self {
        self.dims.insert(id.into(), v);
        self
    }

    pub fn with_integrity(mut self, i: Integrity) -> Self {
        self.integrity = i;
        self
    }

    pub fn with_source(mut self, src: impl Into<String>) -> Self {
        self.provenance.push(SourceRef(src.into()));
        let (p, t) = canonicalize_provenance(std::mem::take(&mut self.provenance));
        self.provenance = p;
        self.provenance_truncated = self.provenance_truncated || t;
        self
    }
}

/// Put a provenance list into canonical form: sorted, deduped, capped at [`PROVENANCE_CAP`].
///
/// WHY sorted rather than first-seen order: canonical provenance is what makes `meet` genuinely
/// commutative and associative — otherwise `meet(a, b)` and `meet(b, a)` would differ only in
/// provenance order and the lattice laws would not hold. Returns the truncation flag.
pub(crate) fn canonicalize_provenance(mut items: Vec<SourceRef>) -> (Vec<SourceRef>, bool) {
    items.sort();
    items.dedup();
    let truncated = items.len() > PROVENANCE_CAP;
    if truncated {
        items.truncate(PROVENANCE_CAP);
    }
    (items, truncated)
}

/// Merge two provenance lists into canonical form.
pub(crate) fn merge_provenance(a: &[SourceRef], b: &[SourceRef]) -> (Vec<SourceRef>, bool) {
    let mut all = a.to_vec();
    all.extend_from_slice(b);
    canonicalize_provenance(all)
}
