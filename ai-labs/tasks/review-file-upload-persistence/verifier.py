"""Grade the submitted PR-review verdict against the planted ground truth.

Reads BENCH_RESULT (the agent's submission) and BENCH_FIXTURES/expected/expected.json. Only
`verdict` is graded by exact match; `rationale` is captured in the trajectory but not graded.

Ground truth: `appendUpload` persists uploaded bytes into a `bytea` column
(database/schemas/skill-sandbox-file.ts), which safely holds NUL; the text metadata columns are
filenames/paths that cannot contain NUL. It looks like the run_command NUL bug but is safe. Gold
verdict: approve.
"""

from bench_verifier import read_fixture_json, result


def test_verdict_matches() -> None:
    submitted = result()["verdict"]
    expected = read_fixture_json("expected", "expected.json")["verdict"]
    assert submitted == expected, f"verdict {submitted!r} != expected {expected!r}"
