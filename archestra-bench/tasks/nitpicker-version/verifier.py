"""Verify the submitted nitpicker version against recorded ground truth.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (the highest crates.io
version of the `nitpicker` crate published on or before 2026-06-01, recorded at authoring time and
never staged to the agent).
"""

import json
import os
from pathlib import Path


def _load(env_var: str, *rel: str) -> dict:
    base = os.environ.get(env_var)
    assert base, f"{env_var} is not set"
    path = Path(base, *rel)
    return json.loads(path.read_text(encoding="utf-8"))


def test_version_matches() -> None:
    result = _load("BENCH_RESULT")
    expected = _load("BENCH_FIXTURES", "expected", "expected.json")
    assert result["version"] == expected["version"], (
        f"submitted {result['version']!r}, expected {expected['version']!r}"
    )
