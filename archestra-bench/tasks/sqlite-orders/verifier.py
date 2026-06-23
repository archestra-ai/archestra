"""Verify the submitted top customer against a recompute from the same SQLite fixture.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/inputs/orders.sqlite (the same binary DB
staged to the agent). Recomputing the aggregate from the fixture avoids hard-coding the expected
value.
"""

import sqlite3

from bench_verifier import fixtures, result


def _top_customer() -> str:
    conn = sqlite3.connect(fixtures("inputs", "orders.sqlite"))
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
    submitted = result()["top_customer"]
    assert submitted == expected, f"submitted top_customer {submitted!r} != expected {expected!r}"
