"""Verify the submitted deck-QC findings against the closed ground-truth defect set.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/defects.json (verifier-only, never
staged to the agent). Grading is a CLOSED SET over the four unambiguous planted defects: the submitted
set of (metric, issue_type) pairs must EQUAL the expected set exactly -- every planted defect present
with the correct issue_type, and no decoy metric (one that is actually consistent in the deck) or
extra pair flagged. Strings are normalized for case/whitespace before comparison.

(The deck also shows $1.2B on slide 6, a comps-IMPLIED EV, vs $1.25B on slide 10, the INDICATIVE deal
EV. Whether those two are a genuine internal conflict or just different concepts is debatable, so
`enterprise_value` is deliberately NOT in the result_schema's metric enum and is not graded either way.)
"""

from bench_verifier import read_fixture_json, result


def _norm(value: str) -> str:
    return value.strip().lower()


def _pair(item: dict) -> tuple[str, str]:
    return (_norm(item["metric"]), _norm(item["issue_type"]))


def test_findings_match_expected_set() -> None:
    expected = {_pair(d) for d in read_fixture_json("expected", "defects.json")["defects"]}

    raw = result().get("findings")
    assert isinstance(raw, list), f"findings must be a list, got {type(raw).__name__}"
    for i, item in enumerate(raw):
        assert isinstance(item, dict), f"findings[{i}] must be an object, got {type(item).__name__}"
        assert "metric" in item and "issue_type" in item, (
            f"findings[{i}] must have 'metric' and 'issue_type': {item!r}"
        )

    submitted = {_pair(item) for item in raw}

    if submitted != expected:
        missing = sorted(expected - submitted)
        extra = sorted(submitted - expected)
        raise AssertionError(
            f"findings {sorted(submitted)} != expected {sorted(expected)}; "
            f"missing (true defects not flagged, or flagged with wrong issue_type): {missing}; "
            f"wrongly flagged (decoys/extras/wrong issue_type): {extra}"
        )
