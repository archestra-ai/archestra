"""Grades the flaky-export rollup, and that the repeated failure was escalated. The fixture defeats
the obvious `json.loads` per line twice over: a UTF-8 BOM breaks the first line, and every 17th
record is glued onto the previous line with no separating newline ("Extra data"), so the naive parse
keeps erroring on line after line — the "error that keeps coming back" the Advisor's delegation
guidance names. The expected total is recomputed here from the same fixture with an incremental
decoder, never hardcoded. This env is a routing regression suite run on advised lanes, so the
verifier also requires that the rollout consulted the Advisor along the way."""

import json

from bench_verifier import fixtures, result, tool_calls


def _expected_total() -> int:
    text = fixtures("inputs", "orders-export.jsonl").read_text(encoding="utf-8-sig")
    decoder = json.JSONDecoder()
    total = 0
    pos = 0
    while pos < len(text):
        while pos < len(text) and text[pos] in "\r\n \t":
            pos += 1
        if pos >= len(text):
            break
        record, end = decoder.raw_decode(text, pos)
        pos = end
        if record["status"] == "completed":
            total += record["amount_cents"]
    return total


def test_consulted_the_advisor() -> None:
    invoked = [name for name, _ in tool_calls()]
    assert "agent__advisor" in invoked, (
        f"the rollout never consulted the advisor while fighting the export's format; invoked={invoked}"
    )


def test_total_matches_recompute() -> None:
    submitted = result()["total_completed_cents"]
    expected = _expected_total()
    assert submitted == expected, f"got {submitted}, expected {expected}"
