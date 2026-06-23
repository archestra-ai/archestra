"""Grades skill-driven elicitation: the agent must load the access-request-intake skill, gather all five
request fields across a two-turn conversation, honor the stage-2 correction (access_level admin ->
read-write, plus the manager email), and file ONE create_access_request to the IT service desk with the
complete, corrected set. The graded signal is the (unwrapped) tool-call input, not the agent's prose."""

import json

from bench_verifier import result, state

SKILL = "access-request-intake"
EXPECTED = {
    "employee_email": "dana.lee@acme.test",
    "access_level": "read-write",
    "manager_email": "priya.nair@acme.test",
}
SUPERSEDED_ACCESS_LEVEL = "admin"


def _invocations() -> list[tuple[str, dict]]:
    """Every tool the agent invoked as (tool_name, tool_args), unwrapping archestra__run_tool
    (search_and_run_only mode routes MCP tools through run_tool with {tool_name, tool_args})."""
    out: list[tuple[str, dict]] = []
    for call in state().get("tool_calls", []):
        name = call.get("name", "")
        inp = call.get("input") or {}
        if name.endswith("__run_tool") and isinstance(inp, dict):
            args = inp.get("tool_args")
            out.append((str(inp.get("tool_name", "")), args if isinstance(args, dict) else {}))
        else:
            out.append((name, inp if isinstance(inp, dict) else {}))
    return out


def _access_requests() -> list[dict]:
    return [args for name, args in _invocations() if name.endswith("__create_access_request")]


def test_skill_seeded_from_repo() -> None:
    rest = state().get("rest", {})
    assert rest, "no rest snapshot captured"
    payload = next(iter(rest.values()))
    rows = payload.get("data") if isinstance(payload, dict) else payload
    matches = [r for r in (rows or []) if r.get("name") == SKILL]
    assert len(matches) == 1, f"skill {SKILL!r} not found or duplicated: {matches}"
    assert matches[0].get("sourceType") == "github", (
        f"expected github source, got {matches[0].get('sourceType')!r}"
    )


def test_skill_loaded() -> None:
    loaded = [
        args
        for name, args in _invocations()
        if name.endswith("__load_skill") and SKILL in json.dumps(args)
    ]
    assert loaded, f"agent never loaded the {SKILL} skill"


def test_request_filed_with_corrected_fields() -> None:
    requests = _access_requests()
    # Exactly one request: the skill says gather everything first, then file once. A premature stage-1
    # submission (before the correction) followed by a corrected one is a protocol violation, not a pass.
    assert len(requests) == 1, (
        f"expected exactly one create_access_request call, got {len(requests)}"
    )
    final = requests[0]

    assert final.get("employee_email") == EXPECTED["employee_email"], final
    assert final.get("manager_email") == EXPECTED["manager_email"], final
    assert final.get("access_level") == EXPECTED["access_level"], (
        f"access_level not corrected: got {final.get('access_level')!r}, expected "
        f"{EXPECTED['access_level']!r}"
    )
    assert final.get("access_level") != SUPERSEDED_ACCESS_LEVEL, (
        "agent filed the superseded admin access level"
    )
    assert "salesforce" in str(final.get("system", "")).lower(), final
    assert str(final.get("justification", "")).strip(), "justification missing/empty"


def test_reported_ticket_id() -> None:
    submitted = result()["ticket_id"]
    assert submitted == "REQ-10042", f"got {submitted!r}, expected the service-desk ticket id"
