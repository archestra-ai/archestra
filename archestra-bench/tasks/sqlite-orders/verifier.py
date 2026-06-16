"""Verify the submitted top customer against a recompute from the same SQLite fixture.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/inputs/orders.sqlite (the same binary DB
staged to the agent). Recomputing the aggregate from the fixture avoids hard-coding the expected
value.
"""

import json
import os
import sqlite3
from pathlib import Path


def _result() -> dict:
    path = os.environ.get("BENCH_RESULT")
    assert path, "BENCH_RESULT is not set"
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _top_customer() -> str:
    base = os.environ.get("BENCH_FIXTURES")
    assert base, "BENCH_FIXTURES is not set"
    db_path = Path(base, "inputs", "orders.sqlite")
    conn = sqlite3.connect(db_path)
    try:
        # Highest total amount wins; ties broken alphabetically by customer name.
        row = conn.execute(
            "SELECT customer FROM orders "
            "GROUP BY customer "
            "ORDER BY SUM(amount) DESC, customer ASC "
            "LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    assert row is not None, "orders table is empty"
    return row[0]


def test_top_customer_matches() -> None:
    expected = _top_customer()
    submitted = _result()["top_customer"]
    assert submitted == expected, f"submitted top_customer {submitted!r} != expected {expected!r}"
