//! Governance-gate behavior against the REAL MCP server (spawned as a child) and the REAL AFC engine.
//! No LLM, no network, no mocks — the model's role (choosing tool calls) is played by the test
//! driving `govern` directly. The live model step is exercised only by running the `afc-agent` binary.

use std::path::Path;

use afc_agent::governance::{GovernanceState, Governed};
use afc_agent::mcp_client::McpTools;
use serde_json::{Map, Value};

fn server_bin() -> &'static str {
    env!("CARGO_BIN_EXE_afc-mcp-tools")
}

fn args(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
        .collect()
}

async fn new_state() -> GovernanceState {
    GovernanceState::new(&afc_demo::default_config_dir(), Path::new(server_bin()))
        .await
        .expect("build governance state")
}

#[tokio::test]
async fn mcp_roundtrip_lists_and_calls_tools() {
    let mcp = McpTools::connect(Path::new(server_bin())).await.unwrap();
    let mut names = mcp.tool_names().await.unwrap();
    names.sort();
    assert_eq!(
        names,
        vec![
            "crm_export",
            "drive_read_doc",
            "drive_write_doc",
            "email_send",
            "web_fetch"
        ]
    );
    let out = mcp
        .call("drive_read_doc", args(&[("doc", "A")]))
        .await
        .unwrap();
    assert!(!out.is_empty(), "read tool must return content over MCP");
}

#[tokio::test]
async fn confidential_read_then_wide_email_is_denied_as_leak() {
    let mut g = new_state().await;
    g.set_prompt_len(5);
    let read = g
        .govern("drive_read_doc", args(&[("doc", "A")]))
        .await
        .unwrap();
    assert!(matches!(read, Governed::Read { .. }));
    // Doc A is readable only by {X}; emailing its content to a wider recipient leaks.
    let send = g
        .govern(
            "email_send",
            args(&[("to", "team"), ("body", "summary of A")]),
        )
        .await
        .unwrap();
    match send {
        Governed::Denied { rule_id, .. } => assert_eq!(rule_id, "std.no_leak"),
        other => panic!("expected leak Deny, got: {}", other.text()),
    }
}

#[tokio::test]
async fn tainted_fetch_then_email_escalates_and_parity_decides() {
    // Odd driving-prompt length → the parity approver approves → the send is dispatched.
    let mut g = new_state().await;
    g.set_prompt_len(7);
    let _ = g
        .govern("web_fetch", args(&[("url", "http://news.example/today")]))
        .await
        .unwrap();
    let approved = g
        .govern("email_send", args(&[("to", "X"), ("body", "digest")]))
        .await
        .unwrap();
    assert!(
        matches!(approved, Governed::Allowed { .. }),
        "odd prompt length should approve, got: {}",
        approved.text()
    );

    // Even driving-prompt length → parity rejects → the escalation finalizes to an audited Deny.
    let mut g2 = new_state().await;
    g2.set_prompt_len(8);
    let _ = g2
        .govern("web_fetch", args(&[("url", "http://news.example/today")]))
        .await
        .unwrap();
    let denied = g2
        .govern("email_send", args(&[("to", "X"), ("body", "digest")]))
        .await
        .unwrap();
    match denied {
        Governed::Denied { rule_id, .. } => assert_eq!(rule_id, "chain.rejected"),
        other => panic!("expected chain.rejected Deny, got: {}", other.text()),
    }
}
