//! Read this quarter's invoices from the internal system (readable only by the
//! finance team), then e-mail the report to an *external auditor* who is **not**
//! a reader of that data. The send is legitimate, but it crosses the audience
//! boundary — so baton routes it to a sign-off that *declassifies* it and leaves
//! an audit record, rather than letting it egress silently.
//!
//! Contrast with `recording_to_task`, where the boundary crossing (to the whole
//! public) should be *refused*. Same `AudienceExceeds` breach; opposite ruling —
//! because here an authority is mandated to vouch the auditor in.
//!
//! Run once with the invoices' audience *specified* (internal-only) and once
//! left *Unknown*.
//!
//! Run with `cargo run --example external_auditor`.

use baton_core::{
    Audience, AudienceRule, Authority, AuthorityName, Decision, Effect, Effects, Grant, Label, PolicyEngine,
    Requirements, Ruling, Speaker, ToolContract, ToolName, ToolRequest, Trajectory, Trust, UnknownPolicy, UserId,
    Violation,
};

/// The internal finance team with access to the invoicing system.
const ALICE: &str = "alice@archestra.ai";
const BOB: &str = "bob@archestra.ai";
/// The external auditor — a different org, and *not* a reader of the invoices.
const AUDITOR: &str = "alex@finance-audit.com";

fn u(id: &str) -> UserId {
    UserId::new(id)
}

/// Signs off sending financial data to the known external auditor — and nothing
/// else. Its mandate vouches in exactly `AUDITOR`, so it can declassify a send
/// to that address but is not competent to wave data to anyone else.
struct FinanceApprover;

impl Authority for FinanceApprover {
    fn rule(&self, needed: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
        let mandate = Grant {
            audience: Some([u(AUDITOR)].into_iter().collect()),
            ..Grant::empty()
        };
        mandate.covers(needed).then(|| {
            (
                AuthorityName::new("finance-approver"),
                Ruling::Approve {
                    reason: "approved sending financials to the external auditor".to_owned(),
                },
            )
        })
    }
}

/// List the invoices (wearing `invoices` as their audience), then e-mail the
/// report to the auditor, and print the decision plus any audit record.
fn run(invoices: Audience, policy: UnknownPolicy) {
    let mut engine = PolicyEngine::new(FinanceApprover, policy);
    engine
        .register(ToolContract {
            name: ToolName::new("invoices.list"),
            requires: Requirements::default(),
            output_label: Label {
                audience: invoices,
                trust: Trust::TRUSTED,
                ..Label::identity()
            },
        })
        .unwrap();
    engine
        .register(ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                audience: AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: Label {
                effects: Effects::declared([Effect::Egress]),
                ..Label::identity()
            },
        })
        .unwrap();

    let mut trajectory = Trajectory::new();
    trajectory.push_message(
        Label::identity(),
        Speaker::user(u(ALICE)),
        "Pull this quarter's invoices, summarize them, and send the report to our external auditor.",
    );
    let Decision::Permitted(permit) = engine.evaluate(&trajectory, &ToolRequest::new(ToolName::new("invoices.list")))
    else {
        unreachable!("the read-only invoice list has no requirements");
    };
    trajectory
        .record_result(permit, "<47 invoices totaling $1.2M>")
        .unwrap();

    let request = ToolRequest::exposing(ToolName::new("email.send"), [u(AUDITOR)]);
    print!(
        "  audience {}  (policy {policy:?})  email → {AUDITOR}: ",
        trajectory.context_label().audience
    );
    match engine.evaluate(&trajectory, &request) {
        Decision::Permitted(permit) => {
            println!("PERMITTED");
            for entry in &permit.result_label().audit {
                println!("      {entry}");
            }
        }
        Decision::Blocked { reason, .. } => println!("BLOCKED — {reason}"),
    }
}

fn main() {
    println!("invoices are internal-only ({{{ALICE}, {BOB}}}); the auditor {AUDITOR} is outside the audience:");
    run(Audience::readers([u(ALICE), u(BOB)]), UnknownPolicy::Escalate);

    println!("\nif the invoices' audience is UNKNOWN, the outcome is the UnknownPolicy's:");
    for policy in [
        UnknownPolicy::Deny,
        UnknownPolicy::Escalate,
        UnknownPolicy::AllowWithAudit,
    ] {
        run(Audience::UNKNOWN, policy);
    }
}
