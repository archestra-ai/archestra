"""Verify the submitted deck-QC findings against the closed ground-truth defect set.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/defects.json (verifier-only, never
staged to the agent). Grading is a CLOSED SET over the four unambiguous planted defects: the submitted
set of (metric, issue_type) pairs -- after dropping any pair on an `ignored_metrics` metric -- must
EQUAL the expected set exactly. Every planted defect must be present with the correct issue_type, and
no decoy metric (one that is actually consistent in the deck) or extra pair may be flagged.

`enterprise_value` is an `ignored_metric`: the deck shows $1.2B (slide 6, a comps-IMPLIED EV) vs
$1.25B (slide 10, the INDICATIVE deal EV). Whether that is a genuine internal conflict or two
legitimately different concepts is debatable, so flagging it (or not) is neither rewarded nor
penalized -- the verifier silently drops it before comparison. Strings are normalized for case/space.
"""

from bench_verifier import read_fixture_json, result


def _norm(value: str) -> str:
    return value.strip().lower()


def _pair(item: dict) -> tuple[str, str]:
    return (_norm(item["metric"]), _norm(item["issue_type"]))


def test_findings_match_expected_set() -> None:
    spec = read_fixture_json("expected", "defects.json")
    expected = {_pair(d) for d in spec["defects"]}
    ignored = {_norm(m) for m in spec.get("ignored_metrics", [])}

    raw = result().get("findings")
    assert isinstance(raw, list), f"findings must be a list, got {type(raw).__name__}"
    for i, item in enumerate(raw):
        assert isinstance(item, dict), f"findings[{i}] must be an object, got {type(item).__name__}"
        assert "metric" in item and "issue_type" in item, (
            f"findings[{i}] must have 'metric' and 'issue_type': {item!r}"
        )

    submitted = {_pair(item) for item in raw if _norm(item["metric"]) not in ignored}

    if submitted != expected:
        missing = sorted(expected - submitted)
        extra = sorted(submitted - expected)
        raise AssertionError(
            f"graded findings {sorted(submitted)} != expected {sorted(expected)} "
            f"(ignored metrics {sorted(ignored)} dropped before comparison); "
            f"missing (true defects not flagged, or flagged with wrong issue_type): {missing}; "
            f"wrongly flagged (decoys/extras/wrong issue_type): {extra}"
        )
