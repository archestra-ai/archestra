"""Grades the synthetic-MCP rollup: the agent must call the acme_it `list_seats` tool and report the
exact total monthly cost. The exact cent total over the controlled seat table is unforgeable without the
tool output, so answer-match + tool-call presence together prove the MCP was actually used."""

from bench_verifier import read_fixture_json, result, state


def _invocations() -> list[tuple[str, dict]]:
    """Every tool the agent invoked as (tool_name, tool_args).

    The bench agent runs in search_and_run_only mode, so MCP tools (and submit_result) are called
    indirectly through `archestra__run_tool` with input {tool_name, tool_args}; built-ins like
    run_command are called directly. Unwrap run_tool so callers see the real tool name + args either way.
    """
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


def _expected() -> int:
    answer = read_fixture_json("expected", "answer.json")
    return answer["total_monthly_cost_cents"]


def test_called_list_seats() -> None:
    invoked = [name for name, _ in _invocations()]
    assert any(name.endswith("__list_seats") for name in invoked), (
        f"agent never called the acme_it list_seats MCP tool; invoked={invoked}"
    )


def test_total_matches() -> None:
    submitted = result()["total_monthly_cost_cents"]
    expected = _expected()
    assert submitted == expected, f"got {submitted}, expected {expected}"
