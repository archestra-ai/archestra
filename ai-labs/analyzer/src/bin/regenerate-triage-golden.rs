use std::fs;
use std::path::PathBuf;

use archestra_bench_core::RolloutId;
use trajectory_analyzer::rubric::{parse_triage, render_section};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/triage_golden")
        .join(name)
}

fn main() -> eyre::Result<()> {
    let judgment = fs::read_to_string(fixture("judgment.json"))?;
    let record = parse_triage(&judgment)?.into_record(
        &RolloutId {
            env: "basic".into(),
            task: "sqlite-orders".into(),
            lane: "kimi".into(),
        },
        "failed",
    );

    fs::write(
        fixture("record.jsonl"),
        format!("{}\n", serde_json::to_string(&record)?),
    )?;
    fs::write(fixture("expected_section.md"), render_section(&record))?;
    println!("regenerated triage golden fixtures");
    Ok(())
}
