"""Verify the submitted median salary against a recompute from the same CSV fixture.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/inputs/salaries.csv (the same file staged to
the agent). Recomputing from the fixture avoids hard-coding the expected value.
"""

import csv
import statistics

from bench_verifier import fixtures, result


def _parse_salary(raw: str | None) -> int | None:
    """Normalize a messy salary cell to a plain dollar amount, or None if not a number.

    Mirrors the surface formats emitted by expected/generate.py: plain integers, a `$` prefix,
    thousands separators, a trailing `k`/`K` meaning thousands, and scientific notation.
    """
    if raw is None:
        return None
    text = raw.strip().replace("$", "").replace(",", "")
    if not text:
        return None
    multiplier = 1
    if text[-1:].lower() == "k":
        multiplier = 1000
        text = text[:-1]
    try:
        return round(float(text) * multiplier)
    except ValueError:
        return None


def _fixture_salaries() -> list[int]:
    # Some rows are structurally malformed (a stray comma shifts the salary out of its column), so
    # truth is defined by scanning every field of each row rather than trusting the `salary` column:
    # the salary is the lone number-parseable field. Numeric rows yield exactly one; junk rows none.
    salaries: list[int] = []
    with fixtures("inputs", "salaries.csv").open(encoding="utf-8") as handle:
        reader = csv.reader(handle)
        next(reader, None)  # header
        for row in reader:
            parsed = [v for v in (_parse_salary(cell) for cell in row) if v is not None]
            assert len(parsed) <= 1, f"row has {len(parsed)} number-parseable fields, expected <=1: {row!r}"
            salaries.extend(parsed)
    return salaries


def test_median_matches() -> None:
    # The fixture is an odd number of integer salaries (see expected/generate.py), so the median is
    # exactly one of them -- an integer. The schema requires an integer submission; compare exactly.
    expected = statistics.median(_fixture_salaries())
    submitted = result()["median_salary"]
    assert submitted == expected, f"submitted median {submitted} != expected {expected}"
