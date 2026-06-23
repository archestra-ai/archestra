"""Verify the submitted total against a recompute from the same transactions fixture.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/inputs/transactions.csv (the same export shown
to the agent). The agent receives the export in one chat and is asked, in a *separate* chat, for the
grand total of just the completed purchases -- so a correct answer requires it to have carried the file
across conversations via persistent storage. Recomputing from the fixture avoids hard-coding the value.
"""

import csv
import json
import os
from pathlib import Path


def _result() -> dict:
    path = os.environ.get("BENCH_RESULT")
    assert path, "BENCH_RESULT is not set"
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _expected_total_cents() -> int:
    base = os.environ.get("BENCH_FIXTURES")
    assert base, "BENCH_FIXTURES is not set"
    total = 0
    with Path(base, "inputs", "transactions.csv").open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["status"].strip().lower() == "completed":
                total += round(float(row["amount"]) * 100)
    return total


def test_total_matches() -> None:
    # Money compared in integer cents so float representation never decides the verdict.
    expected = _expected_total_cents()
    submitted_cents = round(float(_result()["total"]) * 100)
    assert submitted_cents == expected, (
        f"submitted total {submitted_cents} cents != expected {expected} cents"
    )
