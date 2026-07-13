"""The upstream-bug shim: CalendarEvent must be hashable so injection-task
security() checks that do `set(email.attachments)` don't crash the run."""

from agentdojo.default_suites.v1.tools.types import CalendarEvent

from baton_dojo import _agentdojo_compat


def _event(id_: str) -> CalendarEvent:
    return CalendarEvent(
        id_=id_,
        title="t",
        description="d",
        start_time="2024-05-26 10:00",
        end_time="2024-05-26 11:00",
        location="loc",
        participants=[],
    )


def test_apply_makes_calendar_event_hashable():
    _agentdojo_compat.apply()
    ev = _event("abc")
    # the exact operation that crashed injection_task_11/12 security()
    assert set([ev, "file-id-1"]) is not None
    assert hash(ev) == hash("abc")


def test_apply_is_idempotent():
    _agentdojo_compat.apply()
    _agentdojo_compat.apply()
    assert CalendarEvent.__hash__ is not None
