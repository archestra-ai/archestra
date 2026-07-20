"""Grades the ticket-status lookup, whose stale per-task agent system prompt names a
nonexistent service-desk tool (acme_it__ticket_lookup): the agent must recover from the
unavailable-tool error -- following the platform's steer through tool discovery to the real
request-status tool -- and still deliver the record. The status enum and filing date exist only in
that tool's output, so answer-match plus the presence of the real tool call proves the recovery
happened rather than a lucky guess."""

from bench_verifier import read_fixture_json, result, tool_calls


def test_looked_up_the_request() -> None:
    invoked = [name for name, _ in tool_calls()]
    assert any(name.endswith("__get_request_status") for name in invoked), (
        f"agent never pulled the request status from the service desk; invoked={invoked}"
    )


def test_submitted_record_matches() -> None:
    expected = read_fixture_json("expected", "answer.json")
    submitted = result()
    assert submitted == expected, f"got {submitted}, expected {expected}"
