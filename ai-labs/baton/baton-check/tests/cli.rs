//! The binary boundary: exit codes and one-JSON-object-per-run on stdout.

use std::io::Write;
use std::process::{Command, Stdio};

fn run_binary(stdin: &str) -> (i32, serde_json::Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_baton-check"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("binary spawns");
    child
        .stdin
        .take()
        .expect("stdin piped")
        .write_all(stdin.as_bytes())
        .expect("stdin writes");
    let output = child.wait_with_output().expect("binary runs");
    let value = serde_json::from_slice(&output.stdout).expect("stdout is one JSON object");
    (output.status.code().expect("no signal"), value)
}

#[test]
fn valid_request_exits_zero_with_a_decision() {
    let (code, value) = run_binary(
        r#"{"unknown_policy":"deny","contracts":[],"user_prompt":"hi",
            "proposed":{"tool":"anything"}}"#,
    );
    assert_eq!(code, 0);
    assert_eq!(value["decision"], "blocked");
    assert_eq!(value["block_kind"], "unknown_denied");
}

#[test]
fn malformed_json_exits_two_with_error_json() {
    let (code, value) = run_binary("not json");
    assert_eq!(code, 2);
    assert!(value["error"].is_string());
}

#[test]
fn unknown_field_exits_two_with_error_json() {
    let (code, value) = run_binary(
        r#"{"unknown_policy":"deny","contracts":[],"user_prompt":"hi",
            "proposed":{"tool":"x"},"surprise":true}"#,
    );
    assert_eq!(code, 2);
    assert!(value["error"].is_string());
}

#[test]
fn blocked_replay_exits_two_with_error_json() {
    let (code, value) = run_binary(
        r#"{"unknown_policy":"deny","contracts":[],"user_prompt":"hi",
            "executed":[{"tool":"anything"}],"proposed":{"tool":"x"}}"#,
    );
    assert_eq!(code, 2);
    assert!(value["error"].is_string());
}
