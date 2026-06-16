"""Verify the submitted median salary against a recompute from the same CSV fixture.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/inputs/salaries.csv (the same file staged to
the agent). Recomputing from the fixture avoids hard-coding the expected value.
"""

import csv
import json
import os
import statistics
from pathlib import Path


def _result() -> dict:
    path = os.environ.get("BENCH_RESULT")
    assert path, "BENCH_RESULT is not set"
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _fixture_salaries() -> list[float]:
    base = os.environ.get("BENCH_FIXTURES")
    assert base, "BENCH_FIXTURES is not set"
    salaries: list[float] = []
    with Path(base, "inputs", "salaries.csv").open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            try:
                salaries.append(float(row["salary"]))
            except (ValueError, TypeError):
                continue
    return salaries


def test_median_matches() -> None:
    # The fixture is an odd number of integer salaries (see expected/generate.py), so the median is
    # exactly one of them -- an integer. The schema requires an integer submission; compare exactly.
    expected = statistics.median(_fixture_salaries())
    submitted = _result()["median_salary"]
    assert submitted == expected, f"submitted median {submitted} != expected {expected}"
