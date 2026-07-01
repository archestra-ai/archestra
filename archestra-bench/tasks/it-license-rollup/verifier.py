"""Grades the contract-billed rollup: the agent must pull both the seat inventory and the contract terms
from the acme_it MCP, then report the real billed monthly total -- not the per-seat list-price sum. The
billed total (per-seat vs flat-commit vs amortized-annual) is unforgeable without joining the two
tool outputs, so answer-match plus the presence of both tool calls proves the work was done."""

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
    return answer["total_billed_monthly_cents"]


def test_called_seats_and_contracts() -> None:
    invoked = [name for name, _ in _invocations()]
    assert any(name.endswith("__list_seats") for name in invoked), (
        f"agent never pulled the seat inventory; invoked={invoked}"
    )
    assert any(name.endswith("__list_license_contracts") for name in invoked), (
        f"agent never pulled the contract terms, so it could not have billed correctly; invoked={invoked}"
    )


def test_billed_total_matches() -> None:
    submitted = result()["total_billed_monthly_cents"]
    expected = _expected()
    assert submitted == expected, f"got {submitted}, expected {expected}"
