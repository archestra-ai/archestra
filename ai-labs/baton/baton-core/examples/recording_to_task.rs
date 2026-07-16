//! Fetch a Grain recording (readable only by the internal team), then open an
//! issue on a *public* GitHub repo. A public issue egresses to `world` — a
//! sentinel recipient standing for the public (there is no e-mail for
//! "everyone"; see the design notes).
//!
//! No authority is registered, so the gate is fully fail-closed: the audience
//! breach to `world` is *terminal* — nothing declassifies it. Contrast with
//! `external_auditor`, where a mandated approver vouches the recipient in. Same
//! `AudienceExceeds` breach, opposite ruling.
//!
//! Run with `cargo run --example recording_to_task`.

use baton_core::{
    ArgumentTree, FlowOutcome, OpaqueValue, PolicyEngine, Speaker, ToolContract, ToolName, ToolRequest, Trajectory,
    UserId, ValueId, ValueLabel,
};

/// The internal team who may read the recording.
const ALICE: &str = "alice@archestra.ai";
const BOB: &str = "bob@archestra.ai";
/// Sentinel recipient standing for the public readership of an open issue — not
/// a real address (the public has no e-mail).
const WORLD: &str = "world";

fn u(id: &str) -> UserId {
    UserId::new(id)
}

fn build_engine() -> PolicyEngine {
    let mut engine = PolicyEngine::new();
    engine
        .register(ToolContract::source(
            "grain.fetch",
            ValueLabel::trusted_readers([u(ALICE), u(BOB)]),
        ))
        .unwrap();
    engine
        .register(ToolContract::egress_sink("github.open_issue", "to"))
        .unwrap();
    engine
}

fn main() {
    let engine = build_engine();
    let mut trajectory = Trajectory::new();
    trajectory.ingress(
        Speaker::user(u(ALICE)),
        ValueLabel::identity(),
        OpaqueValue::new("Skim the latest customer call and open a bug for the crash they hit."),
    );

    // Fetch the recording; the output wears the internal team's audience.
    let fetch = ToolRequest::new(ToolName::new("grain.fetch"), ArgumentTree::empty(), []);
    let recording = match engine.evaluate(&mut trajectory, fetch) {
        Ok(FlowOutcome::AllowedNow(token)) => {
            let (_canonical, receipt) = trajectory.release(token).unwrap();
            trajectory
                .record_output(
                    receipt,
                    OpaqueValue::new("<transcript: names the customer's staging host>"),
                )
                .unwrap()
        }
        other => unreachable!("the read-only recording fetch has no requirements, got {other:?}"),
    };
    println!(
        "recording is internal-only ({{{ALICE}, {BOB}}}); a public issue egresses to `{WORLD}`.\n\
         recording wears {}",
        trajectory.value(recording).unwrap().label()
    );

    // Open a public issue carrying the recording: an audience breach to `world`
    // with no mandated authority — a provable, terminal refusal.
    let open = open_issue(&mut trajectory, recording, WORLD);
    print!("  open public issue → {WORLD}: ");
    match engine.evaluate(&mut trajectory, open) {
        Ok(FlowOutcome::AllowedNow(_)) => println!("PERMITTED (unexpected: no authority is mandated)"),
        Ok(FlowOutcome::Terminal { reason, .. }) => println!("BLOCKED — {reason}"),
        Ok(FlowOutcome::Remediable { .. }) => {
            println!("BLOCKED — remediable, but no registered authority can clear it")
        }
        Err(refusal) => println!("REFUSED — {refusal}"),
    }

    println!("\naudit trail:");
    for event in trajectory.audit() {
        println!("   * {event}");
    }
}

/// Build a `github.open_issue` request carrying the recording as its body, so
/// the flow wears the recording's audience — a breach to `world` that, with no
/// mandated authority, is a terminal refusal.
fn open_issue(trajectory: &mut Trajectory, recording: ValueId, recipient: &str) -> ToolRequest {
    let to = trajectory.ingress(
        Speaker::user(u(ALICE)),
        ValueLabel::identity(),
        OpaqueValue::new(recipient),
    );
    ToolRequest::new(
        ToolName::new("github.open_issue"),
        ArgumentTree::object([("to", to), ("body", recording)]),
        [],
    )
}
