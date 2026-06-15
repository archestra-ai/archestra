"""Out-of-band verifier for the multistage-demo task.

Reads the agent's submitted result (DEMO_REPORT) and the ground-truth inputs (DEMO_DATA) and checks
that the agent returned the PRODUCT (the corrected ask), not the sum (the original ask)."""

import json
import os


def test_product_matches() -> None:
    report = json.loads(open(os.environ["DEMO_REPORT"], encoding="utf-8").read())
    data = json.loads(open(os.environ["DEMO_DATA"], encoding="utf-8").read())
    expected = data["a"] * data["b"]
    assert report["product"] == expected, f"expected product {expected}, got {report.get('product')!r}"
