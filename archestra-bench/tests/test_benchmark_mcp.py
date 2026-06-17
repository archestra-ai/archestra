"""Submission state machine of the in-process benchmark MCP: arming, format budget, first-wins."""

from __future__ import annotations

from benchmark_mcp import BenchmarkMcp, SubmissionAccepted, SubmissionFormatFailed

_SCHEMA = {
    "type": "object",
    "required": ["artifact"],
    "additionalProperties": False,
    "properties": {"artifact": {"type": "string", "minLength": 1}},
}


def _mcp() -> BenchmarkMcp:
    # the constructor wires the in-process context + lock but never starts the server thread
    # (that is .start()), so the submission state machine is exercised directly, no network.
    return BenchmarkMcp()


def test_submission_before_arming_is_refused_without_consuming_budget() -> None:
    mcp = _mcp()
    mcp.begin_task(task_key="t", schema=_SCHEMA, max_attempts=2)

    msg = mcp._handle_submit({"artifact": "stage1.gif"})
    assert "more steps" in msg
    # a valid-but-premature submission must not lock the task or burn an attempt
    mcp.allow_submission("t")
    assert mcp._handle_submit({"artifact": "final.zip"}).startswith("Result accepted")
    submission = mcp.take_submission("t")
    assert isinstance(submission, SubmissionAccepted)
    assert submission.payload_bytes == b'{"artifact": "final.zip"}'
    assert submission.attempts == 1


def test_arming_then_first_valid_submission_wins() -> None:
    mcp = _mcp()
    mcp.begin_task(task_key="t", schema=_SCHEMA, max_attempts=3)
    mcp.allow_submission("t")
    assert mcp._handle_submit({"artifact": "first.zip"}).startswith("Result accepted")
    assert "already accepted" in mcp._handle_submit({"artifact": "second.zip"})
    submission = mcp.take_submission("t")
    assert isinstance(submission, SubmissionAccepted)
    assert submission.payload_bytes == b'{"artifact": "first.zip"}'


def test_format_budget_only_counts_after_arming() -> None:
    mcp = _mcp()
    mcp.begin_task(task_key="t", schema=_SCHEMA, max_attempts=2)
    # premature submissions, valid or not, never advance the budget
    for _ in range(5):
        assert "more steps" in mcp._handle_submit({"not": "matching"})
    mcp.allow_submission("t")
    assert "does not match" in mcp._handle_submit({"not": "matching"})
    assert "budget is exhausted" in mcp._handle_submit({"not": "matching"})
    submission = mcp.take_submission("t")
    assert isinstance(submission, SubmissionFormatFailed)
    assert submission.attempts == 2
