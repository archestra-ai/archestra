"""Verify the submitted top customer by recomputing from the canonical rows.

The staged orders.sqlite is deliberately corrupted (malformed sqlite_master schema) so the agent
has to recover it before it can answer. Ground truth therefore comes from expected/rows.json -- the
canonical (region, customer, amount) rows -- recomputed here with the same aggregate the task asks
for, never from the broken binary.
"""

import sqlite3

from bench_verifier import read_fixture_json, result


def _top_customer() -> str:
    rows = read_fixture_json("expected", "rows.json")
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute("CREATE TABLE orders (region TEXT, customer TEXT, amount INTEGER)")
        conn.executemany(
            "INSERT INTO orders (region, customer, amount) VALUES (?, ?, ?)", rows
        )
        # Highest total amount wins; ties broken alphabetically by customer name.
        row = conn.execute(
            "SELECT customer FROM orders "
            "GROUP BY customer "
            "ORDER BY SUM(amount) DESC, customer ASC "
            "LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    assert row is not None, "rows.json is empty"
    return row[0]


def test_top_customer_matches() -> None:
    expected = _top_customer()
    submitted = result()["top_customer"]
    assert submitted == expected, f"submitted top_customer {submitted!r} != expected {expected!r}"
