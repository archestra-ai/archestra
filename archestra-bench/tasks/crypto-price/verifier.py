"""Verify the submitted BTC/SOL price ratio against recorded ground truth within tolerance.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (the BTC and SOL Close
prices fetched at authoring time, never staged to the agent). The expected ratio is derived here as
btc_usd / sol_usd; the tolerance allows harmless rounding of the requested Yahoo Finance 1h Close
values, not nearby candles or alternate fields.
"""

import json
import os
from pathlib import Path

_TOLERANCE = 0.005  # ±0.5%


def _load(env_var: str, *rel: str) -> dict:
    base = os.environ.get(env_var)
    assert base, f"{env_var} is not set"
    path = Path(base, *rel)
    return json.loads(path.read_text(encoding="utf-8"))


def test_ratio_matches() -> None:
    result = _load("BENCH_RESULT")
    expected = _load("BENCH_FIXTURES", "expected", "expected.json")
    expected_ratio = expected["btc_usd"] / expected["sol_usd"]
    submitted = result["btc_sol_ratio"]
    assert abs(submitted - expected_ratio) <= _TOLERANCE * expected_ratio, (
        f"submitted {submitted} not within {_TOLERANCE:.1%} of {expected_ratio}"
    )
