# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate the median-salary fixture: tasks/median-salary/inputs/salaries.csv.

Deterministic (fixed seed) so the committed fixture is reproducible. The CSV has name/department/
salary columns with a realistic spread, plus a couple of blank and non-numeric salary cells to
defeat naive parsing -- the median is taken over the numeric salary values only.

Run:  uv run tasks/median-salary/expected/generate.py
"""

from __future__ import annotations

import csv
import random
from pathlib import Path

_SEED = 20260601
_ROWS = 15  # small enough to inline in the task prompt; odd count -> an unambiguous median
_DEPARTMENTS = {
    "Engineering": 145_000,
    "Sales": 95_000,
    "Marketing": 88_000,
    "Support": 72_000,
    "HR": 80_000,
}


def main() -> None:
    rng = random.Random(_SEED)
    rows = [["name", "department", "salary"]]
    for i in range(_ROWS):
        dept = rng.choice(list(_DEPARTMENTS))
        base = _DEPARTMENTS[dept]
        salary = max(40_000, round(rng.gauss(base, base * 0.18)))
        rows.append([f"Employee {i + 1:03d}", dept, str(salary)])

    # a blank and a non-numeric salary cell: the median must ignore both.
    rows.append(["Employee 121", "Sales", ""])
    rows.append(["Employee 122", "Support", "N/A"])

    out = Path(__file__).resolve().parent.parent / "inputs" / "salaries.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
