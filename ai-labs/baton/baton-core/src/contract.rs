//! Tool contracts: requirements over the context label, checked as the
//! design notes' `(Requirements − Label)` set difference.

use std::collections::BTreeSet;
use std::fmt;

use crate::ToolName;
use crate::dimension::{Adequacy, Effect, KnownTrust, UserId};
use crate::label::Label;

/// A concrete tool invocation the policy is asked to authorize.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRequest {
    pub tool: ToolName,
    /// Readers this call would expose context to (e.g. e-mail recipients).
    /// Empty for tools that do not egress context to people; an
    /// audience-guarded sink with an empty set is a [`Breach`].
    pub recipients: BTreeSet<UserId>,
}

impl ToolRequest {
    pub fn new(tool: ToolName) -> Self {
        Self {
            tool,
            recipients: BTreeSet::new(),
        }
    }

    pub fn exposing(tool: ToolName, recipients: impl IntoIterator<Item = UserId>) -> Self {
        Self {
            tool,
            recipients: recipients.into_iter().collect(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AudienceRule {
    #[default]
    Unrestricted,
    /// Every declared recipient must already be an allowed reader of the
    /// context: `recipients − context.audience` must be empty.
    RecipientsWithinContext,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AttentionRule {
    #[default]
    NotRequired,
    /// The most recent turn must be an explicit confirmation of *this* tool.
    ExplicitConfirmation,
}

/// What a tool demands of the context label before it may run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Requirements {
    /// Minimum *known* trust. `Trust::Unknown` never satisfies any bar —
    /// deliberately over [`KnownTrust`], so "unknown suffices" cannot even be
    /// expressed; unpacking `Unknown` is always an explicit
    /// [`crate::engine::UnknownPolicy`] or authority decision.
    /// `Some(KnownTrust::Suspicious)` means "provenance must merely be
    /// established".
    pub trust: Option<KnownTrust>,
    pub audience: AudienceRule,
    pub attention: AttentionRule,
    /// Effects that must not already have happened in the context.
    pub forbid_prior_effects: BTreeSet<Effect>,
}

/// A requirement that is provably not met.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Breach {
    TrustBelow {
        required: KnownTrust,
        actual: KnownTrust,
    },
    /// The non-empty diff `recipients − context.audience`.
    AudienceExceeds {
        outside: BTreeSet<UserId>,
    },
    /// An audience-guarded sink was called with no recipients at all. The
    /// caller definitionally has this data, so its absence is an integration
    /// bug, not an annotation gap — a breach, never softened by
    /// [`crate::engine::UnknownPolicy`].
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
}

impl fmt::Display for Breach {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TrustBelow { required, actual } => {
                write!(f, "context trust is {actual}, tool requires {required}")
            }
            Self::AudienceExceeds { outside } => {
                write!(f, "recipients outside context audience:")?;
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
                write!(f, "context already carries forbidden effects:")?;
                for e in effects {
                    write!(f, " {e}")?;
                }
                Ok(())
            }
        }
    }
}

/// A requirement that cannot be proven either way because something is
/// `Unknown`. Kept apart from [`Breach`] so policy can treat missing
/// knowledge differently from proven violations.
#[derive(Debug, Clone, PartialEq, Eq)]
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
                write!(f, "context trust unknown, cannot prove the required trust")
            }
            Self::AudienceUnknown => write!(f, "context audience unknown, cannot bound recipients"),
            Self::EffectsUnknown => write!(f, "context effects unknown"),
            Self::NoContract { tool } => write!(f, "tool `{tool}` has no contract"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    Breach(Breach),
    Unprovable(Unprovable),
    /// The source-side taint knob ([`crate::engine::TaintPolicy::Escalate`])
    /// flagged this flow: folding the tool's output onto the context would
    /// degrade a dimension. Acknowledge-only — there is nothing to prove or
    /// lift, only a fact to record.
    TaintEntry {
        tool: ToolName,
    },
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Breach(b) => write!(f, "breach: {b}"),
            Self::Unprovable(u) => write!(f, "unprovable: {u}"),
            Self::TaintEntry { tool } => {
                write!(f, "taint: flow through `{tool}` degrades the context")
            }
        }
    }
}

/// Where a violation sits on the *fixability* axis, orthogonal to the
/// breach/unprovable *provability* axis: what an authority can do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fixability {
    /// A grant can cover it (a lift for the label dimensions, `confirms` for
    /// attention).
    GrantFixable,
    /// Nothing to lift — one cannot attest a negative over `Unknown` effects,
    /// nor conjure a missing contract. An authority may only accept the fact
    /// on the record.
    AcknowledgeOnly,
    /// An integration bug (the caller definitionally holds the data); no
    /// authority may override it.
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
            Self::Unprovable(Unprovable::EffectsUnknown | Unprovable::NoContract { .. }) | Self::TaintEntry { .. } => {
                Fixability::AcknowledgeOnly
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use]
pub enum Verdict {
    Allow,
    Escalate(Vec<Violation>),
}

/// A tool's annotation: what it demands of the context, and the label its
/// results wear.
///
/// The output label is per-result provenance only; taint from the context the
/// call was made in propagates through the trajectory fold, not through here.
/// A label cannot express a user confirmation at all (confirmations are
/// structural on user turns), so a contract cannot re-arm a confirmation
/// gate from its own output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolContract {
    pub name: ToolName,
    pub requires: Requirements,
    pub output_label: Label,
}

impl Requirements {
    /// `confirmation` is the trajectory's pending user confirmation
    /// ([`crate::turn::Trajectory::pending_confirmation`]) — structural
    /// context alongside the folded label.
    pub fn check(&self, context: &Label, confirmation: Option<&ToolName>, request: &ToolRequest) -> Verdict {
        // An ordered Writer, not commutative validation: the emission order
        // (trust, audience, attention, effects) is an observable part of the
        // contract, so each arm pushes in turn. The per-dimension order
        // semantics live beside each combine in `dimension.rs`; this is only
        // the composition and the structural (non-dimension) arms.
        let mut violations = Vec::new();

        if let Some(required) = self.trust {
            match context.trust.at_least(required) {
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
                if request.recipients.is_empty() {
                    violations.push(Violation::Breach(Breach::UndeclaredRecipients));
                } else {
                    match context.audience.covers(&request.recipients) {
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
            (AttentionRule::ExplicitConfirmation, Some(confirmed)) if *confirmed == request.tool => {}
            (AttentionRule::ExplicitConfirmation, Some(confirmed)) => {
                violations.push(Violation::Breach(Breach::ConfirmationForOtherTool {
                    confirmed: confirmed.clone(),
                    requested: request.tool.clone(),
                }));
            }
            (AttentionRule::ExplicitConfirmation, None) => {
                violations.push(Violation::Breach(Breach::ConfirmationMissing {
                    tool: request.tool.clone(),
                }));
            }
        }

        if !self.forbid_prior_effects.is_empty() {
            match context.effects.avoids(&self.forbid_prior_effects) {
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
            Verdict::Allow
        } else {
            Verdict::Escalate(violations)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::{Audience, Effects, Trust};

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    fn email_requirements() -> Requirements {
        Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: AudienceRule::RecipientsWithinContext,
            ..Requirements::default()
        }
    }

    fn private_trusted_context() -> Label {
        Label {
            audience: Audience::readers([user("alice"), user("bob")]),
            trust: Trust::TRUSTED,
            ..Label::identity()
        }
    }

    #[test]
    fn all_requirements_met_allows() {
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert_eq!(
            email_requirements().check(&private_trusted_context(), None, &request),
            Verdict::Allow
        );
    }

    #[test]
    fn suspicious_context_is_a_breach_but_unknown_is_unprovable() {
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);

        let suspicious = Label {
            trust: Trust::SUSPICIOUS,
            ..private_trusted_context()
        };
        assert_eq!(
            email_requirements().check(&suspicious, None, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::TrustBelow {
                required: KnownTrust::Trusted,
                actual: KnownTrust::Suspicious,
            })])
        );

        let unknown = Label {
            trust: Trust::Unknown,
            ..private_trusted_context()
        };
        assert_eq!(
            email_requirements().check(&unknown, None, &request),
            Verdict::Escalate(vec![Violation::Unprovable(Unprovable::TrustUnknown)])
        );
    }

    #[test]
    fn unknown_trust_never_satisfies_any_bar() {
        // Even the lowest bar — provenance merely established — is
        // unprovable for Unknown: unpacking Unknown into a judgement is
        // always an explicit policy or authority decision, never a cast.
        let requirements = Requirements {
            trust: Some(KnownTrust::Suspicious),
            ..Requirements::default()
        };
        let request = ToolRequest::new(ToolName::new("notes.append"));

        let unknown = Label {
            trust: Trust::Unknown,
            ..Label::identity()
        };
        assert_eq!(
            requirements.check(&unknown, None, &request),
            Verdict::Escalate(vec![Violation::Unprovable(Unprovable::TrustUnknown)])
        );

        let suspicious = Label {
            trust: Trust::SUSPICIOUS,
            ..Label::identity()
        };
        assert_eq!(requirements.check(&suspicious, None, &request), Verdict::Allow);
    }

    #[test]
    fn recipient_outside_audience_reports_the_diff() {
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob"), user("charlie")]);
        assert_eq!(
            email_requirements().check(&private_trusted_context(), None, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::AudienceExceeds {
                outside: BTreeSet::from([user("charlie")]),
            })])
        );
    }

    #[test]
    fn egress_without_recipients_is_a_breach() {
        let none_declared = ToolRequest::new(ToolName::new("email.send"));
        assert_eq!(
            email_requirements().check(&private_trusted_context(), None, &none_declared),
            Verdict::Escalate(vec![Violation::Breach(Breach::UndeclaredRecipients)])
        );
    }

    #[test]
    fn unknown_audience_cannot_bound_recipients() {
        let context = Label {
            audience: Audience::Unknown,
            ..private_trusted_context()
        };
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert_eq!(
            email_requirements().check(&context, None, &request),
            Verdict::Escalate(vec![Violation::Unprovable(Unprovable::AudienceUnknown)])
        );
    }

    #[test]
    fn public_context_allows_any_recipient() {
        let context = Label {
            audience: Audience::Public,
            ..private_trusted_context()
        };
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("stranger")]);
        assert_eq!(email_requirements().check(&context, None, &request), Verdict::Allow);
    }

    #[test]
    fn confirmation_must_name_the_requested_tool() {
        let requirements = Requirements {
            attention: AttentionRule::ExplicitConfirmation,
            ..Requirements::default()
        };
        let request = ToolRequest::new(ToolName::new("db.drop"));
        let context = Label::identity();

        assert_eq!(
            requirements.check(&context, None, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::ConfirmationMissing {
                tool: ToolName::new("db.drop"),
            })])
        );

        assert_eq!(
            requirements.check(&context, Some(&ToolName::new("email.send")), &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::ConfirmationForOtherTool {
                confirmed: ToolName::new("email.send"),
                requested: ToolName::new("db.drop"),
            })])
        );

        assert_eq!(
            requirements.check(&context, Some(&ToolName::new("db.drop")), &request),
            Verdict::Allow
        );
    }

    #[test]
    fn forbidden_prior_effects_are_enforced() {
        let requirements = Requirements {
            forbid_prior_effects: BTreeSet::from([Effect::Mutation]),
            ..Requirements::default()
        };
        let request = ToolRequest::new(ToolName::new("report.generate"));

        let mutated = Label {
            effects: Effects::declared([Effect::Mutation, Effect::Egress]),
            ..Label::identity()
        };
        assert_eq!(
            requirements.check(&mutated, None, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::ForbiddenPriorEffects {
                effects: BTreeSet::from([Effect::Mutation]),
            })])
        );

        let unknown = Label {
            effects: Effects::Unknown,
            ..Label::identity()
        };
        assert_eq!(
            requirements.check(&unknown, None, &request),
            Verdict::Escalate(vec![Violation::Unprovable(Unprovable::EffectsUnknown)])
        );

        assert_eq!(requirements.check(&Label::identity(), None, &request), Verdict::Allow);
    }
}
