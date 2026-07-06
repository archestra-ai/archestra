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

#[test]
fn compiler_rejects_non_robust_declassifier() {
    let src = afc_demo::default_config_dir();
    let tmp = tempfile::tempdir().unwrap();
    for entry in std::fs::read_dir(&src).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), tmp.path().join(entry.file_name())).unwrap();
    }
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
