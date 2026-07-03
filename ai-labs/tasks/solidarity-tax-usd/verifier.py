"""Verify the submitted solidarity-tax amount (in USD) for a Polish taxpayer.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/expected/expected.json (the stated income,
the danina solidarnościowa threshold and rate, and the NBP table-A USD mid rate on the last banking
day of 2023 (2023-12-29; 2023-12-31 is a Sunday with no NBP table), recorded at authoring time and
never staged to the agent). The expected answer is
recomputed here as floor(rate * (income - threshold) / usd_pln_mid) so no final number is hardcoded.
"""

import math

from bench_verifier import read_fixture_json, result


def test_tax_owed_usd_matches() -> None:
    truth = read_fixture_json("expected", "expected.json")
    tax_pln = truth["rate_pct"] / 100 * (truth["income_pln"] - truth["threshold_pln"])
    expected = math.floor(tax_pln / truth["usd_pln_mid"])
    submitted = result()["tax_owed_usd"]
    assert submitted == expected, f"submitted {submitted} != expected {expected}"
