# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the sqlite-orders fixture: tasks/sqlite-orders/inputs/orders.sqlite.

Fully deterministic -- no randomness, fixed hand-written rows -- so the committed binary DB is
reproducible. The table `orders(id, region, customer, amount)` spans a few regions and customers,
arranged so the per-customer total `amount` (the verified aggregate) is not guessable from the
prompt: the winning customer is not the one with the most rows or the single largest order.

Run:  uv run tasks/sqlite-orders/expected/build_fixture.py
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

# (region, customer, amount). Fixed rows; the per-customer total is non-trivial:
# Wave Dynamics wins on total despite no single huge order and not the most rows.
_ROWS: list[tuple[str, str, int]] = [
    ("EMEA", "Atlas Corp", 1_200),
    ("EMEA", "Atlas Corp", 980),
    ("EMEA", "Borealis Ltd", 1_750),
    ("EMEA", "Borealis Ltd", 640),
    ("EMEA", "Cobalt Foods", 2_300),
    ("EMEA", "Wave Dynamics", 1_500),
    ("EMEA", "Wave Dynamics", 1_460),
    ("AMER", "Atlas Corp", 1_100),
    ("AMER", "Cobalt Foods", 510),
    ("AMER", "Delta Print", 3_200),
    ("AMER", "Delta Print", 410),
    ("AMER", "Wave Dynamics", 2_050),
    ("AMER", "Wave Dynamics", 1_990),
    ("AMER", "Borealis Ltd", 700),
    ("APAC", "Atlas Corp", 2_400),
    ("APAC", "Cobalt Foods", 1_330),
    ("APAC", "Cobalt Foods", 1_270),
    ("APAC", "Delta Print", 880),
    ("APAC", "Wave Dynamics", 1_820),
    ("APAC", "Wave Dynamics", 1_760),
    ("APAC", "Borealis Ltd", 1_050),
    ("APAC", "Borealis Ltd", 960),
    ("EMEA", "Delta Print", 1_640),
    ("AMER", "Atlas Corp", 1_320),
    ("APAC", "Wave Dynamics", 1_410),
    ("EMEA", "Cobalt Foods", 1_180),
]


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "inputs" / "orders.sqlite"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    conn = sqlite3.connect(out)
    try:
        conn.execute(
            "CREATE TABLE orders ("
            "id INTEGER PRIMARY KEY, region TEXT, customer TEXT, amount INTEGER)"
        )
        conn.executemany(
            "INSERT INTO orders (region, customer, amount) VALUES (?, ?, ?)",
            _ROWS,
        )
        conn.commit()
    finally:
        conn.close()
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(_ROWS)} rows)")


if __name__ == "__main__":
    main()
