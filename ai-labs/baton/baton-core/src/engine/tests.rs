use std::collections::BTreeSet;

use super::application::RoutedRuling;
use super::capability::RESPONSE_SINK;
use super::planning::select_fair;
use super::*;
use crate::approval::{AuthorityMode, Ruling, TrajectoryView};
use crate::audit::{AuditEvent, AuthorityName};
use crate::contract::{Requirements, Unprovable, Violation};
use crate::dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
use crate::plan::{ExitKind, Justification, NonEmptyVec, Posture, RemedyPlan, TransitionKind, TransitionSpec};
use crate::request::{ArgumentName, ArgumentSchema, ArgumentTree, ResponseRequest, ToolRequest};
use crate::revision::{PlanId, ValueId};
use crate::turn::{Speaker, Trajectory};
use crate::value::{OpaqueValue, ValueLabel};

fn user(id: &str) -> UserId {
    UserId::new(id)
}

fn email_contract() -> ToolContract {
    ToolContract {
        name: ToolName::new("email.send"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress]),
        arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
    }
}

fn engine_with(contracts: impl IntoIterator<Item = ToolContract>) -> PolicyEngine {
    let mut engine = PolicyEngine::new();
    for contract in contracts {
        engine.register(contract).unwrap();
    }
    engine
}

/// Ingress a value readable by `readers` with the given trust.
fn ingress(trajectory: &mut Trajectory, readers: &[&str], trust: Trust, body: &str) -> ValueId {
    trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel {
            audience: Audience::readers(readers.iter().map(|r| user(r))),
            trust,
        },
        OpaqueValue::new(body),
    )
}

/// Test shorthand for the full dispatch boundary: release, then record.
fn dispatch(trajectory: &mut Trajectory, token: ExecutionToken, body: &str) -> Result<ValueId, RejectedToken> {
    let (_, receipt) = trajectory.release(token)?;
    trajectory.record_output(receipt, OpaqueValue::new(body))
}

/// Drive a blocked flow through its first-plan remedy steps to a permit —
/// for effect-axis tests that must genuinely acquire the growth (walk the
/// Accept) rather than pre-seed a downhill past.
fn walk_to_permit(engine: &PolicyEngine, trajectory: &mut Trajectory, request: ToolRequest) -> ExecutionToken {
    match engine.pursue(trajectory, request, 16) {
        Pursuit::Permitted(token) => token,
        other => panic!("expected to reach a permit, got {other:?}"),
    }
}

/// Ingress a value at the identity label (e.g. a recipient name) spoken by alice.
fn identity_ingress(trajectory: &mut Trajectory, body: &str) -> ValueId {
    trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::identity(),
        OpaqueValue::new(body),
    )
}

fn email_request(trajectory: &mut Trajectory, body: ValueId, recipient: &str) -> ToolRequest {
    let to = identity_ingress(trajectory, recipient);
    ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::new(),
    )
}

/// Evaluate a flow expected to block remediably and return its plans.
fn remediable(engine: &PolicyEngine, trajectory: &mut Trajectory, request: ToolRequest) -> NonEmptyVec<RemedyPlan> {
    match engine.evaluate(trajectory, request) {
        Decision::Blocked(Blocked::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    }
}

/// Mint and apply the first step of `plan`.
fn apply_first_step(engine: &PolicyEngine, trajectory: &mut Trajectory, plan: PlanId) -> StepOutcome {
    let capability = engine.mint_step(trajectory, plan, 0).unwrap();
    engine.apply_step(trajectory, capability).unwrap()
}

fn approve_all(
    _: &crate::transition::ProposedGrant,
    _: &[Violation],
    _: &crate::approval::TrajectoryView,
) -> Option<crate::approval::Ruling> {
    Some(Ruling::Approve {
        reason: "approved".to_owned(),
    })
}

fn abstain_all(
    _: &crate::transition::ProposedGrant,
    _: &[Violation],
    _: &crate::approval::TrajectoryView,
) -> Option<crate::approval::Ruling> {
    None
}

fn inline_authority(
    name: &str,
    mandate: crate::transition::AuthorityMandate,
    decide: crate::approval::AuthorityFn,
) -> Authority {
    Authority {
        name: AuthorityName::new(name),
        mandate,
        mode: AuthorityMode::Inline(decide),
    }
}

fn external_authority(name: &str, mandate: crate::transition::AuthorityMandate) -> Authority {
    Authority {
        name: AuthorityName::new(name),
        mandate,
        mode: AuthorityMode::External,
    }
}

#[test]
fn clean_flow_is_permitted_and_result_admitted_with_folded_label() {
    // The confidentiality flow is clean; the only obstacle is the first
    // egress growing the surface, so an acquirer walks it to a permit and
    // the egress genuinely commits at dispatch.
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "the doc");
    let request = email_request(&mut trajectory, body, "bob");

    let token = walk_to_permit(&engine, &mut trajectory, request);
    assert!(trajectory.pending_action().is_some());
    assert_eq!(trajectory.state().past_effects(), &Effects::none());
    // The permit came through acquisition, not a bypassed growth check.
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::AcceptApplied { .. }))
    );

    let result = dispatch(&mut trajectory, token, "sent").unwrap();
    assert!(trajectory.pending_action().is_none());
    // Output label folds intrinsic (identity) with the argument labels.
    assert_eq!(
        trajectory.value(result).unwrap().label().audience,
        Audience::readers([user("alice"), user("bob")])
    );
    // Effects were committed at dispatch, not before.
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
}

#[test]
fn explicit_flow_taint_blocks_the_sink() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw page");
    let request = email_request(&mut trajectory, body, "bob");

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::TrustBelow { .. })]
    ));
    assert!(trajectory.pending_action().is_none());
}

#[test]
fn control_dependence_taints_a_clean_payload() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
    let clean_body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "harmless");
    let to = identity_ingress(&mut trajectory, "bob");
    // The invocation was selected by something that read the secret:
    // whether this email happens leaks a bit even though the payload is
    // clean.
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(clean_body)),
        ])),
        BTreeSet::from([secret]),
    );

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::AudienceExceeds { outside })]
            if *outside == BTreeSet::from([user("bob")])
    ));
}

#[test]
fn unregistered_tool_blocks_without_an_acknowledge_authority() {
    let engine = engine_with([]);
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
    let request = ToolRequest::new(
        ToolName::new("mystery.tool"),
        ArgumentTree::Value(body),
        BTreeSet::new(),
    );

    // No implicit accept: an unprovable flow with no competent authority
    // has no remedy and blocks terminally (fail-closed default).
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

#[test]
fn unregistered_tool_acknowledged_dispatches_with_unknown_output() {
    // A no-contract call needs both competences: acquire its Unknown growth
    // and acknowledge the missing contract.
    let mut engine = engine_with([]);
    engine
        .register_authority(inline_authority(
            "accept-unknowns",
            crate::transition::AuthorityMandate {
                acknowledge_unknown: true,
                acquire_effects: true,
                ..crate::transition::AuthorityMandate::none()
            },
            approve_all,
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
    let request = ToolRequest::new(
        ToolName::new("mystery.tool"),
        ArgumentTree::Value(body),
        BTreeSet::new(),
    );

    // The unprovable, surface-growing flow routes through the chain: walking
    // it acquires the growth and acknowledges the missing contract.
    let token = walk_to_permit(&engine, &mut trajectory, request);
    assert!(trajectory.state().audit().iter().any(|e| matches!(
        e,
        AuditEvent::WaiverApplied { changes, .. } if changes.contains(&crate::audit::WaiverKind::Acknowledgment)
    )));
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::AcceptApplied { effects, .. } if *effects == Effects::UNKNOWN))
    );

    let result = dispatch(&mut trajectory, token, "???").unwrap();
    // Intrinsic unknown poisons the output despite trusted inputs...
    assert_eq!(trajectory.value(result).unwrap().label(), &ValueLabel::unknown());
    // ...and the unknown effect commits at dispatch, absorbing the past.
    assert_eq!(trajectory.state().past_effects(), &Effects::UNKNOWN);
}

/// A grant-fixable unprovable (unknown trust at a Trusted-requiring sink)
/// routes through the chain as a durable Endorse — trust is no longer
/// waivable, so an unknown-trust argument is raised by a relabel.
#[test]
fn unknown_trust_routes_as_an_endorse() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    // Unknown trust cannot prove the sink's `Trusted` requirement.
    let doc = ingress(&mut trajectory, &["alice", "bob"], Trust::UNKNOWN, "doc");
    let request = email_request(&mut trajectory, doc, "bob");

    let Decision::Blocked(Blocked::Remediable { violations, plans }) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected a remediable block");
    };
    assert!(
        violations
            .iter()
            .any(|v| matches!(v, Violation::Unprovable(crate::contract::Unprovable::TrustUnknown)))
    );
    // The residual routes to a durable Endorse raising the doc's trust to
    // the sink's requirement.
    assert!(matches!(
        &plans.first().steps.first().kind,
        TransitionKind::Derive { source, justification: Justification::Fiat { delta, .. } }
            if *source == doc && delta.trust == Some(KnownTrust::Trusted)
    ));
    // ...routed to the trust-competent external human.
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("expected the external human to be consulted");
    };
    assert_eq!(pending.authority().as_str(), "human");
}

#[test]
fn guarded_sink_without_recipients_is_structural() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([(
            ArgumentName::new("body"),
            ArgumentTree::Value(body),
        )])),
        BTreeSet::new(),
    );

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::RequiresStructuralFix);
}

#[test]
fn stale_token_is_rejected_after_any_mutation() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");

    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit");
    };
    // Any state change — here a value admission, not even a turn —
    // invalidates the token.
    trajectory
        .admit_model_output(OpaqueValue::new("thinking"), BTreeSet::from([body]), BTreeSet::new())
        .unwrap();

    let err = dispatch(&mut trajectory, token, "sent").unwrap_err();
    assert!(matches!(err, RejectedToken::Stale { .. }));
}

#[test]
fn foreign_trajectory_token_is_rejected() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");
    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit");
    };

    let mut other = Trajectory::new();
    let err = dispatch(&mut other, token, "sent").unwrap_err();
    assert!(matches!(err, RejectedToken::ForeignTrajectory { .. }));
}

#[test]
fn second_distinct_proposal_is_refused_until_abandoned() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let first = email_request(&mut trajectory, body, "bob");
    let second = ToolRequest::new(ToolName::new("email.send"), ArgumentTree::Value(body), BTreeSet::new());

    let Decision::Permitted(_token) = engine.evaluate(&mut trajectory, first.clone()) else {
        panic!("expected permit");
    };
    let pending = trajectory.pending_action().unwrap().id();

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, second.clone()) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::ActionAlreadyPending { pending });
    // The in-flight action is untouched by the refused proposal.
    assert_eq!(trajectory.pending_action().unwrap().id(), pending);

    trajectory.abandon_pending();
    assert!(trajectory.pending_action().is_none());
}

#[test]
fn re_entry_reuses_the_pending_action() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");

    let Decision::Permitted(first) = engine.evaluate(&mut trajectory, request.clone()) else {
        panic!("expected permit");
    };
    let Decision::Permitted(second) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit on re-entry");
    };
    assert_eq!(first.action(), second.action());

    // Both tokens are bound to the same revision; spending one consumes
    // the action and invalidates the other.
    dispatch(&mut trajectory, second, "sent").unwrap();
    let err = dispatch(&mut trajectory, first, "again").unwrap_err();
    assert!(matches!(err, RejectedToken::Stale { .. }));
}

#[test]
fn committed_effects_feed_later_checks() {
    let mut report = email_contract();
    report.name = ToolName::new("report.generate");
    report.requires = Some(Requirements {
        forbid_prior_effects: BTreeSet::from([Effect::Egress]),
        ..Requirements::default()
    });
    report.effects = Effects::none();
    report.arguments = ArgumentSchema::opaque();

    let mut engine = engine_with([email_contract(), report]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");

    // Acquire the egress and dispatch it: the commit is what the later sink
    // check must observe.
    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "sent").unwrap();

    let report_request = ToolRequest::new(
        ToolName::new("report.generate"),
        ArgumentTree::Value(body),
        BTreeSet::new(),
    );
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, report_request) else {
        panic!("expected terminal block");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::ForbiddenPriorEffects { .. })]
    ));
}

#[test]
fn duplicate_contract_is_refused() {
    let mut engine = PolicyEngine::new();
    engine.register(email_contract()).unwrap();
    assert_eq!(
        engine.register(email_contract()),
        Err(DuplicateContract {
            tool: ToolName::new("email.send")
        })
    );
}

#[test]
fn unknown_value_reference_blocks_loudly() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    let ghost = ValueId::new(1000);
    let request = ToolRequest::new(ToolName::new("email.send"), ArgumentTree::Value(ghost), BTreeSet::new());

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::UnknownValueReferenced { value: ghost });
}

#[test]
fn effects_survive_a_declared_dispatch_failure() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");

    let token = walk_to_permit(&engine, &mut trajectory, request);
    let (canonical, receipt) = trajectory.release(token).unwrap();
    assert_eq!(canonical.tool, ToolName::new("email.send"));
    // Effects are committed at release, before any result exists.
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));

    trajectory.record_failure(receipt).unwrap();
    assert!(trajectory.pending_action().is_none());
    // Failure removes nothing.
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
}

#[test]
fn canonical_request_renders_the_checked_tree() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "the doc");
    let request = email_request(&mut trajectory, body, "bob");

    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit");
    };
    let (canonical, receipt) = trajectory.release(token).unwrap();
    assert_eq!(canonical.rendered, r#"{"body":"the doc","to":"bob"}"#);
    trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
}

/// The bound is checked before a step, never after: with exactly enough
/// budget for the one Accept step, the resulting permit is still returned.
#[test]
fn pursue_returns_a_permit_produced_by_the_final_allowed_step() {
    let mut engine = engine_with([egress_tool()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let Pursuit::Permitted(token) = engine.pursue(&mut trajectory, ping_request(body), 1) else {
        panic!("the final allowed step's permit must be returned");
    };
    dispatch(&mut trajectory, token, "pong").unwrap();
}

/// A permitted pursuit authorizes but commits nothing: effects land at
/// release, not while walking — the two-phase boundary is untouched.
#[test]
fn pursue_permit_commits_nothing_before_release() {
    let mut engine = engine_with([egress_tool()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let Pursuit::Permitted(token) = engine.pursue(&mut trajectory, ping_request(body), 8) else {
        panic!("expected a permit");
    };
    assert_eq!(trajectory.state().past_effects(), &Effects::none());
    let (_, receipt) = trajectory.release(token).unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
    trajectory.record_output(receipt, OpaqueValue::new("pong")).unwrap();
}

/// A stalled pursuit abandons the pending action: the trajectory stays free
/// for the next proposal instead of refusing it as already-pending.
#[test]
fn pursue_stall_abandons_the_pending_action() {
    let mut engine = engine_with([egress_tool()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let Pursuit::Stalled { violations, cause } = engine.pursue(&mut trajectory, ping_request(body), 0) else {
        panic!("a zero bound must stall a remediable flow");
    };
    assert_eq!(cause, StallCause::BoundExhausted);
    assert!(!violations.is_empty());
    assert!(trajectory.pending_action().is_none());
    let Pursuit::Permitted(token) = engine.pursue(&mut trajectory, ping_request(body), 8) else {
        panic!("the trajectory must be free after a stall");
    };
    dispatch(&mut trajectory, token, "pong").unwrap();
}

/// Pursuing a different proposal while an action is in flight is refused
/// terminally WITHOUT touching the in-flight action: its token still
/// releases — the one terminal where clearing the slot would be a bug.
#[test]
fn pursue_of_a_different_proposal_leaves_the_inflight_action_untouched() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let to_bob = identity_ingress(&mut trajectory, "bob");
    let to_alice = identity_ingress(&mut trajectory, "alice");
    let first = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::object([("to", to_bob), ("body", body)]),
        [],
    );
    let second = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::object([("to", to_alice), ("body", body)]),
        [],
    );

    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, first) else {
        panic!("expected a permit");
    };
    let Pursuit::Terminal(block) = engine.pursue(&mut trajectory, second, 8) else {
        panic!("a different proposal while one is pending must refuse terminally");
    };
    assert!(matches!(block.reason, BlockReason::ActionAlreadyPending { .. }));
    assert!(trajectory.pending_action().is_some());
    dispatch(&mut trajectory, token, "sent").unwrap();
}

/// A pursuit deferring to an external authority keeps the pending action, so
/// the held approval can re-enter through `apply_approval`.
#[test]
fn pursue_keeps_the_slot_for_an_external_ruling() {
    let mut engine = engine_with([egress_tool()]);
    engine
        .register_authority(external_authority("effect-approver", acquirer_mandate()))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let Pursuit::NeedsApproval(pending) = engine.pursue(&mut trajectory, ping_request(body), 8) else {
        panic!("the external acquirer should defer");
    };
    assert!(trajectory.pending_action().is_some());
    let Decision::Permitted(token) = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "acquired".to_owned(),
            },
        )
        .unwrap()
    else {
        panic!("the approval should permit");
    };
    dispatch(&mut trajectory, token, "pong").unwrap();
}

/// A combinator-built inline authority routes and rules end-to-end: vouching
/// carol in (Endorse) and acquiring the egress (Accept) walk the flow to a
/// genuine permit — the combinators grant real, sufficient competence.
#[test]
fn combinator_built_inline_authority_endorses_to_a_permit() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(Authority::inline(
            "approver",
            crate::transition::AuthorityMandate::none()
                .vouch_audience([user("carol")])
                .acquire_effects(),
            approve_all,
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "carol");
    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "sent").unwrap();
}

/// A combinator-built external authority defers, and the pursuit names it.
#[test]
fn combinator_built_external_authority_defers_naming_it() {
    let mut engine = engine_with([egress_tool()]);
    engine
        .register_authority(Authority::external(
            "effect-approver",
            crate::transition::AuthorityMandate::none().acquire_effects(),
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let Pursuit::NeedsApproval(pending) = engine.pursue(&mut trajectory, ping_request(body), 8) else {
        panic!("the external acquirer should defer");
    };
    assert_eq!(pending.authority(), &AuthorityName::new("effect-approver"));
}

/// A `source`-registered tool is a pure read whose recorded output wears the
/// declared label after the admission fold.
#[test]
fn source_contract_output_wears_the_declared_label() {
    let internal = || ValueLabel::trusted_readers([user("alice"), user("bob")]);
    let engine = engine_with([ToolContract::source("invoices.list", internal())]);
    let mut trajectory = Trajectory::new();
    let request = ToolRequest::new(ToolName::new("invoices.list"), ArgumentTree::empty(), []);
    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
        panic!("a pure read must permit");
    };
    let id = dispatch(&mut trajectory, token, "47 invoices").unwrap();
    assert_eq!(trajectory.value(id).unwrap().label(), &internal());
}

/// An `egress_sink`-registered tool reads recipients from the named argument
/// (walking the Accept for its declared egress), and blocks structurally when
/// the recipients argument is missing.
#[test]
fn egress_sink_contract_resolves_recipients_and_blocks_undeclared() {
    let mut engine = engine_with([ToolContract::egress_sink("email.send", "to")]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();

    let body = ingress(&mut trajectory, &["bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");
    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "sent").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));

    let body = ingress(&mut trajectory, &["bob"], Trust::TRUSTED, "doc two");
    let bare = ToolRequest::new(ToolName::new("email.send"), ArgumentTree::object([("body", body)]), []);
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, bare) else {
        panic!("an egress sink with no recipients argument must block terminally");
    };
    assert!(
        block
            .violations
            .contains(&Violation::Breach(crate::contract::Breach::UndeclaredRecipients))
    );
}

#[test]
fn object_built_request_checks_and_renders_like_the_literal_tree() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "the doc");
    let to = identity_ingress(&mut trajectory, "bob");
    // `object` + leaf coercion + iterator control set: duplicates dedup into
    // the same mandatory set a literal `BTreeSet` would carry.
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::object([("to", to), ("body", body)]),
        [body, body],
    );
    assert_eq!(request.control, BTreeSet::from([body]));

    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit");
    };
    let (canonical, receipt) = trajectory.release(token).unwrap();
    assert_eq!(canonical.rendered, r#"{"body":"the doc","to":"bob"}"#);
    trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
}

#[test]
fn stale_receipt_is_rejected_after_any_mutation() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");

    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit");
    };
    let (_, receipt) = trajectory.release(token).unwrap();
    trajectory
        .admit_model_output(OpaqueValue::new("meanwhile"), BTreeSet::from([body]), BTreeSet::new())
        .unwrap();
    let err = trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap_err();
    assert!(matches!(err, RejectedToken::Stale { .. }));
}

#[test]
fn foreign_receipt_is_rejected() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");
    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit");
    };
    let (_, receipt) = trajectory.release(token).unwrap();

    let mut other = Trajectory::new();
    let err = other.record_output(receipt, OpaqueValue::new("sent")).unwrap_err();
    assert!(matches!(err, RejectedToken::ForeignTrajectory { .. }));
}

#[test]
fn spent_confirmation_cannot_authorize_a_second_attempt() {
    let drop_contract = ToolContract {
        name: ToolName::new("db.drop"),
        requires: Some(Requirements {
            attention: crate::contract::AttentionRule::ExplicitConfirmation,
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Mutation]),
        arguments: ArgumentSchema::opaque(),
    };
    let engine = engine_with([drop_contract]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Mutation]));
    let go = trajectory.ingress(
        crate::turn::Speaker::confirming(user("alice"), ToolName::new("db.drop")),
        ValueLabel::identity(),
        OpaqueValue::new("yes, drop it"),
    );
    let request = ToolRequest::new(ToolName::new("db.drop"), ArgumentTree::Value(go), BTreeSet::new());

    let Decision::Permitted(token) = engine.evaluate(&mut trajectory, request.clone()) else {
        panic!("expected permit with confirmation in force");
    };
    let (_, receipt) = trajectory.release(token).unwrap();
    // The dispatch fails without appending a turn: the confirming turn is
    // the newest turn again, but its confirmation was spent at release.
    trajectory.record_failure(receipt).unwrap();
    assert_eq!(trajectory.pending_confirmation(), None);

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected block without a live confirmation");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::ConfirmationMissing { .. })]
    ));
}

fn response_engine(readers: &[&str]) -> PolicyEngine {
    PolicyEngine::new().with_response_policy(ResponsePolicy {
        requires: Requirements {
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        },
        readers: readers.iter().map(|r| user(r)).collect(),
    })
}

#[test]
fn clean_response_is_emitted_from_the_exact_checked_tree() {
    let engine = response_engine(&["alice"]);
    let mut trajectory = Trajectory::new();
    let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "all done");
    let request = ResponseRequest {
        body: ArgumentTree::Value(note),
        control: BTreeSet::new(),
        basis: trajectory.revision(),
    };

    let ResponseDecision::Emitted { value, rendered } = engine.evaluate_response(&mut trajectory, request) else {
        panic!("expected emission");
    };
    assert_eq!(rendered, "\"all done\"");
    // The emitted value is the rendered bytes, derived from the tree.
    assert_eq!(trajectory.value(value).unwrap().body().as_str(), rendered);
    assert!(matches!(
        trajectory.turns().last(),
        Some(crate::turn::Turn {
            actor: crate::turn::Actor::Assistant,
            ..
        })
    ));
}

#[test]
fn response_leaking_outside_readers_is_blocked() {
    // The conversation reader is charlie, but the response depends on a
    // value only alice may read.
    let engine = response_engine(&["charlie"]);
    let mut trajectory = Trajectory::new();
    let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
    let summary = trajectory
        .admit_model_output(
            OpaqueValue::new("about the secret"),
            BTreeSet::from([secret]),
            BTreeSet::new(),
        )
        .unwrap();
    let request = ResponseRequest {
        body: ArgumentTree::Value(summary),
        control: BTreeSet::new(),
        basis: trajectory.revision(),
    };

    let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request) else {
        panic!("expected block");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })]
    ));
}

#[test]
fn response_control_dependence_is_checked() {
    let engine = response_engine(&["charlie"]);
    let mut trajectory = Trajectory::new();
    let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
    let bland = ingress(&mut trajectory, &["alice", "charlie"], Trust::TRUSTED, "ok");
    // The response text is clean, but WHETHER to say it was decided after
    // reading the secret.
    let request = ResponseRequest {
        body: ArgumentTree::Value(bland),
        control: BTreeSet::from([secret]),
        basis: trajectory.revision(),
    };

    let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request) else {
        panic!("expected block");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })]
    ));
}

#[test]
fn stale_response_basis_is_blocked_and_touches_nothing() {
    let engine = response_engine(&["alice"]);
    let mut trajectory = Trajectory::new();
    let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "done");
    let stale_basis = trajectory.revision();
    // The trajectory moves on before emission.
    trajectory
        .admit_model_output(OpaqueValue::new("more"), BTreeSet::from([note]), BTreeSet::new())
        .unwrap();
    let turns_before = trajectory.turns().len();

    let request = ResponseRequest {
        body: ArgumentTree::Value(note),
        control: BTreeSet::new(),
        basis: stale_basis,
    };
    let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request) else {
        panic!("expected block");
    };
    assert!(matches!(block.reason, BlockReason::StaleResponse { .. }));
    assert_eq!(trajectory.turns().len(), turns_before);
}

#[test]
fn response_without_policy_is_unprovable() {
    let engine = engine_with([]);
    let mut trajectory = Trajectory::new();
    let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "hi");
    let request = ResponseRequest {
        body: ArgumentTree::Value(note),
        control: BTreeSet::new(),
        basis: trajectory.revision(),
    };

    let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, request) else {
        panic!("expected block");
    };
    // The response sink is strict emit-or-terminal (D1): an unprovable
    // response with no policy has no remedy. The vector is exactly the
    // unprovable call against the reserved sink — the response check has
    // no surface-growth arm.
    assert_eq!(block.reason, BlockReason::NoRemedy);
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Unprovable(Unprovable::NoContract { tool })] if *tool == ToolName::new(RESPONSE_SINK)
    ));
}

#[test]
fn duplicate_reentry_token_cannot_release_twice() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, body, "bob");

    let Decision::Permitted(first) = engine.evaluate(&mut trajectory, request.clone()) else {
        panic!("expected permit");
    };
    let Decision::Permitted(second) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected permit on re-entry");
    };

    // Releasing one consumes the dispatch slot at that revision; the
    // duplicate can never begin a second dispatch.
    let (_, receipt) = trajectory.release(first).unwrap();
    let err = trajectory.release(second).unwrap_err();
    assert!(matches!(err, RejectedToken::Stale { .. }));
    trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
}

#[test]
fn unknown_control_dependency_blocks_loudly() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let ghost = ValueId::new(1000);
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Value(body),
        BTreeSet::from([ghost]),
    );

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::UnknownValueReferenced { value: ghost });
}

#[test]
fn duplicate_transformer_and_transition_registration_refused() {
    fn passthrough(v: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
        Ok(v.clone())
    }
    let entry = || RegisteredTransformer {
        descriptor: crate::transition::TransformerDescriptor {
            transformer: crate::value::TransformerRef {
                id: "pii.redact".into(),
                version: 1,
            },
            precondition: crate::transition::LabelPredicate::any(),
            output: ValueLabel::identity(),
        },
        run: passthrough,
    };
    let mut engine = PolicyEngine::new();
    engine.register_transformer(entry()).unwrap();
    assert!(engine.register_transformer(entry()).is_err());

    let transition = || ActionTransition {
        id: crate::value::TransformerRef {
            id: "sandbox".into(),
            version: 1,
        },
        from_tool: ToolName::new("shell.run"),
        to_tool: ToolName::new("shell.run.sandboxed"),
        effects: Effects::none(),
    };
    engine.register_action_transition(transition()).unwrap();
    assert!(engine.register_action_transition(transition()).is_err());
}

fn redact_transformer() -> RegisteredTransformer {
    fn redact(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
        Ok(OpaqueValue::new("[redacted]"))
    }
    RegisteredTransformer {
        descriptor: crate::transition::TransformerDescriptor {
            transformer: crate::value::TransformerRef {
                id: "pii.redact".into(),
                version: 1,
            },
            precondition: crate::transition::LabelPredicate {
                trust: Some(Trust::SUSPICIOUS),
                audience: None,
            },
            output: ValueLabel::identity(),
        },
        run: redact,
    }
}

fn human() -> crate::approval::Authority {
    crate::approval::Authority {
        name: crate::audit::AuthorityName::new("human"),
        mandate: crate::transition::AuthorityMandate {
            trust: Some(crate::dimension::KnownTrust::Trusted),
            audience: Some(BTreeSet::from([user("alice"), user("bob"), user("charlie")])),
            waive_prior_effects: true,
            confirms: true,
            acknowledge_unknown: true,
            may_release_control: true,
            acquire_effects: true,
        },
        mode: crate::approval::AuthorityMode::External,
    }
}

/// A suspicious payload with a registered redactor yields a single-step
/// transform plan predicting a clean flow.
#[test]
fn tainted_payload_plans_a_transform() {
    let mut engine = engine_with([email_contract()]);
    engine.register_transformer(redact_transformer()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw page");
    let request = email_request(&mut trajectory, raw, "bob");

    let Decision::Blocked(Blocked::Remediable { violations, plans }) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected remediable block");
    };
    assert!(matches!(
        violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::TrustBelow { .. })]
    ));
    let transform_plan = plans
        .iter()
        .find(|p| p.steps.len() == 1)
        .expect("single-step transform plan");
    assert!(matches!(
        &transform_plan.steps.first().kind,
        TransitionKind::Derive { source, justification: Justification::Content(_) } if *source == raw
    ));
    assert!(transform_plan.final_postcondition.is_clean());
    // Plans are stored on the trajectory, bound to its current revision,
    // and the pending action they target stays open.
    assert_eq!(trajectory.plans().len(), plans.len());
    assert_eq!(trajectory.plans()[0].basis, trajectory.revision());
    assert!(trajectory.pending_action().is_some());
}

/// An audience breach carried by an argument leaf yields an Endorse plan (a
/// durable relabel), routed to a competent authority.
#[test]
fn audience_breach_plans_an_endorse() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    // Only alice may read the doc; sending to charlie exceeds it.
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private doc");
    let request = email_request(&mut trajectory, doc, "charlie");

    let plans = remediable(&engine, &mut trajectory, request);
    let endorse = plans.first();
    assert_eq!(endorse.steps.len(), 1);
    assert!(matches!(
        &endorse.steps.first().kind,
        TransitionKind::Derive { source, justification: Justification::Fiat { delta, .. } }
            if *source == doc && delta.audience.as_ref().is_some_and(|r| r.contains(&user("charlie")))
    ));
    // Routing is live at application: the endorse step defers to the
    // competent external human.
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, endorse.id) else {
        panic!("expected the external human to be consulted");
    };
    assert_eq!(pending.authority().as_str(), "human");
}

/// A breach carried by more than one argument leaf endorses each
/// contributing leaf (multi-source), and clears only once every one is
/// raised — the audience fold is intersection, so a single raise is not
/// enough.
#[test]
fn a_multi_source_audience_breach_endorses_every_contributing_leaf() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("auto", human().mandate, approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    // Two body parts, each readable only by alice; sending to bob exceeds
    // both, so both must be endorsed.
    let part1 = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "part one");
    let part2 = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "part two");
    let to = identity_ingress(&mut trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (
                ArgumentName::new("body"),
                ArgumentTree::Object(std::collections::BTreeMap::from([
                    (ArgumentName::new("0"), ArgumentTree::Value(part1)),
                    (ArgumentName::new("1"), ArgumentTree::Value(part2)),
                ])),
            ),
        ])),
        BTreeSet::new(),
    );

    let plans = remediable(&engine, &mut trajectory, request);
    let plan_id = plans.first().id;
    let endorsed: BTreeSet<ValueId> = plans
        .first()
        .steps
        .iter()
        .filter_map(|s| match &s.kind {
            TransitionKind::Derive {
                source,
                justification: Justification::Fiat { .. },
            } => Some(*source),
            _ => None,
        })
        .collect();
    assert_eq!(
        endorsed,
        BTreeSet::from([part1, part2]),
        "both contributing leaves are endorsed"
    );

    // Applying only the first endorse does not yet clear the breach.
    let StepOutcome::Advanced(mut decision) = apply_first_step(&engine, &mut trajectory, plan_id) else {
        panic!("expected the step to advance");
    };
    assert!(
        matches!(decision, Decision::Blocked(Blocked::Remediable { .. })),
        "a single endorse does not clear a two-leaf intersection breach"
    );
    // Continuing endorses the second leaf and reaches a permit.
    loop {
        match decision {
            Decision::Permitted(_) => break,
            Decision::Blocked(Blocked::Remediable { plans, .. }) => {
                decision = match apply_first_step(&engine, &mut trajectory, plans.first().id) {
                    StepOutcome::Advanced(d) => d,
                    other => panic!("unexpected outcome: {other:?}"),
                };
            }
            other => panic!("expected to reach a permit, got {other:?}"),
        }
    }
}

/// A granted Endorse mints a durable relabel: the source keeps its narrow
/// label, a new value carries the raise under `Provenance::Endorsed`, the
/// authority is audited, and the re-evaluated flow is permitted. (The
/// grant is delivered through the external approval path an
/// out-of-process authority re-enters.)
#[test]
fn a_granted_endorse_durably_relabels_the_source_and_permits() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private doc");
    let doc_label = trajectory.store().get(doc).unwrap().label().clone();
    let request = email_request(&mut trajectory, doc, "charlie");

    // The breach enumerates an Endorse route; applying its step defers to
    // the external human, who vouches the doc for charlie by fiat — the
    // durable analogue of the audience waiver.
    let plans = remediable(&engine, &mut trajectory, request);
    let endorse_plan = plans
        .iter()
        .find(|p| matches!(&p.steps.first().kind, TransitionKind::Derive { source, justification: Justification::Fiat { .. } } if *source == doc))
        .expect("an endorse plan for the doc");
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, endorse_plan.id) else {
        panic!("expected the external human to be consulted");
    };
    assert_eq!(pending.authority().as_str(), "human");

    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            Ruling::Approve {
                reason: "vouched".into(),
            },
        )
        .unwrap();
    assert!(
        matches!(decision, Decision::Permitted(_)),
        "the raise clears the audience breach"
    );

    // Durability by construction: the source is untouched; a new value
    // carries the raised label with Endorsed provenance naming the authority.
    assert_eq!(trajectory.store().get(doc).unwrap().label(), &doc_label);
    let (derived, authority) = trajectory
        .state()
        .audit()
        .iter()
        .find_map(|e| match e {
            AuditEvent::EndorseApplied { derived, authority, .. } => Some((*derived, authority.clone())),
            _ => None,
        })
        .expect("the endorse was audited");
    assert_eq!(authority.as_str(), "human");
    let derived_stored = trajectory.store().get(derived).unwrap();
    assert_ne!(
        derived_stored.label(),
        &doc_label,
        "the derived value's label was raised"
    );
    assert!(matches!(
        derived_stored.provenance(),
        crate::value::Provenance::Endorsed { source, .. } if *source == doc
    ));
}

/// Routing an Endorse honours the mandate bounds: a delta the authority
/// cannot vouch finds no competent authority; a bounded one routes.
#[test]
fn an_endorse_routes_only_within_the_mandate_bounds() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap(); // may vouch alice/bob/charlie
    let mut trajectory = Trajectory::new();
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "doc");
    let view = TrajectoryView::new(trajectory.store());

    let beyond = crate::transition::ProposedGrant::Endorse {
        source: doc,
        delta: crate::transition::EndorseDelta {
            trust: None,
            audience: Some(BTreeSet::from([user("dave")])),
        },
    };
    assert!(matches!(
        engine.route_grant(&beyond, &[], &view),
        RoutedRuling::NoRuling
    ));

    let within = crate::transition::ProposedGrant::Endorse {
        source: doc,
        delta: crate::transition::EndorseDelta {
            trust: None,
            audience: Some(BTreeSet::from([user("charlie")])),
        },
    };
    assert!(matches!(
        engine.route_grant(&within, &[], &view),
        RoutedRuling::External(_)
    ));
}

/// A denied Endorse is terminal and mints no value: the fiat relabel never
/// happens, so the store and the source label are untouched.
#[test]
fn a_denied_endorse_is_terminal_and_mints_no_value() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private doc");
    let request = email_request(&mut trajectory, doc, "charlie");

    let plans = remediable(&engine, &mut trajectory, request);
    let endorse_plan = plans
        .iter()
        .find(|p| matches!(&p.steps.first().kind, TransitionKind::Derive { source, justification: Justification::Fiat { .. } } if *source == doc))
        .expect("an endorse plan for the doc");
    let values_before = trajectory.store().len();
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, endorse_plan.id) else {
        panic!("expected the external human to be consulted");
    };

    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            Ruling::Deny {
                reason: "suspicious source".into(),
            },
        )
        .unwrap();
    assert!(matches!(decision, Decision::Blocked(Blocked::Terminal(_))));
    assert_eq!(
        trajectory.store().len(),
        values_before,
        "a denied endorse mints nothing"
    );
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::EndorseDenied { .. }))
    );
}

/// D3: an inline authority walks the *transitive* ancestry and refuses to
/// endorse a value whose suspicious source is two provenance edges back —
/// invisible to the value's own laundered label and to a single provenance
/// lookup, visible only through the closure walk.
#[test]
fn endorse_authority_refuses_a_suspicious_transitive_ancestry() {
    fn refuse_suspicious_ancestry(
        grant: &crate::transition::ProposedGrant,
        _: &[Violation],
        view: &crate::approval::TrajectoryView,
    ) -> Option<crate::approval::Ruling> {
        let crate::transition::ProposedGrant::Endorse { source, .. } = grant else {
            return None;
        };
        let tainted = view
            .ancestry(*source)
            .any(|(_, label, _)| label.trust == Trust::SUSPICIOUS);
        if tainted {
            None
        } else {
            Some(crate::approval::Ruling::Approve {
                reason: "clean ancestry".to_owned(),
            })
        }
    }
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("vetter", human().mandate, refuse_suspicious_ancestry))
        .unwrap();

    // A body laundered twice below the fold: trusted itself, but its root
    // (two edges back) carries `root_trust`.
    let laundered_body = |trajectory: &mut Trajectory, root_trust: Trust| -> ValueId {
        let root = ingress(trajectory, &["alice"], root_trust, "raw");
        let trusted = ValueLabel {
            audience: Audience::readers([user("alice")]),
            trust: Trust::TRUSTED,
        };
        let mid = trajectory.seed_transformed(root, trusted.clone());
        trajectory.seed_transformed(mid, trusted)
    };

    // Suspicious root → the authority abstains → terminal.
    let mut tainted = Trajectory::new();
    tainted.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = laundered_body(&mut tainted, Trust::SUSPICIOUS);
    let request = email_request(&mut tainted, body, "charlie");
    let plans = remediable(&engine, &mut tainted, request);
    let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
        apply_first_step(&engine, &mut tainted, plans.first().id)
    else {
        panic!("a suspicious transitive ancestor should be refused");
    };
    assert_eq!(block.reason, BlockReason::NoAuthorityRuled);

    // Trusted root, same shape → endorsed and permitted.
    let mut clean = Trajectory::new();
    clean.seed_committed_effects(Effects::declared([Effect::Egress]));
    let body = laundered_body(&mut clean, Trust::TRUSTED);
    let request = email_request(&mut clean, body, "charlie");
    let _token = walk_to_permit(&engine, &mut clean, request);
}

/// Control-borne taint prefers the narrower control-release waiver over
/// attesting the data itself.
#[test]
fn control_taint_plans_control_release_first() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "secret");
    let clean = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "harmless");
    let to = identity_ingress(&mut trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(clean)),
        ])),
        BTreeSet::from([secret]),
    );

    let plans = remediable(&engine, &mut trajectory, request);
    assert!(matches!(
        &plans.first().steps.first().kind,
        TransitionKind::ApplyWaiver {
            delta: crate::transition::TransientWaiver { control_release, .. },
        } if *control_release == BTreeSet::from([secret])
    ));
}

/// A breach that is part control-borne and part arg-borne composes: the
/// control-release waiver drops the control-narrowed recipient (bob), and an
/// Endorse durably vouches the recipient the argument itself excludes
/// (charlie). The control-release candidate must still be offered even though
/// it only *narrows* the witness. (Regression: the violation-set comparison
/// in `minimal_control_release`.)
#[test]
fn control_release_and_endorse_compose_for_a_mixed_audience_breach() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    // The body admits alice and bob; a control selector restricts to alice.
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let control = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "selector");
    let to_bob = identity_ingress(&mut trajectory, "bob");
    let to_charlie = identity_ingress(&mut trajectory, "charlie");
    // Sending to {bob, charlie}: with control folded the flow audience is
    // {alice}, so both are outside. Releasing control admits bob, leaving
    // only charlie exposed.
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (
                ArgumentName::new("to"),
                ArgumentTree::Object(std::collections::BTreeMap::from([
                    (ArgumentName::new("0"), ArgumentTree::Value(to_bob)),
                    (ArgumentName::new("1"), ArgumentTree::Value(to_charlie)),
                ])),
            ),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::from([control]),
    );
    let plans = remediable(&engine, &mut trajectory, request);
    let composes = plans.iter().any(|plan| {
        let endorses_charlie = plan.steps.iter().any(|step| {
            matches!(
                &step.kind,
                TransitionKind::Derive { source, justification: Justification::Fiat { delta, .. } }
                    if *source == body && delta.audience.as_ref().is_some_and(|r| r.contains(&user("charlie")))
            )
        });
        let releases_control = plan.steps.iter().any(|step| {
            matches!(
                &step.kind,
                TransitionKind::ApplyWaiver {
                    delta: crate::transition::TransientWaiver { control_release, .. },
                } if *control_release == BTreeSet::from([control])
            )
        });
        endorses_charlie && releases_control
    });
    assert!(
        composes,
        "the mixed breach should endorse the body for charlie and release control for bob"
    );
}

/// Least-privilege release: two control deps carry the same restriction
/// (joint-only — releasing either alone leaves the other still restricting)
/// alongside an unrelated identity-labelled control. The offered release set
/// is exactly the two carriers, never the innocent bystander. (Regression:
/// an all-or-nothing fallback would release all three, violating D4.)
#[test]
fn control_release_is_least_privilege_over_joint_carriers() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    // Body admits alice and bob; the recipient is bob.
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "body");
    // Two controls each restrict the audience to alice (joint carriers).
    let secret_a = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "sel-a");
    let secret_b = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "sel-b");
    // An unrelated control at the identity label carries nothing.
    let noise = identity_ingress(&mut trajectory, "noise");
    let to_bob = identity_ingress(&mut trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to_bob)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::from([secret_a, secret_b, noise]),
    );
    let plans = remediable(&engine, &mut trajectory, request);
    let released = plans.iter().any(|plan| {
        matches!(
            &plan.steps.first().kind,
            TransitionKind::ApplyWaiver {
                delta: crate::transition::TransientWaiver { control_release, .. },
            } if *control_release == BTreeSet::from([secret_a, secret_b])
        )
    });
    assert!(
        released,
        "release the two joint carriers only, never the unrelated control"
    );
    // And no enumerated plan may over-release the unrelated control.
    let over_releases = plans.iter().any(|plan| {
        plan.steps.iter().any(|step| {
            matches!(
                &step.kind,
                TransitionKind::ApplyWaiver { delta } if delta.control_release.contains(&noise)
            )
        })
    });
    assert!(!over_releases, "the unrelated control must never be released");
}

/// Masking least-privilege: a Suspicious-trust control masks an Unknown-trust
/// one in the fold (their combine is Suspicious, which satisfies the sink),
/// so once the Suspicious control is left folded the Unknown one is redundant.
/// Only the audience control actually carries a breach, so the release set is
/// exactly {audience control}. A single greedy pass would over-release the
/// masked Unknown control (it is dropped only after the Suspicious one, which
/// a single pass never revisits); the fixpoint reaches {audience} alone.
#[test]
fn control_release_fixpoint_avoids_masked_over_release() {
    let sink = ToolContract {
        name: ToolName::new("email.send"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Suspicious),
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::none(),
        arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
    };
    let mut engine = engine_with([sink]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "body");
    // The audience-restricting control is the sole carrier; the other two
    // touch only trust (non-restricting audience), and Suspicious masks
    // Unknown in the fold.
    let restrict = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "restrict");
    let unknown = trajectory.ingress(
        crate::turn::Speaker::user(user("alice")),
        ValueLabel {
            audience: Audience::PUBLIC,
            trust: Trust::UNKNOWN,
        },
        OpaqueValue::new("unk"),
    );
    let suspicious = trajectory.ingress(
        crate::turn::Speaker::user(user("alice")),
        ValueLabel {
            audience: Audience::PUBLIC,
            trust: Trust::SUSPICIOUS,
        },
        OpaqueValue::new("susp"),
    );
    let to_bob = identity_ingress(&mut trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to_bob)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::from([restrict, unknown, suspicious]),
    );
    let plans = remediable(&engine, &mut trajectory, request);
    let released_exactly_restrict = plans.iter().any(|plan| {
        matches!(
            &plan.steps.first().kind,
            TransitionKind::ApplyWaiver {
                delta: crate::transition::TransientWaiver { control_release, .. },
            } if *control_release == BTreeSet::from([restrict])
        )
    });
    assert!(
        released_exactly_restrict,
        "release only the audience control, not the masked trust controls"
    );
}

/// A registered tool-identity mapping to a weaker-contract tool yields a
/// constrain plan.
#[test]
fn constrain_plan_maps_to_narrower_tool() {
    let fetch = ToolContract {
        name: ToolName::new("web.fetch"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            ..Requirements::default()
        }),
        output_label: ValueLabel {
            audience: Audience::PUBLIC,
            trust: Trust::SUSPICIOUS,
        },
        effects: Effects::declared([Effect::Egress]),
        arguments: ArgumentSchema::opaque(),
    };
    let cached = ToolContract {
        name: ToolName::new("web.fetch.cached"),
        requires: Some(Requirements::default()),
        output_label: ValueLabel {
            audience: Audience::PUBLIC,
            trust: Trust::SUSPICIOUS,
        },
        effects: Effects::none(),
        arguments: ArgumentSchema::opaque(),
    };
    let mut engine = engine_with([fetch, cached]);
    engine
        .register_action_transition(ActionTransition {
            id: crate::value::TransformerRef {
                id: "cache-only".into(),
                version: 1,
            },
            from_tool: ToolName::new("web.fetch"),
            to_tool: ToolName::new("web.fetch.cached"),
            effects: Effects::none(),
        })
        .unwrap();
    let mut trajectory = Trajectory::new();
    let url = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "http://x");
    let request = ToolRequest::new(ToolName::new("web.fetch"), ArgumentTree::Value(url), BTreeSet::new());

    let plans = remediable(&engine, &mut trajectory, request);
    let constrain = plans
        .iter()
        .find(|p| matches!(&p.steps.first().kind, TransitionKind::ConstrainAction { .. }))
        .expect("constrain plan");
    assert!(constrain.final_postcondition.is_clean());
}

/// With no registered remedy that predicts a clean flow, the block stays
/// terminal.
#[test]
fn no_applicable_remedy_is_terminal() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw");
    let request = email_request(&mut trajectory, raw, "bob");

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
    // The full emission order: the sink's trust breach first, then the
    // first-egress growth appended by the criterion-(1) check.
    assert!(matches!(
        block.violations.as_slice(),
        [
            Violation::Breach(crate::contract::Breach::TrustBelow { .. }),
            Violation::Breach(crate::contract::Breach::SurfaceGrowth { growth }),
        ] if *growth == Effects::declared([Effect::Egress])
    ));
    assert!(trajectory.pending_action().is_none());
}

/// A transform plan applied end-to-end: the derived value takes the
/// tainted slot, the flow permits, and the canonical rendering carries
/// the redacted bytes.
#[test]
fn transform_step_applies_and_flow_permits() {
    let mut engine = engine_with([email_contract()]);
    engine.register_transformer(redact_transformer()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw secrets");
    let request = email_request(&mut trajectory, raw, "bob");

    let plans = remediable(&engine, &mut trajectory, request);
    let plan = plans
        .iter()
        .find(|p| {
            p.steps.len() == 1
                && matches!(
                    &p.steps.first().kind,
                    TransitionKind::Derive {
                        justification: Justification::Content(_),
                        ..
                    }
                )
        })
        .expect("transform plan");

    let outcome = apply_first_step(&engine, &mut trajectory, plan.id);
    let StepOutcome::Advanced(Decision::Permitted(token)) = outcome else {
        panic!("expected the transform to advance to a permit, got {outcome:?}");
    };
    // The raw value keeps its label; the derived value took its slot.
    assert_eq!(trajectory.value(raw).unwrap().label().trust, Trust::SUSPICIOUS);
    assert!(matches!(
        trajectory.state().audit(),
        [AuditEvent::ValueTransition {
            outcome: crate::audit::TransitionOutcome::Applied,
            ..
        }]
    ));

    let (canonical, receipt) = trajectory.release(token).unwrap();
    assert!(canonical.rendered.contains("[redacted]"));
    assert!(!canonical.rendered.contains("raw secrets"));
    trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
}

/// A rule-approved Endorse permits inline, with the application audited.
#[test]
fn rule_approved_endorse_permits_inline() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("auto-approve", human().mandate, approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");

    let plans = remediable(&engine, &mut trajectory, request);
    assert!(matches!(
        &plans.first().steps.first().kind,
        TransitionKind::Derive {
            justification: Justification::Fiat { .. },
            ..
        }
    ));
    let outcome = apply_first_step(&engine, &mut trajectory, plans.first().id);
    let StepOutcome::Advanced(Decision::Permitted(_token)) = outcome else {
        panic!("expected inline endorse permit, got {outcome:?}");
    };
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::EndorseApplied { .. }))
    );
}

/// An inline authority that abstains falls through to the next competent
/// authority rather than denying the flow.
#[test]
fn inline_abstention_falls_through_to_the_next_authority() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("first", human().mandate, abstain_all))
        .unwrap();
    engine
        .register_authority(inline_authority("second", human().mandate, approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");
    let plans = remediable(&engine, &mut trajectory, request);
    let StepOutcome::Advanced(Decision::Permitted(_)) = apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected the second authority to approve after the first abstained");
    };
    // The applied endorse is attributed to the authority that actually ruled.
    assert!(trajectory.state().audit().iter().any(|e| matches!(
        e,
        AuditEvent::EndorseApplied { authority, .. } if authority.as_str() == "second"
    )));
}

/// Inline authorities are consulted before external ones, even when an
/// external authority was registered first.
#[test]
fn inline_authority_is_consulted_before_external() {
    let mut engine = engine_with([email_contract()]);
    // External registered first; the inline authority must still win.
    engine.register_authority(human()).unwrap();
    engine
        .register_authority(inline_authority("inline", human().mandate, approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");
    let plans = remediable(&engine, &mut trajectory, request);
    // Inline resolves synchronously — no round-trip to the external human.
    let StepOutcome::Advanced(Decision::Permitted(_)) = apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected the inline authority to decide before the external one");
    };
}

/// When every competent authority is inline and all abstain, the flow
/// fails closed with no ruling produced.
#[test]
fn all_inline_abstentions_block_with_no_ruling() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("only", human().mandate, abstain_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");
    let plans = remediable(&engine, &mut trajectory, request);
    let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
        apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected a terminal block when every authority abstains");
    };
    assert_eq!(block.reason, BlockReason::NoAuthorityRuled);
}

/// An inline denial is decisive: it terminates the walk and does not fall
/// through to a later would-approve authority.
#[test]
fn inline_denial_is_decisive_and_does_not_fall_through() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("denier", human().mandate, deny_all))
        .unwrap();
    engine
        .register_authority(inline_authority("approver", human().mandate, approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");
    let plans = remediable(&engine, &mut trajectory, request);
    let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
        apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("a denial must terminate, not fall through to the approver");
    };
    assert!(matches!(block.reason, BlockReason::DeniedByAuthority { .. }));
    // The audience-breach route is an Endorse, so the denial is attributed
    // as one.
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::EndorseDenied { .. }))
    );
}

/// An authority that may only release control cannot acknowledge an
/// unknown: the `acknowledge_unknown` gate is not satisfiable by a lift
/// dimension. (Regression: the acknowledge bypass.)
#[test]
fn control_release_only_authority_cannot_acknowledge_an_unknown() {
    let mut engine = engine_with([]);
    engine
        .register_authority(inline_authority("control-only", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
    let request = ToolRequest::new(
        ToolName::new("mystery.tool"),
        ArgumentTree::Value(body),
        BTreeSet::new(),
    );
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("a control-release-only authority must not clear an unknown");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

/// A mixed residual (a grant-fixable breach *and* an acknowledge-only
/// unknown) needs a single authority competent for both — a lift-only
/// mandate must not launder the unknown. (Regression: the mixed-residual
/// acknowledge bypass.)
#[test]
fn mixed_residual_needs_acknowledge_competence_not_just_the_lift() {
    let mut engine = engine_with([]);
    // A tool with unknown effects; dispatching it makes past-effects UNKNOWN.
    engine
        .register(ToolContract {
            name: ToolName::new("fetch"),
            requires: Some(Requirements::default()),
            output_label: ValueLabel::unknown(),
            effects: Effects::UNKNOWN,
            arguments: ArgumentSchema::opaque(),
        })
        .unwrap();
    // A sink that both demands Trusted and forbids a prior Egress.
    engine
        .register(ToolContract {
            name: ToolName::new("email.send"),
            requires: Some(Requirements {
                trust: Some(KnownTrust::Trusted),
                audience: crate::contract::AudienceRule::FromRecipients,
                forbid_prior_effects: BTreeSet::from([Effect::Egress]),
                ..Requirements::default()
            }),
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
        })
        .unwrap();
    // Trust-competent, but NOT competent to acknowledge unknowns.
    engine
        .register_authority(inline_authority(
            "trust-only",
            crate::transition::AuthorityMandate {
                trust: Some(KnownTrust::Trusted),
                audience: Some(BTreeSet::from([user("alice"), user("bob")])),
                ..crate::transition::AuthorityMandate::none()
            },
            approve_all,
        ))
        .unwrap();

    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::UNKNOWN);
    let doc = ingress(&mut trajectory, &["alice", "bob"], Trust::UNKNOWN, "doc");
    // Dispatch fetch to drive past-effects to UNKNOWN.
    let Decision::Permitted(token) = engine.evaluate(
        &mut trajectory,
        ToolRequest::new(ToolName::new("fetch"), ArgumentTree::Value(doc), BTreeSet::new()),
    ) else {
        panic!("fetch should permit");
    };
    dispatch(&mut trajectory, token, "page").unwrap();

    // Emailing the doc now breaches trust (unknown) AND cannot prove it
    // avoids the prior Egress (unknown past): [TrustUnknown, EffectsUnknown].
    let request = email_request(&mut trajectory, doc, "bob");
    let decision = engine.evaluate(&mut trajectory, request);
    let Decision::Blocked(Blocked::Terminal(block)) = decision else {
        panic!("trust-only must not clear the unknown effect, got {decision:?}");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

// ---- S6: criterion (1) + Accept ----

/// A tool that egresses but requires nothing of the flow, so the only
/// possible violation is surface growth.
fn egress_tool() -> ToolContract {
    ToolContract {
        name: ToolName::new("net.ping"),
        requires: Some(Requirements::default()),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress]),
        arguments: ArgumentSchema::opaque(),
    }
}

fn ping_request(body: ValueId) -> ToolRequest {
    ToolRequest::new(ToolName::new("net.ping"), ArgumentTree::Value(body), BTreeSet::new())
}

/// An inline authority competent to acquire effects, always approving.
fn inline_acquirer() -> crate::approval::Authority {
    inline_authority("acquirer", acquirer_mandate(), approve_all)
}

/// The first egress grows the committed surface; with no `acquire_effects`
/// authority it has no remedy and blocks (fail-closed, no implicit accept).
#[test]
fn surface_growth_blocks_without_an_acquire_authority() {
    let engine = engine_with([egress_tool()]);
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, ping_request(body)) else {
        panic!("a growing effect with no acquirer must block terminally");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::SurfaceGrowth { growth })]
            if *growth == Effects::declared([Effect::Egress])
    ));
    assert_eq!(trajectory.state().past_effects(), &Effects::none());
}

/// With an acquirer, the growth routes to an `AcceptGrowth` step; applying
/// it clears the flow and permits. The effect commits at release, not early.
#[test]
fn accept_authority_acquires_the_growth_and_permits() {
    let mut engine = engine_with([egress_tool()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let plans = remediable(&engine, &mut trajectory, ping_request(body));
    assert!(matches!(
        &plans.first().steps.first().kind,
        TransitionKind::AcceptGrowth { effects } if *effects == Effects::declared([Effect::Egress])
    ));
    let StepOutcome::Advanced(Decision::Permitted(token)) =
        apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("the acceptance should clear the flow and permit");
    };
    // No early commit.
    assert_eq!(trajectory.state().past_effects(), &Effects::none());
    dispatch(&mut trajectory, token, "pong").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
    assert!(trajectory.state().audit().iter().any(|e| matches!(
        e,
        AuditEvent::AcceptApplied { effects, .. } if *effects == Effects::declared([Effect::Egress])
    )));
}

/// A no-contract call is both `NoContract` (acknowledge-only) and a growth
/// to `Unknown` (accept). An acknowledge-only authority cannot launder the
/// growth; only an authority competent for *both* clears it (blocker-2).
#[test]
fn no_contract_growth_needs_both_acknowledge_and_acquire() {
    let mystery = |trajectory: &mut Trajectory| {
        let body = ingress(trajectory, &["alice"], Trust::TRUSTED, "x");
        ToolRequest::new(
            ToolName::new("mystery.tool"),
            ArgumentTree::Value(body),
            BTreeSet::new(),
        )
    };

    // Acknowledge-only: cannot acquire the unknown growth → terminal.
    let mut engine = engine_with([]);
    engine
        .register_authority(inline_authority(
            "ack-only",
            crate::transition::AuthorityMandate {
                acknowledge_unknown: true,
                ..crate::transition::AuthorityMandate::none()
            },
            approve_all,
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let request = mystery(&mut trajectory);
    let Decision::Blocked(Blocked::Terminal(_)) = engine.evaluate(&mut trajectory, request) else {
        panic!("an acknowledge-only authority must not clear the unknown growth");
    };

    // Both competences: walk the plan (accept the growth, acknowledge the
    // missing contract) to a permit; dispatch drives past-effects to Unknown.
    let mut engine = engine_with([]);
    engine
        .register_authority(inline_authority(
            "both",
            crate::transition::AuthorityMandate {
                acknowledge_unknown: true,
                acquire_effects: true,
                ..crate::transition::AuthorityMandate::none()
            },
            approve_all,
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let request = mystery(&mut trajectory);
    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "???").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::UNKNOWN);
}

/// An external acquirer defers to an out-of-process ruling carrying the
/// `Accept` grant; the approval re-enters and permits.
#[test]
fn external_accept_roundtrip() {
    let mut engine = engine_with([egress_tool()]);
    engine
        .register_authority(external_authority("effect-approver", acquirer_mandate()))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let plans = remediable(&engine, &mut trajectory, ping_request(body));
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("the external acquirer should defer to an out-of-process ruling");
    };
    assert!(matches!(
        pending.grant(),
        crate::transition::ProposedGrant::Accept { effects } if *effects == Effects::declared([Effect::Egress])
    ));
    let Decision::Permitted(token) = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "acquired".to_owned(),
            },
        )
        .unwrap()
    else {
        panic!("the approval should permit");
    };
    dispatch(&mut trajectory, token, "pong").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
}

/// Acquisition authorizes the growth on the pending action but commits
/// nothing: abandoning the token (never releasing) leaves the surface empty.
#[test]
fn accepted_growth_then_abandon_commits_nothing() {
    let mut engine = engine_with([egress_tool()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let plans = remediable(&engine, &mut trajectory, ping_request(body));
    let StepOutcome::Advanced(Decision::Permitted(token)) =
        apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected a permit after acceptance");
    };
    drop(token);
    assert_eq!(trajectory.state().past_effects(), &Effects::none());
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::AcceptApplied { .. }))
    );
    assert!(
        !trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::EffectsCommitted { .. }))
    );
}

/// Once the first egress is committed, a second egress is downhill on the
/// effect surface and permits directly, with no further acquisition.
#[test]
fn second_egress_is_downhill_after_the_first() {
    let mut engine = engine_with([egress_tool()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let plans = remediable(&engine, &mut trajectory, ping_request(body));
    let StepOutcome::Advanced(Decision::Permitted(token)) =
        apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected a permit after acceptance");
    };
    dispatch(&mut trajectory, token, "pong").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));

    let body2 = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping-again");
    let Decision::Permitted(_) = engine.evaluate(&mut trajectory, ping_request(body2)) else {
        panic!("a second egress is downhill and permits without another acceptance");
    };
}

/// An authority competent for every lift *except* `acquire_effects` gets no
/// Accept route: the growth blocks terminally.
#[test]
fn acquire_incompetent_authority_gets_no_accept_route() {
    let mut engine = engine_with([egress_tool()]);
    engine
        .register_authority(external_authority(
            "no-acquire",
            crate::transition::AuthorityMandate {
                trust: Some(KnownTrust::Trusted),
                audience: Some(BTreeSet::from([user("alice")])),
                waive_prior_effects: true,
                confirms: true,
                acknowledge_unknown: true,
                may_release_control: true,
                acquire_effects: false,
            },
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, ping_request(body)) else {
        panic!("without acquire_effects the growth cannot be routed");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

/// Acceptance is idempotent: after the marker is recorded, re-entry with the
/// same original permits without a second acquisition or audit event.
#[test]
fn accept_re_entry_writes_no_duplicate_audit() {
    let mut engine = engine_with([egress_tool()]);
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let request = ping_request(body);
    let plans = remediable(&engine, &mut trajectory, request.clone());
    let StepOutcome::Advanced(Decision::Permitted(_)) = apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected a permit after acceptance");
    };
    let accepts = |t: &Trajectory| {
        t.state()
            .audit()
            .iter()
            .filter(|e| matches!(e, AuditEvent::AcceptApplied { .. }))
            .count()
    };
    assert_eq!(accepts(&trajectory), 1);
    let Decision::Permitted(_) = engine.evaluate(&mut trajectory, request) else {
        panic!("re-entry after acceptance should permit idempotently");
    };
    assert_eq!(accepts(&trajectory), 1);
}

// ---- S7: ExitKind categorization + cap fairness ----

fn tref(id: &str) -> crate::value::TransformerRef {
    crate::value::TransformerRef {
        id: id.into(),
        version: 1,
    }
}

fn plan_steps(kinds: Vec<TransitionKind>) -> NonEmptyVec<TransitionSpec> {
    NonEmptyVec::from_vec(
        kinds
            .into_iter()
            .map(|kind| TransitionSpec {
                precondition: Posture::clean(),
                postcondition: Posture::clean(),
                kind,
            })
            .collect(),
    )
    .expect("non-empty")
}

/// A route's category is its decisive (most authority-dependent) step; a
/// composite is categorized by that step, not its first.
#[test]
fn exit_kind_is_the_decisive_step() {
    let transform = TransitionKind::Derive {
        source: ValueId::new(0),
        justification: Justification::Content(tref("s")),
    };
    let constrain = TransitionKind::ConstrainAction { transition: tref("c") };
    let accept = TransitionKind::AcceptGrowth {
        effects: Effects::declared([Effect::Egress]),
    };
    let waiver = TransitionKind::ApplyWaiver {
        delta: crate::transition::TransientWaiver::empty(),
    };
    assert_eq!(
        ExitKind::decisive(&plan_steps(vec![transform.clone()])),
        ExitKind::Sanitize
    );
    assert_eq!(
        ExitKind::decisive(&plan_steps(vec![constrain.clone()])),
        ExitKind::Constrain
    );
    assert_eq!(ExitKind::decisive(&plan_steps(vec![accept.clone()])), ExitKind::Accept);
    assert_eq!(
        ExitKind::decisive(&plan_steps(vec![waiver.clone()])),
        ExitKind::WaiverOrAcknowledge
    );
    // [constrain -> accept] is decided by the accept.
    assert_eq!(
        ExitKind::decisive(&plan_steps(vec![constrain, accept])),
        ExitKind::Accept
    );
    // [transform -> waiver] is decided by the waiver.
    assert_eq!(
        ExitKind::decisive(&plan_steps(vec![transform, waiver])),
        ExitKind::WaiverOrAcknowledge
    );
}

/// With more routes than the cap but no more categories than the cap, fair
/// selection keeps one route of every category — a flat truncation would
/// let the many Sanitize routes starve the rest.
#[test]
fn cap_fairness_keeps_one_route_per_category() {
    let clean = Posture::clean();
    let mut pool: Vec<(NonEmptyVec<TransitionSpec>, Posture)> = Vec::new();
    for i in 0..6u64 {
        pool.push((
            plan_steps(vec![TransitionKind::Derive {
                source: ValueId::new(i),
                justification: Justification::Content(tref("s")),
            }]),
            clean.clone(),
        ));
    }
    pool.push((
        plan_steps(vec![TransitionKind::ConstrainAction { transition: tref("c") }]),
        clean.clone(),
    ));
    pool.push((
        plan_steps(vec![TransitionKind::AcceptGrowth {
            effects: Effects::declared([Effect::Egress]),
        }]),
        clean.clone(),
    ));
    pool.push((
        plan_steps(vec![TransitionKind::ApplyWaiver {
            delta: crate::transition::TransientWaiver::empty(),
        }]),
        clean.clone(),
    ));
    // 9 routes, 4 categories, cap 4.
    let selected = select_fair(pool, 4);
    assert_eq!(selected.len(), 4);
    let categories: BTreeSet<ExitKind> = selected.iter().map(|(steps, _)| ExitKind::decisive(steps)).collect();
    assert_eq!(
        categories,
        BTreeSet::from([
            ExitKind::Sanitize,
            ExitKind::Constrain,
            ExitKind::Accept,
            ExitKind::WaiverOrAcknowledge,
        ])
    );
}

// ---- S8: Constrain <-> Accept composition ----

/// A flow that BOTH breaches a sink (suspicious payload at a Trusted-
/// requiring tool) AND grows the surface ({Egress, Mutation}) composes a
/// Constrain (fixing the trust breach and dropping Mutation) with an Accept
/// of the *residual* growth. Accept is computed on the reduced effects, so
/// it acquires only {Egress}; a full constrain to no effects leaves no
/// Accept step at all.
#[test]
fn constrain_then_accept_covers_only_the_residual_growth() {
    let export = ToolContract {
        name: ToolName::new("db.export"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress, Effect::Mutation]),
        arguments: ArgumentSchema::opaque(),
    };
    let readonly = ToolContract {
        name: ToolName::new("db.export.readonly"),
        requires: Some(Requirements::default()),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress]),
        arguments: ArgumentSchema::opaque(),
    };
    let noop = ToolContract {
        name: ToolName::new("db.export.noop"),
        requires: Some(Requirements::default()),
        output_label: ValueLabel::identity(),
        effects: Effects::none(),
        arguments: ArgumentSchema::opaque(),
    };
    let mut engine = engine_with([export, readonly, noop]);
    engine
        .register_action_transition(ActionTransition {
            id: tref("readonly"),
            from_tool: ToolName::new("db.export"),
            to_tool: ToolName::new("db.export.readonly"),
            effects: Effects::declared([Effect::Egress]),
        })
        .unwrap();
    engine
        .register_action_transition(ActionTransition {
            id: tref("noop"),
            from_tool: ToolName::new("db.export"),
            to_tool: ToolName::new("db.export.noop"),
            effects: Effects::none(),
        })
        .unwrap();
    // Only an effect-acquirer is registered — no trust authority — so the
    // trust breach can be cleared *only* by a constrain, never a waiver.
    engine.register_authority(inline_acquirer()).unwrap();

    let mut trajectory = Trajectory::new();
    let payload = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "rows");
    let request = ToolRequest::new(
        ToolName::new("db.export"),
        ArgumentTree::Value(payload),
        BTreeSet::new(),
    );
    let plans = remediable(&engine, &mut trajectory, request.clone());

    // The readonly route constrains first, then accepts *only* {Egress}.
    let composite = plans
        .iter()
        .find(|p| {
            matches!(
                &p.steps.first().kind,
                TransitionKind::ConstrainAction { transition } if *transition == tref("readonly")
            )
        })
        .expect("a constrain-to-readonly route");
    assert_eq!(composite.exit_kind(), ExitKind::Accept);
    assert_eq!(composite.steps.len(), 2);
    assert!(matches!(
        &composite.steps.get(1).unwrap().kind,
        TransitionKind::AcceptGrowth { effects } if *effects == Effects::declared([Effect::Egress])
    ));

    // The full constrain to no effects leaves nothing to accept.
    let full = plans
        .iter()
        .find(|p| {
            matches!(
                &p.steps.first().kind,
                TransitionKind::ConstrainAction { transition } if *transition == tref("noop")
            )
        })
        .expect("a constrain-to-noop route");
    assert_eq!(full.exit_kind(), ExitKind::Constrain);
    assert_eq!(full.steps.len(), 1);

    // Walking the composite commits exactly the reduced effect.
    let mut decision = engine.evaluate(&mut trajectory, request);
    let token = loop {
        match decision {
            Decision::Permitted(token) => break token,
            Decision::Blocked(Blocked::Remediable { plans, .. }) => {
                let plan = plans
                    .iter()
                    .find(|p| !matches!(&p.steps.first().kind, TransitionKind::ConstrainAction { transition } if *transition == tref("noop")))
                    .expect("the readonly/accept continuation");
                decision = match apply_first_step(&engine, &mut trajectory, plan.id) {
                    StepOutcome::Advanced(decision) => decision,
                    other => panic!("unexpected step outcome: {other:?}"),
                };
            }
            other => panic!("expected to reach a permit, got {other:?}"),
        }
    };
    // Both steps ran at runtime — the constrain, then the acquisition of the
    // reduced growth — not merely predicted by the planner.
    let audit = trajectory.state().audit();
    assert!(audit.iter().any(|e| matches!(e, AuditEvent::ActionConstrained { .. })));
    assert!(audit.iter().any(
        |e| matches!(e, AuditEvent::AcceptApplied { effects, .. } if *effects == Effects::declared([Effect::Egress]))
    ));
    dispatch(&mut trajectory, token, "exported").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
}

/// The discriminant of a step's kind, for asserting the order steps ran.
fn step_label(kind: &TransitionKind) -> &'static str {
    match kind {
        TransitionKind::Derive {
            justification: Justification::Content(_),
            ..
        } => "sanitize",
        TransitionKind::ConstrainAction { .. } => "constrain",
        TransitionKind::Derive {
            justification: Justification::Fiat { .. },
            ..
        } => "endorse",
        TransitionKind::AcceptGrowth { .. } => "accept",
        TransitionKind::ApplyWaiver { .. } => "waiver",
    }
}

/// The full composition across both axes: a flow too suspicious (Sanitize),
/// too narrow (Endorse), too broad in effect (Constrain), and still
/// surface-growing (Accept). Each reduction shrinks what the next authority
/// signs off — Endorse vouches only the audience Sanitize left, Accept
/// acquires only the growth Constrain left — and all four run at runtime.
#[test]
fn full_composition_reduces_then_authorizes_the_irreducible_residual() {
    fn launder(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
        Ok(OpaqueValue::new("[laundered]"))
    }
    let dispatch_tool = ToolContract {
        name: ToolName::new("dispatch"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress, Effect::Mutation]),
        arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
    };
    // The constrained target: email.send drops Mutation (effects {Egress})
    // but keeps the trusted-and-in-context requirement.
    let mut engine = engine_with([dispatch_tool, email_contract()]);
    // Sanitize fixes only trust (SUSPICIOUS -> TRUSTED), leaving the narrow
    // audience for Endorse.
    engine
        .register_transformer(RegisteredTransformer {
            descriptor: crate::transition::TransformerDescriptor {
                transformer: crate::value::TransformerRef {
                    id: "detox".to_owned(),
                    version: 1,
                },
                precondition: crate::transition::LabelPredicate {
                    trust: Some(Trust::SUSPICIOUS),
                    audience: None,
                },
                output: ValueLabel {
                    audience: Audience::readers([user("alice")]),
                    trust: Trust::TRUSTED,
                },
            },
            run: launder,
        })
        .unwrap();
    engine
        .register_action_transition(ActionTransition {
            id: tref("egress-only"),
            from_tool: ToolName::new("dispatch"),
            to_tool: ToolName::new("email.send"),
            effects: Effects::declared([Effect::Egress]),
        })
        .unwrap();
    // The voucher may raise audience but not trust, so Sanitize is the only
    // way to clear the trust breach; the acquirer takes the residual growth.
    engine
        .register_authority(inline_authority(
            "voucher",
            crate::transition::AuthorityMandate {
                audience: Some(BTreeSet::from([user("alice"), user("charlie")])),
                ..crate::transition::AuthorityMandate::none()
            },
            approve_all,
        ))
        .unwrap();
    engine.register_authority(inline_acquirer()).unwrap();

    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "raw");
    let to = identity_ingress(&mut trajectory, "charlie");
    let request = ToolRequest::new(
        ToolName::new("dispatch"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::new(),
    );

    let plans = remediable(&engine, &mut trajectory, request);

    // The composite route is all four steps in canonical order, each
    // authority signing off only the reduced residual.
    let composite = plans.iter().max_by_key(|p| p.steps.len()).expect("a plan");
    let kinds: Vec<&str> = composite.steps.iter().map(|s| step_label(&s.kind)).collect();
    assert_eq!(kinds, ["sanitize", "constrain", "endorse", "accept"]);
    assert_eq!(composite.exit_kind(), ExitKind::Endorse);
    // Endorse signs off only the audience — trust was reduced by Sanitize.
    let endorse = composite
        .steps
        .iter()
        .find_map(|s| match &s.kind {
            TransitionKind::Derive {
                justification: Justification::Fiat { delta, .. },
                ..
            } => Some(delta),
            _ => None,
        })
        .expect("an endorse step");
    assert_eq!(endorse.trust, None);
    assert_eq!(endorse.audience.as_ref().unwrap(), &BTreeSet::from([user("charlie")]));
    // Accept acquires only {Egress} — Mutation was reduced by Constrain.
    let accept = composite
        .steps
        .iter()
        .find_map(|s| match &s.kind {
            TransitionKind::AcceptGrowth { effects } => Some(effects),
            _ => None,
        })
        .expect("an accept step");
    assert_eq!(accept, &Effects::declared([Effect::Egress]));

    // Walk the most-composed route to a permit; all four steps run.
    let mut applied: Vec<&str> = Vec::new();
    let mut plans = plans;
    let token = loop {
        let plan = plans.iter().max_by_key(|p| p.steps.len()).expect("a plan");
        applied.push(step_label(&plan.steps.first().kind));
        match apply_first_step(&engine, &mut trajectory, plan.id) {
            StepOutcome::Advanced(Decision::Permitted(token)) => break token,
            StepOutcome::Advanced(Decision::Blocked(Blocked::Remediable { plans: next, .. })) => plans = next,
            other => panic!("unexpected outcome: {other:?}"),
        }
    };
    assert_eq!(applied, ["sanitize", "constrain", "endorse", "accept"]);
    // Only the reduced effect commits.
    dispatch(&mut trajectory, token, "sent").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));
}

/// A pool already within the cap is returned unchanged (order preserved).
#[test]
fn cap_fairness_is_a_noop_within_the_cap() {
    let clean = Posture::clean();
    let pool: Vec<(NonEmptyVec<TransitionSpec>, Posture)> = vec![
        (
            plan_steps(vec![TransitionKind::ConstrainAction { transition: tref("c") }]),
            clean.clone(),
        ),
        (
            plan_steps(vec![TransitionKind::ApplyWaiver {
                delta: crate::transition::TransientWaiver::empty(),
            }]),
            clean.clone(),
        ),
    ];
    let selected = select_fair(pool.clone(), MAX_PLANS);
    assert_eq!(selected, pool);
}

/// End-to-end through `enumerate_plans`: many Constrain routes are generated
/// before the single (late) Sanitize route, exceeding MAX_PLANS. Fair
/// selection must still surface the Sanitize category — a flat truncation, or
/// a generation cap that stopped before the sanitizer, would drop it.
#[test]
fn cap_fairness_rescues_a_late_category_end_to_end() {
    let sink = ToolContract {
        name: ToolName::new("sink"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::none(),
        arguments: ArgumentSchema::opaque(),
    };
    let variants = MAX_PLANS + 2;
    let mut contracts = vec![sink];
    for i in 0..variants {
        contracts.push(ToolContract {
            name: ToolName::new(format!("sink.v{i}")),
            requires: Some(Requirements::default()),
            output_label: ValueLabel::identity(),
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        });
    }
    let mut engine = engine_with(contracts);
    for i in 0..variants {
        engine
            .register_action_transition(ActionTransition {
                id: tref(&format!("c{i}")),
                from_tool: ToolName::new("sink"),
                to_tool: ToolName::new(format!("sink.v{i}")),
                effects: Effects::none(),
            })
            .unwrap();
    }
    // One transformer clears the trust breach content-wise — the sole,
    // late-generated Sanitize route.
    engine.register_transformer(redact_transformer()).unwrap();

    let mut trajectory = Trajectory::new();
    let payload = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "raw");
    let request = ToolRequest::new(ToolName::new("sink"), ArgumentTree::Value(payload), BTreeSet::new());
    let plans = remediable(&engine, &mut trajectory, request);
    assert!(plans.len() <= MAX_PLANS);
    assert!(
        plans.iter().any(|p| p.exit_kind() == ExitKind::Sanitize),
        "fair selection must keep the late-generated Sanitize route"
    );
    assert!(plans.iter().any(|p| p.exit_kind() == ExitKind::Constrain));
}

/// An external waiver round-trips through PendingApproval; approval
/// permits, and the whole loop is audited. Uses a control-borne breach so
/// the residual is a control-release waiver (an arg-borne breach would route
/// to Endorse instead).
#[test]
fn external_waiver_approval_roundtrip() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    // A control selector narrows the flow audience below the recipient, so
    // the residual is a control release rather than a value relabel.
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let secret = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "selector");
    let to = identity_ingress(&mut trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::from([secret]),
    );

    let plans = remediable(&engine, &mut trajectory, request);
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("expected pending approval");
    };
    assert_eq!(pending.authority().as_str(), "human");

    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "reviewed".to_owned(),
            },
        )
        .unwrap();
    assert!(matches!(decision, Decision::Permitted(_)));
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::ApprovalRequested { .. }))
    );
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::WaiverApplied { .. }))
    );
}

/// An inline authority reads the trajectory view (a value's label) and the
/// violations to decide, and abstains when the view fails its check.
#[test]
fn inline_authority_inspects_the_view_and_violations() {
    // Auto-vouch an audience expansion only when the trajectory's first
    // ingress (the document under review) is itself trusted.
    fn vouch_trusted_source(
        grant: &crate::transition::ProposedGrant,
        violations: &[Violation],
        view: &crate::approval::TrajectoryView,
    ) -> Option<crate::approval::Ruling> {
        let audience_breach = violations
            .iter()
            .any(|v| matches!(v, Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })));
        let source_trusted = view
            .label(crate::revision::ValueId::new(0))
            .is_some_and(|label| label.trust == Trust::TRUSTED);
        if audience_breach && source_trusted && matches!(grant, crate::transition::ProposedGrant::Endorse { .. }) {
            Some(crate::approval::Ruling::Approve {
                reason: "source document is trusted".to_owned(),
            })
        } else {
            None
        }
    }
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("vouch", human().mandate, vouch_trusted_source))
        .unwrap();

    // Trusted source (value#0): the view read passes, the authority approves.
    let mut trusted = Trajectory::new();
    trusted.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut trusted, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trusted, doc, "charlie");
    let plans = remediable(&engine, &mut trusted, request);
    let StepOutcome::Advanced(Decision::Permitted(_)) = apply_first_step(&engine, &mut trusted, plans.first().id)
    else {
        panic!("expected approval when the view shows a trusted source");
    };

    // Suspicious source: same audience breach, but the view read fails the
    // trust check, so the authority abstains and no ruling is produced.
    let mut suspicious = Trajectory::new();
    suspicious.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut suspicious, &["alice"], Trust::SUSPICIOUS, "private");
    let request = email_request(&mut suspicious, doc, "charlie");
    let plans = remediable(&engine, &mut suspicious, request);
    let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
        apply_first_step(&engine, &mut suspicious, plans.first().id)
    else {
        panic!("expected abstention when the view shows a suspicious source");
    };
    assert_eq!(block.reason, BlockReason::NoAuthorityRuled);
}

/// An external pending approval carries an owned *transitive* ancestry
/// snapshot — the labels and provenance of the values in scope and every
/// value they derive from, never bytes — and the round-trip completes on
/// approval. The endorsed value is laundered trusted, but its suspicious
/// root is two provenance edges back: only a transitive snapshot surfaces it.
#[test]
fn external_pending_carries_a_transitive_ancestry_snapshot() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let root = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "raw");
    let trusted = ValueLabel {
        audience: Audience::readers([user("alice")]),
        trust: Trust::TRUSTED,
    };
    let mid = trajectory.seed_transformed(root, trusted.clone());
    let doc = trajectory.seed_transformed(mid, trusted);
    let request = email_request(&mut trajectory, doc, "charlie");

    let plans = remediable(&engine, &mut trajectory, request);
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("expected pending approval");
    };
    // The direct endorsed value and its transitive root are both in scope.
    let doc_view = pending.ancestry().get(doc).expect("the endorsed value is in scope");
    assert_eq!(doc_view.label.trust, Trust::TRUSTED);
    let root_view = pending
        .ancestry()
        .get(root)
        .expect("the transitive root is in the snapshot");
    assert_eq!(root_view.label.trust, Trust::SUSPICIOUS);
    assert!(matches!(root_view.provenance, crate::value::Provenance::Ingress { .. }));

    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "reviewed the ancestry".to_owned(),
            },
        )
        .unwrap();
    assert!(matches!(decision, Decision::Permitted(_)));
}

/// A denial blocks terminally and is audited; the identical later flow
/// escalates afresh (nothing was stored loosened).
#[test]
fn external_waiver_denial_blocks_terminally() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");

    let plans = remediable(&engine, &mut trajectory, request.clone());
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("expected pending approval");
    };
    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Deny {
                reason: "not comfortable".to_owned(),
            },
        )
        .unwrap();
    let Decision::Blocked(Blocked::Terminal(block)) = decision else {
        panic!("expected terminal block");
    };
    assert!(matches!(block.reason, BlockReason::DeniedByAuthority { .. }));
    // The audience-breach route is an Endorse, so the external denial is
    // attributed as one.
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::EndorseDenied { .. }))
    );
    assert!(trajectory.pending_action().is_none());

    // The same flow escalates again from scratch: the denial loosened
    // and stored nothing.
    assert!(matches!(
        engine.evaluate(&mut trajectory, request),
        Decision::Blocked(Blocked::Remediable { .. })
    ));
}

/// Stale and foreign step capabilities and approvals are refused without
/// touching state.
#[test]
fn stale_and_foreign_step_capabilities_are_refused() {
    let mut engine = engine_with([email_contract()]);
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");

    let plans = remediable(&engine, &mut trajectory, request);
    let plan = plans.first().id;
    let capability = engine.mint_step(&trajectory, plan, 0).unwrap();

    // Any state change stales the capability (and the plan itself).
    trajectory
        .admit_model_output(OpaqueValue::new("thinking"), BTreeSet::from([doc]), BTreeSet::new())
        .unwrap();
    let revision_before = trajectory.revision();
    assert!(matches!(
        engine.apply_step(&mut trajectory, capability),
        Err(StepRefused::StalePlan { .. })
    ));
    assert!(matches!(
        engine.mint_step(&trajectory, plan, 0),
        Err(StepRefused::StalePlan { .. })
    ));
    // Refusal touched nothing.
    assert_eq!(trajectory.revision(), revision_before);

    // A stale approval is likewise refused.
    trajectory.abandon_pending();
    let retry = email_request(&mut trajectory, doc, "charlie");
    let plans = remediable(&engine, &mut trajectory, retry);
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("expected pending approval");
    };
    trajectory
        .admit_model_output(OpaqueValue::new("more"), BTreeSet::from([doc]), BTreeSet::new())
        .unwrap();
    assert!(matches!(
        engine.apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "late".to_owned()
            }
        ),
        Err(StepRefused::StalePlan { .. })
    ));
}

/// A transformer error fails the step, audits the failure with no
/// derived value, and advances the revision (staling siblings).
#[test]
fn transformer_error_fails_the_step_and_audits() {
    fn broken(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
        Err(crate::transition::TransformerError {
            message: "redactor crashed".to_owned(),
        })
    }
    let mut engine = engine_with([email_contract()]);
    let mut transformer = redact_transformer();
    transformer.run = broken;
    engine.register_transformer(transformer).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let raw = ingress(&mut trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "raw");
    let request = email_request(&mut trajectory, raw, "bob");

    let plans = remediable(&engine, &mut trajectory, request);
    let values_before = trajectory.store().len();
    let revision_before = trajectory.revision();
    let outcome = apply_first_step(&engine, &mut trajectory, plans.first().id);
    assert!(matches!(
        outcome,
        StepOutcome::Failed(crate::audit::TransitionFailure::TransformerError { .. })
    ));
    assert_eq!(trajectory.store().len(), values_before);
    assert!(trajectory.revision() > revision_before);
    assert!(matches!(
        trajectory.state().audit(),
        [AuditEvent::ValueTransition {
            derived: None,
            outcome: crate::audit::TransitionOutcome::Failed(_),
            ..
        }]
    ));
}

/// The design's canonical composition across re-planning rounds:
/// Transform -> (replan) -> Waiver -> recheck -> Permit.
#[test]
fn multi_step_composition_transform_then_waiver() {
    // This redactor establishes trust but cannot widen the audience:
    // its output stays readable by alice only.
    fn redact(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
        Ok(OpaqueValue::new("[redacted]"))
    }
    let mut engine = engine_with([email_contract()]);
    engine
        .register_transformer(RegisteredTransformer {
            descriptor: crate::transition::TransformerDescriptor {
                transformer: crate::value::TransformerRef {
                    id: "pii.redact.private".into(),
                    version: 1,
                },
                precondition: crate::transition::LabelPredicate {
                    trust: Some(Trust::SUSPICIOUS),
                    audience: None,
                },
                output: ValueLabel {
                    audience: Audience::readers([user("alice")]),
                    trust: Trust::TRUSTED,
                },
            },
            run: redact,
        })
        .unwrap();
    engine.register_authority(human()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    // Suspicious AND readable only by alice, sent to charlie: needs both
    // a transform (trust) and a waiver (audience).
    let raw = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "raw");
    let request = email_request(&mut trajectory, raw, "charlie");

    let plans = remediable(&engine, &mut trajectory, request);
    // A two-step plan predicting the full route exists...
    assert!(plans.iter().any(|p| p.steps.len() == 2));
    // ...and application goes step by step, re-planning in between.
    let transform_plan = plans
        .iter()
        .find(|p| {
            matches!(
                &p.steps.first().kind,
                TransitionKind::Derive {
                    justification: Justification::Content(_),
                    ..
                }
            )
        })
        .expect("plan starting with a transform");
    let StepOutcome::Advanced(Decision::Blocked(Blocked::Remediable { plans, violations })) =
        apply_first_step(&engine, &mut trajectory, transform_plan.id)
    else {
        panic!("expected the transform to advance to a re-planned block");
    };
    // Only the audience breach remains.
    assert!(matches!(
        violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })]
    ));
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("expected pending approval");
    };
    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "redacted version may go out".to_owned(),
            },
        )
        .unwrap();
    let Decision::Permitted(token) = decision else {
        panic!("expected permit after the full composition");
    };
    let (canonical, receipt) = trajectory.release(token).unwrap();
    assert!(canonical.rendered.contains("[redacted]"));
    trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
}

/// A confirmation survives remedy steps on the confirmed action and is
/// spent only at release (decision 12).
#[test]
fn confirmation_survives_remedy_steps() {
    let drop_contract = ToolContract {
        name: ToolName::new("db.drop"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            attention: crate::contract::AttentionRule::ExplicitConfirmation,
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Mutation]),
        arguments: ArgumentSchema::opaque(),
    };
    let mut engine = engine_with([drop_contract]);
    engine.register_transformer(redact_transformer()).unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Mutation]));
    let table = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "users_table");
    trajectory.ingress(
        crate::turn::Speaker::confirming(user("alice"), ToolName::new("db.drop")),
        ValueLabel::identity(),
        OpaqueValue::new("yes, drop it"),
    );
    let request = ToolRequest::new(ToolName::new("db.drop"), ArgumentTree::Value(table), BTreeSet::new());

    // Blocked on trust only — the confirmation holds.
    let Decision::Blocked(Blocked::Remediable { violations, plans }) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected remediable block");
    };
    assert!(matches!(
        violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::TrustBelow { .. })]
    ));
    let StepOutcome::Advanced(Decision::Permitted(token)) =
        apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected permit — the confirmation must survive the transform");
    };
    assert!(trajectory.pending_confirmation().is_some());
    let (_, receipt) = trajectory.release(token).unwrap();
    // Release spends it.
    assert_eq!(trajectory.pending_confirmation(), None);
    trajectory.record_output(receipt, OpaqueValue::new("dropped")).unwrap();
}

#[test]
fn authorities_share_one_name_space() {
    let none = crate::transition::AuthorityMandate::none;
    let mut engine = PolicyEngine::new();
    engine
        .register_authority(inline_authority("gate", none(), approve_all))
        .unwrap();
    // The same name is refused regardless of mode.
    assert!(
        engine
            .register_authority(inline_authority("gate", none(), approve_all))
            .is_err()
    );
    assert!(engine.register_authority(external_authority("gate", none())).is_err());
}

/// A capability minted under one engine's registries never resolves
/// against another's — even one configured identically.
#[test]
fn capabilities_are_bound_to_their_engine() {
    let mut engine_a = engine_with([email_contract()]);
    engine_a.register_authority(human()).unwrap();
    // Engine B registers the same names — a different trust domain.
    let mut engine_b = engine_with([email_contract()]);
    engine_b.register_authority(human()).unwrap();

    let mut trajectory = Trajectory::new();
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "private");
    let request = email_request(&mut trajectory, doc, "charlie");
    let plans = remediable(&engine_a, &mut trajectory, request);

    // B can neither mint nor apply against A's stored plan.
    assert!(matches!(
        engine_b.mint_step(&trajectory, plans.first().id, 0),
        Err(StepRefused::ForeignEngine { .. })
    ));
    let capability = engine_a.mint_step(&trajectory, plans.first().id, 0).unwrap();
    assert!(matches!(
        engine_b.apply_step(&mut trajectory, capability),
        Err(StepRefused::ForeignEngine { .. })
    ));

    // Nor can B consume A's pending approval.
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine_a, &mut trajectory, plans.first().id) else {
        panic!("expected pending approval");
    };
    assert!(matches!(
        engine_b.apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "cross-domain".to_owned()
            }
        ),
        Err(StepRefused::ForeignEngine { .. })
    ));
}

/// An action transition whose declared effects disagree with the target
/// contract is never planned: the narrowing baton validates must be what
/// the target actually does.
#[test]
fn constrain_with_mismatched_target_effects_is_not_planned() {
    let fetch = ToolContract {
        name: ToolName::new("web.fetch"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress]),
        arguments: ArgumentSchema::opaque(),
    };
    // The target contract says it mutates; the transition claims no
    // effects. The narrowing claim and reality disagree.
    let cached = ToolContract {
        name: ToolName::new("web.fetch.cached"),
        requires: Some(Requirements::default()),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Mutation]),
        arguments: ArgumentSchema::opaque(),
    };
    let mut engine = engine_with([fetch, cached]);
    engine
        .register_action_transition(ActionTransition {
            id: crate::value::TransformerRef {
                id: "cache-only".into(),
                version: 1,
            },
            from_tool: ToolName::new("web.fetch"),
            to_tool: ToolName::new("web.fetch.cached"),
            effects: Effects::none(),
        })
        .unwrap();
    let mut trajectory = Trajectory::new();
    let url = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "http://x");
    let request = ToolRequest::new(ToolName::new("web.fetch"), ArgumentTree::Value(url), BTreeSet::new());

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block — the inconsistent mapping must not be planned");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

/// A constrained action's narrowed effects are what release commits, and
/// a later effect-sensitive sink sees exactly them.
#[test]
fn constrained_effects_survive_to_release_and_later_sinks() {
    let fetch = ToolContract {
        name: ToolName::new("web.fetch"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress]),
        arguments: ArgumentSchema::opaque(),
    };
    let cached = ToolContract {
        name: ToolName::new("web.fetch.cached"),
        requires: Some(Requirements::default()),
        output_label: ValueLabel::identity(),
        effects: Effects::none(),
        arguments: ArgumentSchema::opaque(),
    };
    let report = ToolContract {
        name: ToolName::new("report.generate"),
        requires: Some(Requirements {
            forbid_prior_effects: BTreeSet::from([Effect::Egress]),
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::none(),
        arguments: ArgumentSchema::opaque(),
    };
    let mut engine = engine_with([fetch, cached, report]);
    engine
        .register_action_transition(ActionTransition {
            id: crate::value::TransformerRef {
                id: "cache-only".into(),
                version: 1,
            },
            from_tool: ToolName::new("web.fetch"),
            to_tool: ToolName::new("web.fetch.cached"),
            effects: Effects::none(),
        })
        .unwrap();
    let mut trajectory = Trajectory::new();
    let url = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "http://x");
    let request = ToolRequest::new(ToolName::new("web.fetch"), ArgumentTree::Value(url), BTreeSet::new());

    let plans = remediable(&engine, &mut trajectory, request);
    let constrain = plans
        .iter()
        .find(|p| matches!(&p.steps.first().kind, TransitionKind::ConstrainAction { .. }))
        .expect("constrain plan");
    let StepOutcome::Advanced(Decision::Permitted(token)) = apply_first_step(&engine, &mut trajectory, constrain.id)
    else {
        panic!("expected the constraint to clear the flow");
    };
    let (canonical, receipt) = trajectory.release(token).unwrap();
    assert_eq!(canonical.tool, ToolName::new("web.fetch.cached"));
    // The narrowed (empty) effects were committed, not the original
    // tool's egress.
    assert_eq!(trajectory.state().past_effects(), &Effects::none());
    trajectory
        .record_output(receipt, OpaqueValue::new("cached page"))
        .unwrap();

    // An egress-forbidding sink is satisfied: no egress ever happened.
    let doc = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "notes");
    let report_request = ToolRequest::new(
        ToolName::new("report.generate"),
        ArgumentTree::Value(doc),
        BTreeSet::new(),
    );
    assert!(matches!(
        engine.evaluate(&mut trajectory, report_request),
        Decision::Permitted(_)
    ));
}

/// After release, a dispatch is in flight: re-evaluating the same request
/// must NOT re-permit the action, and a second release is refused. This
/// closes the double-dispatch hole (release advances the revision, so a
/// naive re-entry would mint a fresh valid token).
#[test]
fn released_action_cannot_be_re_permitted_or_re_released() {
    let engine = engine_with([email_contract()]);
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let doc = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "doc");
    let request = email_request(&mut trajectory, doc, "bob");

    let Decision::Permitted(token1) = engine.evaluate(&mut trajectory, request.clone()) else {
        panic!("expected permit");
    };
    let (_, receipt) = trajectory.release(token1).unwrap();

    // Re-entry while the dispatch is in flight is refused, not re-permitted.
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected the released action to block re-entry");
    };
    assert!(matches!(block.reason, BlockReason::ActionAlreadyPending { .. }));

    // The outstanding receipt still closes the action normally.
    trajectory.record_output(receipt, OpaqueValue::new("sent")).unwrap();
    assert!(trajectory.pending_action().is_none());
}

/// Re-evaluating an unprovable flow is idempotent: acknowledgment happens
/// at application (once, on a consumed capability), so evaluation — first
/// or re-entrant — writes no acknowledgment audit.
#[test]
fn unprovable_re_entry_writes_no_audit() {
    let mut engine = engine_with([]);
    engine
        .register_authority(inline_authority(
            "accept-unknowns",
            crate::transition::AuthorityMandate {
                acknowledge_unknown: true,
                ..crate::transition::AuthorityMandate::none()
            },
            approve_all,
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::UNKNOWN);
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
    let request = ToolRequest::new(
        ToolName::new("mystery.tool"),
        ArgumentTree::Value(body),
        BTreeSet::new(),
    );

    let waiver_audits = |trajectory: &Trajectory| {
        trajectory
            .state()
            .audit()
            .iter()
            .filter(|e| matches!(e, AuditEvent::WaiverApplied { .. }))
            .count()
    };

    let Decision::Blocked(Blocked::Remediable { .. }) = engine.evaluate(&mut trajectory, request.clone()) else {
        panic!("expected a remediable block");
    };
    assert_eq!(waiver_audits(&trajectory), 0);
    // Re-evaluate the same original request: still remediable, still no audit.
    let Decision::Blocked(Blocked::Remediable { .. }) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected a remediable block on re-entry");
    };
    assert_eq!(waiver_audits(&trajectory), 0);
}

// ---- Denial audit attribution per grant kind ----

fn deny_all(
    _: &crate::transition::ProposedGrant,
    _: &[Violation],
    _: &crate::approval::TrajectoryView,
) -> Option<crate::approval::Ruling> {
    Some(crate::approval::Ruling::Deny {
        reason: "denied".to_owned(),
    })
}

fn acquirer_mandate() -> crate::transition::AuthorityMandate {
    crate::transition::AuthorityMandate {
        acquire_effects: true,
        ..crate::transition::AuthorityMandate::none()
    }
}

fn releaser_mandate() -> crate::transition::AuthorityMandate {
    crate::transition::AuthorityMandate {
        may_release_control: true,
        ..crate::transition::AuthorityMandate::none()
    }
}

/// A control-tainted flow whose only route is a control-release waiver:
/// clean payload, one masking control dep, prior egress already committed.
fn control_release_scenario(trajectory: &mut Trajectory) -> ToolRequest {
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let secret = ingress(trajectory, &["alice"], Trust::TRUSTED, "secret");
    let body = ingress(trajectory, &["alice", "bob"], Trust::TRUSTED, "harmless");
    let to = identity_ingress(trajectory, "bob");
    ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::from([secret]),
    )
}

/// Denying an Accept step inline audits `AcceptDenied`, not a generic
/// waiver denial.
#[test]
fn an_inline_accept_denial_audits_accept_denied() {
    let mut engine = engine_with([egress_tool()]);
    engine
        .register_authority(inline_authority("growth-denier", acquirer_mandate(), deny_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let plans = remediable(&engine, &mut trajectory, ping_request(body));
    let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
        apply_first_step(&engine, &mut trajectory, plans.first().id)
    else {
        panic!("expected terminal denial");
    };
    assert!(matches!(block.reason, BlockReason::DeniedByAuthority { .. }));
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::AcceptDenied { .. }))
    );
    assert!(
        !trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::WaiverDenied { .. }))
    );
}

/// Denying an Accept through the external approval path audits
/// `AcceptDenied` too — the attribution match is shared by both paths.
#[test]
fn an_external_accept_denial_audits_accept_denied() {
    let mut engine = engine_with([egress_tool()]);
    engine
        .register_authority(external_authority("remote-acquirer", acquirer_mandate()))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "ping");
    let plans = remediable(&engine, &mut trajectory, ping_request(body));
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plans.first().id) else {
        panic!("expected pending approval");
    };
    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Deny {
                reason: "denied".to_owned(),
            },
        )
        .unwrap();
    assert!(matches!(decision, Decision::Blocked(Blocked::Terminal(_))));
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::AcceptDenied { .. }))
    );
}

/// Denying a control-release waiver inline audits `WaiverDenied`.
#[test]
fn an_inline_control_release_denial_audits_waiver_denied() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(inline_authority("release-denier", releaser_mandate(), deny_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let request = control_release_scenario(&mut trajectory);
    let plans = remediable(&engine, &mut trajectory, request);
    let plan = plans
        .iter()
        .find(|p| matches!(p.steps.first().kind, TransitionKind::ApplyWaiver { .. }))
        .expect("a control-release route");
    let StepOutcome::Advanced(Decision::Blocked(Blocked::Terminal(block))) =
        apply_first_step(&engine, &mut trajectory, plan.id)
    else {
        panic!("expected terminal denial");
    };
    assert!(matches!(block.reason, BlockReason::DeniedByAuthority { .. }));
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::WaiverDenied { .. }))
    );
}

/// Denying a control-release waiver through the external approval path
/// audits `WaiverDenied` as well.
#[test]
fn an_external_control_release_denial_audits_waiver_denied() {
    let mut engine = engine_with([email_contract()]);
    engine
        .register_authority(external_authority("remote-releaser", releaser_mandate()))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let request = control_release_scenario(&mut trajectory);
    let plans = remediable(&engine, &mut trajectory, request);
    let plan = plans
        .iter()
        .find(|p| matches!(p.steps.first().kind, TransitionKind::ApplyWaiver { .. }))
        .expect("a control-release route");
    let StepOutcome::NeedsApproval(pending) = apply_first_step(&engine, &mut trajectory, plan.id) else {
        panic!("expected pending approval");
    };
    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Deny {
                reason: "denied".to_owned(),
            },
        )
        .unwrap();
    assert!(matches!(decision, Decision::Blocked(Blocked::Terminal(_))));
    assert!(
        trajectory
            .state()
            .audit()
            .iter()
            .any(|e| matches!(e, AuditEvent::WaiverDenied { .. }))
    );
}

// ---- Exact violation vectors ----

/// A missing contract reports the unprovable call and the Unknown-effects
/// growth, in emission order.
#[test]
fn a_missing_contract_reports_no_contract_then_unknown_growth() {
    let engine = engine_with([]);
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "x");
    let request = ToolRequest::new(
        ToolName::new("mystery.tool"),
        ArgumentTree::Value(body),
        BTreeSet::new(),
    );
    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [
            Violation::Unprovable(Unprovable::NoContract { tool }),
            Violation::Breach(crate::contract::Breach::SurfaceGrowth { growth }),
        ] if *tool == ToolName::new("mystery.tool") && *growth == Effects::UNKNOWN
    ));
}

// ---- Response sink parameters ----

/// The response check runs with the pending tool action out of scope: an
/// accepted-but-undispatched egress neither blocks nor taints an
/// unrelated response.
#[test]
fn a_response_is_independent_of_the_pending_tool_action() {
    let mut engine = engine_with([email_contract()]).with_response_policy(ResponsePolicy {
        requires: Requirements {
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        },
        readers: BTreeSet::from([user("alice")]),
    });
    engine.register_authority(inline_acquirer()).unwrap();
    let mut trajectory = Trajectory::new();
    let body = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "the doc");
    let request = email_request(&mut trajectory, body, "bob");
    let _token = walk_to_permit(&engine, &mut trajectory, request);
    assert!(trajectory.pending_action().is_some());

    let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "sending it now");
    let response = ResponseRequest {
        body: ArgumentTree::Value(note),
        control: BTreeSet::new(),
        basis: trajectory.revision(),
    };
    let ResponseDecision::Emitted { .. } = engine.evaluate_response(&mut trajectory, response) else {
        panic!("expected emission despite the pending accepted egress");
    };
}

/// A pending user confirmation never satisfies response attention: the
/// response check consults no confirmation at all.
#[test]
fn a_pending_confirmation_never_satisfies_response_attention() {
    let engine = PolicyEngine::new().with_response_policy(ResponsePolicy {
        requires: Requirements {
            attention: crate::contract::AttentionRule::ExplicitConfirmation,
            ..Requirements::default()
        },
        readers: BTreeSet::from([user("alice")]),
    });
    let mut trajectory = Trajectory::new();
    let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "hi");
    trajectory.ingress(
        Speaker::confirming(user("alice"), ToolName::new(RESPONSE_SINK)),
        ValueLabel::identity(),
        OpaqueValue::new("yes"),
    );
    assert!(trajectory.pending_confirmation().is_some());

    let response = ResponseRequest {
        body: ArgumentTree::Value(note),
        control: BTreeSet::new(),
        basis: trajectory.revision(),
    };
    let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, response)
    else {
        panic!("expected block");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::ConfirmationMissing { tool })]
            if *tool == ToolName::new(RESPONSE_SINK)
    ));
}

/// The response check consumes committed past effects.
#[test]
fn a_response_checks_committed_past_effects() {
    let engine = PolicyEngine::new().with_response_policy(ResponsePolicy {
        requires: Requirements {
            forbid_prior_effects: BTreeSet::from([Effect::Egress]),
            ..Requirements::default()
        },
        readers: BTreeSet::from([user("alice")]),
    });
    let mut trajectory = Trajectory::new();
    let note = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "quiet so far");
    let response = ResponseRequest {
        body: ArgumentTree::Value(note),
        control: BTreeSet::new(),
        basis: trajectory.revision(),
    };
    let ResponseDecision::Emitted { .. } = engine.evaluate_response(&mut trajectory, response) else {
        panic!("expected emission before any egress");
    };

    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let response = ResponseRequest {
        body: ArgumentTree::Value(note),
        control: BTreeSet::new(),
        basis: trajectory.revision(),
    };
    let ResponseDecision::Blocked(Blocked::Terminal(block)) = engine.evaluate_response(&mut trajectory, response)
    else {
        panic!("expected block after the committed egress");
    };
    assert!(matches!(
        block.violations.as_slice(),
        [Violation::Breach(crate::contract::Breach::ForbiddenPriorEffects { .. })]
    ));
}

// ---- Terminal rescue: joint Endorse x control-release ----

fn masked_contract() -> ToolContract {
    ToolContract {
        name: ToolName::new("post.publish"),
        requires: Some(Requirements {
            trust: Some(KnownTrust::Suspicious),
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        }),
        output_label: ValueLabel::identity(),
        effects: Effects::declared([Effect::Egress]),
        arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
    }
}

/// An Unknown-trust body whose trust deficit a Suspicious control masks in
/// the fold, while the control alone restricts the audience: releasing the
/// control unmasks `TrustUnknown`, and endorsement alone finds no unreleased
/// argument deficit — only the joint solve clears it.
fn masked_flow(trajectory: &mut Trajectory) -> (ValueId, ValueId, ToolRequest) {
    let body = ingress(trajectory, &["alice", "bob"], Trust::UNKNOWN, "draft");
    let secret = ingress(trajectory, &["alice"], Trust::SUSPICIOUS, "selection basis");
    let to = identity_ingress(trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("post.publish"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::from([secret]),
    );
    (body, secret, request)
}

fn endorser_mandate() -> crate::transition::AuthorityMandate {
    crate::transition::AuthorityMandate {
        trust: Some(KnownTrust::Suspicious),
        ..crate::transition::AuthorityMandate::none()
    }
}

#[test]
fn rescue_composes_endorse_then_release_for_a_masked_flow() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (body, secret, request) = masked_flow(&mut trajectory);

    let plans = remediable(&engine, &mut trajectory, request.clone());
    assert_eq!(plans.len(), 1);
    let steps = &plans.first().steps;
    assert!(matches!(
        &steps.first().kind,
        TransitionKind::Derive { source, justification: Justification::Fiat { delta, targets } }
            if *source == body
                && delta.trust == Some(KnownTrust::Suspicious)
                && *targets == vec![Violation::Unprovable(Unprovable::TrustUnknown)]
    ));
    assert!(matches!(
        &steps.get(steps.len() - 1).unwrap().kind,
        TransitionKind::ApplyWaiver { delta }
            if delta.control_release == BTreeSet::from([secret])
    ));

    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "published").unwrap();
    let audit = trajectory.state().audit();
    assert!(audit.iter().any(|e| matches!(e, AuditEvent::EndorseApplied { .. })));
    assert!(audit.iter().any(|e| matches!(e, AuditEvent::WaiverApplied { .. })));
}

#[test]
fn rescue_without_an_endorse_authority_stays_terminal() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (_, _, request) = masked_flow(&mut trajectory);

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

#[test]
fn rescue_without_a_release_authority_stays_terminal() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (_, _, request) = masked_flow(&mut trajectory);

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected terminal block");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

/// The endorse authority rules on the projected post-release residual, not
/// the masked actual posture: this authority approves only when it sees the
/// projected `TrustUnknown`, so the walk succeeding proves the projection
/// reached it.
#[test]
fn rescue_endorse_authority_sees_the_projected_target() {
    fn approve_iff_projected(
        _: &crate::transition::ProposedGrant,
        resolved: &[Violation],
        _: &crate::approval::TrajectoryView,
    ) -> Option<crate::approval::Ruling> {
        if resolved
            .iter()
            .any(|v| matches!(v, Violation::Unprovable(Unprovable::TrustUnknown)))
        {
            Some(crate::approval::Ruling::Approve {
                reason: "the projected residual names the unknown".to_owned(),
            })
        } else {
            Some(crate::approval::Ruling::Deny {
                reason: "asked to endorse against a vector with no trust gap".to_owned(),
            })
        }
    }
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("endorser", endorser_mandate(), approve_iff_projected))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (_, _, request) = masked_flow(&mut trajectory);

    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "published").unwrap();
}

#[test]
fn rescue_release_stays_least_privilege() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (_, secret, mut request) = masked_flow(&mut trajectory);
    // A second, clean control dep must not be released alongside the dirty one.
    let clean_ctl = ingress(&mut trajectory, &["alice", "bob"], Trust::TRUSTED, "benign plan");
    request.control.insert(clean_ctl);

    let plans = remediable(&engine, &mut trajectory, request);
    let steps = &plans.first().steps;
    assert!(matches!(
        &steps.get(steps.len() - 1).unwrap().kind,
        TransitionKind::ApplyWaiver { delta }
            if delta.control_release == BTreeSet::from([secret])
    ));
}

/// A masked flow whose first egress also grows the surface composes an
/// Accept into the rescue; without an acquirer it stays terminal.
#[test]
fn rescue_composes_an_accept_for_projected_growth() {
    let authorities = |engine: &mut PolicyEngine, with_acquirer: bool| {
        engine
            .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
            .unwrap();
        engine
            .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
            .unwrap();
        if with_acquirer {
            engine.register_authority(inline_acquirer()).unwrap();
        }
    };

    let mut engine = engine_with([masked_contract()]);
    authorities(&mut engine, true);
    let mut trajectory = Trajectory::new();
    let (_, _, request) = masked_flow(&mut trajectory);
    let plans = remediable(&engine, &mut trajectory, request.clone());
    let kinds: Vec<ExitKind> = vec![plans.first().exit_kind()];
    assert_eq!(kinds, vec![ExitKind::Endorse]);
    assert!(
        plans
            .first()
            .steps
            .iter()
            .any(|step| matches!(step.kind, TransitionKind::AcceptGrowth { .. }))
    );
    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "published").unwrap();
    assert_eq!(trajectory.state().past_effects(), &Effects::declared([Effect::Egress]));

    let mut engine = engine_with([masked_contract()]);
    authorities(&mut engine, false);
    let mut trajectory = Trajectory::new();
    let (_, _, request) = masked_flow(&mut trajectory);
    assert!(matches!(
        engine.evaluate(&mut trajectory, request),
        Decision::Blocked(Blocked::Terminal(_))
    ));
}

/// A projected residual carrying an acknowledge-only fact routes the final
/// waiver to `acknowledge_unknown` competence — the projection must not
/// launder what it cannot attest.
#[test]
fn rescue_carries_acknowledge_only_facts() {
    let contract = ToolContract {
        requires: Some(Requirements {
            trust: Some(KnownTrust::Suspicious),
            audience: crate::contract::AudienceRule::FromRecipients,
            forbid_prior_effects: BTreeSet::from([Effect::Egress]),
            ..Requirements::default()
        }),
        ..masked_contract()
    };

    let run = |ack: bool| {
        let mut engine = engine_with([contract.clone()]);
        engine
            .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
            .unwrap();
        let releaser_mandate = crate::transition::AuthorityMandate {
            may_release_control: true,
            acknowledge_unknown: ack,
            ..crate::transition::AuthorityMandate::none()
        };
        engine
            .register_authority(inline_authority("releaser", releaser_mandate, approve_all))
            .unwrap();
        let mut trajectory = Trajectory::new();
        // Unknown committed effects: the forbid check becomes an
        // acknowledge-only `EffectsUnknown`, and the proposed egress cannot
        // grow the (absorbing) surface.
        trajectory.seed_committed_effects(Effects::UNKNOWN);
        let (_, _, request) = masked_flow(&mut trajectory);
        (engine, trajectory, request)
    };

    let (engine, mut trajectory, request) = run(false);
    assert!(matches!(
        engine.evaluate(&mut trajectory, request),
        Decision::Blocked(Blocked::Terminal(_))
    ));

    // With the competence, the rescue applies end-to-end and the waiver's
    // audit shows the acknowledgment alongside the release.
    let (engine, mut trajectory, request) = run(true);
    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "published").unwrap();
    assert!(trajectory.state().audit().iter().any(|e| matches!(
        e,
        AuditEvent::WaiverApplied { changes, .. }
            if changes.contains(&crate::audit::WaiverKind::Acknowledgment)
                && changes.contains(&crate::audit::WaiverKind::ControlRelease)
    )));
}

/// The counterexample to a release-all-anchored search: control `mask` keeps
/// the argument's Unknown trust masked, control `gate` alone restricts the
/// audience. Releasing only `{gate}` is clean — no endorsement involved —
/// while releasing everything would expose `TrustUnknown`.
fn subset_release_flow(trajectory: &mut Trajectory) -> (ValueId, ToolRequest) {
    let body = ingress(trajectory, &["alice", "bob"], Trust::UNKNOWN, "draft");
    let mask = ingress(trajectory, &["alice", "bob"], Trust::SUSPICIOUS, "mask");
    let gate = ingress(trajectory, &["alice"], Trust::TRUSTED, "selection");
    let to = identity_ingress(trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("post.publish"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::from([mask, gate]),
    );
    (gate, request)
}

#[test]
fn rescue_finds_a_clean_subset_release_without_an_endorser() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (gate, request) = subset_release_flow(&mut trajectory);

    let plans = remediable(&engine, &mut trajectory, request.clone());
    let steps = &plans.first().steps;
    assert_eq!(steps.len(), 1);
    assert!(matches!(
        &steps.first().kind,
        TransitionKind::ApplyWaiver { delta }
            if delta.control_release == BTreeSet::from([gate])
    ));

    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "published").unwrap();
}

/// With an endorser available, the pure subset release still wins: the
/// smallest clean candidate needs no durable relabel, so none is asked for.
#[test]
fn rescue_prefers_the_smallest_release_over_an_endorsement() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (gate, request) = subset_release_flow(&mut trajectory);

    let plans = remediable(&engine, &mut trajectory, request);
    let steps = &plans.first().steps;
    assert_eq!(steps.len(), 1);
    assert!(matches!(
        &steps.first().kind,
        TransitionKind::ApplyWaiver { delta }
            if delta.control_release == BTreeSet::from([gate])
    ));
}

/// An external endorse approval carries the projected residual — exactly the
/// unprovable the mask hides — as what the grant resolves.
#[test]
fn rescue_external_approval_resolves_the_projected_residual() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(external_authority("remote-endorser", endorser_mandate()))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (_, _, request) = masked_flow(&mut trajectory);

    let plans = remediable(&engine, &mut trajectory, request);
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    let StepOutcome::NeedsApproval(pending) = engine.apply_step(&mut trajectory, capability).unwrap() else {
        panic!("expected the external endorse to defer");
    };
    assert_eq!(pending.resolves(), &[Violation::Unprovable(Unprovable::TrustUnknown)]);
    let decision = engine
        .apply_approval(
            &mut trajectory,
            pending,
            crate::approval::Ruling::Approve {
                reason: "vouched".to_owned(),
            },
        )
        .unwrap();
    assert!(matches!(decision, Decision::Blocked(Blocked::Remediable { .. })));
}

/// Past the exhaustive-search bound the rescue refuses outright — even when
/// a release-all-anchored search would have found a plan (endorser and
/// releaser both present, release-all viable). Fail-closed terminal, never a
/// partial search that inherits the non-monotone blindness.
#[test]
fn rescue_refuses_past_the_exhaustive_bound() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let (_, _, mut request) = masked_flow(&mut trajectory);
    // Under the bound this exact flow is rescued (the composition test
    // above); pad with neutral identity-label controls until the control set
    // exceeds the bound and the same flow must refuse instead.
    for i in 0..12 {
        request
            .control
            .insert(identity_ingress(&mut trajectory, &format!("noise-{i}")));
    }
    assert!(request.control.len() > 12);

    let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
        panic!("expected the bounded rescue to refuse");
    };
    assert_eq!(block.reason, BlockReason::NoRemedy);
}

/// One raise to the bottom trust bar re-masks the remaining Unknown leaves in
/// the min-fold: the rescue re-derives per peel and must emit exactly one
/// endorse, never a batch vouching every initially-deficient leaf.
#[test]
fn rescue_does_not_over_endorse_re_masked_leaves() {
    let mut engine = engine_with([masked_contract()]);
    engine
        .register_authority(inline_authority("endorser", endorser_mandate(), approve_all))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    let first = ingress(&mut trajectory, &["alice", "bob"], Trust::UNKNOWN, "summary");
    let second = ingress(&mut trajectory, &["alice", "bob"], Trust::UNKNOWN, "appendix");
    let mask = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "mask");
    let to = identity_ingress(&mut trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("post.publish"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (
                ArgumentName::new("body"),
                ArgumentTree::List(vec![ArgumentTree::Value(first), ArgumentTree::Value(second)]),
            ),
        ])),
        BTreeSet::from([mask]),
    );

    let plans = remediable(&engine, &mut trajectory, request.clone());
    let steps = &plans.first().steps;
    assert_eq!(steps.len(), 2);
    assert!(matches!(
        &steps.first().kind,
        TransitionKind::Derive { source, justification: Justification::Fiat { .. } } if *source == first
    ));
    assert!(matches!(
        &steps.get(1).unwrap().kind,
        TransitionKind::ApplyWaiver { .. }
    ));
    let endorsed = |t: &Trajectory| {
        t.state()
            .audit()
            .iter()
            .filter(|e| matches!(e, AuditEvent::EndorseApplied { .. }))
            .count()
    };
    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "published").unwrap();
    assert_eq!(endorsed(&trajectory), 1);
}

/// Each rescue endorse step targets the projected residual at its own peel:
/// once the first raise clears the trust gap (and first's own audience
/// deficit), the second authority is shown only second's audience deficit.
#[test]
fn rescue_endorse_targets_shrink_per_peel() {
    let mut engine = engine_with([masked_contract()]);
    let endorser = crate::transition::AuthorityMandate {
        trust: Some(KnownTrust::Suspicious),
        audience: Some(BTreeSet::from([user("bob")])),
        ..crate::transition::AuthorityMandate::none()
    };
    engine
        .register_authority(inline_authority("endorser", endorser, approve_all))
        .unwrap();
    engine
        .register_authority(inline_authority("releaser", releaser_mandate(), approve_all))
        .unwrap();
    let mut trajectory = Trajectory::new();
    trajectory.seed_committed_effects(Effects::declared([Effect::Egress]));
    // First-admitted leaf: Unknown trust AND missing bob; second leaf:
    // trusted but missing bob. The masking control both keeps trust provable
    // and restricts the audience, so no ordinary endorse can clear the flow
    // without the release the rescue composes; the first raise clears the
    // trust gap, leaving the second authority only second's audience deficit.
    let first = ingress(&mut trajectory, &["alice"], Trust::UNKNOWN, "summary");
    let second = ingress(&mut trajectory, &["alice"], Trust::TRUSTED, "appendix");
    let mask = ingress(&mut trajectory, &["alice"], Trust::SUSPICIOUS, "mask");
    let to = identity_ingress(&mut trajectory, "bob");
    let request = ToolRequest::new(
        ToolName::new("post.publish"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (
                ArgumentName::new("body"),
                ArgumentTree::List(vec![ArgumentTree::Value(first), ArgumentTree::Value(second)]),
            ),
        ])),
        BTreeSet::from([mask]),
    );

    let plans = remediable(&engine, &mut trajectory, request.clone());
    let steps = &plans.first().steps;
    assert!(matches!(
        &steps.first().kind,
        TransitionKind::Derive { source, justification: Justification::Fiat { targets, .. } }
            if *source == first
                && targets.iter().any(|v| matches!(v, Violation::Unprovable(Unprovable::TrustUnknown)))
                && targets.iter().any(|v| matches!(v, Violation::Breach(crate::contract::Breach::AudienceExceeds { .. })))
    ));
    assert!(matches!(
        &steps.get(1).unwrap().kind,
        TransitionKind::Derive { source, justification: Justification::Fiat { targets, .. } }
            if *source == second
                && *targets == vec![Violation::Breach(crate::contract::Breach::AudienceExceeds {
                    outside: BTreeSet::from([user("bob")]),
                })]
    ));

    let token = walk_to_permit(&engine, &mut trajectory, request);
    dispatch(&mut trajectory, token, "published").unwrap();
}

// ---- Unknown requirements: fail closed as RequirementsUnknown ----

/// A tool contract that never states its requirements (`requires: None`)
/// escalates as the sole `RequirementsUnknown` fact, regardless of the
/// calling flow's own label — an unstated policy is unprovable, not an
/// implicit allow, so even a fully trusted, publicly readable flow escalates
/// exactly like a suspicious, narrowly-bounded one.
#[test]
fn unknown_requirements_escalate_as_sole_unprovable() {
    let mut engine = PolicyEngine::new();
    engine
        .register(ToolContract {
            name: ToolName::new("mystery.tool"),
            requires: None,
            output_label: ValueLabel::identity(),
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        })
        .unwrap();
    // Unknown requirements escalate identically for a fully trusted public
    // flow and a suspicious bounded one — the flow label is irrelevant.
    for label in [
        ValueLabel::identity(),
        ValueLabel {
            trust: Trust::SUSPICIOUS,
            audience: Audience::readers([user("alice")]),
        },
    ] {
        let mut trajectory = Trajectory::new();
        let value = trajectory.ingress(Speaker::user(user("alice")), label, OpaqueValue::new("hi"));
        let request = ToolRequest::new(
            ToolName::new("mystery.tool"),
            ArgumentTree::Value(value),
            BTreeSet::new(),
        );
        // With no authority registered to acknowledge it, the acknowledge-only
        // fact has no remedy at all — fail closed all the way to terminal.
        let Decision::Blocked(Blocked::Terminal(block)) = engine.evaluate(&mut trajectory, request) else {
            panic!("expected terminal block");
        };
        assert_eq!(
            block.violations,
            vec![Violation::Unprovable(Unprovable::RequirementsUnknown)]
        );
        assert_eq!(block.reason, BlockReason::NoRemedy);
    }
}

/// An authority explicitly competent to acknowledge unknown facts can still
/// clear the call — unknown requirements are acknowledge-only, not
/// unconditionally terminal; they route through the same `acknowledge_unknown`
/// competence as a missing contract.
#[test]
fn allow_authority_acknowledges_unknown_requirements() {
    fn always_allow(
        _grant: &crate::transition::ProposedGrant,
        _violations: &[Violation],
        _view: &TrajectoryView,
    ) -> Option<Ruling> {
        Some(Ruling::Approve {
            reason: "policy allow".into(),
        })
    }
    let mut engine = PolicyEngine::new();
    engine
        .register(ToolContract {
            name: ToolName::new("mystery.tool"),
            requires: None,
            output_label: ValueLabel::identity(),
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        })
        .unwrap();
    engine
        .register_authority(Authority::inline(
            "default-allow",
            crate::transition::AuthorityMandate::none().acknowledge_unknown(),
            always_allow,
        ))
        .unwrap();
    let mut trajectory = Trajectory::new();
    let value = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::identity(),
        OpaqueValue::new("hi"),
    );
    let request = ToolRequest::new(
        ToolName::new("mystery.tool"),
        ArgumentTree::Value(value),
        BTreeSet::new(),
    );
    match engine.pursue(&mut trajectory, request, 8) {
        Pursuit::Permitted(_token) => {}
        other => panic!("expected permitted via acknowledgment, got {other:?}"),
    }
    // The audit trail names the authority and the acknowledged fact.
    let acknowledged = trajectory.state().audit().iter().any(|e| {
        matches!(
            e,
            AuditEvent::WaiverApplied { authority, .. } if authority.as_str() == "default-allow"
        )
    });
    assert!(acknowledged, "expected a WaiverApplied audit event from default-allow");
}

/// A contract that considers its requirements and declares none (`Some(default)`)
/// is unconditionally different from one that never states them (`None`): the
/// former is a deliberate "nothing required" and stays ungated, no escalation
/// at all.
#[test]
fn considered_empty_requirements_stay_ungated() {
    let mut engine = PolicyEngine::new();
    engine
        .register(ToolContract {
            name: ToolName::new("open.tool"),
            requires: Some(Requirements::default()),
            output_label: ValueLabel::identity(),
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        })
        .unwrap();
    let mut trajectory = Trajectory::new();
    let value = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::identity(),
        OpaqueValue::new("hi"),
    );
    let request = ToolRequest::new(ToolName::new("open.tool"), ArgumentTree::Value(value), BTreeSet::new());
    assert!(matches!(
        engine.evaluate(&mut trajectory, request),
        Decision::Permitted(_)
    ));
}
