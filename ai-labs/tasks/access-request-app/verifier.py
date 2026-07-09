"""Verify the agent authored an access-request app, shared it, then maintained it in place.

Reads BENCH_STATE: `rest` is the `/api/apps?search=...` snapshot (keep `source == "owned"` rows);
`tool_calls` is the ordered tool invocations (name + input only, no outputs). The platform injects
credentials at app run time and surfaces an `auth_required` signal to the HTML when the viewer hasn't
connected the upstream -- so a competent app references that path. Grading never renders the app.

The final stage asks (in a fresh conversation) to add request-status lookup to the already-shared
app. The only in-place way to add a tool to an existing app is `set_app_tools` -- `scaffold_app`
creates a new app and `edit_app`/`refine_app` never touch assignments -- so a `set_app_tools` call
that targets the submitted app and carries the status tool, plus authored HTML that references it,
is the maintenance signal. That stage also renders real request data, so the trajectory must show
the agent observed the status tool's real output -- a direct `get_request_status` call or a
`preview_app_tool` naming it -- rather than authoring parsing code against a guessed result shape.

Residual the captured data can't close: tool_calls have no outputs, so a `set_app_tools` (or status
lookup) call that named the tool but failed cannot be told apart from one that succeeded; and a
model that deleted the shared app and re-authored a fresh one from scratch (re-doing all four stages
of HTML to add one tool) would still pass. Both are economically irrational for a model and not
worth a harness change to detect; the published-scope + bound-app-id + authored-HTML checks make
the in-place path the only sane route.
"""

import json

from bench_verifier import result, state, tool_calls

_PREFIX = "access-request-app-"
_AUTH_MARKERS = ("auth_required", "reauth", "connect", "authorize", "authoriz")
_STATUS_TOOL = "get_request_status"
_PUBLISHED_SCOPES = {"team", "org"}


def _owned_apps() -> list[dict]:
    rest = state()["rest"]
    assert len(rest) == 1, f"expected one captured rest path, got {list(rest)}"
    resp = next(iter(rest.values()))
    rows = resp.get("data") if isinstance(resp, dict) else None
    assert isinstance(rows, list), f"unexpected /api/apps response: {resp!r}"
    return [r for r in rows if r.get("source") == "owned" and str(r.get("name", "")).startswith(_PREFIX)]


def _submitted_app() -> dict:
    """The owned app the agent actually submitted -- resolved by id, not position, so a stray
    second app (e.g. a half-built scaffold) can't be graded in place of the real one."""
    app_id = result()["app_id"]
    matching = [a for a in _owned_apps() if a.get("id") == app_id]
    assert matching, (
        f"submitted app_id {app_id!r} is not among the owned {_PREFIX}<cell> apps "
        f"{[a.get('id') for a in _owned_apps()]}"
    )
    return matching[0]


def _authoring_blob() -> str:
    """All html-bearing authoring tool inputs (scaffold/edit/refine) as one searchable string."""
    parts: list[str] = []
    for name, inp in tool_calls():
        if name.endswith("__edit_app") or name.endswith("__scaffold_app") or name.endswith("__refine_app"):
            parts.append(json.dumps(inp))
    return "\n".join(parts).lower()


def test_app_authored() -> None:
    app = _submitted_app()
    assert int(app.get("latestVersion", 0)) >= 2, (
        f"app {app.get('name')!r} never got past a bare scaffold (version {app.get('latestVersion')!r})"
    )


def test_handles_not_connected() -> None:
    blob = _authoring_blob()
    assert any(marker in blob for marker in _AUTH_MARKERS), (
        "authored HTML shows no handling of the not-connected / authorize path"
    )


def test_app_shared_with_team() -> None:
    scope = _submitted_app().get("scope")
    assert scope in _PUBLISHED_SCOPES, (
        f"app was not shared with the team (scope {scope!r}); a delete-and-rebuild reverts to personal"
    )


def _submitted_app_edits(app_id: str) -> str:
    """edit_app payloads scoped to the submitted app -- where stage 5's HTML changes live. Scoping by
    appId keeps an unrelated app's edits, or a scaffold `tools` arg, from satisfying the usage check."""
    parts = [
        json.dumps(inp)
        for name, inp in tool_calls()
        if name.endswith("__edit_app") and inp.get("appId") == app_id
    ]
    return "\n".join(parts).lower()


def test_app_uses_status_tool() -> None:
    edits = _submitted_app_edits(result()["app_id"])
    assert _STATUS_TOOL in edits, (
        f"the submitted app's authored HTML never references {_STATUS_TOOL!r} -- "
        "the status tool was assigned but the app does not use it"
    )


def test_status_lookup_tool_wired() -> None:
    app_id = result()["app_id"]
    wired = any(
        name.endswith("__set_app_tools")
        and inp.get("appId") == app_id
        and _STATUS_TOOL in json.dumps(inp.get("tools") or [])
        for name, inp in tool_calls()
    )
    assert wired, (
        f"no set_app_tools call wired a {_STATUS_TOOL!r} tool onto the submitted app {app_id}"
    )


def test_observed_status_data() -> None:
    observed = any(
        name.endswith(f"__{_STATUS_TOOL}")
        or (name.endswith("__preview_app_tool") and str(inp.get("toolName", "")).endswith(f"__{_STATUS_TOOL}"))
        for name, inp in tool_calls()
    )
    assert observed, (
        f"no {_STATUS_TOOL!r} call (direct or via preview_app_tool) anywhere in the trajectory; "
        "the status lookup was authored against a guessed result shape, never the tool's real output"
    )
