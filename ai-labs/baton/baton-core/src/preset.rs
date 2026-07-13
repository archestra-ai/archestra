//! Preset dimension kinds: the small library of generic label algebras a
//! deployment composes from, each generic over its own value type `T`.
//!
//! The crate's three built-in dimensions are one instance each of three of
//! these presets ([`crate::dimension`] re-expresses them):
//!
//! | Preset | Built-in instance | Fold (`combine`) | Adequacy |
//! |---|---|---|---|
//! | [`MeetSet`] | `Audience` | intersection; `All` identity, `Unknown` absorbing | `covers` |
//! | [`JoinSet`] | `Effects`  | union; `Has(∅)` identity, `Unknown` absorbing | `avoids` |
//! | [`MinLevel`]| `Trust`    | min over `bottom < Unknown < rest` | `at_least` |
//! | [`MaxLevel`]| — (classification) | max over `rest < Unknown < top` | `at_most` |
//!
//! Each keeps the two-algebra split the built-ins rely on (see the crate
//! `CLAUDE.md`): `combine` is the commutative, idempotent **taint fold**, where
//! `Unknown` has a *definite* position (absorbing for the sets; just above
//! bottom for `MinLevel`, just below top for `MaxLevel`); the **adequacy**
//! relation is the three-valued sink-side proof, where `Unknown` is instead
//! bottom → `Adequacy::Unprovable`. The `Known(T) | Unknown` split stays
//! two-level so a requirement expressed over `T` can never be satisfied by
//! `Unknown` — "unknown suffices" remains unrepresentable.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// The sink-side proof for one dimension: three-valued, not a lattice
/// comparison. `Holds` when the context satisfies the requirement,
/// `Fails(witness)` when it provably does not (the witness is exactly what is
/// wrong), and `Unprovable` when `Unknown` blocked the proof either way — the
/// point where `Unknown` is *incomparable*, the opposite of its definite
/// position in the taint fold.
///
/// This is the public result type of every preset's adequacy relation. The
/// built-in dimensions delegate to the presets but keep their own adequacy
/// methods crate-internal, since only the engine consumes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Adequacy<W> {
    Holds,
    Fails(W),
    Unprovable,
}

/// A value type that designates its least element under [`Ord`]. Required by
/// [`MinLevel`], whose `Unknown` sits *just above* that bottom in the fold.
///
/// **Law:** `Self::bottom() <= x` for every `x`. `MinLevel::combine`'s
/// associativity depends on it — if `bottom()` is not the true minimum, the
/// fold is not a semilattice.
pub trait HasBottom: Ord {
    fn bottom() -> Self;
}

/// A value type that designates its greatest element under [`Ord`]. Required by
/// [`MaxLevel`], whose `Unknown` sits *just below* that top in the fold.
///
/// **Law:** `Self::top() >= x` for every `x` (the dual of [`HasBottom`]).
pub trait HasTop: Ord {
    fn top() -> Self;
}

/// The confidentiality-meet preset (generalizes `Audience`). The fold is the
/// most-restrictive combine: a value is `All` (top / identity), a concrete
/// `Only(set)`, or `Unknown` (absorbing). Adequacy is `covers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MeetSet<T: Ord> {
    All,
    Only(BTreeSet<T>),
    Unknown,
}

impl<T: Ord + Clone> MeetSet<T> {
    /// Intersection fold: `Unknown` absorbs, `All` is the identity, and two
    /// `Only` sets meet to their intersection.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::All, x) | (x, Self::All) => x,
            (Self::Only(a), Self::Only(b)) => Self::Only(a.intersection(&b).cloned().collect()),
        }
    }

    /// Adequacy against a required set: is every member of `need` already
    /// inside this set? `All` holds for anything; `Unknown` bounds nothing (so
    /// `Unprovable`, never silently `All`); `Only` holds iff nothing falls
    /// outside, with the `Fails` witness being exactly the members outside.
    pub fn covers(&self, need: &BTreeSet<T>) -> Adequacy<BTreeSet<T>> {
        match self {
            Self::Unknown => Adequacy::Unprovable,
            Self::All => Adequacy::Holds,
            Self::Only(allowed) => {
                let outside: BTreeSet<T> = need.difference(allowed).cloned().collect();
                if outside.is_empty() {
                    Adequacy::Holds
                } else {
                    Adequacy::Fails(outside)
                }
            }
        }
    }
}

/// The accumulating-union preset (generalizes `Effects`). A value is `Has(set)`
/// (with `Has(∅)` the identity) or `Unknown` (absorbing). Adequacy is `avoids`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum JoinSet<T: Ord> {
    Has(BTreeSet<T>),
    Unknown,
}

impl<T: Ord + Clone> JoinSet<T> {
    /// The empty accumulation — the fold identity.
    pub fn empty() -> Self {
        Self::Has(BTreeSet::new())
    }

    /// Union fold: `Unknown` absorbs, two `Has` sets combine to their union.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Has(a), Self::Has(b)) => Self::Has(a.union(&b).cloned().collect()),
        }
    }

    /// Adequacy against a forbidden set: none of `forbidden` may already be
    /// present. `Unknown` can attest the absence of nothing (so `Unprovable`);
    /// `Has` holds iff the intersection is empty, with the `Fails` witness the
    /// forbidden members that are present.
    pub fn avoids(&self, forbidden: &BTreeSet<T>) -> Adequacy<BTreeSet<T>> {
        match self {
            Self::Unknown => Adequacy::Unprovable,
            Self::Has(present) => {
                let hit: BTreeSet<T> = forbidden.intersection(present).cloned().collect();
                if hit.is_empty() {
                    Adequacy::Holds
                } else {
                    Adequacy::Fails(hit)
                }
            }
        }
    }
}

/// The trust-like ordered preset (generalizes `Trust`). Worse = lower, fold =
/// min, `Unknown` just above bottom, adequacy = `at_least(floor)` — "least wins".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MinLevel<T: Ord> {
    Known(T),
    Unknown,
}

impl<T: Ord + HasBottom> MinLevel<T> {
    /// Min fold over the total order `bottom < Unknown < rest`: a known bottom
    /// dominates `Unknown` (it is still lower), while `Unknown` dominates every
    /// other known value.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Known(a), Self::Known(b)) => Self::Known(a.min(b)),
            (Self::Known(a), Self::Unknown) | (Self::Unknown, Self::Known(a)) => {
                if a == T::bottom() {
                    Self::Known(a)
                } else {
                    Self::Unknown
                }
            }
            (Self::Unknown, Self::Unknown) => Self::Unknown,
        }
    }
}

impl<T: Ord + Clone> MinLevel<T> {
    /// Adequacy against a floor: a known value at or above the floor holds, a
    /// lower one `Fails` (carrying the actual value), and `Unknown` never
    /// satisfies any bar — unpacking it is an explicit decision, so `Unprovable`.
    pub fn at_least(&self, floor: T) -> Adequacy<T> {
        match self {
            Self::Known(actual) if *actual >= floor => Adequacy::Holds,
            Self::Known(actual) => Adequacy::Fails(actual.clone()),
            Self::Unknown => Adequacy::Unprovable,
        }
    }
}

/// The classification-like ordered preset (the dual of [`MinLevel`], with no
/// built-in instance yet). Worse = higher, fold = max, `Unknown` just below
/// top, adequacy = `at_most(ceiling)` — "most sensitive wins".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MaxLevel<T: Ord> {
    Known(T),
    Unknown,
}

impl<T: Ord + HasTop> MaxLevel<T> {
    /// Max fold over the total order `rest < Unknown < top`: a known top
    /// dominates `Unknown`, while `Unknown` dominates every other known value.
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Known(a), Self::Known(b)) => Self::Known(a.max(b)),
            (Self::Known(a), Self::Unknown) | (Self::Unknown, Self::Known(a)) => {
                if a == T::top() {
                    Self::Known(a)
                } else {
                    Self::Unknown
                }
            }
            (Self::Unknown, Self::Unknown) => Self::Unknown,
        }
    }
}

impl<T: Ord + Clone> MaxLevel<T> {
    /// Adequacy against a ceiling: a known value at or below the ceiling holds,
    /// a higher one `Fails` (carrying the actual value), and `Unknown` is
    /// `Unprovable`.
    pub fn at_most(&self, ceiling: T) -> Adequacy<T> {
        match self {
            Self::Known(actual) if *actual <= ceiling => Adequacy::Holds,
            Self::Known(actual) => Adequacy::Fails(actual.clone()),
            Self::Unknown => Adequacy::Unprovable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A three-valued ordered sample, so the `MinLevel`/`MaxLevel` `Unknown`
    /// generalization is exercised past the two-valued `KnownTrust`: `Unknown`
    /// must sit *just above* `Low` (bottom) and *just below* `High` (top),
    /// leaving `Mid` on the `Unknown` side of both folds.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    enum Level {
        Low,
        Mid,
        High,
    }

    impl HasBottom for Level {
        fn bottom() -> Self {
            Self::Low
        }
    }

    impl HasTop for Level {
        fn top() -> Self {
            Self::High
        }
    }

    fn set(items: impl IntoIterator<Item = u8>) -> BTreeSet<u8> {
        items.into_iter().collect()
    }

    #[test]
    fn has_bottom_and_top_are_the_extrema() {
        for x in [Level::Low, Level::Mid, Level::High] {
            assert!(Level::bottom() <= x, "bottom not <= {x:?}");
            assert!(Level::top() >= x, "top not >= {x:?}");
        }
    }

    #[test]
    fn meet_set_intersects_with_all_identity_and_unknown_absorbing() {
        let ab = MeetSet::Only(set([1, 2]));
        let bc = MeetSet::Only(set([2, 3]));
        assert_eq!(ab.clone().combine(bc), MeetSet::Only(set([2])));
        // Disjoint sets meet to nobody, not to All.
        assert_eq!(
            MeetSet::Only(set([1])).combine(MeetSet::Only(set([2]))),
            MeetSet::Only(BTreeSet::new())
        );
        assert_eq!(MeetSet::All.combine(ab.clone()), ab);
        assert_eq!(MeetSet::<u8>::Unknown.combine(MeetSet::All), MeetSet::Unknown);
    }

    #[test]
    fn meet_set_covers_over_the_three_values() {
        assert_eq!(MeetSet::<u8>::All.covers(&set([9])), Adequacy::Holds);
        assert_eq!(MeetSet::<u8>::Unknown.covers(&set([1])), Adequacy::Unprovable);
        let ab = MeetSet::Only(set([1, 2]));
        assert_eq!(ab.covers(&set([2])), Adequacy::Holds);
        assert_eq!(ab.covers(&BTreeSet::new()), Adequacy::Holds);
        assert_eq!(ab.covers(&set([2, 3])), Adequacy::Fails(set([3])));
    }

    #[test]
    fn join_set_unions_with_empty_identity_and_unknown_absorbing() {
        let a = JoinSet::Has(set([1]));
        let b = JoinSet::Has(set([2]));
        assert_eq!(a.clone().combine(b), JoinSet::Has(set([1, 2])));
        assert_eq!(JoinSet::empty().combine(a.clone()), a.clone());
        assert_eq!(a.combine(JoinSet::Unknown), JoinSet::Unknown);
    }

    #[test]
    fn join_set_avoids_over_the_three_values() {
        let forbidden = set([1]);
        assert_eq!(JoinSet::<u8>::empty().avoids(&forbidden), Adequacy::Holds);
        assert_eq!(JoinSet::Has(set([2])).avoids(&forbidden), Adequacy::Holds);
        assert_eq!(JoinSet::Has(set([1, 2])).avoids(&forbidden), Adequacy::Fails(set([1])));
        assert_eq!(JoinSet::<u8>::Unknown.avoids(&forbidden), Adequacy::Unprovable);
        // An empty forbidden set is vacuously avoided.
        assert_eq!(JoinSet::Has(set([1])).avoids(&BTreeSet::new()), Adequacy::Holds);
    }

    #[test]
    fn min_level_folds_min_with_unknown_just_above_bottom() {
        use Level::{High, Low, Mid};
        // Bottom dominates Unknown (it is still lower); every other known value
        // is dominated by Unknown.
        assert_eq!(MinLevel::Known(Low).combine(MinLevel::Unknown), MinLevel::Known(Low));
        assert_eq!(MinLevel::Known(Mid).combine(MinLevel::Unknown), MinLevel::Unknown);
        assert_eq!(MinLevel::Known(High).combine(MinLevel::Unknown), MinLevel::Unknown);
        // Between known values it is plain min.
        assert_eq!(
            MinLevel::Known(Low).combine(MinLevel::Known(High)),
            MinLevel::Known(Low)
        );
        assert_eq!(
            MinLevel::Known(Mid).combine(MinLevel::Known(High)),
            MinLevel::Known(Mid)
        );
        assert_eq!(MinLevel::<Level>::Unknown.combine(MinLevel::Unknown), MinLevel::Unknown);
    }

    #[test]
    fn min_level_at_least_over_the_values() {
        use Level::{High, Low, Mid};
        assert_eq!(MinLevel::Known(High).at_least(Mid), Adequacy::Holds);
        assert_eq!(MinLevel::Known(Mid).at_least(Mid), Adequacy::Holds);
        assert_eq!(MinLevel::Known(Low).at_least(Mid), Adequacy::Fails(Low));
        assert_eq!(MinLevel::<Level>::Unknown.at_least(Low), Adequacy::Unprovable);
        assert_eq!(MinLevel::<Level>::Unknown.at_least(High), Adequacy::Unprovable);
    }

    #[test]
    fn max_level_folds_max_with_unknown_just_below_top() {
        use Level::{High, Low, Mid};
        assert_eq!(MaxLevel::Known(High).combine(MaxLevel::Unknown), MaxLevel::Known(High));
        assert_eq!(MaxLevel::Known(Mid).combine(MaxLevel::Unknown), MaxLevel::Unknown);
        assert_eq!(MaxLevel::Known(Low).combine(MaxLevel::Unknown), MaxLevel::Unknown);
        assert_eq!(
            MaxLevel::Known(Low).combine(MaxLevel::Known(High)),
            MaxLevel::Known(High)
        );
        assert_eq!(MaxLevel::Known(Low).combine(MaxLevel::Known(Mid)), MaxLevel::Known(Mid));
        assert_eq!(MaxLevel::<Level>::Unknown.combine(MaxLevel::Unknown), MaxLevel::Unknown);
    }

    #[test]
    fn max_level_at_most_over_the_values() {
        use Level::{High, Low, Mid};
        assert_eq!(MaxLevel::Known(Low).at_most(Mid), Adequacy::Holds);
        assert_eq!(MaxLevel::Known(Mid).at_most(Mid), Adequacy::Holds);
        assert_eq!(MaxLevel::Known(High).at_most(Mid), Adequacy::Fails(High));
        assert_eq!(MaxLevel::<Level>::Unknown.at_most(Low), Adequacy::Unprovable);
        assert_eq!(MaxLevel::<Level>::Unknown.at_most(High), Adequacy::Unprovable);
    }

    fn meet_samples() -> Vec<MeetSet<u8>> {
        vec![
            MeetSet::All,
            MeetSet::Only(set([1, 2])),
            MeetSet::Only(set([2])),
            MeetSet::Unknown,
        ]
    }

    fn join_samples() -> Vec<JoinSet<u8>> {
        vec![
            JoinSet::empty(),
            JoinSet::Has(set([1])),
            JoinSet::Has(set([1, 2])),
            JoinSet::Unknown,
        ]
    }

    fn min_samples() -> Vec<MinLevel<Level>> {
        vec![
            MinLevel::Known(Level::Low),
            MinLevel::Known(Level::Mid),
            MinLevel::Known(Level::High),
            MinLevel::Unknown,
        ]
    }

    fn max_samples() -> Vec<MaxLevel<Level>> {
        vec![
            MaxLevel::Known(Level::Low),
            MaxLevel::Known(Level::Mid),
            MaxLevel::Known(Level::High),
            MaxLevel::Unknown,
        ]
    }

    /// Every preset fold is a commutative, idempotent semilattice.
    #[test]
    fn folds_are_commutative_idempotent_and_associative() {
        macro_rules! check {
            ($samples:expr) => {{
                let samples = $samples;
                for a in &samples {
                    assert_eq!(a.clone().combine(a.clone()), *a, "not idempotent: {a:?}");
                    for b in &samples {
                        assert_eq!(
                            a.clone().combine(b.clone()),
                            b.clone().combine(a.clone()),
                            "not commutative: {a:?} {b:?}"
                        );
                        for c in &samples {
                            let left = a.clone().combine(b.clone()).combine(c.clone());
                            let right = a.clone().combine(b.clone().combine(c.clone()));
                            assert_eq!(left, right, "not associative: {a:?} {b:?} {c:?}");
                        }
                    }
                }
            }};
        }
        check!(meet_samples());
        check!(join_samples());
        check!(min_samples());
        check!(max_samples());
    }
}
