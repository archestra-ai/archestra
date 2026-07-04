"""Recompute the letter-count over the same surface the agent saw and compare to its submission.

Reads BENCH_STATE: `rest` holds the post-run snapshot of the agent's assigned tools
(`/api/agents/<id>/tools`) and the instance skills (`/api/skills`). Both endpoints expose the same
`name` field the agent counts, so truth here is defined identically to the agent's task -- no
hardcoded answer. The skills response is asserted complete (so a paginated overflow fails loudly
rather than silently undercounting). BENCH_RESULT carries the submitted count.
"""

from bench_verifier import result, state

_TARGET_A = 3  # count names whose lowercase form has exactly this many 'a's


def _rows(value: object) -> list:
    """Unwrap a list endpoint response: a bare array, or an {items|data: [...]} envelope."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("items", "data"):
            rows = value.get(key)
            if isinstance(rows, list):
                return rows
    raise AssertionError(f"unrecognized list response shape: {type(value).__name__}")


def _names(rows: list) -> list[str]:
    names = []
    for row in rows:
        name = row.get("name") if isinstance(row, dict) else None
        assert isinstance(name, str), f"row has no string name: {row!r}"
        names.append(name)
    return names


def test_count_matches() -> None:
    # Truth is the `name` field of /api/agents/<id>/tools and /api/skills -- which must be byte-identical
    # to the names the model is shown (so the agent's count and this recompute agree). That holds while
    # the chat tool list uses the registered tool names verbatim; if that ever changes, this diverges.
    rest = state()["rest"]
    assert len(rest) == 2, f"expected exactly two captured rest paths, got {list(rest)}"
    skills_key = next(k for k in rest if k.startswith("/api/skills"))
    tools_key = next(k for k in rest if k != skills_key)

    skills_resp = rest[skills_key]
    skill_rows = _rows(skills_resp)
    pagination = skills_resp.get("pagination") if isinstance(skills_resp, dict) else None
    if isinstance(pagination, dict) and isinstance(pagination.get("total"), int):
        assert pagination["total"] <= len(skill_rows), (
            f"skills snapshot incomplete: pagination.total={pagination['total']} > captured {len(skill_rows)}"
        )

    names = _names(_rows(rest[tools_key])) + _names(skill_rows)
    expected = sum(1 for name in names if name.lower().count("a") == _TARGET_A)
    submitted = result()["count"]
    assert submitted == expected, f"submitted count {submitted} != recomputed {expected} (over {len(names)} names)"
