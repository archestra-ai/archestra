//! Golden-corpus conformance: every fixture input must produce exactly the
//! committed `normalized` + `encoded` output. The goldens pin the TOON spec-v3
//! encoding the proxy ships (decision: migrated wire format, `toon-format` crate
//! is the source of truth — there is no npm oracle).
//!
//! Regenerating `tests/fixtures/golden-corpus.json`:
//!
//! 1. Inputs (only when the corpus itself changes) — from `platform/backend`:
//!    `pnpm exec tsx ../archestra-rs/proxy-transform-core/tests/fixtures/gen-corpus.mts`
//! 2. Expected outputs — from `platform/archestra-rs`:
//!    `UPDATE_TOON_GOLDENS=1 cargo test -p proxy_transform_core --test golden_corpus`
//!
//! Review the diff: a changed golden is a wire-format change.

use proxy_transform_core::{ToonEncodeItem, ToonEncodeResult, toon_encode_tool_results};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCase {
    name: String,
    raw_content: String,
    unwrap: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected: Option<ExpectedOutput>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedOutput {
    normalized: String,
    encoded: Option<String>,
}

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden-corpus.json")
}

/// Update deliberately when the corpus generator changes — this pins fixture
/// truncation from silently shrinking coverage.
const EXPECTED_CASE_COUNT: usize = 120;

#[test]
fn golden_corpus_conformance() {
    let path = fixture_path();
    let raw = std::fs::read_to_string(&path).expect("read golden corpus fixture");
    let mut cases: Vec<GoldenCase> = serde_json::from_str(&raw).expect("parse golden corpus");
    assert_eq!(
        cases.len(),
        EXPECTED_CASE_COUNT,
        "golden corpus size changed; update EXPECTED_CASE_COUNT deliberately"
    );

    let items: Vec<ToonEncodeItem> = cases
        .iter()
        .map(|case| ToonEncodeItem {
            id: case.name.clone(),
            raw_content: case.raw_content.clone(),
            unwrap: case.unwrap,
        })
        .collect();
    let results: Vec<ToonEncodeResult> = toon_encode_tool_results(items, None);
    assert_eq!(results.len(), cases.len(), "positional contract");

    if std::env::var("UPDATE_TOON_GOLDENS").as_deref() == Ok("1") {
        assert!(
            std::env::var_os("CI").is_none(),
            "refusing to regenerate goldens in CI"
        );
        for (case, result) in cases.iter_mut().zip(&results) {
            case.expected = Some(ExpectedOutput {
                normalized: result.normalized.clone(),
                encoded: result.encoded.clone(),
            });
        }
        let mut out = serde_json::to_string_pretty(&cases).expect("serialize goldens");
        out.push('\n');
        std::fs::write(&path, out).expect("write golden corpus fixture");
        // Fall through: the freshly written goldens must pass the comparison.
    }

    for (case, result) in cases.iter().zip(&results) {
        let expected = case.expected.as_ref().unwrap_or_else(|| {
            panic!(
                "golden case {:?} has no expected output; regenerate with \
                 UPDATE_TOON_GOLDENS=1 cargo test -p proxy_transform_core --test golden_corpus",
                case.name
            )
        });
        assert_eq!(
            result.normalized, expected.normalized,
            "normalized mismatch for {:?}",
            case.name
        );
        assert_eq!(
            result.encoded, expected.encoded,
            "encoded mismatch for {:?}",
            case.name
        );
    }
}
