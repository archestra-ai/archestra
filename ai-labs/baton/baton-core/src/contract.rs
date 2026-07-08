//! Tool contracts: requirements over the context label, checked as the
//! design notes' `(Requirements − Label)` set difference.

use std::collections::BTreeSet;
use std::fmt;

use crate::ToolName;
use crate::dimension::{Attention, Audience, Effect, Effects, Trust, UserId};
use crate::label::Label;

/// A concrete tool invocation the policy is asked to authorize.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowRequest {
    pub tool: ToolName,
    /// Readers this call would expose context to (e.g. e-mail recipients).
    /// Empty for tools that do not egress context to people; an
    /// audience-guarded sink with an empty set is a [`Breach`].
    pub recipients: BTreeSet<UserId>,
}

impl FlowRequest {
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

/// A trust floor a contract may demand. Deliberately not [`Trust`] itself:
/// `Unknown` is an epistemic state, not a bar one can set, so "unknown
/// suffices" cannot be expressed by accident — leniency has to be spelled
/// out as [`TrustRequirement::NotSuspicious`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustRequirement {
    /// Provenance must be affirmatively trusted; `Unknown` is unprovable.
    Trusted,
    /// Only definite adversarial influence violates; `Unknown` passes.
    NotSuspicious,
}

impl fmt::Display for TrustRequirement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Trusted => write!(f, "trusted"),
            Self::NotSuspicious => write!(f, "not-suspicious"),
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
    pub trust: Option<TrustRequirement>,
    pub audience: AudienceRule,
    pub attention: AttentionRule,
    /// Effects that must not already have happened in the context.
    pub forbid_prior_effects: BTreeSet<Effect>,
}

/// A requirement that is provably not met.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Breach {
    TrustBelow {
        required: TrustRequirement,
        actual: Trust,
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
            Self::ConfirmationForOtherTool {
                confirmed,
                requested,
            } => write!(f, "confirmation was for `{confirmed}`, not `{requested}`"),
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
                write!(f, "context trust unknown, cannot prove it is trusted")
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
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Breach(b) => write!(f, "breach: {b}"),
            Self::Unprovable(u) => write!(f, "unprovable: {u}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Escalate(Vec<Violation>),
}

/// A tool's annotation: what it demands of the context, and the label its
/// results wear.
///
/// The output label is per-result provenance only; taint from the context the
/// call was made in propagates through the trajectory fold, not through here.
/// An output label must not carry [`Attention::High`]: a tool result is not a
/// user confirmation, and a contract that re-arms an explicit-confirmation
/// gate from its own output would defeat that gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolContract {
    pub name: ToolName,
    pub requires: Requirements,
    pub output_label: Label,
}

impl ToolContract {
    pub fn check(&self, context: &Label, request: &FlowRequest) -> Verdict {
        self.requires.check(context, request)
    }
}

impl Requirements {
    pub fn check(&self, context: &Label, request: &FlowRequest) -> Verdict {
        let mut violations = Vec::new();

        if let Some(required) = self.trust {
            match (required, context.trust) {
                (_, Trust::Trusted) | (TrustRequirement::NotSuspicious, Trust::Unknown) => {}
                (TrustRequirement::Trusted, Trust::Unknown) => {
                    violations.push(Violation::Unprovable(Unprovable::TrustUnknown));
                }
                (_, Trust::Suspicious) => {
                    violations.push(Violation::Breach(Breach::TrustBelow {
                        required,
                        actual: Trust::Suspicious,
                    }));
                }
            }
        }

        match self.audience {
            AudienceRule::Unrestricted => {}
            AudienceRule::RecipientsWithinContext => {
                if request.recipients.is_empty() {
                    violations.push(Violation::Breach(Breach::UndeclaredRecipients));
                } else {
                    match &context.audience {
                        Audience::Unknown => {
                            violations.push(Violation::Unprovable(Unprovable::AudienceUnknown));
                        }
                        Audience::Public => {}
                        Audience::Readers(allowed) => {
                            let outside: BTreeSet<UserId> =
                                request.recipients.difference(allowed).cloned().collect();
                            if !outside.is_empty() {
                                violations
                                    .push(Violation::Breach(Breach::AudienceExceeds { outside }));
                            }
                        }
                    }
                }
            }
        }

        match (self.attention, &context.attention) {
            (AttentionRule::NotRequired, _) => {}
            (AttentionRule::ExplicitConfirmation, Attention::High(confirmed))
                if *confirmed == request.tool => {}
            (AttentionRule::ExplicitConfirmation, Attention::High(confirmed)) => {
                violations.push(Violation::Breach(Breach::ConfirmationForOtherTool {
                    confirmed: confirmed.clone(),
                    requested: request.tool.clone(),
                }));
            }
            (AttentionRule::ExplicitConfirmation, Attention::Regular) => {
                violations.push(Violation::Breach(Breach::ConfirmationMissing {
                    tool: request.tool.clone(),
                }));
            }
        }

        if !self.forbid_prior_effects.is_empty() {
            match &context.effects {
                Effects::Unknown => {
                    violations.push(Violation::Unprovable(Unprovable::EffectsUnknown));
                }
                Effects::Declared(present) => {
                    let hit: BTreeSet<Effect> = self
                        .forbid_prior_effects
                        .intersection(present)
                        .copied()
                        .collect();
                    if !hit.is_empty() {
                        violations.push(Violation::Breach(Breach::ForbiddenPriorEffects {
                            effects: hit,
                        }));
                    }
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

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    fn email_requirements() -> Requirements {
        Requirements {
            trust: Some(TrustRequirement::Trusted),
            audience: AudienceRule::RecipientsWithinContext,
            ..Requirements::default()
        }
    }

    fn private_trusted_context() -> Label {
        Label {
            audience: Audience::readers([user("alice"), user("bob")]),
            trust: Trust::Trusted,
            ..Label::identity()
        }
    }

    #[test]
    fn all_requirements_met_allows() {
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert_eq!(
            email_requirements().check(&private_trusted_context(), &request),
            Verdict::Allow
        );
    }

    #[test]
    fn suspicious_context_is_a_breach_but_unknown_is_unprovable() {
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);

        let suspicious = Label {
            trust: Trust::Suspicious,
            ..private_trusted_context()
        };
        assert_eq!(
            email_requirements().check(&suspicious, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::TrustBelow {
                required: TrustRequirement::Trusted,
                actual: Trust::Suspicious,
            })])
        );

        let unknown = Label {
            trust: Trust::Unknown,
            ..private_trusted_context()
        };
        assert_eq!(
            email_requirements().check(&unknown, &request),
            Verdict::Escalate(vec![Violation::Unprovable(Unprovable::TrustUnknown)])
        );
    }

    #[test]
    fn not_suspicious_floor_is_explicitly_lenient_about_unknown() {
        let requirements = Requirements {
            trust: Some(TrustRequirement::NotSuspicious),
            ..Requirements::default()
        };
        let request = FlowRequest::new(ToolName::new("notes.append"));

        let unknown = Label {
            trust: Trust::Unknown,
            ..Label::identity()
        };
        assert_eq!(requirements.check(&unknown, &request), Verdict::Allow);

        let suspicious = Label {
            trust: Trust::Suspicious,
            ..Label::identity()
        };
        assert_eq!(
            requirements.check(&suspicious, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::TrustBelow {
                required: TrustRequirement::NotSuspicious,
                actual: Trust::Suspicious,
            })])
        );
    }

    #[test]
    fn recipient_outside_audience_reports_the_diff() {
        let request =
            FlowRequest::exposing(ToolName::new("email.send"), [user("bob"), user("charlie")]);
        assert_eq!(
            email_requirements().check(&private_trusted_context(), &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::AudienceExceeds {
                outside: BTreeSet::from([user("charlie")]),
            })])
        );
    }

    #[test]
    fn egress_without_recipients_is_a_breach() {
        let none_declared = FlowRequest::new(ToolName::new("email.send"));
        assert_eq!(
            email_requirements().check(&private_trusted_context(), &none_declared),
            Verdict::Escalate(vec![Violation::Breach(Breach::UndeclaredRecipients)])
        );
    }

    #[test]
    fn unknown_audience_cannot_bound_recipients() {
        let context = Label {
            audience: Audience::Unknown,
            ..private_trusted_context()
        };
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert_eq!(
            email_requirements().check(&context, &request),
            Verdict::Escalate(vec![Violation::Unprovable(Unprovable::AudienceUnknown)])
        );
    }

    #[test]
    fn public_context_allows_any_recipient() {
        let context = Label {
            audience: Audience::Public,
            ..private_trusted_context()
        };
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("stranger")]);
        assert_eq!(
            email_requirements().check(&context, &request),
            Verdict::Allow
        );
    }

    #[test]
    fn confirmation_must_name_the_requested_tool() {
        let requirements = Requirements {
            attention: AttentionRule::ExplicitConfirmation,
            ..Requirements::default()
        };
        let request = FlowRequest::new(ToolName::new("db.drop"));

        let unconfirmed = Label::identity();
        assert_eq!(
            requirements.check(&unconfirmed, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::ConfirmationMissing {
                tool: ToolName::new("db.drop"),
            })])
        );

        let confirmed_other = Label {
            attention: Attention::High(ToolName::new("email.send")),
            ..Label::identity()
        };
        assert_eq!(
            requirements.check(&confirmed_other, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::ConfirmationForOtherTool {
                confirmed: ToolName::new("email.send"),
                requested: ToolName::new("db.drop"),
            })])
        );

        let confirmed = Label {
            attention: Attention::High(ToolName::new("db.drop")),
            ..Label::identity()
        };
        assert_eq!(requirements.check(&confirmed, &request), Verdict::Allow);
    }

    #[test]
    fn forbidden_prior_effects_are_enforced() {
        let requirements = Requirements {
            forbid_prior_effects: BTreeSet::from([Effect::Mutation]),
            ..Requirements::default()
        };
        let request = FlowRequest::new(ToolName::new("report.generate"));

        let mutated = Label {
            effects: Effects::declared([Effect::Mutation, Effect::Egress]),
            ..Label::identity()
        };
        assert_eq!(
            requirements.check(&mutated, &request),
            Verdict::Escalate(vec![Violation::Breach(Breach::ForbiddenPriorEffects {
                effects: BTreeSet::from([Effect::Mutation]),
            })])
        );

        let unknown = Label {
            effects: Effects::Unknown,
            ..Label::identity()
        };
        assert_eq!(
            requirements.check(&unknown, &request),
            Verdict::Escalate(vec![Violation::Unprovable(Unprovable::EffectsUnknown)])
        );

        assert_eq!(
            requirements.check(&Label::identity(), &request),
            Verdict::Allow
        );
    }
}
