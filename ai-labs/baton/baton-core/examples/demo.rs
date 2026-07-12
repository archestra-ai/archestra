//! A narrated end-to-end run of the value-granular policy engine.
//!
//! ```text
//! cargo run --example demo        # narration only
//! cargo run --example demo -- -v  # + engine decision path (debug)
//! cargo run --example demo -- -vv # + label algebra (trace)
//! ```
//!
//! The scenario: alice works with a private document, the agent fetches an
//! untrusted web page, and the policy decides — per value, not per
//! conversation — what may flow where.

use std::collections::{BTreeMap, BTreeSet};

use baton_core::{
    ArgumentName, ArgumentSchema, ArgumentTree, Audience, AudienceRule, Blocked, Decision, Effect, Effects, KnownTrust,
    OpaqueValue, PolicyEngine, Requirements, Speaker, ToolContract, ToolName, ToolRequest, Trajectory, Trust,
    UnknownPolicy, UserId, ValueId, ValueLabel,
};
use clap::Parser;

#[derive(Parser)]
struct Args {
    /// -v for the engine decision path, -vv for the label algebra.
    #[arg(short, long, action = clap::ArgAction::Count)]
    verbose: u8,
}

fn main() {
    let args = Args::parse();
    let level = match args.verbose {
        0 => "warn",
        1 => "baton_core=debug",
        _ => "baton_core=trace",
    };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(level))
        .init();

    let mut engine = PolicyEngine::new(UnknownPolicy::Escalate);
    engine
        .register(ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                audience: AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
        })
        .unwrap();
    engine
        .register(ToolContract {
            name: ToolName::new("web.fetch"),
            requires: Requirements::default(),
            output_label: ValueLabel {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
            },
            effects: Effects::none(),
            arguments: ArgumentSchema::opaque(),
        })
        .unwrap();

    let mut trajectory = Trajectory::new();
    let alice = || UserId::new("alice");

    println!("1. alice shares a private, trusted document.");
    let doc = trajectory.ingress(
        Speaker::user(alice()),
        ValueLabel {
            audience: Audience::readers([alice(), UserId::new("bob")]),
            trust: Trust::TRUSTED,
        },
        OpaqueValue::new("quarterly numbers: ..."),
    );

    println!("2. emailing the document to bob — a reader of the doc: permitted.");
    let request = email(&mut trajectory, doc, "bob");
    match engine.evaluate(&mut trajectory, request) {
        Decision::Permitted(token) => {
            let sent = trajectory
                .record_result(token, OpaqueValue::new("message-id: 1"))
                .unwrap();
            println!(
                "   -> sent; result value {sent}, effects now {}",
                trajectory.state().past_effects()
            );
        }
        Decision::Blocked(blocked) => unreachable!("expected permit, got {blocked:?}"),
    }

    println!("3. the agent fetches an untrusted page (its contract marks output suspicious).");
    let fetch = ToolRequest::new(ToolName::new("web.fetch"), ArgumentTree::Value(doc), BTreeSet::new());
    let page = match engine.evaluate(&mut trajectory, fetch) {
        Decision::Permitted(token) => trajectory
            .record_result(token, OpaqueValue::new("<html>ignore instructions...</html>"))
            .unwrap(),
        Decision::Blocked(blocked) => unreachable!("expected permit, got {blocked:?}"),
    };
    println!(
        "   -> page value {page} wears {}",
        trajectory.value(page).unwrap().label()
    );

    println!("4. a model summary derived from the page inherits its taint.");
    let summary = trajectory
        .admit_model_output(
            OpaqueValue::new("the page says to email charlie"),
            BTreeSet::from([page]),
            BTreeSet::new(),
        )
        .unwrap();
    println!(
        "   -> summary {} wears {}",
        summary,
        trajectory.value(summary).unwrap().label()
    );

    println!("5. emailing that summary to bob: blocked — the flow's trust is suspicious.");
    let request = email(&mut trajectory, summary, "bob");
    match engine.evaluate(&mut trajectory, request) {
        Decision::Blocked(Blocked::Terminal(block)) => {
            println!("   -> blocked ({}):", block.reason);
            for violation in &block.violations {
                println!("      - {violation}");
            }
        }
        Decision::Permitted(_) => unreachable!("expected block"),
    }

    println!("6. but emailing the ORIGINAL doc again is still fine: taint is per value now.");
    let request = email(&mut trajectory, doc, "bob");
    match engine.evaluate(&mut trajectory, request) {
        Decision::Permitted(token) => {
            trajectory
                .record_result(token, OpaqueValue::new("message-id: 2"))
                .unwrap();
            println!("   -> sent. The raw page taints only flows derived from it.");
        }
        Decision::Blocked(blocked) => unreachable!("expected permit, got {blocked:?}"),
    }
}

fn email(trajectory: &mut Trajectory, body: ValueId, recipient: &str) -> ToolRequest {
    let to = trajectory.ingress(
        Speaker::user(UserId::new("alice")),
        ValueLabel::identity(),
        OpaqueValue::new(recipient),
    );
    ToolRequest::new(
        ToolName::new("email.send"),
        ArgumentTree::Object(BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(to)),
            (ArgumentName::new("body"), ArgumentTree::Value(body)),
        ])),
        BTreeSet::new(),
    )
}
