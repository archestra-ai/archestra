# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate the median-salary fixture: tasks/median-salary/inputs/salaries.csv.

Deterministic (fixed seed) so the committed fixture is reproducible. The CSV has name/department/
salary columns. Each numeric salary is rendered in one of several messy formats -- plain integer,
a dollar sign, thousands separators, a trailing `k` for thousands, or scientific notation -- so a
naive float() parse (or eyeballing the column) drops rows and gets the wrong median. Some rows are
also structurally malformed: a duplicated/misplaced comma shifts the salary out of its column, so a
column-indexed reader (csv.DictReader on `salary`) reads the wrong cell. A handful of blank /
non-numeric placeholder cells must be ignored. The median is taken over the numeric salaries only,
after normalizing every format and recovering the value regardless of which column it landed in.

Run:  uv run tasks/median-salary/expected/generate.py
"""

from __future__ import annotations

import csv
import random
from pathlib import Path

_SEED = 20260601
_ROWS = 25  # odd count of numeric rows -> an unambiguous median that is one of the values
_DEPARTMENTS = {
    "Engineering": 145_000,
    "Sales": 95_000,
    "Marketing": 88_000,
    "Support": 72_000,
    "HR": 80_000,
}
_JUNK = ["", "N/A", "TBD", "see HR", "—"]


def _render(value: int, fmt: str) -> str:
    """Render an integer salary in one of the supported messy surface formats (lossless)."""
    match fmt:
        case "plain":
            return str(value)
        case "dollar":
            return f"${value:,}"
        case "commas":
            return f"{value:,}"
        case "k":
            thousands, rem = divmod(value, 1000)
            return f"{thousands}.{rem:03d}k"
        case "sci":
            return f"{value:.6e}"
    raise ValueError(fmt)


def main() -> None:
    rng = random.Random(_SEED)
    formats = ["plain", "dollar", "commas", "k", "sci"]
    rows = [["name", "department", "salary"]]
    for i in range(_ROWS):
        dept = rng.choice(list(_DEPARTMENTS))
        base = _DEPARTMENTS[dept]
        salary = max(40_000, round(rng.gauss(base, base * 0.18)))
        cell = _render(salary, rng.choice(formats))
        # ~1 in 6 rows is structurally broken: a stray empty field shifts every column right, so a
        # reader keyed on the `salary` header lands on the wrong cell. The value is still the lone
        # number-parseable field in the row.
        if rng.random() < 0.18:
            rows.append([f"Employee {i + 1:03d}", "", dept, cell])
        else:
            rows.append([f"Employee {i + 1:03d}", dept, cell])

    # blank / non-numeric salary cells: the median must ignore all of these.
    for j, junk in enumerate(_JUNK):
        rows.append([f"Employee {200 + j:03d}", rng.choice(list(_DEPARTMENTS)), junk])

    out = Path(__file__).resolve().parent.parent / "inputs" / "salaries.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle, lineterminator="\n").writerows(rows)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
