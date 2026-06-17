"""Verify the submitted lena.png size against recorded ground truth.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (the size of
scikit-image's `skimage/data/lena.png`, in KiB floored, recorded at authoring time from the pinned
source and never staged to the agent).
"""

import json
import os
from pathlib import Path


def _load(env_var: str, *rel: str) -> dict:
    base = os.environ.get(env_var)
    assert base, f"{env_var} is not set"
    path = Path(base, *rel)
    return json.loads(path.read_text(encoding="utf-8"))


def test_size_matches() -> None:
    result = _load("BENCH_RESULT")
    expected = _load("BENCH_FIXTURES", "expected", "expected.json")
    assert result["size_kb"] == expected["size_kb"], (
        f"submitted {result['size_kb']}, expected {expected['size_kb']}"
    )
