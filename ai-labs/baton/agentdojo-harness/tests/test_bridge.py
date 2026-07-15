"""Bridge round-trips against the real baton-check binary."""

import pytest

from baton_dojo.bridge import BatonBridge, BatonProtocolError, Call
from baton_dojo.contracts import load_table

TABLE = load_table("workspace")


def bridge(policy: str = "deny") -> BatonBridge:
    return BatonBridge(contracts=TABLE.wire_contracts(), unknown_policy=policy)


def test_clean_context_permits_sink():
    decision = bridge().check(
        "invite bob",
        executed=[Call("get_current_day")],
        proposed=Call("send_email", recipients=("bob@example.com",)),
    )
    assert decision.permitted
    assert not decision.audited


def test_blocked_decisions_are_policy_blocks_and_refusals_are_not():
    """Only a genuine `blocked` decision acquires the policy-block sentinel;
    refused/unresolved oracle answers must never count as policy blocks."""
    from baton_dojo.bridge import BatonDecision
    from baton_dojo.defense import POLICY_BLOCK_SENTINEL, denial_message

    blocked = BatonDecision(decision="blocked", block_kind="denied_by_authority", detail="d")
    assert denial_message(blocked).startswith(POLICY_BLOCK_SENTINEL)
    assert blocked.blocked and not blocked.permitted

    refused = BatonDecision(decision="refused", refusal_kind="stale_basis", detail="d")
    unresolved = BatonDecision(decision="unresolved", unresolved_kind="stalled", detail="d")
    for decision in (refused, unresolved):
        assert not decision.permitted and not decision.blocked
        assert not denial_message(decision).startswith(POLICY_BLOCK_SENTINEL)


def test_tainted_context_blocks_sink():
    decision = bridge().check(
        "summarize my emails",
        executed=[Call("get_unread_emails")],
        proposed=Call("send_email", recipients=("bob@example.com",)),
    )
    assert not decision.permitted
    assert decision.block_kind == "denied_by_authority"


def test_unregistered_tool_follows_unknown_policy():
    proposed = Call("mystery_tool")
    assert bridge("deny").check("x", [], proposed).block_kind == "unknown_denied"
    permitted = bridge("allow_with_audit").check("x", [], proposed)
    assert permitted.permitted and permitted.audited
    assert bridge("escalate").check("x", [], proposed).block_kind == "denied_by_authority"


def test_replaying_a_blocked_call_raises_protocol_error():
    with pytest.raises(BatonProtocolError):
        bridge().check(
            "summarize my emails",
            executed=[
                Call("get_unread_emails"),
                Call("send_email", recipients=("bob@example.com",)),
            ],
            proposed=Call("get_current_day"),
        )


def test_table_covers_live_workspace_suite():
    from agentdojo.task_suite.load_suites import get_suite

    suite = get_suite("v1.2.2", "workspace")
    TABLE.check_covers({tool.name for tool in suite.tools})


def test_recipients_extraction():
    assert TABLE.recipients_of("send_email", {"recipients": ["a@x.com", "b@x.com"]}) == [
        "a@x.com",
        "b@x.com",
    ]
    assert TABLE.recipients_of("share_file", {"email": "a@x.com", "file_id": "1"}) == ["a@x.com"]
    assert TABLE.recipients_of("create_calendar_event", {"title": "standup"}) == []
    assert TABLE.recipients_of("get_current_day", {}) == []
    with pytest.raises(ValueError):
        TABLE.recipients_of("send_email", {"recipients": 42})
