//! Read this quarter's invoices from the internal system (readable only by the
//! finance team), then e-mail the report to an *external auditor* who is **not**
//! a reader of that data. The send crosses the audience boundary and is the
//! first egress this turn — so baton routes it to a mandated sign-off that
//! *declassifies* it (endorses the auditor in) and *accepts* the egress, leaving
//! an audit record, rather than letting it out silently.
//!
//! Contrast with `recording_to_task`, where the boundary crossing (to the whole
//! public) is *refused*: same `AudienceExceeds` breach, opposite ruling —
//! because there no authority is mandated to vouch the recipient in.
//!
//! Run with `cargo run --example external_auditor`.

use std::collections::{BTreeMap, BTreeSet};

use baton_core::{
    ArgumentName, ArgumentSchema, ArgumentTree, Audience, AudienceRule, Authority, AuthorityMandate, AuthorityMode,
    AuthorityName, Blocked, Decision, Effect, Effects, OpaqueValue, PolicyEngine, ProposedGrant, Requirements, Ruling,
    Speaker, StepOutcome, ToolContract, ToolName, ToolRequest, Trajectory, TrajectoryView, Trust, UserId, ValueId,
    ValueLabel, Violation,
};

/// The internal finance team with access to the invoicing system.
const ALICE: &str = "alice@archestra.ai";
const BOB: &str = "bob@archestra.ai";
/// The external auditor — a different org, and *not* a reader of the invoices.
const AUDITOR: &str = "alex@finance-audit.com";

fn u(id: &str) -> UserId {
    UserId::new(id)
}

/// Approves any grant routed here. Competence is gated by the mandate, so an
/// unconditional approval vouches in exactly `AUDITOR` and accepts the send's
/// first egress — and is not competent to wave data to anyone else.
fn approve_auditor(_: &ProposedGrant, _: &[Violation], _: &TrajectoryView<'_>) -> Option<Ruling> {
    Some(Ruling::Approve {
        reason: "approved sending financials to the external auditor".to_owned(),
    })
}

fn finance_approver() -> Authority {
    Authority {
        name: AuthorityName::new("finance-approver"),
        mandate: AuthorityMandate {
            trust: None,
            audience: Some(BTreeSet::from([u(AUDITOR)])),
            waive_prior_effects: false,
            confirms: false,
            acknowledge_unknown: false,
            may_release_control: false,
            acquire_effects: true,
        },
        mode: AuthorityMode::Inline(approve_auditor),
    }
}

fn build_engine() -> PolicyEngine {
    let mut engine = PolicyEngine::new();
    engine
        .register(ToolContract {
            name: ToolName::new("invoices.list"),
            requires: Requirements::default(),
            output_label: ValueLabel {
                audience: Audience::readers([u(ALICE), u(BOB)]),
                trust: Trust::TRUSTED,
            },
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        })
        .unwrap();
    engine
        .register(ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                audience: AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
        })
        .unwrap();
    engine.register_authority(finance_approver()).unwrap();
    engine
}

fn main() {
    let engine = build_engine();
    let mut trajectory = Trajectory::new();
    trajectory.ingress(
        Speaker::user(u(ALICE)),
        ValueLabel::identity(),
        OpaqueValue::new("Pull this quarter's invoices, summarize them, and send the report to our external auditor."),
    );

    // Read the invoices; the output wears the finance team's audience.
    let list = ToolRequest::new(
        ToolName::new("invoices.list"),
        ArgumentTree::Object(BTreeMap::new()),
        BTreeSet::new(),
    );
    let report = match engine.evaluate(&mut trajectory, list) {
        Decision::Permitted(token) => {
            let (_canonical, receipt) = trajectory.release(token).unwrap();
            trajectory
                .record_output(receipt, OpaqueValue::new("<47 invoices totaling $1.2M>"))
                .unwrap()
        }
        other => unreachable!("the read-only invoice list has no requirements, got {other:?}"),
    };
    println!(
        "invoices are internal-only ({{{ALICE}, {BOB}}}); the auditor {AUDITOR} is outside the audience.\n\
         report wears {}",
        trajectory.value(report).unwrap().label()
    );

    // E-mail the report to the auditor: an audience breach and the first egress,
    // both cleared by the mandated finance approver.
    let send = email(&mut trajectory, report, AUDITOR);
    print!("  email → {AUDITOR}: ");
    match declassify_to_permit(&engine, &mut trajectory, send) {
        Ok(()) => println!("PERMITTED (finance approver endorsed the auditor and accepted the egress)"),
        Err(reason) => println!("BLOCKED — {reason}"),
    }

    println!("\naudit trail:");
    for event in trajectory.state().audit() {
        println!("   * {event}");
    }
}

/// Build an `email.send` request carrying the report as its body, so the flow
/// wears the report's audience and the authority can endorse *the data* in for
/// the auditor (a control dep could only be released, not relabeled).
fn email(trajectory: &mut Trajectory, report: ValueId, recipient: &str) -> ToolRequest {
    let to = trajectory.ingress(
        Speaker::user(u(ALICE)),
        ValueLabel::identity(),
        OpaqueValue::new(recipient),
    );
    ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(report)),
        ])),
        BTreeSet::new(),
    )
}

/// Drive a blocked-but-remediable send through its first plan, letting the
/// inline authorities rule, until it permits (then dispatch) or blocks.
fn declassify_to_permit(
    engine: &PolicyEngine,
    trajectory: &mut Trajectory,
    request: ToolRequest,
) -> Result<(), String> {
    let mut decision = engine.evaluate(trajectory, request);
    loop {
        match decision {
            Decision::Permitted(token) => {
                let (_canonical, receipt) = trajectory.release(token).unwrap();
                trajectory
                    .record_output(receipt, OpaqueValue::new("message-id: 1"))
                    .unwrap();
                return Ok(());
            }
            Decision::Blocked(Blocked::Terminal(block)) => return Err(block.reason.to_string()),
            Decision::Blocked(Blocked::Remediable { plans, .. }) => {
                let capability = engine.mint_step(trajectory, plans.first().id, 0).unwrap();
                decision = match engine.apply_step(trajectory, capability).unwrap() {
                    StepOutcome::Advanced(next) => next,
                    other => return Err(format!("unexpected step outcome: {other:?}")),
                };
            }
        }
    }
}
