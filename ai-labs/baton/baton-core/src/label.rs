//! [`Label`]: the metadata that travels with every turn, and its combine.
//!
//! The crate has two distinct algebraic objects over the same dimensions;
//! keeping them apart is load-bearing:
//!
//! - **Taint fold** — how provenance *combines* as turns meet. Per data
//!   dimension this is a commutative, idempotent semilattice (see
//!   [`crate::dimension`]); `Unknown` has a definite position in each. The
//!   whole [`Label`] is **not** a join-semilattice: it is a monoid whose
//!   product is (that semilattice product over audience/trust/effects) × a
//!   non-commutative Writer log for `audit`. So the whole-label operation is
//!   [`Label::combine`] (monoid append), not a lattice join.
//! - **Adequacy relation** — the *proof* at a sink: is this context good
//!   enough for this flow? That is a three-valued decision, not a lattice
//!   comparison, and lives beside each dimension's combine
//!   ([`crate::dimension`]) and in [`crate::contract`].

use std::collections::BTreeSet;
use std::fmt;

use tracing::trace;

use crate::ToolName;
use crate::authority::AuthorityName;
use crate::contract::Violation;
use crate::dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};

/// One record in the audit dimension.
///
/// Every loosening leaves a trace here; folds concatenate traces in turn
/// order, so the context label carries the full history of exceptions that
/// shaped it. Append-only holds by construction within this crate — nothing
/// here ever removes an entry — but a [`Label`] is plain data, so protecting
/// audit integrity from the surrounding process is the embedding harness's
/// job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditEntry {
    /// An authority minted a [`Grant`] that resolved a set of grant-fixable
    /// violations for one flow (check-transient — the stored context is never
    /// loosened).
    Declassified {
        grant: Grant,
        resolved: Vec<Violation>,
        authority: AuthorityName,
        reason: String,
    },
    /// An acknowledge-only fact accepted on the record — a missing contract or
    /// unprovable effects, which no grant can lift. `by` names the signer:
    /// `Some` when an authority signed off (under
    /// [`crate::engine::UnknownPolicy::Escalate`]), `None` when the policy
    /// audited it through without consulting anyone (under
    /// [`crate::engine::UnknownPolicy::AllowWithAudit`]).
    Acknowledged {
        tool: ToolName,
        facts: Vec<Violation>,
        by: Option<AuthorityName>,
    },
}

impl fmt::Display for AuditEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Declassified {
                resolved,
                authority,
                reason,
                ..
            } => {
                write!(f, "declassified by {authority} ({reason}):")?;
                for v in resolved {
                    write!(f, " [{v}]")?;
                }
                Ok(())
            }
            Self::Acknowledged { tool, facts, by } => {
                match by {
                    Some(authority) => write!(f, "acknowledged by {authority} through `{tool}`:")?,
                    None => write!(f, "unverified flow through `{tool}`:")?,
                }
                for v in facts {
                    write!(f, " [{v}]")?;
                }
                Ok(())
            }
        }
    }
}

/// The product of all data dimensions: what a piece of data *is* from the
/// policy's point of view.
///
/// User confirmations are deliberately not here — they are a property of the
/// interaction, not of data, and live structurally on user turns
/// ([`crate::turn::Actor::User`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub audience: Audience,
    pub trust: Trust,
    pub effects: Effects,
    pub audit: Vec<AuditEntry>,
}

impl Label {
    /// Identity of [`Label::combine`]: neutral in every dimension.
    pub fn identity() -> Self {
        Self {
            audience: Audience::PUBLIC,
            trust: Trust::TRUSTED,
            effects: Effects::none(),
            audit: Vec::new(),
        }
    }

    /// Label for data whose provenance is entirely unestablished — e.g. the
    /// output of a tool nobody annotated.
    pub fn unknown() -> Self {
        Self {
            audience: Audience::UNKNOWN,
            trust: Trust::UNKNOWN,
            effects: Effects::UNKNOWN,
            audit: Vec::new(),
        }
    }

    /// Monoid append: the semilattice product over audience/trust/effects
    /// times the Writer log for `audit`. Commutative in the three data
    /// dimensions; **not** in `audit`, which appends — so fold trajectories in
    /// turn order to keep the trail chronological.
    #[must_use]
    pub fn combine(self, newer: Self) -> Self {
        trace!(older = %self, newer = %newer, "combine");
        let mut audit = self.audit;
        audit.extend(newer.audit);
        Self {
            audience: self.audience.combine(newer.audience),
            trust: self.trust.combine(newer.trust),
            effects: self.effects.combine(newer.effects),
            audit,
        }
    }

    pub fn fold(labels: impl IntoIterator<Item = Self>) -> Self {
        let folded = labels.into_iter().fold(Self::identity(), Self::combine);
        trace!(result = %folded, "fold");
        folded
    }

    /// Apply an authority-minted [`Grant`] to produce a **check-transient**
    /// loosened context. The engine rechecks against the result and discards
    /// it — the stored context is never loosened.
    ///
    /// `lift` is monotone/inflationary in every data dimension in the
    /// *adequacy* (permissiveness) order — where `Unknown` is the bottom of
    /// every dimension — so it can only move a context toward passing a
    /// check, never demote one, which also makes it idempotent. (This is the
    /// adequacy order, not the taint fold order: they agree for audience and
    /// effects but differ for trust, where `Unknown` sits *between* the known
    /// judgements in the fold yet is *bottom* for adequacy. Trust-lift is a
    /// join, not a replace, so a `Trusted` context is never demoted by a
    /// weaker attestation.)
    ///
    /// `confirms` is deliberately not applied here: a confirmation is check
    /// input, not label state.
    #[must_use]
    pub fn lift(&self, grant: &Grant) -> Self {
        let trust = match grant.trust {
            Some(attested) => self.trust.raised_to(attested),
            None => self.trust,
        };
        let audience = match &grant.audience {
            Some(vouched) => self.audience.admitting(vouched),
            None => self.audience.clone(),
        };
        let effects = match &grant.effects {
            Some(waived) => self.effects.waiving(waived),
            None => self.effects.clone(),
        };
        let lifted = Self {
            audience,
            trust,
            effects,
            audit: self.audit.clone(),
        };
        trace!(grant = ?grant, base = %self, result = %lifted, "lift");
        lifted
    }
}

/// An authority's proposed loosening of one flow.
///
/// **Proposal data, not an unforgeable capability.** All fields are public,
/// like [`Label`] — both are harness-trusted data. A `Grant` has no authority
/// *by itself*: it loosens a flow only after the engine (a) routes it to an
/// authority whose declared mandate [`covers`](Grant::covers) it and (b)
/// rechecks the lifted context fail-closed. Routing + recheck establish
/// authority, not the type.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Grant {
    /// Attest that context trust is at least this.
    pub trust: Option<KnownTrust>,
    /// Vouch exactly these readers into the audience.
    pub audience: Option<BTreeSet<UserId>>,
    /// Treat these already-present effects as waived.
    pub effects: Option<BTreeSet<Effect>>,
    /// Stand in for a user confirmation.
    pub confirms: bool,
}

impl Grant {
    /// The identity grant: loosens nothing. Covered by every grant, so an
    /// acknowledgment-only flow (which needs `empty`) is competently handled
    /// by any authority.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Does this grant, read as a *mandate*, cover `need`? A partial order:
    /// trust by the [`KnownTrust`] order (attesting more than asked is fine),
    /// audience/effects by set inclusion, `confirms` by boolean implication.
    /// An absent (`None`/`false`) need asks nothing of that dimension and is
    /// covered by anything; the empty grant is the order's identity, covered
    /// by all. Pure and deterministic — the tuple authority relies on the
    /// same answer at routing time and at delegation time.
    #[must_use]
    pub fn covers(&self, need: &Self) -> bool {
        let trust_ok = match need.trust {
            None => true,
            Some(n) => matches!(self.trust, Some(m) if m >= n),
        };
        let audience_ok = match &need.audience {
            None => true,
            Some(n) => matches!(&self.audience, Some(m) if n.is_subset(m)),
        };
        let effects_ok = match &need.effects {
            None => true,
            Some(n) => matches!(&self.effects, Some(m) if n.is_subset(m)),
        };
        let confirms_ok = !need.confirms || self.confirms;
        trust_ok && audience_ok && effects_ok && confirms_ok
    }
}

impl fmt::Display for Label {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "audience={} trust={} effects={} audit=[{}]",
            self.audience,
            self.trust,
            self.effects,
            self.audit.len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::AuthorityName;
    use crate::contract::{Unprovable, Violation};
    use crate::dimension::{Effect, UserId};
    use crate::preset::Adequacy;

    fn audit_entry(reason: &str) -> AuditEntry {
        AuditEntry::Declassified {
            grant: Grant::empty(),
            resolved: vec![Violation::Unprovable(Unprovable::AudienceUnknown)],
            authority: AuthorityName::new("test"),
            reason: reason.to_owned(),
        }
    }

    #[test]
    fn identity_is_neutral() {
        let label = Label {
            audience: Audience::readers([UserId::new("alice")]),
            trust: Trust::SUSPICIOUS,
            effects: Effects::declared([Effect::Egress]),
            audit: vec![audit_entry("x")],
        };
        assert_eq!(Label::identity().combine(label.clone()), label);
    }

    #[test]
    fn combine_merges_every_dimension() {
        let private_trusted = Label {
            audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
            trust: Trust::TRUSTED,
            effects: Effects::none(),
            audit: vec![audit_entry("first")],
        };
        let public_suspicious = Label {
            audience: Audience::PUBLIC,
            trust: Trust::SUSPICIOUS,
            effects: Effects::declared([Effect::Mutation]),
            audit: vec![audit_entry("second")],
        };
        let combined = private_trusted.combine(public_suspicious);
        assert_eq!(
            combined.audience,
            Audience::readers([UserId::new("alice"), UserId::new("bob")])
        );
        assert_eq!(combined.trust, Trust::SUSPICIOUS);
        assert_eq!(combined.effects, Effects::declared([Effect::Mutation]));
        assert_eq!(combined.audit, vec![audit_entry("first"), audit_entry("second")]);
    }

    #[test]
    fn unknown_label_poisons_the_fold() {
        let folded = Label::fold([Label::identity(), Label::unknown()]);
        assert_eq!(folded.audience, Audience::UNKNOWN);
        assert_eq!(folded.trust, Trust::UNKNOWN);
        assert_eq!(folded.effects, Effects::UNKNOWN);
    }

    fn sample_labels() -> Vec<Label> {
        vec![
            Label::identity(),
            Label::unknown(),
            Label {
                audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
                trust: Trust::SUSPICIOUS,
                effects: Effects::declared([Effect::Mutation, Effect::Egress]),
                audit: Vec::new(),
            },
            Label {
                audience: Audience::PUBLIC,
                trust: Trust::TRUSTED,
                effects: Effects::none(),
                audit: Vec::new(),
            },
        ]
    }

    fn sample_grants() -> Vec<Grant> {
        vec![
            Grant::empty(),
            Grant {
                trust: Some(KnownTrust::Trusted),
                ..Grant::empty()
            },
            Grant {
                trust: Some(KnownTrust::Suspicious),
                ..Grant::empty()
            },
            Grant {
                audience: Some(BTreeSet::from([UserId::new("bob")])),
                ..Grant::empty()
            },
            Grant {
                effects: Some(BTreeSet::from([Effect::Mutation])),
                ..Grant::empty()
            },
            Grant {
                trust: Some(KnownTrust::Trusted),
                audience: Some(BTreeSet::from([UserId::new("charlie")])),
                effects: Some(BTreeSet::from([Effect::Egress])),
                confirms: true,
            },
        ]
    }

    #[test]
    fn lift_empty_is_identity() {
        for x in sample_labels() {
            assert_eq!(x.lift(&Grant::empty()), x);
        }
    }

    #[test]
    fn lift_is_idempotent() {
        for x in sample_labels() {
            for g in sample_grants() {
                let once = x.lift(&g);
                assert_eq!(once.lift(&g), once, "grant={g:?} x={x}");
            }
        }
    }

    #[test]
    fn lift_is_inflationary_in_the_adequacy_order() {
        // `lift` may only move a context toward passing a check (`Unknown` is
        // bottom in every dimension), never demote one.
        for x in sample_labels() {
            for g in sample_grants() {
                let up = x.lift(&g);
                assert!(x.trust.adequacy_le(&up.trust), "trust demoted: g={g:?} x={x}");
                assert!(x.audience.adequacy_le(&up.audience), "audience demoted: g={g:?} x={x}");
                assert!(x.effects.adequacy_le(&up.effects), "effects demoted: g={g:?} x={x}");
            }
        }
    }

    #[test]
    fn trust_grant_clears_the_trust_bar() {
        for floor in [KnownTrust::Suspicious, KnownTrust::Trusted] {
            let g = Grant {
                trust: Some(floor),
                ..Grant::empty()
            };
            for x in sample_labels() {
                assert_eq!(x.lift(&g).trust.at_least(floor), Adequacy::Holds, "floor={floor} x={x}");
            }
        }
    }

    #[test]
    fn audience_grant_covers_the_vouched_recipients() {
        let recipients = BTreeSet::from([UserId::new("bob"), UserId::new("charlie")]);
        let g = Grant {
            audience: Some(recipients.clone()),
            ..Grant::empty()
        };
        for x in sample_labels() {
            assert_eq!(x.lift(&g).audience.covers(&recipients), Adequacy::Holds, "x={x}");
        }
    }

    #[test]
    fn effects_grant_clears_declared_contexts_only() {
        // EffectsUnknown is acknowledge-only, never grant-fixable, so an
        // effects grant only ever targets a Declared context.
        let forbidden = BTreeSet::from([Effect::Mutation]);
        let g = Grant {
            effects: Some(forbidden.clone()),
            ..Grant::empty()
        };
        for present in [
            Effects::none(),
            Effects::declared([Effect::Mutation]),
            Effects::declared([Effect::Mutation, Effect::Egress]),
        ] {
            let x = Label {
                effects: present,
                ..Label::identity()
            };
            assert_eq!(x.lift(&g).effects.avoids(&forbidden), Adequacy::Holds, "x={x}");
        }
        // Unknown is not cleared — this is precisely why it is
        // acknowledge-only rather than grant-fixable.
        let unknown = Label {
            effects: Effects::UNKNOWN,
            ..Label::identity()
        };
        assert_eq!(unknown.lift(&g).effects.avoids(&forbidden), Adequacy::Unprovable);
    }

    #[test]
    fn covers_is_reflexive_and_transitive() {
        let grants = sample_grants();
        for g in &grants {
            assert!(g.covers(g), "not reflexive: {g:?}");
        }
        for a in &grants {
            for b in &grants {
                for c in &grants {
                    if a.covers(b) && b.covers(c) {
                        assert!(a.covers(c), "not transitive: {a:?} {b:?} {c:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn covers_trust_follows_the_known_trust_order() {
        let trusted_mandate = Grant {
            trust: Some(KnownTrust::Trusted),
            ..Grant::empty()
        };
        let suspicious_need = Grant {
            trust: Some(KnownTrust::Suspicious),
            ..Grant::empty()
        };
        // Attesting more than asked covers the smaller need.
        assert!(trusted_mandate.covers(&suspicious_need));
        // A suspicious mandate cannot cover a trusted need.
        let trusted_need = Grant {
            trust: Some(KnownTrust::Trusted),
            ..Grant::empty()
        };
        let suspicious_mandate = Grant {
            trust: Some(KnownTrust::Suspicious),
            ..Grant::empty()
        };
        assert!(!suspicious_mandate.covers(&trusted_need));
        // The empty (None) mandate covers only a None need.
        assert!(Grant::empty().covers(&Grant::empty()));
        assert!(!Grant::empty().covers(&suspicious_need));
    }

    #[test]
    fn empty_grant_is_covered_by_all() {
        for g in sample_grants() {
            assert!(g.covers(&Grant::empty()), "{g:?} should cover empty");
        }
    }
}
