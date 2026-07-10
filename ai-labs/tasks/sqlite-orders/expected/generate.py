# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the sqlite-orders fixture: a deliberately corrupted-but-recoverable SQLite DB.

Fully deterministic -- no randomness, fixed hand-written rows -- so the committed binary DB is
reproducible. The table `orders(id, region, customer, amount)` spans a few regions and customers,
arranged so the per-customer total `amount` (the verified aggregate) is not guessable from the
prompt: the winning customer is not the one with the most rows or the single largest order.

The committed DB is corrupted on purpose. The `orders` row is dropped from sqlite_master (via
`PRAGMA writable_schema`), so the table is invisible to a normal open -- `SELECT * FROM orders`
fails with "no such table" -- while its data page is left untouched and orphaned, so every row
survives intact and lossless. The agent has to recover the rows to answer: `sqlite3 .recover`
salvages the orphan page into a `lost_and_found` table, or a `PRAGMA writable_schema` repair can
re-attach the schema entry.

Ground truth for the verifier is written alongside as expected/rows.json (the canonical rows as
data). The verifier recomputes the aggregate from that, never from the broken binary.

Run:  uv run tasks/sqlite-orders/expected/generate.py
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import tempfile
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

# The aggregate the task asks for; kept identical to the verifier so the fixture self-checks.
_TOP_QUERY = (
    "SELECT customer FROM orders "
    "GROUP BY customer ORDER BY SUM(amount) DESC, customer ASC LIMIT 1"
)
_CREATE_SQL = "CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT, customer TEXT, amount INTEGER)"


def _build_clean(path: Path) -> None:
    path.unlink(missing_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute(_CREATE_SQL)
        conn.executemany(
            "INSERT INTO orders (region, customer, amount) VALUES (?, ?, ?)",
            _ROWS,
        )
        conn.commit()
    finally:
        conn.close()


def _top_customer(db: Path) -> str:
    conn = sqlite3.connect(db)
    try:
        row = conn.execute(_TOP_QUERY).fetchone()
    finally:
        conn.close()
    assert row is not None, "clean build produced no rows"
    return row[0]


def _root_page(db: Path) -> int:
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("SELECT rootpage FROM sqlite_master WHERE name='orders'").fetchone()
    finally:
        conn.close()
    assert row is not None, "orders schema row missing before corruption"
    return row[0]


def _recovered_rows(db: Path) -> list[tuple[str, str, int]]:
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute("SELECT region, customer, amount FROM orders").fetchall()
    finally:
        conn.close()
    return sorted(rows)


def _drop_schema_entry(path: Path) -> None:
    """Drop the orders row from sqlite_master, orphaning (but not freeing) its data page."""
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA writable_schema=ON")
        dropped = conn.execute("DELETE FROM sqlite_master WHERE name='orders'").rowcount
        conn.execute("PRAGMA writable_schema=OFF")
        conn.commit()
    finally:
        conn.close()
    assert dropped == 1, f"expected to drop exactly one schema row, dropped {dropped}"


def _assert_broken(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute("SELECT * FROM orders").fetchall()
    except sqlite3.DatabaseError:
        return
    finally:
        conn.close()
    raise AssertionError("corrupted DB unexpectedly read cleanly")


def _assert_recoverable(path: Path, rootpage: int) -> None:
    """Re-attach the schema entry on a scratch copy and confirm every row reads back (lossless)."""
    tmp = Path(tempfile.mkdtemp()) / "recovered.sqlite"
    shutil.copyfile(path, tmp)
    conn = sqlite3.connect(tmp)
    try:
        conn.execute("PRAGMA writable_schema=ON")
        conn.execute(
            "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) "
            "VALUES ('table', 'orders', 'orders', ?, ?)",
            (rootpage, _CREATE_SQL),
        )
        conn.execute("PRAGMA writable_schema=OFF")
        conn.commit()
    finally:
        conn.close()
    try:
        recovered = _recovered_rows(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    assert recovered == sorted(_ROWS), "re-attached schema did not recover every row"


def _assert_recover_cli(path: Path) -> None:
    """Optional: confirm the agent's `.recover` path salvages the orphan page into lost_and_found."""
    sqlite_cli = shutil.which("sqlite3")
    if sqlite_cli is None:
        print("note: sqlite3 CLI not found; skipped .recover validation")
        return
    recovered = subprocess.run([sqlite_cli, str(path), ".recover"], capture_output=True, text=True)
    if recovered.returncode != 0:
        print("note: sqlite3 CLI .recover failed; skipped .recover validation")
        return
    dump = recovered.stdout
    # `.recover` prefixes a dot-command (e.g. `.dbconfig`) that only the CLI understands; drop it.
    sql = "\n".join(line for line in dump.splitlines() if not line.startswith("."))
    tmp = Path(tempfile.mkdtemp()) / "recovered.sqlite"
    conn = sqlite3.connect(tmp)
    try:
        conn.executescript(sql)
        # lost_and_found columns: c1=region, c2=customer, c3=amount (c0 is the rowid alias).
        rows = conn.execute("SELECT c1, c2, c3 FROM lost_and_found").fetchall()
    finally:
        conn.close()
        tmp.unlink(missing_ok=True)
    assert sorted(rows) == sorted(_ROWS), ".recover did not salvage every row"


def main() -> None:
    base = Path(__file__).resolve().parent.parent
    out = base / "inputs" / "orders.sqlite"
    rows_json = base / "expected" / "rows.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    _build_clean(out)
    expected = _top_customer(out)
    rootpage = _root_page(out)
    _drop_schema_entry(out)
    _assert_broken(out)
    _assert_recoverable(out, rootpage)
    _assert_recover_cli(out)

    rows_json.write_text(
        json.dumps([list(row) for row in _ROWS], indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(_ROWS)} rows, schema entry dropped)")
    print(f"wrote {rows_json} (top_customer={expected!r})")


if __name__ == "__main__":
    main()
