//! Sink requirements and their typed violations, checked against the flow
//! label of exactly the values a request depends on.

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;
use tracing::trace;

use crate::ToolName;
use crate::dimension::{Effect, Effects, KnownTrust, UserId};
use crate::preset::Adequacy;
use crate::value::ValueLabel;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub enum AudienceRule {
    #[default]
    Unrestricted,
    /// Every resolved recipient must already be an allowed reader of the
    /// flow: `recipients − flow.audience` must be empty.
    RecipientsWithinContext,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub enum AttentionRule {
    #[default]
    NotRequired,
    /// The most recent turn must be an explicit, unspent confirmation of
    /// *this* tool.
    ExplicitConfirmation,
}

/// What a tool demands before it may run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Requirements {
    /// Minimum *known* trust of the flow. `Trust::UNKNOWN` never satisfies
    /// any bar — deliberately over [`KnownTrust`], so "unknown suffices"
    /// cannot even be expressed; an unknown-trust flow routes through the
    /// authority chain (an [`crate::approval::Authority`] endorses the source
    /// value under a durably raised label), never an implicit pass.
    /// `Some(KnownTrust::Suspicious)` means "provenance must merely be
    /// established".
    pub trust: Option<KnownTrust>,
    pub audience: AudienceRule,
    pub attention: AttentionRule,
    /// Effects that must not already have happened in the trajectory.
    pub forbid_prior_effects: BTreeSet<Effect>,
}

/// A requirement that is provably not met.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Breach {
    TrustBelow {
        required: KnownTrust,
        actual: KnownTrust,
    },
    /// The non-empty diff `recipients − flow.audience`.
    AudienceExceeds {
        outside: BTreeSet<UserId>,
    },
    /// An audience-guarded sink was called with no recipients at all. The
    /// caller definitionally has this data, so its absence is an integration
    /// bug, not an annotation gap — a breach, never softened by an authority.
    UndeclaredRecipients,
    ConfirmationMissing {
        tool: ToolName,
    },
    ConfirmationForOtherTool {
        confirmed: ToolName,
        requested: ToolName,
    },
    ForbiddenPriorEffects {
        effects: BTreeSet<Effect>,
    },
    /// The call's proposed effects would grow the committed effect surface by
    /// `growth` (criterion (1)): the flow is not downhill on effects. Cleared
    /// only by an `Accept` authority acquiring the growth, never by a waiver.
    SurfaceGrowth {
        growth: Effects,
    },
}

impl fmt::Display for Breach {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TrustBelow { required, actual } => {
                write!(f, "flow trust is {actual}, tool requires {required}")
            }
            Self::AudienceExceeds { outside } => {
                write!(f, "recipients outside flow audience:")?;
                for id in outside {
                    write!(f, " {id}")?;
                }
                Ok(())
            }
            Self::UndeclaredRecipients => {
                write!(f, "audience-guarded sink called with no recipients")
            }
            Self::ConfirmationMissing { tool } => {
                write!(f, "no explicit user confirmation for `{tool}`")
            }
            Self::ConfirmationForOtherTool { confirmed, requested } => {
                write!(f, "confirmation was for `{confirmed}`, not `{requested}`")
            }
            Self::ForbiddenPriorEffects { effects } => {
                write!(f, "trajectory already carries forbidden effects:")?;
                for e in effects {
                    write!(f, " {e}")?;
                }
                Ok(())
            }
            Self::SurfaceGrowth { growth } => {
                write!(f, "proposed effects grow the committed surface by {growth}")
            }
        }
    }
}

/// A requirement that cannot be proven either way because something is
/// `Unknown`. Kept apart from [`Breach`] so policy can treat missing
/// knowledge differently from proven violations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Unprovable {
    TrustUnknown,
    AudienceUnknown,
    EffectsUnknown,
    /// The tool has no registered contract at all.
    NoContract {
        tool: ToolName,
    },
}

impl fmt::Display for Unprovable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TrustUnknown => {
                write!(f, "flow trust unknown, cannot prove the required trust")
            }
            Self::AudienceUnknown => write!(f, "flow audience unknown, cannot bound recipients"),
            Self::EffectsUnknown => write!(f, "trajectory effects unknown"),
            Self::NoContract { tool } => write!(f, "tool `{tool}` has no contract"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Violation {
    Breach(Breach),
    Unprovable(Unprovable),
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Breach(b) => write!(f, "breach: {b}"),
            Self::Unprovable(u) => write!(f, "unprovable: {u}"),
        }
    }
}

/// Where a violation sits on the *fixability* axis, orthogonal to the
/// breach/unprovable *provability* axis: what a remedy can do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fixability {
    /// A transition or waiver can address it.
    GrantFixable,
    /// Nothing to lift — one cannot attest a negative over `Unknown` effects,
    /// nor conjure a missing contract. A waiver may only accept the fact on
    /// the record.
    AcknowledgeOnly,
    /// A surface growth (criterion (1)) that only an `Accept` authority may
    /// acquire on the pending action; a waiver cannot address it.
    AcceptFixable,
    /// An integration bug (the caller definitionally holds the data); nothing
    /// may override it.
    Structural,
}

impl Violation {
    pub(crate) fn fixability(&self) -> Fixability {
        match self {
            Self::Breach(Breach::UndeclaredRecipients) => Fixability::Structural,
            Self::Breach(
                Breach::TrustBelow { .. }
                | Breach::AudienceExceeds { .. }
                | Breach::ForbiddenPriorEffects { .. }
                | Breach::ConfirmationMissing { .. }
                | Breach::ConfirmationForOtherTool { .. },
            )
            | Self::Unprovable(Unprovable::TrustUnknown | Unprovable::AudienceUnknown) => Fixability::GrantFixable,
            Self::Breach(Breach::SurfaceGrowth { .. }) => Fixability::AcceptFixable,
            Self::Unprovable(Unprovable::EffectsUnknown | Unprovable::NoContract { .. }) => Fixability::AcknowledgeOnly,
        }
    }
}

/// The raw output of the sink check. Internal: a consumer receives a
/// [`crate::engine::Decision`] (or [`crate::engine::ResponseDecision`]), which
/// folds this verdict together with the engine's remedy machinery.
#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use]
pub(crate) enum Verdict {
    Allow,
    Escalate(Vec<Violation>),
}

impl Requirements {
    /// The value-granular sink check: audience and trust against the flow
    /// label (`L_flow = combine(L_args, L_control)` — see [`crate::request`]),
    /// effects against the trajectory's monotone past effects, attention
    /// against the structural pending confirmation.
    ///
    /// An ordered Writer, not commutative validation: the emission order
    /// (trust, audience, attention, effects) is an observable part of the
    /// contract, so each arm pushes in turn. The per-dimension order
    /// semantics live beside each combine in `dimension.rs`; this is only
    /// the composition and the structural (non-dimension) arms.
    pub(crate) fn check_flow(
        &self,
        flow: &ValueLabel,
        past_effects: &Effects,
        confirmation: Option<&ToolName>,
        tool: &ToolName,
        recipients: &BTreeSet<UserId>,
    ) -> Verdict {
        let mut violations = Vec::new();

        if let Some(required) = self.trust {
            match flow.trust.at_least(required) {
                Adequacy::Holds => {}
                Adequacy::Unprovable => {
                    violations.push(Violation::Unprovable(Unprovable::TrustUnknown));
                }
                Adequacy::Fails(actual) => {
                    violations.push(Violation::Breach(Breach::TrustBelow { required, actual }));
                }
            }
        }

        match self.audience {
            AudienceRule::Unrestricted => {}
            AudienceRule::RecipientsWithinContext => {
                if recipients.is_empty() {
                    violations.push(Violation::Breach(Breach::UndeclaredRecipients));
                } else {
                    match flow.audience.covers(recipients) {
                        Adequacy::Holds => {}
                        Adequacy::Unprovable => {
                            violations.push(Violation::Unprovable(Unprovable::AudienceUnknown));
                        }
                        Adequacy::Fails(outside) => {
                            violations.push(Violation::Breach(Breach::AudienceExceeds { outside }));
                        }
                    }
                }
            }
        }

        match (self.attention, confirmation) {
            (AttentionRule::NotRequired, _) => {}
            (AttentionRule::ExplicitConfirmation, Some(confirmed)) if confirmed == tool => {}
            (AttentionRule::ExplicitConfirmation, Some(confirmed)) => {
                violations.push(Violation::Breach(Breach::ConfirmationForOtherTool {
                    confirmed: confirmed.clone(),
                    requested: tool.clone(),
                }));
            }
            (AttentionRule::ExplicitConfirmation, None) => {
                violations.push(Violation::Breach(Breach::ConfirmationMissing { tool: tool.clone() }));
            }
        }

        if !self.forbid_prior_effects.is_empty() {
            match past_effects.avoids(&self.forbid_prior_effects) {
                Adequacy::Holds => {}
                Adequacy::Unprovable => {
                    violations.push(Violation::Unprovable(Unprovable::EffectsUnknown));
                }
                Adequacy::Fails(effects) => {
                    violations.push(Violation::Breach(Breach::ForbiddenPriorEffects { effects }));
                }
            }
        }

        if violations.is_empty() {
            trace!(%tool, "check_flow: allow");
            Verdict::Allow
        } else {
            trace!(%tool, violations = ?violations, "check_flow: escalate");
            Verdict::Escalate(violations)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::{Audience, Trust};

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    /// The emission order (trust, audience, attention, effects) is an
    /// observable part of the contract — asserted on the typed vector, never
    /// on wording.
    #[test]
    fn check_flow_emits_violations_in_contract_order() {
        let requirements = Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: AudienceRule::RecipientsWithinContext,
            attention: AttentionRule::ExplicitConfirmation,
            forbid_prior_effects: BTreeSet::from([Effect::Egress]),
        };
        let flow = ValueLabel {
            audience: Audience::readers([user("alice")]),
            trust: Trust::SUSPICIOUS,
        };
        let tool = ToolName::new("db.drop");
        let recipients = BTreeSet::from([user("bob")]);

        let verdict = requirements.check_flow(&flow, &Effects::declared([Effect::Egress]), None, &tool, &recipients);
        assert_eq!(
            verdict,
            Verdict::Escalate(vec![
                Violation::Breach(Breach::TrustBelow {
                    required: KnownTrust::Trusted,
                    actual: KnownTrust::Suspicious,
                }),
                Violation::Breach(Breach::AudienceExceeds {
                    outside: BTreeSet::from([user("bob")]),
                }),
                Violation::Breach(Breach::ConfirmationMissing { tool: tool.clone() }),
                Violation::Breach(Breach::ForbiddenPriorEffects {
                    effects: BTreeSet::from([Effect::Egress]),
                }),
            ])
        );
    }

    #[test]
    fn check_flow_allows_adequate_flow() {
        let requirements = Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: AudienceRule::RecipientsWithinContext,
            ..Requirements::default()
        };
        let flow = ValueLabel {
            audience: Audience::readers([user("alice"), user("bob")]),
            trust: Trust::TRUSTED,
        };
        let verdict = requirements.check_flow(
            &flow,
            &Effects::none(),
            None,
            &ToolName::new("email.send"),
            &BTreeSet::from([user("bob")]),
        );
        assert_eq!(verdict, Verdict::Allow);
    }

    #[test]
    fn check_flow_unknown_flow_is_unprovable_not_breach() {
        let requirements = Requirements {
            trust: Some(KnownTrust::Suspicious),
            audience: AudienceRule::RecipientsWithinContext,
            ..Requirements::default()
        };
        let verdict = requirements.check_flow(
            &ValueLabel::unknown(),
            &Effects::none(),
            None,
            &ToolName::new("email.send"),
            &BTreeSet::from([user("bob")]),
        );
        assert_eq!(
            verdict,
            Verdict::Escalate(vec![
                Violation::Unprovable(Unprovable::TrustUnknown),
                Violation::Unprovable(Unprovable::AudienceUnknown),
            ])
        );
    }

    #[test]
    fn check_flow_guarded_sink_without_recipients_is_structural() {
        let requirements = Requirements {
            audience: AudienceRule::RecipientsWithinContext,
            ..Requirements::default()
        };
        let verdict = requirements.check_flow(
            &ValueLabel::identity(),
            &Effects::none(),
            None,
            &ToolName::new("email.send"),
            &BTreeSet::new(),
        );
        assert_eq!(
            verdict,
            Verdict::Escalate(vec![Violation::Breach(Breach::UndeclaredRecipients)])
        );
        assert_eq!(
            Violation::Breach(Breach::UndeclaredRecipients).fixability(),
            Fixability::Structural
        );
    }

    #[test]
    fn check_flow_confirmation_must_name_this_tool() {
        let requirements = Requirements {
            attention: AttentionRule::ExplicitConfirmation,
            ..Requirements::default()
        };
        let confirmed = ToolName::new("other.tool");
        let requested = ToolName::new("db.drop");
        let verdict = requirements.check_flow(
            &ValueLabel::identity(),
            &Effects::none(),
            Some(&confirmed),
            &requested,
            &BTreeSet::new(),
        );
        assert_eq!(
            verdict,
            Verdict::Escalate(vec![Violation::Breach(Breach::ConfirmationForOtherTool {
                confirmed,
                requested,
            })])
        );
    }
}
