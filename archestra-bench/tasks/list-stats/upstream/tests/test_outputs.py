"""Out-of-band verifier for the list-stats task: recompute the stats from the ground-truth input
(LIST_STATS_DATA) and check the agent's submitted result (LIST_STATS_REPORT) matches exactly."""

import json
import os


def test_stats_match() -> None:
    report = json.loads(open(os.environ["LIST_STATS_REPORT"], encoding="utf-8").read())
    numbers = json.loads(open(os.environ["LIST_STATS_DATA"], encoding="utf-8").read())["numbers"]
    assert report["sum"] == sum(numbers), f"sum: expected {sum(numbers)}, got {report.get('sum')!r}"
    assert report["count"] == len(numbers), f"count: expected {len(numbers)}, got {report.get('count')!r}"
    assert report["min"] == min(numbers), f"min: expected {min(numbers)}, got {report.get('min')!r}"
    assert report["max"] == max(numbers), f"max: expected {max(numbers)}, got {report.get('max')!r}"
