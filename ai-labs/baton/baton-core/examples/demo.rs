//! Toy end-to-end run: an agent summarizes a shared doc, fetches a web page,
//! e-mails people, drops a table, and calls an unannotated tool — with every
//! flow checked against the folded context label and routed to a two-member
//! authority panel composed as a plain tuple.
//!
//! Run with `cargo run --example demo`.

use baton_core::{
    AttentionRule, Audience, AudienceRule, Authority, AuthorityName, Breach, Decision, Effect, Effects, Grant,
    KnownTrust, Label, PolicyEngine, Requirements, Ruling, Speaker, TaintPolicy, ToolContract, ToolName, ToolRequest,
    Trajectory, Trust, UnknownPolicy, UserId, Violation,
};

/// Scripted stand-in for a real approval UI. This "human" is mandated for
/// trust and audience escalations (not confirmations, not effect waivers): it
/// vouches for the provenance of a flow and for who may read it. It signs off
/// on anything that reaches it *unless* the flow would expose data to someone
/// outside the current audience.
struct HumanInTheLoop;

impl HumanInTheLoop {
    fn mandate() -> Grant {
        Grant {
            trust: Some(KnownTrust::Trusted),
            audience: Some(
                [UserId::new("alice"), UserId::new("bob"), UserId::new("charlie")]
                    .into_iter()
                    .collect(),
            ),
            effects: None,
            confirms: false,
        }
    }
}

impl Authority for HumanInTheLoop {
    fn rule(
        &self,
        needed: &Grant,
        _: &ToolRequest,
        _: &Label,
        violations: &[Violation],
    ) -> Option<(AuthorityName, Ruling)> {
        Self::mandate().covers(needed).then(|| {
            let exposes_outsiders = violations
                .iter()
                .any(|v| matches!(v, Violation::Breach(Breach::AudienceExceeds { .. })));
            let ruling = if exposes_outsiders {
                Ruling::Deny {
                    reason: "not comfortable exposing this outside the audience".to_owned(),
                }
            } else {
                Ruling::Approve {
                    reason: "reviewed the provenance, it is fine to proceed".to_owned(),
                }
            };
            (AuthorityName::new("human-in-the-loop"), ruling)
        })
    }
}

/// An on-call admin, mandated only for confirmations: it can stand in for the
/// end user's explicit confirmation of a sensitive action. (Confirmation is
/// just one authority among several.)
struct OnCallAdmin;

impl OnCallAdmin {
    fn mandate() -> Grant {
        Grant {
            confirms: true,
            ..Grant::empty()
        }
    }
}

impl Authority for OnCallAdmin {
    fn rule(&self, needed: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
        Self::mandate().covers(needed).then(|| {
            (
                AuthorityName::new("on-call-admin"),
                Ruling::Approve {
                    reason: "on-call admin authorizes this action".to_owned(),
                },
            )
        })
    }
}

/// The panel: consulted left to right, first covering mandate decides. Pure
/// tuple composition — no `Box<dyn>`.
type Panel = (HumanInTheLoop, OnCallAdmin);

fn alice() -> UserId {
    UserId::new("alice")
}

fn push_alice(trajectory: &mut Trajectory, label: Label, content: &str) {
    trajectory.push_message(label, Speaker::user(alice()), content);
}

/// Evaluate one flow, narrate the outcome, and record the result on a permit.
fn attempt(engine: &PolicyEngine<Panel>, trajectory: &mut Trajectory, request: ToolRequest, result_content: &str) {
    println!("-> requesting `{}`", request.tool);
    println!("   context: {}", trajectory.context_label());
    match engine.evaluate(trajectory, &request) {
        Decision::Permitted(permit) => {
            println!("   PERMITTED, result label: {}", permit.result_label());
            for entry in &permit.result_label().audit {
                println!("   audit + {entry}");
            }
            trajectory
                .record_result(permit, result_content)
                .expect("nothing was appended between evaluate and record");
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

/// `-v` traces the decision path (`debug`), `-vv` also the label algebra
/// (`trace`); the `v`s accumulate whether written `-vv` or `-v -v`, and
/// `--verbose` counts as one. `RUST_LOG` overrides the flag.
fn verbosity() -> u8 {
    std::env::args().skip(1).fold(0u8, |level, arg| {
        let bump = match arg.as_str() {
            "--verbose" => 1,
            // `-v`, `-vv`, `-vvv`, ...: one step per `v`.
            s if s.len() > 1 && s.starts_with('-') && s[1..].bytes().all(|b| b == b'v') => {
                u8::try_from(s.len() - 1).unwrap_or(u8::MAX)
            }
            _ => 0,
        };
        level.saturating_add(bump)
    })
}

/// Logs go to stderr so this demo's stdout narration stays clean.
fn init_tracing(verbosity: u8) {
    let default = match verbosity {
        0 => "warn",
        1 => "baton_core=debug",
        _ => "baton_core=trace",
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default)),
        )
        .with_writer(std::io::stderr)
        .init();
}

fn main() {
    init_tracing(verbosity());

    // AllowWithAudit for unprovable gaps; the taint knob on so a degrading
    // step is flagged and signed off rather than propagating silently.
    let mut engine = PolicyEngine::new((HumanInTheLoop, OnCallAdmin), UnknownPolicy::AllowWithAudit)
        .with_taint_policy(TaintPolicy::Escalate);
    let contracts = [
        ToolContract {
            name: ToolName::new("web.fetch"),
            requires: Requirements::default(),
            output_label: Label {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
                ..Label::identity()
            },
        },
        ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                audience: AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: Label {
                effects: Effects::declared([Effect::Egress]),
                ..Label::identity()
            },
        },
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
        },
        ToolContract {
            name: ToolName::new("report.generate"),
            requires: Requirements {
                forbid_prior_effects: [Effect::Egress].into_iter().collect(),
                ..Requirements::default()
            },
            output_label: Label::identity(),
        },
    ];
    for contract in contracts {
        engine.register(contract).expect("no duplicate contract");
    }

    let mut trajectory = Trajectory::new();

    println!("== 1. Alice asks; the shared doc is readable by alice and bob ==");
    push_alice(
        &mut trajectory,
        Label {
            audience: Audience::readers([alice(), UserId::new("bob")]),
            ..Label::identity()
        },
        "Summarize the quarterly doc against what competitors say online, email it to Bob.",
    );

    println!("== 2. Fetching the web degrades trust; the taint knob makes the human acknowledge it ==");
    attempt(
        &engine,
        &mut trajectory,
        ToolRequest::new(ToolName::new("web.fetch")),
        "<html>competitor blog post</html>",
    );

    println!("== 3. Email to Bob: trust breach → routed to the human by its trust mandate ==");
    attempt(
        &engine,
        &mut trajectory,
        ToolRequest::exposing(ToolName::new("email.send"), [UserId::new("bob")]),
        "email to bob sent",
    );

    println!("== 4. Email to Charlie: outside the audience → the human denies ==");
    attempt(
        &engine,
        &mut trajectory,
        ToolRequest::exposing(ToolName::new("email.send"), [UserId::new("charlie")]),
        "email to charlie sent",
    );

    println!("== 5. db.drop without confirmation → routed to the on-call admin by its confirms mandate ==");
    attempt(
        &engine,
        &mut trajectory,
        ToolRequest::new(ToolName::new("db.drop")),
        "table dropped",
    );

    println!("== 6. report.generate forbids prior egress, which the context now carries ==");
    println!("      the need is an effect waiver — no authority's mandate covers it ==");
    attempt(
        &engine,
        &mut trajectory,
        ToolRequest::new(ToolName::new("report.generate")),
        "report built",
    );

    println!("== 7. An unannotated tool: audited through by policy, taint acknowledged, poisons the fold ==");
    attempt(
        &engine,
        &mut trajectory,
        ToolRequest::new(ToolName::new("calendar.lookup")),
        "next sync: thursday",
    );

    println!("== Final context and full audit trail ==");
    let context = trajectory.context_label();
    println!("context: {context}");
    for entry in &context.audit {
        println!("audit: {entry}");
    }
}
