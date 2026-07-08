//! Label dimensions and their combine algebra.
//!
//! Each dimension defines its own `combine`: how two values merge when data
//! from two sources meets in one context. [`crate::label::Label::join`]
//! applies these per dimension; nothing else in the crate invents merge
//! semantics.

use std::collections::BTreeSet;
use std::fmt;

use crate::ToolName;

/// A user known to the surrounding system (ACLs, directories, ...).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
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
            (Self::Readers(a), Self::Readers(b)) => {
                Self::Readers(a.intersection(&b).cloned().collect())
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

/// How much the provenance of data is trusted.
///
/// Ordered `Suspicious < Unknown < Trusted`; the fold is `min` (least
/// trusted wins). `Unknown` sits between the two on purpose: it must never
/// satisfy a `Trusted` requirement (that would treat missing provenance as
/// safe), but definite evidence of adversarial influence is stronger still,
/// so `Suspicious ∧ Unknown = Suspicious`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Trust {
    Suspicious,
    Unknown,
    Trusted,
}

impl Trust {
    #[must_use]
    pub fn combine(self, other: Self) -> Self {
        self.min(other)
    }
}

impl fmt::Display for Trust {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Suspicious => write!(f, "suspicious"),
            Self::Unknown => write!(f, "unknown"),
            Self::Trusted => write!(f, "trusted"),
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
            (Self::Declared(a), Self::Declared(b)) => {
                Self::Declared(a.union(&b).copied().collect())
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

/// Whether the user is explicitly paying attention right now.
///
/// `High` is an explicit confirmation bound to one named tool, and only the
/// *most recent* turn's attention counts (`combine` keeps the newer value):
/// a confirmation authorizes the immediately following action, never a later
/// one and never a different tool. There is no `Unknown` here — the absence
/// of a confirmation is a definite `Regular`, not missing metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attention {
    Regular,
    High(ToolName),
}

impl Attention {
    #[must_use]
    pub fn combine(self, newer: Self) -> Self {
        newer
    }
}

impl fmt::Display for Attention {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Regular => write!(f, "regular"),
            Self::High(tool) => write!(f, "high({tool})"),
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
        assert_eq!(
            Audience::Unknown.combine(Audience::Public),
            Audience::Unknown
        );
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
        assert_eq!(Trust::Trusted.combine(Trust::Suspicious), Trust::Suspicious);
        assert_eq!(Trust::Trusted.combine(Trust::Trusted), Trust::Trusted);
    }

    #[test]
    fn trust_unknown_sits_between() {
        assert_eq!(Trust::Trusted.combine(Trust::Unknown), Trust::Unknown);
        assert_eq!(Trust::Unknown.combine(Trust::Suspicious), Trust::Suspicious);
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

    #[test]
    fn attention_newest_wins_in_both_directions() {
        let high = Attention::High(ToolName::new("db.drop"));
        assert_eq!(high.clone().combine(Attention::Regular), Attention::Regular);
        assert_eq!(Attention::Regular.combine(high.clone()), high);
    }
}
