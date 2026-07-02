"""Verify the agent authored a keyboard-driven kanban app with correct SDK usage.

Reads BENCH_STATE: `rest` is the `/api/apps?search=...` snapshot (keep `source == "owned"` rows);
`tool_calls` is the ordered tool invocations (name + input only, no outputs). The unusual requirement
is keyboard-only operation, so the authored HTML should wire keyboard handling. The platform injects
`window.archestra` and rejects HTML that self-imports the SDK, so a clean app uses the injected
global and does not import the SDK file. Grading never renders the app; these check the authored
markup, not runtime behavior.

The cards are seeded from the acme_it seat inventory, so the trajectory must also show the agent
observed that tool's real output -- a direct `list_seats` call or a `preview_app_tool` naming it --
rather than authoring parsing code against a guessed result shape. Residual: tool_calls carry no
outputs, so a call that errored counts the same as one that succeeded.
"""

import json

from bench_verifier import result, state

_PREFIX = "keyboard-kanban-app-"
_KEYBOARD_MARKERS = ("keydown", "keyup", "arrowright", "arrowleft", "arrowup", "arrowdown", "tabindex")
_DATA_TOOL = "list_seats"


def _owned_apps() -> list[dict]:
    rest = state()["rest"]
    assert len(rest) == 1, f"expected one captured rest path, got {list(rest)}"
    resp = next(iter(rest.values()))
    rows = resp.get("data") if isinstance(resp, dict) else None
    assert isinstance(rows, list), f"unexpected /api/apps response: {resp!r}"
    return [r for r in rows if r.get("source") == "owned" and str(r.get("name", "")).startswith(_PREFIX)]


def _tool_calls():
    """(name, input) for each call, unwrapping run_tool to the inner tool it dispatched."""
    for call in state().get("tool_calls", []):
        name = call.get("name")
        inp = call.get("input") or {}
        if name == "archestra__run_tool":
            name, inp = inp.get("tool_name"), (inp.get("tool_args") or {})
        if name:
            yield name, inp


def _authoring_blob() -> str:
    parts: list[str] = []
    for name, inp in _tool_calls():
        if name.endswith("__edit_app") or name.endswith("__scaffold_app") or name.endswith("__refine_app"):
            parts.append(json.dumps(inp))
    return "\n".join(parts)


def test_app_authored() -> None:
    apps = _owned_apps()
    assert apps, f"no owned app named {_PREFIX}<cell> was created"
    app = apps[0]
    assert int(app.get("latestVersion", 0)) >= 2, (
        f"app {app.get('name')!r} never got past a bare scaffold (version {app.get('latestVersion')!r})"
    )
    assert result()["app_id"] == app.get("id"), "submitted app_id does not match the created app"


def test_keyboard_driven() -> None:
    blob = _authoring_blob().lower()
    assert any(marker in blob for marker in _KEYBOARD_MARKERS), (
        "authored HTML shows no keyboard handling; the board is not keyboard-driven"
    )


def test_observed_seat_data() -> None:
    observed = any(
        name.endswith(f"__{_DATA_TOOL}")
        or (name.endswith("__preview_app_tool") and str(inp.get("toolName", "")).endswith(f"__{_DATA_TOOL}"))
        for name, inp in _tool_calls()
    )
    assert observed, (
        f"no {_DATA_TOOL!r} call (direct or via preview_app_tool) anywhere in the trajectory; "
        "the seat cards were authored against a guessed result shape, never the tool's real output"
    )
