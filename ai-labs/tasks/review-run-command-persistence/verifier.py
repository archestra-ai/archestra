"""Grade the submitted PR-review verdict against the planted ground truth.

Reads BENCH_RESULT (the agent's submission) and BENCH_FIXTURES/expected/expected.json. Only
`verdict` is graded by exact match; `rationale` is captured in the trajectory but not graded.

Ground truth: `appendCommand` persists run_command stdout/stderr into `text` columns
(database/schemas/skill-sandbox-command.ts) with no NUL stripping, so binary command output
crashes the insert. The fix (050f17e94) added stripNullBytes. Gold verdict: decline:nul-persistence.
"""

from bench_verifier import read_fixture_json, result


def test_verdict_matches() -> None:
    submitted = result()["verdict"]
    expected = read_fixture_json("expected", "expected.json")["verdict"]
    assert submitted == expected, f"verdict {submitted!r} != expected {expected!r}"
