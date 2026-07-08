//! Toy end-to-end run: an agent summarizes a shared doc, fetches a web page,
//! e-mails people, drops a table, and calls an unannotated tool — with every
//! flow checked against the folded context label.
//!
//! Run with `cargo run --example demo`.

use baton_core::{
    Actor, Attention, AttentionRule, Audience, AudienceRule, Authority, AuthorityName, Breach,
    Decision, Effect, Effects, FlowRequest, Label, LabeledTurn, PolicyEngine, Requirements, Ruling,
    ToolContract, ToolName, Trajectory, Trust, Turn, UnknownPolicy, Unprovable, UserId, Violation,
};

/// Scripted stand-in for a real approval UI: this "human" has decided in
/// advance to approve exactly one thing — sending the web-tainted summary to
/// Bob — and to deny everything else that reaches them.
struct HumanInTheLoop;

impl Authority for HumanInTheLoop {
    fn name(&self) -> AuthorityName {
        AuthorityName::new("human-in-the-loop")
    }

    fn adjudicate(&self, request: &FlowRequest, _: &Label, violations: &[Violation]) -> Ruling {
        let only_trust = violations.iter().all(|v| {
            matches!(
                v,
                Violation::Breach(Breach::TrustBelow { .. })
                    | Violation::Unprovable(Unprovable::TrustUnknown { .. })
            )
        });
        let to_bob_only = request
            .exposes_to
            .as_ref()
            .is_some_and(|r| !r.is_empty() && r.iter().all(|u| u.as_str() == "bob"));
        if only_trust && to_bob_only {
            Ruling::Approve {
                reason: "reviewed the draft, it is fine to send to bob".to_owned(),
            }
        } else {
            Ruling::Deny {
                reason: "not comfortable approving this".to_owned(),
            }
        }
    }
}

fn alice() -> UserId {
    UserId::new("alice")
}

fn user_turn(label: Label, content: &str) -> LabeledTurn {
    LabeledTurn {
        label,
        turn: Turn {
            actor: Actor::User(alice()),
            content: content.to_owned(),
        },
    }
}

/// Evaluate one flow, narrate the outcome, and record the result on a permit.
fn attempt(
    engine: &PolicyEngine<HumanInTheLoop>,
    trajectory: &mut Trajectory,
    request: FlowRequest,
    result_content: &str,
) {
    println!("-> requesting `{}`", request.tool);
    println!("   context: {}", trajectory.context_label());
    match engine.evaluate(trajectory, &request) {
        Decision::Permitted(permit) => {
            println!("   PERMITTED, result label: {}", permit.result_label());
            for entry in &permit.result_label().audit {
                println!("   audit + {entry}");
            }
            trajectory.record_result(permit, result_content);
        }
        Decision::Blocked { violations, reason } => {
            println!("   BLOCKED ({reason})");
            for violation in &violations {
                println!("   - {violation}");
            }
        }
    }
    println!();
}

fn main() {
    let mut engine = PolicyEngine::new(HumanInTheLoop, UnknownPolicy::AllowWithAudit);
    engine.register(ToolContract {
        name: ToolName::new("web.fetch"),
        requires: Requirements::default(),
        output_label: Label {
            audience: Audience::Public,
            trust: Trust::Suspicious,
            ..Label::identity()
        },
    });
    engine.register(ToolContract {
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
    });
    engine.register(ToolContract {
        name: ToolName::new("db.drop"),
        requires: Requirements {
            attention: AttentionRule::ExplicitConfirmation,
            ..Requirements::default()
        },
        output_label: Label {
            effects: Effects::declared([Effect::Mutation]),
            ..Label::identity()
        },
    });

    let mut trajectory = Trajectory::new();

    println!("== 1. Alice asks; the shared doc is readable by alice and bob ==");
    trajectory.push(user_turn(
        Label {
            audience: Audience::readers([alice(), UserId::new("bob")]),
            ..Label::identity()
        },
        "Summarize the quarterly doc against what competitors say online, email it to Bob.",
    ));

    println!("== 2. Fetching the web taints trust, not the audience bound ==");
    attempt(
        &engine,
        &mut trajectory,
        FlowRequest::new(ToolName::new("web.fetch")),
        "<html>competitor blog post</html>",
    );

    println!("== 3. Email to Bob: trust breach escalates, the human approves ==");
    attempt(
        &engine,
        &mut trajectory,
        FlowRequest::exposing(ToolName::new("email.send"), [UserId::new("bob")]),
        "email to bob sent",
    );

    println!("== 4. Email to Charlie: he is outside the context audience ==");
    attempt(
        &engine,
        &mut trajectory,
        FlowRequest::exposing(ToolName::new("email.send"), [UserId::new("charlie")]),
        "email to charlie sent",
    );

    println!("== 5. db.drop without explicit confirmation ==");
    attempt(
        &engine,
        &mut trajectory,
        FlowRequest::new(ToolName::new("db.drop")),
        "table dropped",
    );

    println!("== 6. Alice explicitly confirms db.drop; the confirmation is bound to that tool ==");
    trajectory.push(user_turn(
        Label {
            audience: Audience::readers([alice(), UserId::new("bob")]),
            attention: Attention::High(ToolName::new("db.drop")),
            ..Label::identity()
        },
        "Yes, drop the staging table.",
    ));
    attempt(
        &engine,
        &mut trajectory,
        FlowRequest::new(ToolName::new("db.drop")),
        "table dropped",
    );

    println!("== 7. An unannotated tool: allowed by policy, on the record, poisons the fold ==");
    attempt(
        &engine,
        &mut trajectory,
        FlowRequest::new(ToolName::new("calendar.lookup")),
        "next sync: thursday",
    );

    println!(
        "== 8. Email to Bob again: the audience is now unprovable (audited through), \
         and the trust breach still needs the human =="
    );
    attempt(
        &engine,
        &mut trajectory,
        FlowRequest::exposing(ToolName::new("email.send"), [UserId::new("bob")]),
        "email to bob sent",
    );

    println!("== Final context and full audit trail ==");
    let context = trajectory.context_label();
    println!("context: {context}");
    for entry in &context.audit {
        println!("audit: {entry}");
    }
}
