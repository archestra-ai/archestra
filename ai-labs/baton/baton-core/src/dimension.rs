//! Label dimensions: the crate's three built-in instances of the generic
//! [`crate::preset`] algebras, plus their value types.
//!
//! Each dimension is a newtype over its preset and delegates its `combine` (the
//! taint fold) and adequacy relation to it; [`crate::label::Label::combine`]
//! applies the per-dimension combine, and nothing else in the crate invents
//! merge semantics.
//!
//! Per data dimension the combine is a commutative, idempotent semilattice,
//! and `Unknown` has a definite position in each (absorbing for audience and
//! effects; between `Trusted` and `Suspicious` for trust). This is the taint
//! fold — distinct from the sink-side adequacy relation, where `Unknown` is
//! instead incomparable → [`Adequacy::Unprovable`](crate::preset).

use std::collections::BTreeSet;
use std::fmt;

use crate::preset::{Adequacy, HasBottom, JoinSet, MeetSet, MinLevel};

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

/// Who is allowed to read a piece of data — an instance of
/// [`MeetSet<UserId>`](crate::preset::MeetSet).
///
/// The fold is the most-restrictive combine (the confidentiality meet):
/// readers of a combination are those allowed to read *every* part. The
/// original design notes said "union", but under union `private ⊔ public =
/// public`, after which a recipients-within-audience sink check is vacuously
/// satisfied and private turns egress anywhere. "Who has already touched
/// this" is provenance — a different dimension, not this one. [`PUBLIC`] is
/// the identity, [`UNKNOWN`] is absorbing.
///
/// [`PUBLIC`]: Audience::PUBLIC
/// [`UNKNOWN`]: Audience::UNKNOWN
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audience(MeetSet<UserId>);

impl Audience {
    /// Readable by anyone — the fold identity (`MeetSet::All`).
    pub const PUBLIC: Self = Self(MeetSet::All);
    /// Audience unestablished — absorbing in the fold, `Unprovable` at a sink.
    pub const UNKNOWN: Self = Self(MeetSet::Unknown);

    pub fn readers(ids: impl IntoIterator<Item = UserId>) -> Self {
        Self(MeetSet::Only(ids.into_iter().collect()))
    }

    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        Self(self.0.combine(other.0))
    }

    /// Adequacy of this audience for a set of recipients: are they all already
    /// allowed readers? See `MeetSet::covers`.
    pub(crate) fn covers(&self, recipients: &BTreeSet<UserId>) -> Adequacy<BTreeSet<UserId>> {
        self.0.covers(recipients)
    }

    /// Grant application ([`Label::lift`](crate::label::Label::lift)): admit
    /// `vouched` into the readers. `Public` stays public; `Unknown` becomes
    /// exactly the vouched readers. Monotone in the adequacy order.
    pub(crate) fn admitting(&self, vouched: &BTreeSet<UserId>) -> Self {
        match &self.0 {
            MeetSet::All => Self(MeetSet::All),
            MeetSet::Only(s) => Self(MeetSet::Only(s.union(vouched).cloned().collect())),
            MeetSet::Unknown => Self(MeetSet::Only(vouched.clone())),
        }
    }

    /// `self ⊑ other` in the adequacy (permissiveness) order: `Unknown` bottom,
    /// `Public` top, `Readers` by inclusion.
    #[cfg(test)]
    pub(crate) fn adequacy_le(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (MeetSet::Unknown, _) => true,
            (_, MeetSet::All) => true,
            (MeetSet::Only(a), MeetSet::Only(b)) => a.is_subset(b),
            _ => false,
        }
    }
}

impl fmt::Display for Audience {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            MeetSet::All => write!(f, "public"),
            MeetSet::Only(ids) => {
                write!(f, "{{")?;
                for (i, id) in ids.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{id}")?;
                }
                write!(f, "}}")
            }
            MeetSet::Unknown => write!(f, "unknown"),
        }
    }
}

/// A trust judgement that has actually been made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum KnownTrust {
    Suspicious,
    Trusted,
}

/// `Suspicious` is the least trusted, so it is the bottom `MinLevel` folds
/// toward (and the element `Unknown` sits just above).
impl HasBottom for KnownTrust {
    fn bottom() -> Self {
        Self::Suspicious
    }
}

impl fmt::Display for KnownTrust {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Suspicious => write!(f, "suspicious"),
            Self::Trusted => write!(f, "trusted"),
        }
    }
}

/// How much the provenance of data is trusted — if that is known at all. An
/// instance of [`MinLevel<KnownTrust>`](crate::preset::MinLevel).
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
pub struct Trust(MinLevel<KnownTrust>);

impl Trust {
    pub const TRUSTED: Self = Self(MinLevel::Known(KnownTrust::Trusted));
    pub const SUSPICIOUS: Self = Self(MinLevel::Known(KnownTrust::Suspicious));
    /// Provenance unestablished — just above bottom in the fold, `Unprovable`
    /// at a sink.
    pub const UNKNOWN: Self = Self(MinLevel::Unknown);

    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        Self(self.0.combine(other.0))
    }

    /// Adequacy of this trust for a floor. See `MinLevel::at_least`.
    pub(crate) fn at_least(&self, floor: KnownTrust) -> Adequacy<KnownTrust> {
        self.0.at_least(floor)
    }

    /// Grant application ([`Label::lift`](crate::label::Label::lift)): raise
    /// trust to at least `attested`. A join (`max`), never a demotion — a
    /// `Trusted` context is never lowered by a weaker attestation, and an
    /// `Unknown` one becomes the attested judgement.
    pub(crate) fn raised_to(&self, attested: KnownTrust) -> Self {
        match self.0 {
            MinLevel::Known(actual) => Self(MinLevel::Known(actual.max(attested))),
            MinLevel::Unknown => Self(MinLevel::Known(attested)),
        }
    }

    /// `self ⊑ other` in the adequacy order: `Unknown` bottom, then
    /// `Suspicious`, then `Trusted`.
    #[cfg(test)]
    pub(crate) fn adequacy_le(&self, other: &Self) -> bool {
        fn rank(t: &MinLevel<KnownTrust>) -> u8 {
            match t {
                MinLevel::Unknown => 0,
                MinLevel::Known(KnownTrust::Suspicious) => 1,
                MinLevel::Known(KnownTrust::Trusted) => 2,
            }
        }
        rank(&self.0) <= rank(&other.0)
    }
}

impl fmt::Display for Trust {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            MinLevel::Known(known) => write!(f, "{known}"),
            MinLevel::Unknown => write!(f, "unknown"),
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

/// Effects that have already happened in a context — an instance of
/// [`JoinSet<Effect>`](crate::preset::JoinSet).
///
/// Union fold; [`none`](Effects::none) (`Has(∅)`) is the identity, and
/// [`UNKNOWN`](Effects::UNKNOWN) (an unannotated tool ran, so anything may have
/// happened) is absorbing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Effects(JoinSet<Effect>);

impl Effects {
    /// Effects unestablished — absorbing in the fold, `Unprovable` at a sink.
    pub const UNKNOWN: Self = Self(JoinSet::Unknown);

    pub fn none() -> Self {
        Self(JoinSet::empty())
    }

    pub fn declared(effects: impl IntoIterator<Item = Effect>) -> Self {
        Self(JoinSet::Has(effects.into_iter().collect()))
    }

    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        Self(self.0.combine(other.0))
    }

    /// Adequacy against a forbidden set: none of `forbidden` may already be
    /// present. See `JoinSet::avoids`.
    pub(crate) fn avoids(&self, forbidden: &BTreeSet<Effect>) -> Adequacy<BTreeSet<Effect>> {
        self.0.avoids(forbidden)
    }

    /// Grant application ([`Label::lift`](crate::label::Label::lift)): waive
    /// `waived` from the present effects. `Unknown` stays `Unknown` — one
    /// cannot attest a negative over it, which is why unprovable effects are
    /// acknowledge-only, never grant-fixable.
    pub(crate) fn waiving(&self, waived: &BTreeSet<Effect>) -> Self {
        match &self.0 {
            JoinSet::Has(present) => Self(JoinSet::Has(present.difference(waived).copied().collect())),
            JoinSet::Unknown => Self(JoinSet::Unknown),
        }
    }

    /// `self ⊑ other` in the adequacy order: `Unknown` bottom, `none()` top,
    /// fewer present effects is more adequate.
    #[cfg(test)]
    pub(crate) fn adequacy_le(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (JoinSet::Unknown, _) => true,
            (JoinSet::Has(a), JoinSet::Has(b)) => b.is_subset(a),
            (JoinSet::Has(_), JoinSet::Unknown) => false,
        }
    }
}

impl fmt::Display for Effects {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            JoinSet::Has(effects) => {
                write!(f, "{{")?;
                for (i, e) in effects.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{e}")?;
                }
                write!(f, "}}")
            }
            JoinSet::Unknown => write!(f, "unknown"),
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
        assert_eq!(a.combine(b), Audience::readers(Vec::<UserId>::new()));
    }

    #[test]
    fn audience_public_is_identity() {
        let readers = Audience::readers([user("alice")]);
        assert_eq!(Audience::PUBLIC.combine(readers.clone()), readers.clone());
        assert_eq!(readers.clone().combine(Audience::PUBLIC), readers);
        assert_eq!(Audience::PUBLIC.combine(Audience::PUBLIC), Audience::PUBLIC);
    }

    #[test]
    fn audience_unknown_is_absorbing() {
        assert_eq!(Audience::UNKNOWN.combine(Audience::PUBLIC), Audience::UNKNOWN);
        assert_eq!(
            Audience::readers([user("alice")]).combine(Audience::UNKNOWN),
            Audience::UNKNOWN
        );
    }

    #[test]
    fn audience_combine_is_associative() {
        let samples = [
            Audience::PUBLIC,
            Audience::readers([user("alice"), user("bob")]),
            Audience::readers([user("bob")]),
            Audience::UNKNOWN,
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
        assert_eq!(Trust::TRUSTED.combine(Trust::UNKNOWN), Trust::UNKNOWN);
        assert_eq!(Trust::UNKNOWN.combine(Trust::TRUSTED), Trust::UNKNOWN);
        assert_eq!(Trust::UNKNOWN.combine(Trust::SUSPICIOUS), Trust::SUSPICIOUS);
        assert_eq!(Trust::SUSPICIOUS.combine(Trust::UNKNOWN), Trust::SUSPICIOUS);
        assert_eq!(Trust::UNKNOWN.combine(Trust::UNKNOWN), Trust::UNKNOWN);
    }

    #[test]
    fn known_trust_bottom_obeys_the_has_bottom_law() {
        // MinLevel's fold relies on `bottom()` being the Ord-minimum; the
        // built-in Trust instance must uphold it (Suspicious is least trusted).
        for t in [KnownTrust::Suspicious, KnownTrust::Trusted] {
            assert!(KnownTrust::bottom() <= t, "bottom() not <= {t}");
        }
        assert_eq!(KnownTrust::bottom(), KnownTrust::Suspicious);
    }

    #[test]
    fn effects_union_and_unknown_absorbs() {
        let mutation = Effects::declared([Effect::Mutation]);
        let egress = Effects::declared([Effect::Egress]);
        assert_eq!(
            mutation.clone().combine(egress),
            Effects::declared([Effect::Mutation, Effect::Egress])
        );
        assert_eq!(mutation.combine(Effects::UNKNOWN), Effects::UNKNOWN);
        assert_eq!(Effects::none().combine(Effects::none()), Effects::none());
    }

    fn users(ids: &[&str]) -> BTreeSet<UserId> {
        ids.iter().map(|id| user(id)).collect()
    }

    #[test]
    fn audience_covers_over_the_three_values() {
        assert_eq!(Audience::PUBLIC.covers(&users(&["stranger"])), Adequacy::Holds);
        assert_eq!(Audience::UNKNOWN.covers(&users(&["bob"])), Adequacy::Unprovable);

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
        assert_eq!(Trust::UNKNOWN.at_least(KnownTrust::Suspicious), Adequacy::Unprovable);
        assert_eq!(Trust::UNKNOWN.at_least(KnownTrust::Trusted), Adequacy::Unprovable);
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
        assert_eq!(Effects::UNKNOWN.avoids(&forbidden), Adequacy::Unprovable);
    }
}
