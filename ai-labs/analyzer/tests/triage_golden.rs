//! Golden-fixture parity test for the triage contract. The Node-side pipeline runs the same
//! assertions against the same fixture files, pinning both implementations to identical bytes.

use std::fs;
use std::path::PathBuf;

use archestra_bench_core::RolloutId;
use trajectory_analyzer::rubric::{parse_triage, render_section};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/triage_golden")
        .join(name)
}

fn golden_record() -> archestra_bench_core::TriageRecord {
    let judgment = fs::read_to_string(fixture("judgment.json")).unwrap();
    parse_triage(&judgment).unwrap().into_record(
        &RolloutId {
            env: "basic".into(),
            task: "sqlite-orders".into(),
            lane: "kimi".into(),
        },
        "failed",
    )
}

#[test]
fn golden_judgment_serializes_to_the_fixture_jsonl_line() {
    let line = serde_json::to_string(&golden_record()).unwrap();
    // The artifact writer terminates every line with `\n`; the fixture pins that too.
    assert_eq!(
        format!("{line}\n"),
        fs::read_to_string(fixture("record.jsonl")).unwrap()
    );
}

#[test]
fn golden_judgment_renders_to_the_fixture_section() {
    assert_eq!(
        render_section(&golden_record()),
        fs::read_to_string(fixture("expected_section.md")).unwrap()
    );
}

/// One-off fixture generator, kept ignored: `cargo test -p trajectory-analyzer --test
/// triage_golden regenerate -- --ignored` rewrites the derived fixtures after a deliberate
/// contract change (then re-verify them by hand against the contract).
#[test]
#[ignore]
fn regenerate_derived_fixtures() {
    let record = golden_record();
    fs::write(
        fixture("record.jsonl"),
        format!("{}\n", serde_json::to_string(&record).unwrap()),
    )
    .unwrap();
    fs::write(fixture("expected_section.md"), render_section(&record)).unwrap();
}
