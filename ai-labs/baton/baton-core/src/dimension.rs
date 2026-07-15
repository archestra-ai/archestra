//! Label dimensions: the crate's three built-in instances of the generic
//! [`crate::preset`] algebras, plus their value types.
//!
//! Each dimension is a newtype over its preset and delegates its `combine` (the
//! taint fold) and adequacy relation to it; [`crate::value::ValueLabel::combine`]
//! applies the per-dimension combine, and nothing else in the crate invents
//! merge semantics.
//!
//! Per data dimension the combine is a commutative, idempotent semilattice,
//! and `Unknown` has a definite position in each (absorbing for audience and
//! effects; between `Trusted` and `Suspicious` for trust). This is the taint
//! fold — distinct from the sink-side adequacy relation, where `Unknown` is
//! instead incomparable → [`Adequacy::Unprovable`](crate::preset).
//!
//! Each dimension also carries a **widening relation** (`widening_over`), the
//! dual of adequacy: whether one element exposes strictly more than a
//! baseline — more readers, a higher trust assertion, a grown effect surface
//! — with the excess as the witness. The general no-widening law is that a
//! derived state is never wider than its causal input fold unless an
//! authority explicitly authorized the widening. Trust and audience enforce
//! it at admission by construction (the conservative fold absorbs any wider
//! declared output — see `value.rs`); effects are not a value dimension, so
//! their instance binds at the flow check as the surface-growth criterion,
//! cleared only by an `AcquireEffects` authorization.

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

use crate::preset::{Adequacy, HasBottom, JoinSet, MeetSet, MinLevel};

/// A user known to the surrounding system (ACLs, directories, ...).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
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
// PartialOrd/Ord are structural (container keys only), never a policy order.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
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

    /// Adequacy of this audience for a public sink: does it admit everyone?
    /// Only `Public` holds; a bounded reader set fails with itself as the
    /// witness (no finite vouch covers "everyone"); `Unknown` is unprovable.
    pub(crate) fn covers_everyone(&self) -> Adequacy<BTreeSet<UserId>> {
        match &self.0 {
            MeetSet::All => Adequacy::Holds,
            MeetSet::Only(readers) => Adequacy::Fails(readers.clone()),
            MeetSet::Unknown => Adequacy::Unprovable,
        }
    }

    /// Endorse lift (durable relabel — see [`crate::remedy::LabelRaise`]):
    /// admit `vouched` into the readers. `Public` stays public; `Unknown`
    /// becomes exactly the vouched readers. Monotone in the adequacy order.
    pub(crate) fn admitting(&self, vouched: &BTreeSet<UserId>) -> Self {
        match &self.0 {
            MeetSet::All => Self(MeetSet::All),
            MeetSet::Only(s) => Self(MeetSet::Only(s.union(vouched).cloned().collect())),
            MeetSet::Unknown => Self(MeetSet::Only(vouched.clone())),
        }
    }

    /// Widening relation (dual of adequacy): does `self` expose readers
    /// beyond `baseline`? The witness is the excess exposure. Declaring
    /// bounded readers over an `Unknown` baseline is a widening — it asserts
    /// an audience the baseline cannot prove, exactly what the endorse raise
    /// [`Self::admitting`] exists to authorize. An `Unknown` self widens
    /// nothing: it asserts no exposure (it is unprovable, not public).
    pub(crate) fn widening_over(&self, baseline: &Audience) -> Option<Audience> {
        match (&self.0, &baseline.0) {
            (MeetSet::All, MeetSet::All) | (MeetSet::Unknown, _) => None,
            (MeetSet::All, MeetSet::Only(_) | MeetSet::Unknown) => Some(Self::PUBLIC),
            (MeetSet::Only(_), MeetSet::All) => None,
            (MeetSet::Only(readers), MeetSet::Only(bounded)) => {
                let excess: BTreeSet<UserId> = readers.difference(bounded).cloned().collect();
                match excess.is_empty() {
                    true => None,
                    false => Some(Self(MeetSet::Only(excess))),
                }
            }
            (MeetSet::Only(readers), MeetSet::Unknown) => Some(Self(MeetSet::Only(readers.clone()))),
        }
    }

    /// The members of `required` this audience does not already admit — the
    /// per-leaf endorse deficit. Empty for `Public`; everything for `Unknown`
    /// (it bounds nothing, so every reader needs the vouch).
    pub(crate) fn missing_readers(&self, required: &BTreeSet<UserId>) -> BTreeSet<UserId> {
        match &self.0 {
            MeetSet::All => BTreeSet::new(),
            MeetSet::Only(readers) => required.difference(readers).cloned().collect(),
            MeetSet::Unknown => required.clone(),
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
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
/// always explicit — an [`crate::approval::Authority`] ruling, never a cast.
///
/// The fold keeps the strongest bad evidence: definite suspicion dominates
/// missing knowledge, which dominates trust
/// (`Suspicious ∧ Unknown = Suspicious`, `Trusted ∧ Unknown = Unknown`).
// PartialOrd/Ord are structural (container keys only), never a policy order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
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

    /// Widening relation (dual of adequacy): does `self` gain provability
    /// *upward* over `baseline`? A higher known judgement widens. Over an
    /// `Unknown` baseline only an above-bottom judgement widens (that
    /// assertion is exactly the durable raise): resolving `Unknown` to the
    /// bottom judgement is the taint fold's own worst-wins outcome
    /// (`Suspicious ∧ Unknown = Suspicious`), never a widening. An `Unknown`
    /// self asserts nothing and widens nothing.
    pub(crate) fn widening_over(&self, baseline: &Trust) -> Option<Trust> {
        match (self.0, baseline.0) {
            (MinLevel::Unknown, _) => None,
            (MinLevel::Known(asserted), MinLevel::Known(base)) => match asserted > base {
                true => Some(*self),
                false => None,
            },
            (MinLevel::Known(asserted), MinLevel::Unknown) => match asserted > KnownTrust::bottom() {
                true => Some(*self),
                false => None,
            },
        }
    }

    /// Endorse lift (durable relabel — see [`crate::remedy::LabelRaise`]):
    /// raise trust to at least `attested`. A join (`max`), never a demotion —
    /// a `Trusted` flow is never lowered by a weaker attestation, and an
    /// `Unknown` one becomes the attested judgement.
    pub(crate) fn raised_to(&self, attested: KnownTrust) -> Self {
        match self.0 {
            MinLevel::Known(actual) => Self(MinLevel::Known(actual.max(attested))),
            MinLevel::Unknown => Self(MinLevel::Known(attested)),
        }
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
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
// PartialOrd/Ord are structural (container keys only), never a policy order.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
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

    /// The declared effect set, or `None` for `Unknown`. Used by the
    /// structural narrowing relation, which must distinguish "provably these
    /// effects" from "anything may happen".
    pub(crate) fn declared_set(&self) -> Option<BTreeSet<Effect>> {
        match &self.0 {
            JoinSet::Has(set) => Some(set.clone()),
            JoinSet::Unknown => None,
        }
    }

    /// Waiver application (check-transient): waive `waived` from the present
    /// effects. `Unknown` stays `Unknown` — one cannot attest a negative over
    /// it, which is why unprovable effects are acknowledge-only.
    pub(crate) fn waiving(&self, waived: &BTreeSet<Effect>) -> Self {
        match &self.0 {
            JoinSet::Has(present) => Self(JoinSet::Has(present.difference(waived).copied().collect())),
            JoinSet::Unknown => Self(JoinSet::Unknown),
        }
    }

    /// Widening relation (dual of adequacy) — the effects instance of the
    /// general no-widening law, where it binds at the *flow check* (effects
    /// are trajectory state, not a value dimension, so admission cannot
    /// enforce it): the effects `self` (a call's proposed effects) would
    /// *add* to the already-committed `past` surface. `None` when the flow is
    /// downhill on effects (`past.combine(self) == past`), else
    /// `Some(growth)` — the minimal effects whose commit equals committing
    /// `self`. Growth to `Unknown` (an unannotated tool over a knowable past)
    /// is a real, representable growth, distinct from any declared set.
    pub(crate) fn widening_over(&self, past: &Effects) -> Option<Effects> {
        if past.clone().combine(self.clone()) == *past {
            return None;
        }
        match (past.declared_set(), self.declared_set()) {
            (Some(committed), Some(proposed)) => Some(Self::declared(proposed.difference(&committed).copied())),
            // An `Unknown` proposal over a knowable past grows the surface to
            // `Unknown`; a declared proposal over an `Unknown` past is absorbed
            // above (that branch returns `None`).
            (_, None) => Some(Self::UNKNOWN),
            (None, Some(_)) => Some(self.clone()),
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
    use proptest::prelude::*;

    use super::*;
    use crate::test_strategies::{arb_audience, arb_effects, arb_trust};

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

    proptest! {
        /// Each data dimension's `combine` is a commutative, idempotent
        /// semilattice — the taint-fold algebra the whole design rests on.
        #[test]
        fn audience_combine_is_a_semilattice(a in arb_audience(), b in arb_audience(), c in arb_audience()) {
            prop_assert_eq!(
                a.clone().combine(b.clone()).combine(c.clone()),
                a.clone().combine(b.clone().combine(c.clone()))
            );
            prop_assert_eq!(a.clone().combine(b.clone()), b.clone().combine(a.clone()));
            prop_assert_eq!(a.clone().combine(a.clone()), a);
        }

        #[test]
        fn trust_combine_is_a_semilattice(a in arb_trust(), b in arb_trust(), c in arb_trust()) {
            prop_assert_eq!(a.combine(b).combine(c), a.combine(b.combine(c)));
            prop_assert_eq!(a.combine(b), b.combine(a));
            prop_assert_eq!(a.combine(a), a);
        }

        #[test]
        fn effects_combine_is_a_semilattice(a in arb_effects(), b in arb_effects(), c in arb_effects()) {
            prop_assert_eq!(
                a.clone().combine(b.clone()).combine(c.clone()),
                a.clone().combine(b.clone().combine(c.clone()))
            );
            prop_assert_eq!(a.clone().combine(b.clone()), b.clone().combine(a.clone()));
            prop_assert_eq!(a.clone().combine(a.clone()), a);
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

    /// The widening relation is the dual of adequacy on every dimension:
    /// strictly more exposure than the baseline, witnessed by the excess.
    #[test]
    fn widening_over_is_the_dual_of_adequacy_per_dimension() {
        // Trust: a higher assertion widens; an above-bottom assertion over
        // Unknown widens (that assertion is the durable raise); resolving
        // Unknown to bottom is the fold's own worst-wins outcome, not a
        // widening; Unknown asserts nothing.
        assert_eq!(Trust::TRUSTED.widening_over(&Trust::SUSPICIOUS), Some(Trust::TRUSTED));
        assert_eq!(Trust::SUSPICIOUS.widening_over(&Trust::TRUSTED), None);
        assert_eq!(Trust::TRUSTED.widening_over(&Trust::TRUSTED), None);
        assert_eq!(Trust::TRUSTED.widening_over(&Trust::UNKNOWN), Some(Trust::TRUSTED));
        assert_eq!(Trust::SUSPICIOUS.widening_over(&Trust::UNKNOWN), None);
        assert_eq!(Trust::UNKNOWN.widening_over(&Trust::SUSPICIOUS), None);

        // Audience: the excess readers are the witness; public over bounded
        // widens to everyone; Unknown asserts no exposure.
        let ab = Audience::readers([user("alice"), user("bob")]);
        let a = Audience::readers([user("alice")]);
        assert_eq!(ab.widening_over(&a), Some(Audience::readers([user("bob")])));
        assert_eq!(a.widening_over(&ab), None);
        assert_eq!(Audience::PUBLIC.widening_over(&a), Some(Audience::PUBLIC));
        assert_eq!(a.widening_over(&Audience::PUBLIC), None);
        assert_eq!(Audience::UNKNOWN.widening_over(&a), None);
        assert_eq!(a.widening_over(&Audience::UNKNOWN), Some(a.clone()));

        // Effects: the growth is the witness — the flow-check instance.
        let egress = Effects::declared([Effect::Egress]);
        assert_eq!(Effects::none().widening_over(&egress), None);
        assert_eq!(
            Effects::declared([Effect::Egress, Effect::Mutation]).widening_over(&egress),
            Some(Effects::declared([Effect::Mutation]))
        );
        assert_eq!(Effects::UNKNOWN.widening_over(&egress), Some(Effects::UNKNOWN));
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
