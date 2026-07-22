"""Verify the submitted BTC/SOL price ratio against recorded ground truth within tolerance.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (the BTC and SOL Close
prices fetched at authoring time, never staged to the agent). The expected ratio is derived here as
btc_usd / sol_usd; the tolerance allows harmless rounding of the requested Yahoo Finance 1h Close
values, not nearby candles or alternate fields.
"""

from bench_verifier import read_fixture_json, result

_TOLERANCE = 0.005  # ±0.5%


def test_ratio_matches() -> None:
    expected = read_fixture_json("expected", "expected.json")
    expected_ratio = expected["btc_usd"] / expected["sol_usd"]
    submitted = result()["btc_sol_ratio"]
    assert abs(submitted - expected_ratio) <= _TOLERANCE * expected_ratio, (
        f"submitted {submitted} not within {_TOLERANCE:.1%} of {expected_ratio}"
    )
