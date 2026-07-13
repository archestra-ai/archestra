//! Fetch a Grain recording, then open an issue on a *public* GitHub repo. The
//! recording is readable only by the internal team; a public issue egresses to
//! `world` — a sentinel recipient for the public (there is no e-mail for
//! "everyone"; see `insights.md`). Run once with the recording's audience
//! *specified* and once left *Unknown*, to see where the audience label alone
//! stops the leak and where it falls to the `UnknownPolicy`.
//!
//! The authority declines every escalation (fail closed), so a PERMITTED means
//! the audience label cleared the sink on its own — except under
//! `AllowWithAudit`, where the policy audits an Unknown through (the `(audited)`
//! row).
//!
//! Run with `cargo run --example recording_to_task`.

use baton_core::{
    Audience, AudienceRule, Authority, AuthorityName, Decision, Effect, Effects, Grant, Label, PolicyEngine,
    Requirements, Ruling, Speaker, ToolContract, ToolName, ToolRequest, Trajectory, Trust, UnknownPolicy, UserId,
    Violation,
};

/// The internal team who may read the recording.
const ALICE: &str = "alice@archestra.ai";
const BOB: &str = "bob@archestra.ai";
/// Sentinel recipient standing for the public readership of an open issue — not
/// a real address (the public has no e-mail); see `insights.md`.
const WORLD: &str = "world";

fn u(id: &str) -> UserId {
    UserId::new(id)
}

/// Declines every escalation (fail closed): no permit ever comes from a waiver.
struct DeclineAll;

impl Authority for DeclineAll {
    fn rule(&self, _: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
        Some((
            AuthorityName::new("decline-all"),
            Ruling::Deny {
                reason: "no waiver".to_owned(),
            },
        ))
    }
}

/// Fetch the recording (wearing `recording` as its audience), then open a public
/// issue that egresses to `world`, and print whether the label cleared the sink
/// under `policy`.
fn run(recording: Audience, policy: UnknownPolicy) {
    let mut engine = PolicyEngine::new(DeclineAll, policy);
    engine
        .register(ToolContract {
            name: ToolName::new("grain.fetch"),
            requires: Requirements::default(),
            output_label: Label {
                audience: recording,
                trust: Trust::TRUSTED,
                ..Label::identity()
            },
        })
        .unwrap();
    engine
        .register(ToolContract {
            name: ToolName::new("github.open_issue"),
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
        "Skim the latest customer call and open a bug for the crash they hit.",
    );
    let Decision::Permitted(permit) = engine.evaluate(&trajectory, &ToolRequest::new(ToolName::new("grain.fetch")))
    else {
        unreachable!("the read-only recording fetch has no requirements");
    };
    trajectory
        .record_result(permit, "<transcript: names the customer's staging host>")
        .unwrap();

    let request = ToolRequest::exposing(ToolName::new("github.open_issue"), [u(WORLD)]);
    print!(
        "  audience {}  (policy {policy:?})  open public issue → {WORLD}: ",
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
    println!("recording audience SPECIFIED → the leak is a provable breach:");
    run(Audience::readers([u(ALICE), u(BOB)]), UnknownPolicy::Escalate);

    println!("\nrecording audience UNKNOWN → the outcome is the UnknownPolicy's:");
    for policy in [
        UnknownPolicy::Deny,
        UnknownPolicy::Escalate,
        UnknownPolicy::AllowWithAudit,
    ] {
        run(Audience::UNKNOWN, policy);
    }
}
