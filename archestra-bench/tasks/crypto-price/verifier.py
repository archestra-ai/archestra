"""Verify the submitted BTC/SOL prices against recorded ground truth within tolerance.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (ground truth fetched
at authoring time, never staged to the agent). Tolerance allows harmless rounding of the requested
Yahoo Finance 1h Close value, not nearby candles or alternate fields.
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


def _close(actual: float, expected: float) -> bool:
    return abs(actual - expected) <= _TOLERANCE * expected


def test_prices_match() -> None:
    result = _load("BENCH_RESULT")
    expected = _load("BENCH_FIXTURES", "expected", "expected.json")
    for key in ("btc_usd", "sol_usd"):
        assert _close(result[key], expected[key]), (
            f"{key}: submitted {result[key]} not within {_TOLERANCE:.1%} of {expected[key]}"
        )
