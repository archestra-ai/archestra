//! The event log's discipline and the projections' semantics, walked through
//! real engine flows.
//!
//! Every mutation must append exactly one atomic batch and advance the
//! revision exactly when the frontier moves (`tracked`), and the projections
//! must tell the causal truth: a label folds exactly a value's dependencies,
//! never the whole trajectory; provenance replays diamonds and transforms.
//!
//! These began as shadow-phase parity tests against the hand-maintained read
//! models. Those models are gone — the projections are the only build path —
//! so the parity half was deleted rather than kept as `project(e) ==
//! project(e)`; what remains are the claims that can still fail.

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
        requires: Some(Requirements {
            trust: Some(KnownTrust::Trusted),
            audience: crate::contract::AudienceRule::FromRecipients,
            ..Requirements::default()
        }),
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
        _: &crate::remedy::Authorization,
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

/// Every value the log admits has its bytes in the store, and the store holds
/// nothing the log did not admit.
///
/// Not tautological, and the one claim the single build path cannot make for
/// itself: bodies live *outside* the projection (the log deliberately does not
/// carry them), so a mutation that commits a `ValueAdmitted` fact without its
/// paired `store_body` call would desynchronize them. `store_body`'s own check
/// is a `debug_assert`, which says nothing in a release build.
fn assert_bodies_track_the_log(trajectory: &Trajectory) {
    let projected = trajectory.view().admitted_values();
    for id in 0..projected {
        let id = ValueId::new(id as u64);
        assert!(
            trajectory.value(id).is_ok(),
            "{id} is admitted by the log but has no body in the store"
        );
    }
    assert!(
        trajectory.value(ValueId::new(projected as u64)).is_err(),
        "the store holds a body for a value the log never admitted"
    );
}

/// Run one operation asserting the one-mutation-one-batch discipline: the
/// frontier (which the revision digests) advances by exactly
/// `expected_batches` batches, and the bodies still track the log.
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
    assert_bodies_track_the_log(trajectory);
    out
}

#[test]
fn permitted_dispatch_advances_one_batch_per_mutation() {
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
        Ok(FlowOutcome::AllowedNow(token)) => token,
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
fn accepted_egress_dispatch_advances_one_batch_per_mutation() {
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
        Ok(FlowOutcome::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };
    // The inline authority acquires the growth (one batch); the recheck
    // permits via re-entry (no batch).
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    let token = match tracked(&mut trajectory, 1, |t| engine.apply_step(t, capability).unwrap()) {
        StepOutcome::Advanced(FlowOutcome::AllowedNow(FlowPermit::Execute(token))) => token,
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
fn transform_remedy_walk_advances_one_batch_per_mutation() {
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
        Ok(FlowOutcome::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };

    // Applying the transform admits the derived value and substitutes it
    // (one batch); the internal recheck permits via re-entry (no batch).
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    let token = match tracked(&mut trajectory, 1, |t| engine.apply_step(t, capability).unwrap()) {
        StepOutcome::Advanced(FlowOutcome::AllowedNow(FlowPermit::Execute(token))) => token,
        other => panic!("expected the transform to permit, got {other:?}"),
    };
    // The projected `current` tree is the substituted one: the tainted body
    // is gone and the derived value took its slot, while the original
    // proposal (the re-entry identity basis) still names the source.
    let projected = projection::pending_action(trajectory.events()).expect("action pending until release");
    assert!(!projected.current().arguments.leaves().contains(&body));
    assert!(projected.original().arguments.leaves().contains(&body));
    assert_eq!(
        projected.current().arguments,
        trajectory
            .pending_action()
            .expect("action pending until release")
            .current()
            .arguments
    );

    let receipt = tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    tracked(&mut trajectory, 1, |t| {
        t.record_output(receipt, OpaqueValue::new("sent")).unwrap()
    });
}

#[test]
fn endorse_approval_walk_advances_one_batch_per_mutation() {
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
        Ok(FlowOutcome::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    // The endorse admits the raised value and substitutes it (one batch);
    // the recheck permits via re-entry (no batch).
    let outcome = tracked(&mut trajectory, 1, |t| engine.apply_step(t, capability).unwrap());
    let token = match outcome {
        StepOutcome::Advanced(FlowOutcome::AllowedNow(FlowPermit::Execute(token))) => token,
        other => panic!("expected the endorse to permit, got {other:?}"),
    };

    let receipt = tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    tracked(&mut trajectory, 1, |t| {
        t.record_output(receipt, OpaqueValue::new("sent")).unwrap()
    });
}

#[test]
fn declared_failure_advances_one_batch_per_mutation() {
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
        Ok(FlowOutcome::Remediable { plans, .. }) => plans,
        other => panic!("expected a remediable block, got {other:?}"),
    };
    let capability = engine.mint_step(&trajectory, plans.first().id, 0).unwrap();
    let token = match engine.apply_step(&mut trajectory, capability).unwrap() {
        StepOutcome::Advanced(FlowOutcome::AllowedNow(FlowPermit::Execute(token))) => token,
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
fn confirmation_spend_advances_one_batch_per_mutation() {
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
        Ok(FlowOutcome::AllowedNow(token)) => token,
        other => panic!("expected a permit, got {other:?}"),
    };
    // Release spends the confirmation: its batch carries the consumption
    // fact, and both truths agree it is gone.
    tracked(&mut trajectory, 1, |t| t.release(token).unwrap().1);
    assert!(projection::confirmation_available(trajectory.events()).is_none());
}

/// Labels are causal projections, never trajectory-wide taints: an
/// irrelevant admission — however suspicious — enters no other value's
/// label, while transitive explicit and control dependencies do.
#[test]
fn label_projection_is_causal_not_trajectory_wide() {
    let mut trajectory = Trajectory::new();
    let doc = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::identity(),
        OpaqueValue::new("clean doc"),
    );
    // Irrelevant later frontier growth: a suspicious value nothing depends on.
    trajectory.ingress(
        Speaker::user(user("mallory")),
        ValueLabel {
            trust: Trust::SUSPICIOUS,
            audience: Audience::UNKNOWN,
        },
        OpaqueValue::new("poison"),
    );
    let summary = trajectory
        .admit_model_output(OpaqueValue::new("summary"), BTreeSet::from([doc]), BTreeSet::new())
        .unwrap();
    let labels = projection::value_labels(trajectory.events());
    assert_eq!(labels.get(&summary), Some(&ValueLabel::identity()));

    // Transitive control dependence, by contrast, is causal and taints.
    let selector = trajectory.ingress(
        Speaker::user(user("mallory")),
        ValueLabel {
            trust: Trust::SUSPICIOUS,
            audience: Audience::PUBLIC,
        },
        OpaqueValue::new("selector"),
    );
    let chosen = trajectory
        .admit_model_output(
            OpaqueValue::new("chosen"),
            BTreeSet::from([summary]),
            BTreeSet::from([selector]),
        )
        .unwrap();
    let derived = trajectory
        .admit_model_output(OpaqueValue::new("derived"), BTreeSet::from([chosen]), BTreeSet::new())
        .unwrap();
    let labels = projection::value_labels(trajectory.events());
    assert_eq!(labels.get(&derived).map(|l| l.trust), Some(Trust::SUSPICIOUS));
}

/// Provenance replays exactly through diamonds and transformed derivations:
/// the projection rebuilt from the log names the edges each value was
/// admitted with, however deep the derivation chain.
#[test]
fn provenance_replays_diamonds_and_transforms() {
    let mut trajectory = Trajectory::new();
    let a = trajectory.ingress(
        Speaker::user(user("alice")),
        ValueLabel::identity(),
        OpaqueValue::new("a"),
    );
    let b = trajectory
        .admit_model_output(OpaqueValue::new("b"), BTreeSet::from([a]), BTreeSet::new())
        .unwrap();
    let c = trajectory
        .admit_model_output(OpaqueValue::new("c"), BTreeSet::from([a]), BTreeSet::new())
        .unwrap();
    let d = trajectory
        .admit_model_output(OpaqueValue::new("d"), BTreeSet::from([b, c]), BTreeSet::new())
        .unwrap();
    let laundered = trajectory.seed_transformed(
        d,
        ValueLabel {
            trust: Trust::TRUSTED,
            audience: Audience::PUBLIC,
        },
    );

    let provenances = projection::provenance(trajectory.events());
    match provenances.get(&d) {
        Some(crate::value::Provenance::ModelOutput { reads, .. }) => {
            assert_eq!(reads, &BTreeSet::from([b, c]), "diamond joins both branches");
        }
        other => panic!("expected model-output provenance for the diamond join, got {other:?}"),
    }
    match provenances.get(&laundered) {
        Some(crate::value::Provenance::Transformed { source, .. }) => assert_eq!(*source, d),
        other => panic!("expected transformed provenance, got {other:?}"),
    }
    // The ancestry chain walks back to the ingress seed through the replayed
    // edges alone.
    let mut frontier = vec![laundered];
    let mut reached_seed = false;
    while let Some(id) = frontier.pop() {
        match provenances.get(&id).expect("every value has projected provenance") {
            crate::value::Provenance::Ingress { .. } => reached_seed = true,
            crate::value::Provenance::ModelOutput { reads, control } => {
                frontier.extend(reads.iter().chain(control.iter()).copied());
            }
            crate::value::Provenance::Transformed { source, .. } => frontier.push(*source),
            crate::value::Provenance::Endorsed { source, .. } => frontier.push(*source),
            crate::value::Provenance::ToolOutput { arguments, control, .. } => {
                frontier.extend(arguments.iter().chain(control.iter()).copied())
            }
        }
    }
    assert!(reached_seed, "the transitive walk reaches the ingress seed");
}
