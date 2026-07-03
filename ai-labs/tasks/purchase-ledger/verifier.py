"""Verify the submitted total against a recompute from the same transactions fixture.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/inputs/transactions.csv (the same export shown
to the agent). The agent receives the export in one chat and is asked, in a *separate* chat, for the
grand total of just the completed purchases -- so a correct answer requires it to have carried the file
across conversations via persistent storage. Recomputing from the fixture avoids hard-coding the value.
"""

import csv

from bench_verifier import fixtures, result


def _expected_total_cents() -> int:
    total = 0
    with fixtures("inputs", "transactions.csv").open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["status"].strip().lower() == "completed":
                total += round(float(row["amount"]) * 100)
    return total


def test_total_matches() -> None:
    # Money compared in integer cents so float representation never decides the verdict.
    expected = _expected_total_cents()
    submitted_cents = round(float(result()["total"]) * 100)
    assert submitted_cents == expected, (
        f"submitted total {submitted_cents} cents != expected {expected} cents"
    )
