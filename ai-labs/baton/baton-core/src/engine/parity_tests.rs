//! Shadow-phase parity: the projections over the dual-recorded event set
//! must agree with the legacy trajectory truth on every representative flow.
//! These tests retire with the legacy mirrors at the projection cutover.

use std::collections::BTreeSet;

use super::*;
use crate::contract::Requirements;
use crate::dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
use crate::projection;
use crate::request::{ArgumentName, ArgumentSchema, ArgumentTree, ToolRequest};
use crate::revision::ValueId;
use crate::turn::{Speaker, Trajectory};
use crate::value::{OpaqueValue, ValueLabel};

fn user(id: &str) -> UserId {
    UserId::new(id)
}

/// The email sink, with the effect surface as a parameter: the label-remedy
/// flows use an effect-free variant (so the surface-growth criterion stays
/// out of frame), while the effects flows declare egress and genuinely
/// acquire the growth through the Accept route.
fn email_contract(effects: Effects) -> ToolContract {
    ToolContract {
        name: ToolName::new("email.send"),
        requires: Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        },
        output_label: ValueLabel::identity(),
        effects,
        arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
    }
}

fn redact_transformer() -> crate::transition::RegisteredTransformer {
    fn redact(_: &OpaqueValue) -> Result<OpaqueValue, crate::transition::TransformerError> {
        Ok(OpaqueValue::new("[redacted]"))
    }
    crate::transition::RegisteredTransformer {
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

fn approving_human() -> crate::approval::Authority {
    fn approve(
        _: &crate::transition::ProposedGrant,
        _: &[crate::contract::Violation],
        _: &crate::approval::TrajectoryView,
    ) -> Option<crate::approval::Ruling> {
        Some(crate::approval::Ruling::Approve {
            reason: "approved".to_owned(),
        })
    }
    crate::approval::Authority::inline(
        "human",
        crate::transition::AuthorityMandate {
            trust: Some(KnownTrust::Trusted),
            audience: Some(BTreeSet::from([user("alice"), user("bob"), user("charlie")])),
            waive_prior_effects: true,
            confirms: true,
            acknowledge_unknown: true,
            may_release_control: true,
            acquire_effects: true,
        },
        approve,
    )
}

fn email_request(trajectory: &mut Trajectory, body: ValueId, recipient: &str) -> ToolRequest {
    let to = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::identity(),
        OpaqueValue::new(recipient),
    );
    ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(std::collections::BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::new(),
    )
}

/// Projected truth == legacy truth, across every domain the shadow
/// projections cover.
fn assert_parity(trajectory: &Trajectory) {
    let events = trajectory.events();

    let labels = projection::value_labels(events);
    let provenances = projection::provenance(events);
    for (id, label) in &labels {
        let stored = trajectory.value(*id).expect("projected value exists in the store");
        assert_eq!(stored.label(), label, "label parity for {id}");
        assert_eq!(
            stored.provenance(),
            provenances.get(id).expect("provenance projected"),
            "provenance parity for {id}"
        );
    }
    // The projection is complete: the store holds exactly the projected ids.
    assert!(trajectory.value(ValueId::new(labels.len() as u64)).is_err());

    assert_eq!(
        &projection::committed_effects(events),
        trajectory.state().past_effects(),
        "committed-effects parity"
    );

    match (projection::pending_action(events), trajectory.pending_action()) {
        (None, None) => {}
        (Some(view), Some(pending)) => {
            assert_eq!(view.action, pending.id());
            assert_eq!(&view.tool, &pending.current().tool);
            assert_eq!(&view.proposed_effects, pending.proposed_effects());
            assert_eq!(&view.accepted_effects, pending.accepted_effects());
            assert_eq!(view.state, pending.state());
        }
        (projected, _) => panic!("pending-action parity broken: projected {projected:?}"),
    }

    assert_eq!(
        projection::confirmation_available(events).map(|(_, tool)| tool),
        trajectory.pending_confirmation().cloned(),
        "confirmation parity"
    );
}

/// Run one operation asserting the frontier advances iff the revision does,
/// by exactly `expected_batches` batches.
fn tracked<R>(trajectory: &mut Trajectory, expected_batches: u64, op: impl FnOnce(&mut Trajectory) -> R) -> R {
    let revision = trajectory.revision();
    let frontier = trajectory.events().frontier();
    let out = op(trajectory);
    let advanced = trajectory.revision() != revision;
    let batches = trajectory.events().frontier().index() - frontier.index();
    assert_eq!(
        advanced,
        batches > 0,
        "staleness parity: the frontier must advance exactly when the revision does"
    );
    assert_eq!(batches, expected_batches, "batch count for this operation");
    assert_parity(trajectory);
    out
}

#[test]
fn permitted_dispatch_projects_the_legacy_truth() {
    let mut engine = PolicyEngine::new();
    engine.register(email_contract(Effects::none())).unwrap();
    let mut trajectory = Trajectory::new();

    let body = tracked(&mut trajectory, 1, |t| {
        t.ingress(
            Speaker::user(user("alice")),
            ValueLabel::trusted_readers([user("alice"), user("bob")]),
            OpaqueValue::new("meeting notes"),
        )
    });
    let request = email_request(&mut trajectory, body, "bob");

    // A fresh clean evaluation proposes the action: one batch.
    let token = match tracked(&mut trajectory, 1, |t| engine.evaluate(t, request)) {
        Decision::Permitted(token) => token,
        other => panic!("expected a permit, got {other:?}"),
    };
    // Release commits effects, spends nothing, marks released: one batch.
    let receipt = tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    // Recording the output admits the value, appends the turn, closes the
    // action: one batch.
    tracked(&mut trajectory, 1, |t| {
        t.record_output(receipt, OpaqueValue::new("sent")).unwrap()
    });
}

/// Walk the Accept route for a genuinely egress-bearing dispatch, so the
/// committed-effects projection is exercised against a real growth
/// acquisition rather than seeded state.
#[test]
fn accepted_egress_dispatch_projects_the_legacy_truth() {
    let mut engine = PolicyEngine::new();
    engine
        .register(email_contract(Effects::declared([Effect::Egress])))
        .unwrap();
    engine.register_authority(approving_human()).unwrap();
    let mut trajectory = Trajectory::new();

    let body = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::trusted_readers([user("alice"), user("bob")]),
        OpaqueValue::new("meeting notes"),
    );
    let request = email_request(&mut trajectory, body, "bob");

    // The first egress is a surface growth: proposal + check, two batches.
    let plans = match tracked(&mut trajectory, 2, |t| engine.evaluate(t, request)) {
        Decision::Blocked(Blocked::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };
    // The inline authority acquires the growth (one batch); the recheck
    // permits via re-entry (no batch).
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    let token = match tracked(&mut trajectory, 1, |t| engine.apply_step(t, capability).unwrap()) {
        StepOutcome::Advanced(Decision::Permitted(token)) => token,
        other => panic!("expected the accept to permit, got {other:?}"),
    };

    let receipt = tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    tracked(&mut trajectory, 1, |t| {
        t.record_output(receipt, OpaqueValue::new("sent")).unwrap()
    });
    assert_eq!(
        projection::committed_effects(trajectory.events()),
        Effects::declared([Effect::Egress])
    );
}

#[test]
fn transform_remedy_walk_projects_the_legacy_truth() {
    let mut engine = PolicyEngine::new();
    engine.register(email_contract(Effects::none())).unwrap();
    engine.register_transformer(redact_transformer()).unwrap();
    let mut trajectory = Trajectory::new();

    let body = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel {
            audience: Audience::readers([user("alice"), user("bob")]),
            trust: Trust::SUSPICIOUS,
        },
        OpaqueValue::new("summarize this page"),
    );
    let request = email_request(&mut trajectory, body, "bob");

    // A fresh remediable evaluation proposes the action and performs the
    // check: two batches.
    let plans = match tracked(&mut trajectory, 2, |t| engine.evaluate(t, request)) {
        Decision::Blocked(Blocked::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };

    // Applying the transform admits the derived value and substitutes it
    // (one batch); the internal recheck permits via re-entry (no batch).
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    let token = match tracked(&mut trajectory, 1, |t| engine.apply_step(t, capability).unwrap()) {
        StepOutcome::Advanced(Decision::Permitted(token)) => token,
        other => panic!("expected the transform to permit, got {other:?}"),
    };
    let substitutions = projection::pending_action(trajectory.events())
        .expect("action pending until release")
        .substitutions;
    assert_eq!(substitutions.len(), 1);
    assert_eq!(substitutions[0].0, body);

    let receipt = tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    tracked(&mut trajectory, 1, |t| {
        t.record_output(receipt, OpaqueValue::new("sent")).unwrap()
    });
}

#[test]
fn endorse_approval_walk_projects_the_legacy_truth() {
    let mut engine = PolicyEngine::new();
    engine.register(email_contract(Effects::none())).unwrap();
    engine.register_authority(approving_human()).unwrap();
    let mut trajectory = Trajectory::new();

    // Readable by alice only, sent to charlie: needs a durable audience
    // raise, granted inline by the approving human.
    let body = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::trusted_readers([user("alice")]),
        OpaqueValue::new("private ticket"),
    );
    let request = email_request(&mut trajectory, body, "charlie");

    let plans = match tracked(&mut trajectory, 2, |t| engine.evaluate(t, request)) {
        Decision::Blocked(Blocked::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    // The endorse admits the raised value and substitutes it (one batch);
    // the recheck permits via re-entry (no batch).
    let outcome = tracked(&mut trajectory, 1, |t| engine.apply_step(t, capability).unwrap());
    let token = match outcome {
        StepOutcome::Advanced(Decision::Permitted(token)) => token,
        other => panic!("expected the endorse to permit, got {other:?}"),
    };

    let receipt = tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    tracked(&mut trajectory, 1, |t| {
        t.record_output(receipt, OpaqueValue::new("sent")).unwrap()
    });
}

#[test]
fn declared_failure_projects_the_legacy_truth() {
    let mut engine = PolicyEngine::new();
    engine
        .register(email_contract(Effects::declared([Effect::Egress])))
        .unwrap();
    engine.register_authority(approving_human()).unwrap();
    let mut trajectory = Trajectory::new();

    let body = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::trusted_readers([user("alice"), user("bob")]),
        OpaqueValue::new("notes"),
    );
    let request = email_request(&mut trajectory, body, "bob");
    let plans = match engine.evaluate(&mut trajectory, request) {
        Decision::Blocked(Blocked::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    let token = match engine.apply_step(&mut trajectory, capability).unwrap() {
        StepOutcome::Advanced(Decision::Permitted(token)) => token,
        other => panic!("expected the accept to permit, got {other:?}"),
    };
    let receipt = tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);

    // Failure closes the action; the committed effects stay in both truths.
    tracked(&mut trajectory, 1, |t| t.record_failure(receipt).unwrap());
    assert_eq!(
        projection::committed_effects(trajectory.events()),
        Effects::declared([Effect::Egress])
    );
}

#[test]
fn confirmation_spend_projects_the_legacy_truth() {
    let mut engine = PolicyEngine::new();
    engine.register(email_contract(Effects::none())).unwrap();
    let mut trajectory = Trajectory::new();

    let body = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::trusted_readers([user("alice"), user("bob")]),
        OpaqueValue::new("notes"),
    );
    let request = email_request(&mut trajectory, body, "bob");

    // The confirming turn is the newest turn when the flow releases.
    tracked(&mut trajectory, 1, |t| {
        t.ingress(
            Speaker::confirming(user("alice"), ToolName::new("email.send")),
            ValueLabel::identity(),
            OpaqueValue::new("yes, send it"),
        )
    });
    assert!(projection::confirmation_available(trajectory.events()).is_some());

    let token = match tracked(&mut trajectory, 1, |t| engine.evaluate(t, request)) {
        Decision::Permitted(token) => token,
        other => panic!("expected a permit, got {other:?}"),
    };
    // Release spends the confirmation: its batch carries the consumption
    // fact, and both truths agree it is gone.
    tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    assert!(projection::confirmation_available(trajectory.events()).is_none());
}
