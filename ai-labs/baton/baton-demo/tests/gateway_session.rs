//! Deterministic tests of the decision core against the real engine — no MCP,
//! no LLM. The `ask` callback stands in for the human.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use baton_demo::gateway::{GatewayConfig, Outcome, Session};

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
            async { Some(true) }
        })
        .await;
    match outcome {
        Outcome::Granted { result, .. } => assert_eq!(result, "Email sent to alex@finance-audit.com."),
        other => panic!("expected the escalation to be granted, got {other:?}"),
    }
    assert_eq!(asks.load(Ordering::SeqCst), 1, "the human is asked exactly once");

    // The action closed: there is nothing left to escalate.
    match session.escalate("again", |_| async { Some(true) }).await {
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

    match session.escalate("auditor needs it", |_| async { Some(false) }).await {
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
    match session.escalate("nothing was blocked", |_| async { Some(true) }).await {
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
    match session.escalate("stale", |_| async { Some(true) }).await {
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

/// A retried identical call after the action completed is a **new** action —
/// it re-enters policy (soft-blocking again here), never silently re-executing
/// the finished one. Transport-level retries of a lost response are the
/// transport's to replay; the session offers no completed-call cache.
#[tokio::test]
async fn a_reissued_call_after_completion_is_a_new_action() {
    let mut session = session();
    read_invoices(&mut session);
    let Outcome::SoftBlocked { .. } = session.call_tool("send_email", &email_args()) else {
        panic!("expected a soft block");
    };
    let Outcome::Granted { .. } = session.escalate("auditor needs it", |_| async { Some(true) }).await else {
        panic!("expected the escalation to be granted");
    };

    match session.call_tool("send_email", &email_args()) {
        Outcome::SoftBlocked { .. } => {}
        other => panic!("expected the replay to re-enter policy as a new action, got {other:?}"),
    }
}

/// When the remedy's grants split across authorities, each authority is asked
/// separately — one ruling never impersonates another authority.
#[tokio::test]
async fn split_mandates_ask_each_authority_once() {
    const SPLIT: &str = r#"
[[authority]]
name = "audience-endorser"
audience = ["alice@archestra.ai", "bob@archestra.ai", "alex@finance-audit.com"]

[[authority]]
name = "effects-officer"
may_release_control = true
acquire_effects = true

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

[tool.contract]
requires = { audience = "recipients_within_context" }
recipients_arg = "to"
effects = ["egress"]
"#;
    let config = GatewayConfig::from_toml(SPLIT).expect("scenario parses");
    let mut session = Session::new(Arc::new(config));
    read_invoices(&mut session);
    let Outcome::SoftBlocked { .. } = session.call_tool("send_email", &args(&[("to", "alex@finance-audit.com")]))
    else {
        panic!("expected a soft block");
    };

    let asked = std::sync::Mutex::new(Vec::new());
    let outcome = session
        .escalate("auditor needs it", |message| {
            asked.lock().unwrap().push(message);
            async { Some(true) }
        })
        .await;
    let Outcome::Granted { .. } = outcome else {
        panic!("expected the escalation to be granted, got {outcome:?}");
    };
    let asked = asked.into_inner().unwrap();
    assert_eq!(asked.len(), 2, "one prompt per authority, not per grant");
    assert!(asked[0].contains("audience-endorser") ^ asked[1].contains("audience-endorser"));
    assert!(asked[0].contains("effects-officer") ^ asked[1].contains("effects-officer"));
}

/// An `ask` that yields no ruling (elicitation failure/timeout) fails closed
/// without recording a human decision: the action stays pending and a later
/// escalation with a working channel still succeeds.
#[tokio::test]
async fn no_ruling_fails_closed_and_keeps_the_action_pending() {
    let mut session = session();
    read_invoices(&mut session);
    let Outcome::SoftBlocked { .. } = session.call_tool("send_email", &email_args()) else {
        panic!("expected a soft block");
    };

    match session.escalate("auditor needs it", |_| async { None }).await {
        Outcome::EscalationUnavailable { .. } => {}
        other => panic!("expected no-ruling to fail closed, got {other:?}"),
    }
    match session.escalate("auditor needs it", |_| async { Some(true) }).await {
        Outcome::Granted { result, .. } => assert_eq!(result, "Email sent to alex@finance-audit.com."),
        other => panic!("expected the retried escalation to succeed, got {other:?}"),
    }
}

/// A template placeholder for a declared-but-omitted optional argument fails
/// the executor after release; the receipt closes via `record_failure` and the
/// session keeps working.
#[test]
fn executor_failure_closes_the_receipt() {
    const OPTIONAL: &str = r#"
[[tool]]
name = "greet"
description = "Greet someone."
result = "Hello {name}."

[[tool.arg]]
name = "name"

[tool.contract]
"#;
    let config = GatewayConfig::from_toml(OPTIONAL).expect("scenario parses");
    let mut session = Session::new(Arc::new(config));
    match session.call_tool("greet", &args(&[])) {
        Outcome::ExecutorFailed { .. } => {}
        other => panic!("expected the render to fail after release, got {other:?}"),
    }
    match session.call_tool("greet", &args(&[("name", "alice")])) {
        Outcome::Executed { result, .. } => assert_eq!(result, "Hello alice."),
        other => panic!("expected the next call to execute, got {other:?}"),
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
    // Result templates are validated at load: undeclared placeholder…
    let unknown_placeholder = r#"
[[tool]]
name = "greet"
description = "d"
result = "Hello {nope}."
"#;
    assert!(GatewayConfig::from_toml(unknown_placeholder).is_err());
    // …and an unclosed one.
    let unclosed = r#"
[[tool]]
name = "greet"
description = "d"
result = "Hello {name."

[[tool.arg]]
name = "name"
"#;
    assert!(GatewayConfig::from_toml(unclosed).is_err());
}
