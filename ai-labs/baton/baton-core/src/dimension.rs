//! Label dimensions and their combine algebra.
//!
//! Each dimension defines its own `combine`: how two values merge when data
//! from two sources meets in one context. [`crate::label::Label::combine`]
//! applies these per dimension; nothing else in the crate invents merge
//! semantics.
//!
//! Per data dimension the combine is a commutative, idempotent semilattice,
//! and `Unknown` has a definite position in each (absorbing for audience and
//! effects; between `Trusted` and `Suspicious` for trust). This is the taint
//! fold — distinct from the sink-side adequacy relation, where `Unknown` is
//! instead incomparable.

use std::collections::BTreeSet;
use std::fmt;

/// A user known to the surrounding system (ACLs, directories, ...).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UserId(String);

impl UserId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The sink-side proof for one dimension: three-valued, not a lattice
/// comparison. `Holds` when the context satisfies the requirement,
/// `Fails(witness)` when it provably does not (the witness is exactly what is
/// wrong — the offending readers, the too-low trust, the present forbidden
/// effects), and `Unprovable` when `Unknown` blocked the proof either way.
///
/// This is where `Unknown` is *incomparable* — the opposite of its definite
/// position in the taint fold. Resolving an `Unprovable` is an explicit
/// [`crate::engine::UnknownPolicy`] or [`crate::authority::Authority`]
/// decision, never a cast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Adequacy<W> {
    Holds,
    Fails(W),
    Unprovable,
}

/// Who is allowed to read a piece of data.
///
/// The fold is the most-restrictive combine (the confidentiality meet):
/// readers of a combination are those allowed to read *every* part. The
/// original design notes said "union", but under union `private ⊔ public =
/// public`, after which a recipients-within-audience sink check is vacuously
/// satisfied and private turns egress anywhere. "Who has already touched
/// this" is provenance — a different dimension, not this one. `Public` is
/// the identity, `Unknown` is absorbing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Audience {
    Public,
    Readers(BTreeSet<UserId>),
    Unknown,
}

impl Audience {
    pub fn readers(ids: impl IntoIterator<Item = UserId>) -> Self {
        Self::Readers(ids.into_iter().collect())
    }

    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Public, x) | (x, Self::Public) => x,
            (Self::Readers(a), Self::Readers(b)) => Self::Readers(a.intersection(&b).cloned().collect()),
        }
    }

    /// Adequacy of this audience for a set of recipients: are they all
    /// already allowed readers? `Public` holds for anyone; `Unknown` cannot
    /// bound anyone (so `Unprovable`, never silently treated as `Public`);
    /// `Readers` holds iff no recipient falls outside, and the `Fails`
    /// witness is exactly the recipients outside the set.
    pub(crate) fn covers(&self, recipients: &BTreeSet<UserId>) -> Adequacy<BTreeSet<UserId>> {
        match self {
            Self::Unknown => Adequacy::Unprovable,
            Self::Public => Adequacy::Holds,
            Self::Readers(allowed) => {
                let outside: BTreeSet<UserId> = recipients.difference(allowed).cloned().collect();
                if outside.is_empty() {
                    Adequacy::Holds
                } else {
                    Adequacy::Fails(outside)
                }
            }
        }
    }
}

impl fmt::Display for Audience {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Public => write!(f, "public"),
            Self::Readers(ids) => {
                write!(f, "{{")?;
                for (i, id) in ids.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{id}")?;
                }
                write!(f, "}}")
            }
            Self::Unknown => write!(f, "unknown"),
        }
    }
}

/// A trust judgement that has actually been made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum KnownTrust {
    Suspicious,
    Trusted,
}

impl fmt::Display for KnownTrust {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Suspicious => write!(f, "suspicious"),
            Self::Trusted => write!(f, "trusted"),
        }
    }
}

/// How much the provenance of data is trusted — if that is known at all.
///
/// `Unknown` is structurally separate from the known judgements so nothing
/// can treat it as "probably fine" by accident: requirements are expressed
/// over [`KnownTrust`] only, and unpacking `Unknown` into a judgement is
/// always explicit — an [`crate::engine::UnknownPolicy`] choice or an
/// [`crate::authority::Authority`] ruling, never a cast.
///
/// The fold keeps the strongest bad evidence: definite suspicion dominates
/// missing knowledge, which dominates trust
/// (`Suspicious ∧ Unknown = Suspicious`, `Trusted ∧ Unknown = Unknown`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    Known(KnownTrust),
    Unknown,
}

impl Trust {
    pub const TRUSTED: Self = Self::Known(KnownTrust::Trusted);
    pub const SUSPICIOUS: Self = Self::Known(KnownTrust::Suspicious);

    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Known(KnownTrust::Suspicious), _) | (_, Self::Known(KnownTrust::Suspicious)) => {
                Self::Known(KnownTrust::Suspicious)
            }
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Known(KnownTrust::Trusted), Self::Known(KnownTrust::Trusted)) => Self::Known(KnownTrust::Trusted),
        }
    }

    /// Adequacy of this trust for a floor. A known judgement at or above the
    /// floor holds; a lower one `Fails`, carrying the actual (too-low)
    /// judgement as witness. `Unknown` never satisfies any bar — unpacking it
    /// is an explicit policy/authority decision, never a comparison — so it
    /// is `Unprovable`.
    pub(crate) fn at_least(self, floor: KnownTrust) -> Adequacy<KnownTrust> {
        match self {
            Self::Known(actual) if actual >= floor => Adequacy::Holds,
            Self::Known(actual) => Adequacy::Fails(actual),
            Self::Unknown => Adequacy::Unprovable,
        }
    }
}

impl fmt::Display for Trust {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Known(known) => write!(f, "{known}"),
            Self::Unknown => write!(f, "unknown"),
        }
    }
}

/// A side effect a tool has on the world outside the trajectory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Effect {
    Mutation,
    Egress,
}

impl fmt::Display for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mutation => write!(f, "mutation"),
            Self::Egress => write!(f, "egress"),
        }
    }
}

/// Effects that have already happened in a context.
///
/// Union fold; `Unknown` (an unannotated tool ran, so anything may have
/// happened) is absorbing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effects {
    Declared(BTreeSet<Effect>),
    Unknown,
}

impl Effects {
    pub fn none() -> Self {
        Self::Declared(BTreeSet::new())
    }

    pub fn declared(effects: impl IntoIterator<Item = Effect>) -> Self {
        Self::Declared(effects.into_iter().collect())
    }

    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Declared(a), Self::Declared(b)) => Self::Declared(a.union(&b).copied().collect()),
        }
    }

    /// Adequacy against a forbidden set: none of `forbidden` may already be
    /// present. `Unknown` effects cannot attest the absence of anything (an
    /// unannotated tool ran), so they are `Unprovable`. `Declared` holds iff
    /// the intersection is empty, and the `Fails` witness is exactly the
    /// forbidden effects that are present.
    pub(crate) fn avoids(&self, forbidden: &BTreeSet<Effect>) -> Adequacy<BTreeSet<Effect>> {
        match self {
            Self::Unknown => Adequacy::Unprovable,
            Self::Declared(present) => {
                let hit: BTreeSet<Effect> = forbidden.intersection(present).copied().collect();
                if hit.is_empty() {
                    Adequacy::Holds
                } else {
                    Adequacy::Fails(hit)
                }
            }
        }
    }
}

impl fmt::Display for Effects {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Declared(effects) => {
                write!(f, "{{")?;
                for (i, e) in effects.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{e}")?;
                }
                write!(f, "}}")
            }
            Self::Unknown => write!(f, "unknown"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    #[test]
    fn audience_intersects_readers() {
        let ab = Audience::readers([user("alice"), user("bob")]);
        let bc = Audience::readers([user("bob"), user("charlie")]);
        assert_eq!(ab.combine(bc), Audience::readers([user("bob")]));
    }

    #[test]
    fn audience_disjoint_readers_combine_to_nobody() {
        let a = Audience::readers([user("alice")]);
        let b = Audience::readers([user("bob")]);
        assert_eq!(a.combine(b), Audience::Readers(BTreeSet::new()));
    }

    #[test]
    fn audience_public_is_identity() {
        let readers = Audience::readers([user("alice")]);
        assert_eq!(Audience::Public.combine(readers.clone()), readers.clone());
        assert_eq!(readers.clone().combine(Audience::Public), readers);
        assert_eq!(Audience::Public.combine(Audience::Public), Audience::Public);
    }

    #[test]
    fn audience_unknown_is_absorbing() {
        assert_eq!(Audience::Unknown.combine(Audience::Public), Audience::Unknown);
        assert_eq!(
            Audience::readers([user("alice")]).combine(Audience::Unknown),
            Audience::Unknown
        );
    }

    #[test]
    fn audience_combine_is_associative() {
        let samples = [
            Audience::Public,
            Audience::readers([user("alice"), user("bob")]),
            Audience::readers([user("bob")]),
            Audience::Unknown,
        ];
        for a in &samples {
            for b in &samples {
                for c in &samples {
                    let left = a.clone().combine(b.clone()).combine(c.clone());
                    let right = a.clone().combine(b.clone().combine(c.clone()));
                    assert_eq!(left, right, "a={a} b={b} c={c}");
                }
            }
        }
    }

    #[test]
    fn trust_least_trusted_wins() {
        assert_eq!(Trust::TRUSTED.combine(Trust::SUSPICIOUS), Trust::SUSPICIOUS);
        assert_eq!(Trust::SUSPICIOUS.combine(Trust::TRUSTED), Trust::SUSPICIOUS);
        assert_eq!(Trust::TRUSTED.combine(Trust::TRUSTED), Trust::TRUSTED);
    }

    #[test]
    fn trust_unknown_sits_between() {
        assert_eq!(Trust::TRUSTED.combine(Trust::Unknown), Trust::Unknown);
        assert_eq!(Trust::Unknown.combine(Trust::TRUSTED), Trust::Unknown);
        assert_eq!(Trust::Unknown.combine(Trust::SUSPICIOUS), Trust::SUSPICIOUS);
        assert_eq!(Trust::SUSPICIOUS.combine(Trust::Unknown), Trust::SUSPICIOUS);
        assert_eq!(Trust::Unknown.combine(Trust::Unknown), Trust::Unknown);
    }

    #[test]
    fn effects_union_and_unknown_absorbs() {
        let mutation = Effects::declared([Effect::Mutation]);
        let egress = Effects::declared([Effect::Egress]);
        assert_eq!(
            mutation.clone().combine(egress),
            Effects::declared([Effect::Mutation, Effect::Egress])
        );
        assert_eq!(mutation.combine(Effects::Unknown), Effects::Unknown);
        assert_eq!(Effects::none().combine(Effects::none()), Effects::none());
    }

    fn users(ids: &[&str]) -> BTreeSet<UserId> {
        ids.iter().map(|id| user(id)).collect()
    }

    #[test]
    fn audience_covers_over_the_three_values() {
        assert_eq!(Audience::Public.covers(&users(&["stranger"])), Adequacy::Holds);
        assert_eq!(Audience::Unknown.covers(&users(&["bob"])), Adequacy::Unprovable);

        let ab = Audience::readers([user("alice"), user("bob")]);
        assert_eq!(ab.covers(&users(&["bob"])), Adequacy::Holds);
        assert_eq!(ab.covers(&users(&["alice", "bob"])), Adequacy::Holds);
        assert_eq!(
            ab.covers(&users(&["bob", "charlie"])),
            Adequacy::Fails(users(&["charlie"]))
        );
    }

    #[test]
    fn trust_at_least_over_the_three_values() {
        assert_eq!(Trust::TRUSTED.at_least(KnownTrust::Trusted), Adequacy::Holds);
        assert_eq!(Trust::TRUSTED.at_least(KnownTrust::Suspicious), Adequacy::Holds);
        assert_eq!(Trust::SUSPICIOUS.at_least(KnownTrust::Suspicious), Adequacy::Holds);
        assert_eq!(
            Trust::SUSPICIOUS.at_least(KnownTrust::Trusted),
            Adequacy::Fails(KnownTrust::Suspicious)
        );
        assert_eq!(Trust::Unknown.at_least(KnownTrust::Suspicious), Adequacy::Unprovable);
        assert_eq!(Trust::Unknown.at_least(KnownTrust::Trusted), Adequacy::Unprovable);
    }

    #[test]
    fn effects_avoids_over_the_three_values() {
        let forbidden = BTreeSet::from([Effect::Mutation]);
        assert_eq!(Effects::none().avoids(&forbidden), Adequacy::Holds);
        assert_eq!(Effects::declared([Effect::Egress]).avoids(&forbidden), Adequacy::Holds);
        assert_eq!(
            Effects::declared([Effect::Mutation, Effect::Egress]).avoids(&forbidden),
            Adequacy::Fails(BTreeSet::from([Effect::Mutation]))
        );
        assert_eq!(Effects::Unknown.avoids(&forbidden), Adequacy::Unprovable);
    }
}
