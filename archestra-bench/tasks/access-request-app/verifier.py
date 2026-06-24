"""Verify the agent authored an access-request app that handles the not-yet-connected (auth) case.

Reads BENCH_STATE: `rest` is the `/api/apps?search=...` snapshot (keep `source == "owned"` rows);
`tool_calls` is the ordered tool invocations. The platform injects credentials at app run time and
surfaces an `auth_required` signal to the HTML when the viewer hasn't connected the upstream -- so a
competent app references that path. Grading never renders the app, so this checks the authored HTML
referenced the connect/auth path, not its runtime behavior.
"""

import json

from bench_verifier import result, state

_PREFIX = "access-request-app-"
_AUTH_MARKERS = ("auth_required", "reauth", "connect", "authorize", "authoriz")


def _owned_apps() -> list[dict]:
    rest = state()["rest"]
    assert len(rest) == 1, f"expected one captured rest path, got {list(rest)}"
    resp = next(iter(rest.values()))
    rows = resp.get("data") if isinstance(resp, dict) else None
    assert isinstance(rows, list), f"unexpected /api/apps response: {resp!r}"
    return [r for r in rows if r.get("source") == "owned" and str(r.get("name", "")).startswith(_PREFIX)]


def _authoring_blob() -> str:
    """All html-bearing authoring tool inputs (scaffold/edit/refine) as one searchable string."""
    parts: list[str] = []
    for call in state().get("tool_calls", []):
        name = call.get("name")
        inp = call.get("input") or {}
        if name == "archestra__run_tool":
            name, inp = inp.get("tool_name"), (inp.get("tool_args") or {})
        if name and (name.endswith("__edit_app") or name.endswith("__scaffold_app") or name.endswith("__refine_app")):
            parts.append(json.dumps(inp))
    return "\n".join(parts).lower()


def test_app_authored() -> None:
    apps = _owned_apps()
    assert apps, f"no owned app named {_PREFIX}<cell> was created"
    app = apps[0]
    assert int(app.get("latestVersion", 0)) >= 2, (
        f"app {app.get('name')!r} never got past a bare scaffold (version {app.get('latestVersion')!r})"
    )
    assert result()["app_id"] == app.get("id"), "submitted app_id does not match the created app"


def test_handles_not_connected() -> None:
    blob = _authoring_blob()
    assert any(marker in blob for marker in _AUTH_MARKERS), (
        "authored HTML shows no handling of the not-connected / authorize path"
    )
