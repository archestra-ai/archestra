"""Verify the submitted nitpicker version against recorded ground truth.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (the highest crates.io
version of the `nitpicker` crate published on or before 2026-06-01, recorded at authoring time and
never staged to the agent).
"""

from bench_verifier import read_fixture_json, result


def test_version_matches() -> None:
    submitted = result()["version"]
    expected = read_fixture_json("expected", "expected.json")["version"]
    assert submitted == expected, f"submitted {submitted!r}, expected {expected!r}"
