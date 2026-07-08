//! [`Label`]: the metadata that travels with every turn, and its join.

use std::fmt;

use crate::ToolName;
use crate::authority::AuthorityName;
use crate::contract::Violation;
use crate::dimension::{Audience, Effects, Trust};

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
    /// An authority explicitly waived a violation for one flow.
    Declassified {
        violation: Violation,
        authority: AuthorityName,
        reason: String,
    },
    /// [`crate::engine::UnknownPolicy::AllowWithAudit`] let unprovable
    /// requirements through.
    UnverifiedFlow {
        tool: ToolName,
        unknowns: Vec<Violation>,
    },
}

impl fmt::Display for AuditEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Declassified {
                violation,
                authority,
                reason,
            } => write!(f, "declassified by {authority} ({reason}): {violation}"),
            Self::UnverifiedFlow { tool, unknowns } => {
                write!(f, "unverified flow through `{tool}`:")?;
                for u in unknowns {
                    write!(f, " [{u}]")?;
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
    /// Identity of [`Label::join`]: neutral in every dimension.
    pub fn identity() -> Self {
        Self {
            audience: Audience::Public,
            trust: Trust::TRUSTED,
            effects: Effects::none(),
            audit: Vec::new(),
        }
    }

    /// Label for data whose provenance is entirely unestablished — e.g. the
    /// output of a tool nobody annotated.
    pub fn unknown() -> Self {
        Self {
            audience: Audience::Unknown,
            trust: Trust::Unknown,
            effects: Effects::Unknown,
            audit: Vec::new(),
        }
    }

    /// Per-dimension combine. Order matters only for `audit` (append), so
    /// fold trajectories in turn order to keep the trail chronological.
    #[must_use]
    pub fn join(self, newer: Self) -> Self {
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
        labels.into_iter().fold(Self::identity(), Self::join)
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

    fn audit_entry(reason: &str) -> AuditEntry {
        AuditEntry::Declassified {
            violation: Violation::Unprovable(Unprovable::AudienceUnknown),
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
        assert_eq!(Label::identity().join(label.clone()), label);
    }

    #[test]
    fn join_combines_every_dimension() {
        let private_trusted = Label {
            audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
            trust: Trust::TRUSTED,
            effects: Effects::none(),
            audit: vec![audit_entry("first")],
        };
        let public_suspicious = Label {
            audience: Audience::Public,
            trust: Trust::SUSPICIOUS,
            effects: Effects::declared([Effect::Mutation]),
            audit: vec![audit_entry("second")],
        };
        let joined = private_trusted.join(public_suspicious);
        assert_eq!(
            joined.audience,
            Audience::readers([UserId::new("alice"), UserId::new("bob")])
        );
        assert_eq!(joined.trust, Trust::SUSPICIOUS);
        assert_eq!(joined.effects, Effects::declared([Effect::Mutation]));
        assert_eq!(
            joined.audit,
            vec![audit_entry("first"), audit_entry("second")]
        );
    }

    #[test]
    fn unknown_label_poisons_the_fold() {
        let folded = Label::fold([Label::identity(), Label::unknown()]);
        assert_eq!(folded.audience, Audience::Unknown);
        assert_eq!(folded.trust, Trust::Unknown);
        assert_eq!(folded.effects, Effects::Unknown);
    }
}
