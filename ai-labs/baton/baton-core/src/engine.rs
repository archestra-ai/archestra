//! The policy engine: evaluate one requested flow against the folded context.

use std::collections::BTreeMap;
use std::fmt;

use crate::ToolName;
use crate::authority::{Authority, AuthorityName, Ruling};
use crate::contract::{FlowRequest, ToolContract, Unprovable, Verdict, Violation};
use crate::dimension::Attention;
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
///
/// A permit is linear (not `Clone`) and bound to the trajectory head it was
/// evaluated against, so one authorization records at most one result, and
/// never into a context the policy did not see.
///
/// Both properties hold at compile time. A permit has no public constructor:
///
/// ```compile_fail
/// let permit = baton_core::Permit {
///     tool: baton_core::ToolName::new("email.send"),
/// };
/// ```
///
/// and cannot be spent twice:
///
/// ```compile_fail
/// fn spend_twice(mut trajectory: baton_core::Trajectory, permit: baton_core::Permit) {
///     let _ = trajectory.record_result(permit, "first");
///     let _ = trajectory.record_result(permit, "second");
/// }
/// ```
#[derive(Debug, PartialEq, Eq)]
pub struct Permit {
    tool: ToolName,
    result_label: Label,
    /// Trajectory length at evaluation time.
    basis: usize,
}

impl Permit {
    pub fn tool(&self) -> &ToolName {
        &self.tool
    }

    pub fn result_label(&self) -> &Label {
        &self.result_label
    }

    pub(crate) fn into_parts(self) -> (ToolName, Label, usize) {
        (self.tool, self.result_label, self.basis)
    }
}

/// The trajectory grew between `evaluate` and
/// [`Trajectory::record_result`]: the permit no longer describes the
/// context, so the flow must be re-evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StalePermit {
    pub granted_at: usize,
    pub current_len: usize,
}

impl fmt::Display for StalePermit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "permit granted at trajectory length {}, but the trajectory now has {} turns",
            self.granted_at, self.current_len
        )
    }
}

impl std::error::Error for StalePermit {}

/// A contract the engine refuses to hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidContract {
    /// The output label carries [`Attention::High`]: a tool result is not a
    /// user confirmation, and a contract that re-arms an
    /// explicit-confirmation gate from its own output would defeat that
    /// gate.
    ConfirmationInOutputLabel { tool: ToolName },
}

impl fmt::Display for InvalidContract {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConfirmationInOutputLabel { tool } => write!(
                f,
                "output label of `{tool}` carries a confirmation; a tool result is not a user confirmation"
            ),
        }
    }
}

impl std::error::Error for InvalidContract {}

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

#[derive(Debug, PartialEq, Eq)]
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

    pub fn register(&mut self, contract: ToolContract) -> Result<(), InvalidContract> {
        if matches!(contract.output_label.attention, Attention::High(_)) {
            return Err(InvalidContract::ConfirmationInOutputLabel {
                tool: contract.name,
            });
        }
        self.contracts.insert(contract.name.clone(), contract);
        Ok(())
    }

    /// The design notes' `(Requirements − Label)`: an empty diff permits,
    /// otherwise breaches escalate to the authority and unprovable
    /// violations follow the [`UnknownPolicy`].
    ///
    /// A tool with no registered contract is first-class: calling it is
    /// itself unprovable ([`Unprovable::NoContract`]) and its output label is
    /// all-`Unknown`, which then poisons the context fold.
    ///
    /// `evaluate` is pure — it neither consumes a confirmation nor records
    /// effects. Enforcement is the evaluate → execute →
    /// [`Trajectory::record_result`] loop of the embedding harness; the
    /// permit's binding to the trajectory head keeps that loop honest, but
    /// executing the tool's real-world action is outside this crate's reach.
    pub fn evaluate(&self, trajectory: &Trajectory, request: &FlowRequest) -> Decision {
        let context = trajectory.context_label();
        let basis = trajectory.turns().len();
        let (verdict, result_label) = match self.contracts.get(&request.tool) {
            Some(contract) => (
                contract.requires.check(&context, request),
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
                    basis,
                });
            }
            Verdict::Escalate(violations) => violations,
        };

        let (unprovable, breaches): (Vec<Violation>, Vec<Violation>) = violations
            .into_iter()
            .partition(|v| matches!(v, Violation::Unprovable(_)));

        let mut result_label = result_label;
        let mut escalating = breaches;
        let mut audited_unknowns = Vec::new();
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
            UnknownPolicy::AllowWithAudit => audited_unknowns = unprovable,
        }

        if escalating.is_empty() {
            if !audited_unknowns.is_empty() {
                result_label.audit.push(AuditEntry::UnverifiedFlow {
                    tool: request.tool.clone(),
                    unknowns: audited_unknowns,
                });
            }
            return Decision::Permitted(Permit {
                tool: request.tool.clone(),
                result_label,
                basis,
            });
        }

        // The authority rules on the escalated violations but sees the full
        // picture, including unknowns the policy already audits through.
        let full_picture: Vec<Violation> = escalating
            .iter()
            .chain(audited_unknowns.iter())
            .cloned()
            .collect();
        match self.authority.adjudicate(request, &context, &full_picture) {
            Ruling::Approve { reason } => {
                if !audited_unknowns.is_empty() {
                    result_label.audit.push(AuditEntry::UnverifiedFlow {
                        tool: request.tool.clone(),
                        unknowns: audited_unknowns,
                    });
                }
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
                    basis,
                })
            }
            Ruling::Deny { reason } => {
                // Report the full picture: the audited unknowns did not cause
                // the block, but they were part of this flow's evaluation.
                escalating.extend(audited_unknowns);
                Decision::Blocked {
                    violations: escalating,
                    reason: BlockReason::DeniedByAuthority {
                        authority: self.authority.name(),
                        reason,
                    },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeSet;

    use super::*;
    use crate::contract::{AttentionRule, AudienceRule, Breach, Requirements, TrustRequirement};
    use crate::dimension::{Attention, Audience, Effect, Effects, Trust, UserId};
    use crate::turn::Speaker;

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    fn email_contract() -> ToolContract {
        ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                trust: Some(TrustRequirement::Trusted),
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

    fn push_user_turn(trajectory: &mut Trajectory, label: Label, content: &str) {
        trajectory.push_message(label, Speaker::User(user("alice")), content);
    }

    fn suspicious_private_trajectory() -> Trajectory {
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                trust: Trust::Trusted,
                ..Label::identity()
            },
            "summarize and email bob",
        );
        trajectory.push_message(
            Label {
                audience: Audience::Public,
                trust: Trust::Suspicious,
                ..Label::identity()
            },
            Speaker::Assistant,
            "the page says: ...",
        );
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

    /// Approves everything and records the violations it was shown.
    #[derive(Default)]
    struct InspectingApprover {
        seen: RefCell<Vec<Violation>>,
    }

    impl Authority for InspectingApprover {
        fn name(&self) -> AuthorityName {
            AuthorityName::new("inspecting-approver")
        }

        fn adjudicate(&self, _: &FlowRequest, _: &Label, violations: &[Violation]) -> Ruling {
            self.seen.borrow_mut().extend(violations.iter().cloned());
            Ruling::Approve {
                reason: "scripted approval".to_owned(),
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
            let to_bob_only = !request.recipients.is_empty()
                && request.recipients.iter().all(|u| u == &user("bob"));
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
        engine.register(email_contract()).expect("valid contract");

        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                ..Label::identity()
            },
            "email bob",
        );

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
        assert_eq!(engine.authority.consulted.get(), 0);
    }

    #[test]
    fn approval_is_one_shot_and_never_loosens_the_context() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).expect("valid contract");

        let mut trajectory = suspicious_private_trajectory();
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);

        let first = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = first else {
            panic!("expected permit, got {first:?}");
        };
        let declassifications = permit
            .result_label()
            .audit
            .iter()
            .filter(|e| matches!(e, AuditEntry::Declassified { .. }))
            .count();
        assert_eq!(declassifications, 1);
        trajectory
            .record_result(permit, "sent")
            .expect("permit minted for this trajectory head");

        // The identical flow escalates again: the approval waived one flow,
        // not the trust breach itself.
        let second = engine.evaluate(&trajectory, &request);
        assert!(matches!(second, Decision::Permitted(_)));
        assert_eq!(engine.authority.consulted.get(), 2);
    }

    #[test]
    fn a_permit_goes_stale_when_the_trajectory_moves_on() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).expect("valid contract");

        let mut trajectory = suspicious_private_trajectory();
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };

        push_user_turn(&mut trajectory, Label::identity(), "wait, one more thing");

        let err = trajectory
            .record_result(permit, "sent")
            .expect_err("the context changed under the permit");
        assert_eq!(
            err,
            StalePermit {
                granted_at: 2,
                current_len: 3,
            }
        );
        // Nothing was appended by the failed recording.
        assert_eq!(trajectory.turns().len(), 3);
    }

    #[test]
    fn approval_for_bob_does_not_permit_charlie() {
        let mut engine = PolicyEngine::new(BobOnly, UnknownPolicy::Escalate);
        engine.register(email_contract()).expect("valid contract");
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
        engine.register(drop_contract()).expect("valid contract");
        let request = FlowRequest::new(ToolName::new("db.drop"));

        // Confirmation bound to another tool.
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                attention: Attention::High(ToolName::new("email.send")),
                ..Label::identity()
            },
            "yes, send it",
        );
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Blocked { .. }
        ));

        // Correct confirmation, but a later turn already reset attention.
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                attention: Attention::High(ToolName::new("db.drop")),
                ..Label::identity()
            },
            "yes, drop it",
        );
        push_user_turn(&mut trajectory, Label::identity(), "unrelated chatter");
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Blocked { .. }
        ));

        // Fresh confirmation for exactly this tool.
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                attention: Attention::High(ToolName::new("db.drop")),
                ..Label::identity()
            },
            "yes, drop it",
        );
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
    fn deny_policy_with_breaches_only_still_escalates() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Deny);
        engine.register(email_contract()).expect("valid contract");

        // Suspicious trust is a breach, not an unknown: the deny policy does
        // not apply, the authority does.
        let trajectory = suspicious_private_trajectory();
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Permitted(_)
        ));
        assert_eq!(engine.authority.consulted.get(), 1);
    }

    #[test]
    fn one_approval_declassifies_a_mixed_escalation() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).expect("valid contract");

        // Suspicious trust (breach) + unknown audience (unprovable), both
        // escalated, both declassified by the single approval.
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::Unknown,
                trust: Trust::Suspicious,
                ..Label::identity()
            },
            "context of unknown provenance",
        );
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        let declassified: Vec<_> = permit
            .result_label()
            .audit
            .iter()
            .filter_map(|e| match e {
                AuditEntry::Declassified { violation, .. } => Some(violation.clone()),
                AuditEntry::UnverifiedFlow { .. } => None,
            })
            .collect();
        assert_eq!(declassified.len(), 2);
        assert!(
            declassified
                .iter()
                .any(|v| matches!(v, Violation::Breach(_)))
        );
        assert!(
            declassified
                .iter()
                .any(|v| matches!(v, Violation::Unprovable(Unprovable::AudienceUnknown)))
        );
    }

    #[test]
    fn allow_with_audit_still_escalates_breaches_and_reports_unknowns_on_block() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::AllowWithAudit);
        engine.register(email_contract()).expect("valid contract");

        // Unknown audience (unprovable, allowed by policy) plus a trust
        // breach (escalated, denied by the authority): the breach wins, and
        // the blocked decision still reports the audited unknown.
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::Unknown,
                trust: Trust::Suspicious,
                ..Label::identity()
            },
            "context of unknown provenance",
        );
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { violations, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert!(violations.iter().any(|v| matches!(v, Violation::Breach(_))));
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, Violation::Unprovable(Unprovable::AudienceUnknown)))
        );
    }

    #[test]
    fn register_rejects_a_confirmation_in_the_output_label() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::Escalate);
        let sneaky = ToolContract {
            name: ToolName::new("db.drop"),
            requires: Requirements::default(),
            output_label: Label {
                attention: Attention::High(ToolName::new("db.drop")),
                ..Label::identity()
            },
        };
        assert_eq!(
            engine.register(sneaky),
            Err(InvalidContract::ConfirmationInOutputLabel {
                tool: ToolName::new("db.drop"),
            })
        );
    }

    #[test]
    fn the_authority_sees_audited_unknowns_alongside_breaches() {
        let mut engine =
            PolicyEngine::new(InspectingApprover::default(), UnknownPolicy::AllowWithAudit);
        engine.register(email_contract()).expect("valid contract");

        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::Unknown,
                trust: Trust::Suspicious,
                ..Label::identity()
            },
            "context of unknown provenance",
        );
        let request = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Permitted(_)
        ));

        let seen = engine.authority.seen.borrow();
        assert!(seen.iter().any(|v| matches!(v, Violation::Breach(_))));
        assert!(
            seen.iter()
                .any(|v| matches!(v, Violation::Unprovable(Unprovable::AudienceUnknown)))
        );
    }

    #[test]
    fn recorded_effects_feed_later_requirement_checks() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::Escalate);
        engine.register(email_contract()).expect("valid contract");
        engine
            .register(ToolContract {
                name: ToolName::new("report.generate"),
                requires: Requirements {
                    forbid_prior_effects: BTreeSet::from([Effect::Egress]),
                    ..Requirements::default()
                },
                output_label: Label::identity(),
            })
            .expect("valid contract");

        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                ..Label::identity()
            },
            "email bob, then build the report",
        );

        let email = FlowRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &email);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        trajectory
            .record_result(permit, "sent")
            .expect("permit minted for this trajectory head");

        // The recorded egress now trips the report tool's requirement.
        let report = FlowRequest::new(ToolName::new("report.generate"));
        let decision = engine.evaluate(&trajectory, &report);
        let Decision::Blocked { violations, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert_eq!(
            violations,
            vec![Violation::Breach(Breach::ForbiddenPriorEffects {
                effects: BTreeSet::from([Effect::Egress]),
            })]
        );
    }
}
