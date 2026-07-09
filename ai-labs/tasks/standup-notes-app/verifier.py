"""Verify the agent authored a notepad app that uses the platform persistence layer, iterated in place.

Reads BENCH_STATE: `rest` is the `/api/apps?search=...` snapshot (keep `source == "owned"` rows);
`tool_calls` is the ordered tool invocations. Persistence is the injected `window.archestra.storage`
API -- the app HTML must call it to survive a refresh, so its presence in the authored HTML is the
signal. Two stages of edits on one app should leave a single app at a bumped version.
"""

import json

from bench_verifier import result, state, tool_calls

_PREFIX = "standup-notes-app-"


def _owned_apps() -> list[dict]:
    rest = state()["rest"]
    assert len(rest) == 1, f"expected one captured rest path, got {list(rest)}"
    resp = next(iter(rest.values()))
    rows = resp.get("data") if isinstance(resp, dict) else None
    assert isinstance(rows, list), f"unexpected /api/apps response: {resp!r}"
    return [r for r in rows if r.get("source") == "owned" and str(r.get("name", "")).startswith(_PREFIX)]


def _authoring_blob() -> str:
    parts: list[str] = []
    for name, inp in tool_calls():
        if name.endswith("__edit_app") or name.endswith("__scaffold_app") or name.endswith("__refine_app"):
            parts.append(json.dumps(inp))
    return "\n".join(parts)


def test_app_authored_and_iterated() -> None:
    apps = _owned_apps()
    assert apps, f"no owned app named {_PREFIX}<cell> was created"
    app = apps[0]
    assert int(app.get("latestVersion", 0)) >= 2, (
        f"app {app.get('name')!r} never got past a bare scaffold (version {app.get('latestVersion')!r})"
    )
    assert result()["app_id"] == app.get("id"), "submitted app_id does not match the created app"
    assert result()["version"] == int(app.get("latestVersion")), (
        f"submitted version {result()['version']} != current latestVersion {app.get('latestVersion')}"
    )


def test_uses_persistence() -> None:
    assert "archestra.storage" in _authoring_blob(), (
        "authored HTML never calls window.archestra.storage; nothing would survive a refresh"
    )
