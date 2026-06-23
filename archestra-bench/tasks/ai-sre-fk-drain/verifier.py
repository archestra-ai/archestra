"""Grade the submitted root-cause verdict against the planted ground truth.

Reads BENCH_RESULT (the agent's submission) and BENCH_FIXTURES/expected/expected.json (the verdict
the fixture generator planted alongside the logs). The three diagnostic fields are graded by exact
match; `summary` is captured in the trajectory but intentionally not graded.
"""

from bench_verifier import read_fixture_json, result


def test_root_cause_component_matches() -> None:
    submitted = result()["root_cause_component"]
    expected = read_fixture_json("expected", "expected.json")["root_cause_component"]
    assert submitted == expected, f"component {submitted!r} != expected {expected!r}"


def test_failure_class_matches() -> None:
    submitted = result()["failure_class"]
    expected = read_fixture_json("expected", "expected.json")["failure_class"]
    assert submitted == expected, f"failure_class {submitted!r} != expected {expected!r}"


def test_evidence_id_matches() -> None:
    submitted = result()["evidence_id"].strip()
    expected = read_fixture_json("expected", "expected.json")["evidence_id"]
    assert submitted == expected, f"evidence_id {submitted!r} != expected {expected!r}"
