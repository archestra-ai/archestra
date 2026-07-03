"""Verify the agent authored an app that wires the DeepWiki (3rd-party MCP) integration.

Reads BENCH_STATE: `rest` holds the `/api/apps?search=...` snapshot captured after the run, and
`tool_calls` holds the run's ordered tool invocations (name + input only, no outputs). `/api/apps`
returns a discriminated union -- keep `source == "owned"` rows. Wiring is proven from the
`scaffold_app` call's `tools` arg: a tool name only resolves (and the app only gets created) if it
exists in the org environment, so a wired `deepwiki__*` name is a real signal, not a memorizable
proxy.

The app's answers come from DeepWiki, so the trajectory must also show the agent observed a
`deepwiki__*` tool's real output -- a direct call or a `preview_app_tool` naming one -- rather than
authoring parsing code against a guessed result shape. Residual: tool_calls carry no outputs, so a
call that errored counts the same as one that succeeded.
"""

import json

from bench_verifier import result, state

_PREFIX = "repo-docs-app-"


def _owned_apps() -> list[dict]:
    rest = state()["rest"]
    assert len(rest) == 1, f"expected one captured rest path, got {list(rest)}"
    resp = next(iter(rest.values()))
    rows = resp.get("data") if isinstance(resp, dict) else None
    assert isinstance(rows, list), f"unexpected /api/apps response: {resp!r}"
    return [r for r in rows if r.get("source") == "owned" and str(r.get("name", "")).startswith(_PREFIX)]


def _calls():
    """Each tool call as (effective_name, input). Under search_and_run_only a call may be wrapped in
    run_tool(tool_name, tool_args); app tools are top-level, but unwrap defensively either way."""
    for call in state().get("tool_calls", []):
        name = call.get("name")
        inp = call.get("input") or {}
        if name == "archestra__run_tool":
            yield inp.get("tool_name"), (inp.get("tool_args") or {})
        else:
            yield name, inp


def test_app_authored() -> None:
    apps = _owned_apps()
    assert apps, f"no owned app named {_PREFIX}<cell> was created"
    app = apps[0]
    assert int(app.get("latestVersion", 0)) >= 2, (
        f"app {app.get('name')!r} is still at version {app.get('latestVersion')!r}; it never got past a bare scaffold"
    )
    assert result()["app_id"] == app.get("id"), "submitted app_id does not match the created app"


def test_wires_deepwiki() -> None:
    wired: list[str] = []
    for name, inp in _calls():
        if name and name.endswith("__scaffold_app"):
            wired += [str(t) for t in (inp.get("tools") or [])]
    assert any("deepwiki__" in t for t in wired), (
        f"the app was not wired to a DeepWiki tool at scaffold time; tools wired: {wired}"
    )


def test_observed_deepwiki_output() -> None:
    observed = any(
        name
        and (
            "deepwiki__" in name
            or (name.endswith("__preview_app_tool") and "deepwiki__" in str(inp.get("toolName", "")))
        )
        for name, inp in _calls()
    )
    assert observed, (
        "no deepwiki__* call (direct or via preview_app_tool) anywhere in the trajectory; "
        "the answer view was authored against a guessed result shape, never the tool's real output"
    )
