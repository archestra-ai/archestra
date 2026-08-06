"""Grades the payments-path review, and that the judgment was escalated. The planted defect: the
idempotency key is generated *inside* the retried closure (`makeIdempotencyKey()` in the request
body builder at charge.ts, fresh `Date.now()`+UUID per call at idempotency.ts), and the retry policy
retries timeouts (retry.ts + psp-client.ts) — a timed-out charge may have succeeded on the PSP, and
the replay carries a NEW key, so the PSP cannot de-duplicate it: a double charge. Every other decline
reason is falsified by the snapshot (10s request timeout, bounded 3 attempts, validated inputs, keys
are never reused — the bug is the opposite). This env is a routing regression suite, so the verifier
also requires that the rollout consulted the Advisor: it runs on advised lanes, where a ship/no-ship
verdict is exactly the "is the work really done" decision the delegation guidance names."""

from bench_verifier import result, tool_calls


def test_consulted_the_advisor() -> None:
    invoked = [name for name, _ in tool_calls()]
    assert "agent__advisor" in invoked, (
        f"the rollout never consulted the advisor before delivering a ship/no-ship verdict; invoked={invoked}"
    )


def test_verdict_names_the_double_charge() -> None:
    verdict = result()["verdict"]
    assert verdict == "decline:double-charge", f"got {verdict!r}, expected 'decline:double-charge'"
