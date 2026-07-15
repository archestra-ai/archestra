//! Deterministic tests of the decision core against the real engine — no MCP,
//! no LLM. The `ask` callback stands in for the human.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use baton_gateway::{GatewayConfig, Outcome, Session};

const SCENARIO: &str = r#"
[[authority]]
name = "human-in-the-loop"
audience = ["alice@archestra.ai", "bob@archestra.ai", "alex@finance-audit.com"]
may_release_control = true
acquire_effects = true
confirms = true
acknowledge_unknown = true

[[tool]]
name = "invoices_list"
description = "List invoices."
result = "47 invoices totaling $1,248,000."

[tool.contract]
output = { audience = ["alice@archestra.ai", "bob@archestra.ai"], trust = "trusted" }

[[tool]]
name = "send_email"
description = "Send an email."
result = "Email sent to {to}."

[[tool.arg]]
name = "to"
required = true

[[tool.arg]]
name = "subject"

[[tool.arg]]
name = "body"

[tool.contract]
requires = { audience = "recipients_within_context" }
recipients_arg = "to"
effects = ["egress"]
"#;

fn session() -> Session {
    let config = GatewayConfig::from_toml(SCENARIO).expect("scenario parses");
    Session::new(Arc::new(config))
}

fn args(pairs: &[(&str, &str)]) -> serde_json::Map<String, serde_json::Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), (*v).into())).collect()
}

fn email_args() -> serde_json::Map<String, serde_json::Value> {
    args(&[
        ("to", "alex@finance-audit.com"),
        ("subject", "Q2 invoices"),
        ("body", "totals attached"),
    ])
}

/// Read the invoices, leaving the private result in the session context.
fn read_invoices(session: &mut Session) {
    match session.call_tool("invoices_list", &args(&[])) {
        Outcome::Executed { result, .. } => assert_eq!(result, "47 invoices totaling $1,248,000."),
        other => panic!("expected the read to execute, got {other:?}"),
    }
}

#[test]
fn clean_read_executes_with_template_result() {
    let mut session = session();
    read_invoices(&mut session);
}

#[test]
fn out_of_audience_send_soft_blocks() {
    let mut session = session();
    read_invoices(&mut session);
    match session.call_tool("send_email", &email_args()) {
        Outcome::SoftBlocked {
            violations, recipients, ..
        } => {
            assert!(!violations.is_empty());
            assert_eq!(
                recipients,
                std::collections::BTreeSet::from([baton_core::UserId::new("alex@finance-audit.com")])
            );
        }
        other => panic!("expected a soft block, got {other:?}"),
    }
}

#[tokio::test]
async fn approved_escalation_dispatches_the_canonical_request_once() {
    let mut session = session();
    read_invoices(&mut session);
    let Outcome::SoftBlocked { .. } = session.call_tool("send_email", &email_args()) else {
        panic!("expected a soft block");
    };

    let asks = AtomicUsize::new(0);
    let outcome = session
        .escalate("auditor needs the summary", |message| {
            asks.fetch_add(1, Ordering::SeqCst);
            assert!(message.contains("alex@finance-audit.com"));
            async { true }
        })
        .await;
    match outcome {
        Outcome::Granted { result, .. } => assert_eq!(result, "Email sent to alex@finance-audit.com."),
        other => panic!("expected the escalation to be granted, got {other:?}"),
    }
    assert_eq!(asks.load(Ordering::SeqCst), 1, "the human is asked exactly once");

    // The action closed: there is nothing left to escalate.
    match session.escalate("again", |_| async { true }).await {
        Outcome::NothingPending => {}
        other => panic!("expected nothing pending after the grant, got {other:?}"),
    }
}

#[tokio::test]
async fn declined_escalation_denies_and_clears_the_action() {
    let mut session = session();
    read_invoices(&mut session);
    let Outcome::SoftBlocked { .. } = session.call_tool("send_email", &email_args()) else {
        panic!("expected a soft block");
    };

    match session.escalate("auditor needs it", |_| async { false }).await {
        Outcome::Denied { .. } => {}
        other => panic!("expected the escalation to be denied, got {other:?}"),
    }

    // The denial cleared the pending action; a fresh identical call soft-blocks anew.
    match session.call_tool("send_email", &email_args()) {
        Outcome::SoftBlocked { .. } => {}
        other => panic!("expected a fresh soft block after denial, got {other:?}"),
    }
}

#[tokio::test]
async fn escalation_without_a_pending_action_reports_nothing_pending() {
    let mut session = session();
    match session.escalate("nothing was blocked", |_| async { true }).await {
        Outcome::NothingPending => {}
        other => panic!("expected nothing pending, got {other:?}"),
    }
}

#[tokio::test]
async fn a_different_call_abandons_the_pending_action() {
    let mut session = session();
    read_invoices(&mut session);
    let Outcome::SoftBlocked { .. } = session.call_tool("send_email", &email_args()) else {
        panic!("expected a soft block");
    };

    // The agent moves on; the blocked send is abandoned, not wedged.
    read_invoices(&mut session);
    match session.escalate("stale", |_| async { true }).await {
        Outcome::NothingPending => {}
        other => panic!("expected the abandoned action to be gone, got {other:?}"),
    }
}

#[test]
fn a_reissued_identical_call_soft_blocks_again() {
    let mut session = session();
    read_invoices(&mut session);
    let Outcome::SoftBlocked { .. } = session.call_tool("send_email", &email_args()) else {
        panic!("expected a soft block");
    };
    match session.call_tool("send_email", &email_args()) {
        Outcome::SoftBlocked { .. } => {}
        other => panic!("expected idempotent re-entry to soft-block again, got {other:?}"),
    }
}

#[test]
fn wire_validation_fails_closed() {
    let mut session = session();
    match session.call_tool("send_email", &args(&[("subject", "no recipient")])) {
        Outcome::BadArguments { .. } => {}
        other => panic!("expected missing required arg to be rejected, got {other:?}"),
    }
    match session.call_tool("send_email", &args(&[("to", "bob@archestra.ai"), ("cc", "x")])) {
        Outcome::BadArguments { .. } => {}
        other => panic!("expected undeclared arg to be rejected, got {other:?}"),
    }
    let mut non_string = args(&[]);
    non_string.insert("to".into(), serde_json::json!(42));
    match session.call_tool("send_email", &non_string) {
        Outcome::BadArguments { .. } => {}
        other => panic!("expected non-string arg to be rejected, got {other:?}"),
    }
    match session.call_tool("rm_rf", &args(&[])) {
        Outcome::UnknownTool { .. } => {}
        other => panic!("expected an unknown tool to be rejected, got {other:?}"),
    }
}

#[test]
fn config_rejects_bad_policies() {
    assert!(GatewayConfig::from_toml("[[tool]]\nname = \"x\"\ndescription = \"d\"\nresult = \"r\"\ntypo = 1").is_err());
    // recipients_within_context without a recipients_arg would block every call.
    let no_recipients = r#"
[[tool]]
name = "send"
description = "d"
result = "r"
[tool.contract]
requires = { audience = "recipients_within_context" }
"#;
    assert!(GatewayConfig::from_toml(no_recipients).is_err());
    // recipients_arg must be a declared argument.
    let unknown_arg = r#"
[[tool]]
name = "send"
description = "d"
result = "r"
[tool.contract]
recipients_arg = "to"
"#;
    assert!(GatewayConfig::from_toml(unknown_arg).is_err());
    // The escalation tool name is reserved.
    let reserved = r#"
[[tool]]
name = "baton__escalate"
description = "d"
result = "r"
"#;
    assert!(GatewayConfig::from_toml(reserved).is_err());
}
