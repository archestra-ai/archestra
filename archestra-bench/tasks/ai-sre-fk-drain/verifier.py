"""Grade the submitted root-cause verdict against the planted ground truth.

Reads BENCH_RESULT (the agent's submission) and BENCH_FIXTURES/expected/expected.json (the verdict
the fixture generator planted alongside the logs). The three diagnostic fields are graded by exact
match; `summary` is captured in the trajectory but intentionally not graded.
"""

import json
import os
from pathlib import Path


def _result() -> dict[str, object]:
    path = os.environ.get("BENCH_RESULT")
    assert path, "BENCH_RESULT is not set"
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _expected() -> dict[str, object]:
    base = os.environ.get("BENCH_FIXTURES")
    assert base, "BENCH_FIXTURES is not set"
    return json.loads(Path(base, "expected", "expected.json").read_text(encoding="utf-8"))


def test_root_cause_component_matches() -> None:
    submitted = _result()["root_cause_component"]
    expected = _expected()["root_cause_component"]
    assert submitted == expected, f"component {submitted!r} != expected {expected!r}"


def test_failure_class_matches() -> None:
    submitted = _result()["failure_class"]
    expected = _expected()["failure_class"]
    assert submitted == expected, f"failure_class {submitted!r} != expected {expected!r}"


def test_evidence_id_matches() -> None:
    submitted = _result()["evidence_id"].strip()
    expected = _expected()["evidence_id"]
    assert submitted == expected, f"evidence_id {submitted!r} != expected {expected!r}"
