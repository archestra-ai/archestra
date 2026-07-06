//! Surface-compiler behavior: the stdlib rules are emitted as IR, and illegal declassifiers are
//! rejected at compile time.

use afc_surface::{SurfaceError, compile_dir};

#[test]
fn compiler_emits_stdlib_and_on_unknown_rules() {
    let policy = compile_dir(&afc_demo::default_config_dir()).expect("demo config compiles");
    let ids: Vec<&str> = policy.rules.iter().map(|r| r.id.as_str()).collect();
    // The engine ships zero hardcoded judgments — these all come from the compiler.
    assert!(ids.contains(&"std.no_leak"));
    assert!(ids.contains(&"std.no_tainted_consequential"));
    assert!(ids.contains(&"on_unknown.egress"));
}

/// Copy the demo config into a fresh tempdir so a single file can be mutated for a negative test.
fn copy_config() -> tempfile::TempDir {
    let src = afc_demo::default_config_dir();
    let tmp = tempfile::tempdir().unwrap();
    for entry in std::fs::read_dir(&src).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), tmp.path().join(entry.file_name())).unwrap();
    }
    tmp
}

#[test]
fn compiler_rejects_non_robust_declassifier() {
    let tmp = copy_config();
    // A declassifier whose precondition is not `integrity: clean` violates robust declassification.
    std::fs::write(
        tmp.path().join("declassifiers.yaml"),
        "declassifiers:\n  san.bad:\n    authority: { kind: sanitizer, impl_pin: \"x@1\" }\n    relabel:\n      readers: { kind: public }\n      integrity: clean\n    precondition:\n      integrity: tainted\n",
    )
    .unwrap();

    match compile_dir(tmp.path()) {
        Err(SurfaceError::IllegalDeclass { id }) => assert_eq!(id, "san.bad"),
        Err(other) => panic!("expected IllegalDeclass, got {other:?}"),
        Ok(_) => panic!("expected IllegalDeclass, but compilation succeeded"),
    }
}

#[test]
fn compiler_rejects_typo_approver_scope() {
    let tmp = copy_config();
    // A bare scope string other than `any` (here a misspelled tool) must fail closed, not become
    // unbounded authority.
    std::fs::write(
        tmp.path().join("approvers.yaml"),
        "approvers:\n  llm.judge:\n    kind: llm\n    pin: \"j@1\"\n    budget: 3\n    requires_clean_context: true\n    scope: { tool: email.send }\n  human.oncall:\n    kind: human\n    auto_approve: true\n    scope: emali.send\n",
    )
    .unwrap();
    assert!(matches!(
        compile_dir(tmp.path()),
        Err(SurfaceError::InvalidScope { .. })
    ));
}

#[test]
fn compiler_rejects_sink_dim_typo() {
    let tmp = copy_config();
    let annotations = std::fs::read_to_string(tmp.path().join("annotations.yaml")).unwrap();
    // Misspell the declared `region` dimension in crm.export's sink.
    let mutated = annotations.replace("region: { kind: from_arg", "regoin: { kind: from_arg");
    std::fs::write(tmp.path().join("annotations.yaml"), mutated).unwrap();
    assert!(matches!(
        compile_dir(tmp.path()),
        Err(SurfaceError::UnknownDimension { .. })
    ));
}

#[test]
fn compiler_rejects_sink_from_arg_field_typo() {
    let tmp = copy_config();
    let annotations = std::fs::read_to_string(tmp.path().join("annotations.yaml")).unwrap();
    // drive.write_doc's sink reads a `doc` arg; misspell it to a field not in the schema.
    let mutated = annotations.replace("field: doc }", "field: docx }");
    std::fs::write(tmp.path().join("annotations.yaml"), mutated).unwrap();
    assert!(matches!(
        compile_dir(tmp.path()),
        Err(SurfaceError::UnknownArgField { .. })
    ));
}

#[test]
fn compiler_rejects_scope_to_unknown_tool() {
    let tmp = copy_config();
    std::fs::write(
        tmp.path().join("approvers.yaml"),
        "approvers:\n  llm.judge:\n    kind: llm\n    pin: \"j@1\"\n    budget: 3\n    requires_clean_context: true\n    scope: { tool: email.send }\n  human.oncall:\n    kind: human\n    auto_approve: true\n    scope: { tool: email.snd }\n",
    )
    .unwrap();
    assert!(matches!(
        compile_dir(tmp.path()),
        Err(SurfaceError::UnknownScopeTool { .. })
    ));
}

#[test]
fn wiring_refuses_unknown_sanitizer_pin() {
    let tmp = copy_config();
    // A typo'd sanitizer pin must not silently become an identity transform.
    std::fs::write(
        tmp.path().join("declassifiers.yaml"),
        "declassifiers:\n  san.redact:\n    authority: { kind: sanitizer, impl_pin: \"redatc@1\" }\n    relabel:\n      readers: { kind: users, users: [X, Y] }\n      integrity: clean\n    precondition:\n      integrity: clean\n",
    )
    .unwrap();
    // Compilation succeeds (the surface does not know impls), but wiring the runtime must fail.
    assert!(compile_dir(tmp.path()).is_ok());
    assert!(afc_demo::Runtime::from_config(tmp.path(), None).is_err());
}
