//! Surface-compiler behavior: the stdlib rules are emitted as IR, and illegal declassifiers are
//! rejected at compile time.

use afc_surface::{SurfaceError, compile_file};

#[test]
fn compiler_emits_stdlib_and_on_unknown_rules() {
    let policy = compile_file(&afc_demo::default_policy_path()).expect("demo policy compiles");
    let ids: Vec<&str> = policy.rules.iter().map(|r| r.id.as_str()).collect();
    // The engine ships zero hardcoded judgments — these all come from the compiler.
    assert!(ids.contains(&"std.no_leak"));
    assert!(ids.contains(&"std.no_tainted_consequential"));
    assert!(ids.contains(&"on_unknown.egress"));
}

fn policy_text() -> String {
    std::fs::read_to_string(afc_demo::default_policy_path()).unwrap()
}

/// Write a policy document to a fresh temp file for a negative test.
fn write_policy(text: &str) -> tempfile::NamedTempFile {
    let f = tempfile::Builder::new().suffix(".yaml").tempfile().unwrap();
    std::fs::write(f.path(), text).unwrap();
    f
}

/// The demo policy with one top-level section's value replaced wholesale, for a negative test.
fn policy_with(section: &str, body: &str) -> tempfile::NamedTempFile {
    let mut doc: serde_yaml::Mapping = serde_yaml::from_str(&policy_text()).unwrap();
    doc.insert(section.into(), serde_yaml::from_str(body).unwrap());
    write_policy(&serde_yaml::to_string(&doc).unwrap())
}

#[test]
fn compiler_rejects_non_robust_declassifier() {
    // A declassifier whose precondition is not `integrity: clean` violates robust declassification.
    let f = policy_with(
        "declassifiers",
        "san.bad:\n  authority: { kind: sanitizer, impl_pin: \"x@1\" }\n  relabel:\n    readers: { kind: public }\n    integrity: clean\n  precondition:\n    integrity: tainted\n",
    );
    match compile_file(f.path()) {
        Err(SurfaceError::IllegalDeclass { id }) => assert_eq!(id, "san.bad"),
        Err(other) => panic!("expected IllegalDeclass, got {other:?}"),
        Ok(_) => panic!("expected IllegalDeclass, but compilation succeeded"),
    }
}

#[test]
fn compiler_rejects_typo_approver_scope() {
    // A bare scope string other than `any` (here a misspelled tool) must fail closed, not become
    // unbounded authority.
    let f = policy_with(
        "approvers",
        "llm.judge:\n  kind: llm\n  pin: \"j@1\"\n  budget: 3\n  requires_clean_context: true\n  scope: { tool: email.send }\nhuman.oncall:\n  kind: human\n  auto_approve: true\n  scope: emali.send\n",
    );
    assert!(matches!(
        compile_file(f.path()),
        Err(SurfaceError::InvalidScope { .. })
    ));
}

#[test]
fn compiler_rejects_sink_dim_typo() {
    // Misspell the declared `region` dimension in crm.export's sink.
    let f = write_policy(
        &policy_text().replace("region: { kind: from_arg", "regoin: { kind: from_arg"),
    );
    assert!(matches!(
        compile_file(f.path()),
        Err(SurfaceError::UnknownDimension { .. })
    ));
}

#[test]
fn compiler_rejects_sink_from_arg_field_typo() {
    // drive.write_doc's sink reads a `doc` arg; misspell it to a field not in the schema.
    let f = write_policy(&policy_text().replace("field: doc }", "field: docx }"));
    assert!(matches!(
        compile_file(f.path()),
        Err(SurfaceError::UnknownArgField { .. })
    ));
}

#[test]
fn compiler_rejects_scope_to_unknown_tool() {
    let f = policy_with(
        "approvers",
        "llm.judge:\n  kind: llm\n  pin: \"j@1\"\n  budget: 3\n  requires_clean_context: true\n  scope: { tool: email.send }\nhuman.oncall:\n  kind: human\n  auto_approve: true\n  scope: { tool: email.snd }\n",
    );
    assert!(matches!(
        compile_file(f.path()),
        Err(SurfaceError::UnknownScopeTool { .. })
    ));
}

#[test]
fn wiring_refuses_unknown_sanitizer_pin() {
    // A typo'd sanitizer pin must not silently become an identity transform.
    let f = policy_with(
        "declassifiers",
        "san.redact:\n  authority: { kind: sanitizer, impl_pin: \"redatc@1\" }\n  relabel:\n    readers: { kind: users, users: [X, Y] }\n    integrity: clean\n  precondition:\n    integrity: clean\n",
    );
    // Compilation succeeds (the surface does not know impls), but wiring the runtime must fail.
    assert!(compile_file(f.path()).is_ok());
    assert!(afc_demo::Runtime::from_config(f.path(), None).is_err());
}
