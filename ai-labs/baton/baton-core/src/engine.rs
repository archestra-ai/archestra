//! The policy engine: evaluate one requested flow against the folded context.

use std::collections::BTreeMap;
use std::fmt;

use crate::ToolName;
use crate::authority::{Authority, AuthorityName, Ruling};
use crate::contract::{FlowRequest, ToolContract, Unprovable, Verdict, Violation};
use crate::label::{AuditEntry, Label};
use crate::turn::Trajectory;

/// What an unprovable (`Unknown`-caused) violation means at a sink.
///
/// This is the gradual-adoption knob: annotate a handful of high-risk tools,
/// leave the rest unknown, and choose how loudly the gaps fail — without
/// pretending the whole system is formally safe.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UnknownPolicy {
    /// Treat unprovable violations like breaches: the authority decides.
    #[default]
    Escalate,
    /// Fail closed.
    Deny,
    /// Let the flow through, recording an [`AuditEntry::UnverifiedFlow`] on
    /// the result label.
    AllowWithAudit,
}

/// Proof that the engine authorized one tool call — the only way to append a
/// tool result to a [`Trajectory`]. Carries the label the result must wear,
/// including any audit entries the authorization produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permit {
    tool: ToolName,
    result_label: Label,
}

impl Permit {
    pub fn tool(&self) -> &ToolName {
        &self.tool
    }

    pub fn result_label(&self) -> &Label {
        &self.result_label
    }

    pub(crate) fn into_parts(self) -> (ToolName, Label) {
        (self.tool, self.result_label)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockReason {
    DeniedByAuthority {
        authority: AuthorityName,
        reason: String,
    },
    /// [`UnknownPolicy::Deny`] and at least one requirement was unprovable.
    UnknownDenied,
}

impl fmt::Display for BlockReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DeniedByAuthority { authority, reason } => {
                write!(f, "denied by {authority}: {reason}")
            }
            Self::UnknownDenied => write!(f, "unknown-policy is deny and the flow is unprovable"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Permitted(Permit),
    Blocked {
        violations: Vec<Violation>,
        reason: BlockReason,
    },
}

/// Holds the tool contracts, the unknown policy, and the escalation channel.
///
/// `evaluate` never mutates the trajectory: an approval is a one-shot
/// exception carried on the [`Permit`]'s result label, so the same violation
/// in a later flow escalates again.
pub struct PolicyEngine<A: Authority> {
    contracts: BTreeMap<ToolName, ToolContract>,
    unknown_policy: UnknownPolicy,
    authority: A,
}

impl<A: Authority> PolicyEngine<A> {
    pub fn new(authority: A, unknown_policy: UnknownPolicy) -> Self {
        Self {
            contracts: BTreeMap::new(),
            unknown_policy,
            authority,
        }
    }

    pub fn register(&mut self, contract: ToolContract) {
        self.contracts.insert(contract.name.clone(), contract);
    }

    /// The design notes' `(Requirements − Label)`: an empty diff permits,
    /// otherwise breaches escalate to the authority and unprovable
    /// violations follow the [`UnknownPolicy`].
    ///
    /// A tool with no registered contract is first-class: calling it is
    /// itself unprovable ([`Unprovable::NoContract`]) and its output label is
    /// all-`Unknown`, which then poisons the context fold.
    pub fn evaluate(&self, trajectory: &Trajectory, request: &FlowRequest) -> Decision {
        let context = trajectory.context_label();
        let (verdict, result_label) = match self.contracts.get(&request.tool) {
            Some(contract) => (
                contract.check(&context, request),
                contract.output_label.clone(),
            ),
            None => (
                Verdict::Escalate(vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: request.tool.clone(),
                })]),
                Label::unknown(),
            ),
        };

        let violations = match verdict {
            Verdict::Allow => {
                return Decision::Permitted(Permit {
                    tool: request.tool.clone(),
                    result_label,
                });
            }
            Verdict::Escalate(violations) => violations,
        };

        let (unprovable, breaches): (Vec<Violation>, Vec<Violation>) = violations
            .into_iter()
            .partition(|v| matches!(v, Violation::Unprovable(_)));

        let mut result_label = result_label;
        let mut escalating = breaches;
        match self.unknown_policy {
            UnknownPolicy::Escalate => escalating.extend(unprovable),
            UnknownPolicy::Deny => {
                if !unprovable.is_empty() {
                    escalating.extend(unprovable);
                    return Decision::Blocked {
                        violations: escalating,
                        reason: BlockReason::UnknownDenied,
                    };
                }
            }
            UnknownPolicy::AllowWithAudit => {
                if !unprovable.is_empty() {
                    result_label.audit.push(AuditEntry::UnverifiedFlow {
                        tool: request.tool.clone(),
                        unknowns: unprovable,
                    });
                }
            }
        }

        if escalating.is_empty() {
            return Decision::Permitted(Permit {
                tool: request.tool.clone(),
                result_label,
            });
        }

        match self.authority.adjudicate(request, &context, &escalating) {
            Ruling::Approve { reason } => {
                let authority = self.authority.name();
                for violation in escalating {
                    result_label.audit.push(AuditEntry::Declassified {
                        violation,
                        authority: authority.clone(),
                        reason: reason.clone(),
                    });
                }
                Decision::Permitted(Permit {
                    tool: request.tool.clone(),
                    result_label,
                })
            }
            Ruling::Deny { reason } => Decision::Blocked {
                violations: escalating,
                reason: BlockReason::DeniedByAuthority {
                    authority: self.authority.name(),
                    reason,
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::BTreeSet;

    use super::*;
    use crate::contract::{AttentionRule, AudienceRule, Breach, Requirements};
    use crate::dimension::{Attention, Audience, Effect, Effects, Trust, UserId};
    use crate::turn::{Actor, LabeledTurn, Turn};

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    fn email_contract() -> ToolContract {
        ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                min_trust: Some(Trust::Trusted),
                audience: AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: Label {
                effects: Effects::declared([Effect::Egress]),
                ..Label::identity()
            },
        }
    }

    fn drop_contract() -> ToolContract {
        ToolContract {
            name: ToolName::new("db.drop"),
            requires: Requirements {
                attention: AttentionRule::ExplicitConfirmation,
                ..Requirements::default()
            },
            output_label: Label {
                effects: Effects::declared([Effect::Mutation]),
                ..Label::identity()
            },
        }
    }

    fn user_turn(label: Label, content: &str) -> LabeledTurn {
        LabeledTurn {
            label,
            turn: Turn {
                actor: Actor::User(user("alice")),
                content: content.to_owned(),
            },
        }
    }

    fn suspicious_private_trajectory() -> Trajectory {
        let mut trajectory = Trajectory::new();
        trajectory.push(user_turn(
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                trust: Trust::Trusted,
                ..Label::identity()
            },
            "summarize and email bob",
        ));
        trajectory.push(LabeledTurn {
            label: Label {
                audience: Audience::Public,
                trust: Trust::Suspicious,
                ..Label::identity()
            },
            turn: Turn {
                actor: Actor::Tool(ToolName::new("web.fetch")),
                content: "<html>".to_owned(),
            },
        });
        trajectory
    }

    /// Approves everything and counts how often it was consulted.
    struct CountingApprover {
        consulted: Cell<usize>,
    }

    impl CountingApprover {
        fn new() -> Self {
            Self {
                consulted: Cell::new(0),
            }
        }
    }

    impl Authority for CountingApprover {
        fn name(&self) -> AuthorityName {
            AuthorityName::new("counting-approver")
        }

        fn adjudicate(&self, _: &FlowRequest, _: &Label, _: &[Violation]) -> Ruling {
            self.consulted.set(self.consulted.get() + 1);
            Ruling::Approve {
                reason: "scripted approval".to_owned(),
            }
        }
    }

    struct DenyAll;

    impl Authority for DenyAll {
        fn name(&self) -> AuthorityName {
            AuthorityName::new("deny-all")
        }

        fn adjudicate(&self, _: &FlowRequest, _: &Label, _: &[Violation]) -> Ruling {
            Ruling::Deny {
                reason: "scripted denial".to_owned(),
            }
        }
    }

    /// Approves only flows whose every recipient is `bob`.
    struct BobOnly;

    impl Authority for BobOnly {
        fn name(&self) -> AuthorityName {
            AuthorityName::new("bob-only")
        }

        fn adjudicate(&self, request: &FlowRequest, _: &Label, _: &[Violation]) -> Ruling {
            let to_bob_only = request
                .exposes_to
                .as_ref()
                .is_some_and(|r| !r.is_empty() && r.iter().all(|u| u == &user("bob")));
            if to_bob_only {
                Ruling::Approve {
                    reason: "reviewed for bob".to_owned(),
                }
            } else {
                Ruling::Deny {
                    reason: "only bob was reviewed".to_owned(),
                }
            }
        }
    }

    #[test]
    fn clean_flow_is_permitted_without_the_authority() {
        let counting = CountingApprover::new();
        let mut engine = PolicyEngine::new(counting, UnknownPolicy::Escalate);
        engine.register(email_contract());

        let mut trajectory = Trajectory::new();
        trajectory.push(user_turn(
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                ..Label::identity()
            },
            "email bob",
        ));

        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert_eq!(
            permit.result_label().effects,
            Effects::declared([Effect::Egress])
        );
        assert!(permit.result_label().audit.is_empty());
    }

    #[test]
    fn approval_is_one_shot_and_never_loosens_the_context() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract());

        let mut trajectory = suspicious_private_trajectory();
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);

        let first = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = first else {
            panic!("expected permit, got {first:?}");
        };
        let declassifications: Vec<_> = permit
            .result_label()
            .audit
            .iter()
            .filter(|e| matches!(e, AuditEntry::Declassified { .. }))
            .collect();
        assert_eq!(declassifications.len(), 1);
        trajectory.record_result(permit, "sent");

        // The identical flow escalates again: the approval waived one flow,
        // not the trust breach itself.
        let second = engine.evaluate(&trajectory, &request);
        assert!(matches!(second, Decision::Permitted(_)));
        assert_eq!(engine.authority.consulted.get(), 2);
    }

    #[test]
    fn approval_for_bob_does_not_permit_charlie() {
        let mut engine = PolicyEngine::new(BobOnly, UnknownPolicy::Escalate);
        engine.register(email_contract());
        let trajectory = suspicious_private_trajectory();

        let to_bob = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert!(matches!(
            engine.evaluate(&trajectory, &to_bob),
            Decision::Permitted(_)
        ));

        let to_charlie = FlowRequest::exposing(ToolName::new("email.send"), [user("charlie")]);
        let decision = engine.evaluate(&trajectory, &to_charlie);
        let Decision::Blocked { violations, reason } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert!(violations.iter().any(|v| matches!(
            v,
            Violation::Breach(Breach::AudienceExceeds { outside })
                if outside == &BTreeSet::from([user("charlie")])
        )));
        assert!(matches!(reason, BlockReason::DeniedByAuthority { .. }));
    }

    #[test]
    fn stale_or_foreign_confirmation_cannot_authorize_a_drop() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::Escalate);
        engine.register(drop_contract());
        let request = FlowRequest::new(ToolName::new("db.drop"));

        // Confirmation bound to another tool.
        let mut trajectory = Trajectory::new();
        trajectory.push(user_turn(
            Label {
                attention: Attention::High(ToolName::new("email.send")),
                ..Label::identity()
            },
            "yes, send it",
        ));
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Blocked { .. }
        ));

        // Correct confirmation, but a later turn already reset attention.
        let mut trajectory = Trajectory::new();
        trajectory.push(user_turn(
            Label {
                attention: Attention::High(ToolName::new("db.drop")),
                ..Label::identity()
            },
            "yes, drop it",
        ));
        trajectory.push(user_turn(Label::identity(), "unrelated chatter"));
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Blocked { .. }
        ));

        // Fresh confirmation for exactly this tool.
        let mut trajectory = Trajectory::new();
        trajectory.push(user_turn(
            Label {
                attention: Attention::High(ToolName::new("db.drop")),
                ..Label::identity()
            },
            "yes, drop it",
        ));
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert_eq!(
            permit.result_label().effects,
            Effects::declared([Effect::Mutation])
        );
    }

    #[test]
    fn unregistered_tool_follows_the_unknown_policy() {
        let request = FlowRequest::new(ToolName::new("calendar.lookup"));
        let trajectory = Trajectory::new();

        // Deny: fail closed without consulting the authority.
        let counting = CountingApprover::new();
        let engine = PolicyEngine::new(counting, UnknownPolicy::Deny);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { violations, reason } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert_eq!(reason, BlockReason::UnknownDenied);
        assert_eq!(
            violations,
            vec![Violation::Unprovable(Unprovable::NoContract {
                tool: ToolName::new("calendar.lookup"),
            })]
        );
        assert_eq!(engine.authority.consulted.get(), 0);

        // Escalate: the authority decides.
        let engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Permitted(_)
        ));
        assert_eq!(engine.authority.consulted.get(), 1);

        // AllowWithAudit: permitted without the authority, but on the record,
        // and the result label is all-unknown.
        let engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::AllowWithAudit);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert_eq!(engine.authority.consulted.get(), 0);
        assert_eq!(permit.result_label().audience, Audience::Unknown);
        assert_eq!(permit.result_label().trust, Trust::Unknown);
        assert_eq!(permit.result_label().effects, Effects::Unknown);
        assert_eq!(
            permit.result_label().audit,
            vec![AuditEntry::UnverifiedFlow {
                tool: ToolName::new("calendar.lookup"),
                unknowns: vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: ToolName::new("calendar.lookup"),
                })],
            }]
        );
    }

    #[test]
    fn allow_with_audit_still_escalates_breaches() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::AllowWithAudit);
        engine.register(email_contract());

        // Unknown audience (unprovable, allowed by policy) plus a trust
        // breach (escalated, denied by the authority): the breach wins.
        let mut trajectory = Trajectory::new();
        trajectory.push(user_turn(
            Label {
                audience: Audience::Unknown,
                trust: Trust::Suspicious,
                ..Label::identity()
            },
            "context of unknown provenance",
        ));
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { violations, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert!(violations.iter().all(|v| matches!(v, Violation::Breach(_))));
    }
}
