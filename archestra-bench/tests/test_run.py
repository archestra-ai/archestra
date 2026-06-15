"""Pure-helper tests for the env-configurable tool surface and runtime placeholder expansion.

These exercise run.py's decision logic without a client: the `basic` env (empty allow-list) must
still strip and reject the mutating skill tools, an allow-list must let exactly the named extras
survive, and the runtime expander must substitute only `{{cell}}`/`{{agent_id}}`.
"""

from __future__ import annotations

import re

from run import _cell_token, _expand_runtime, _surface_violations, _tools_to_strip

_BASE = frozenset(
    {
        "archestra__artifact_write",
        "archestra__todo_write",
        "archestra__run_command",
        "archestra__upload_file",
        "archestra__download_file",
        "archestra__list_skills",
        "archestra__load_skill",
    }
)
_CREATE = "archestra__create_skill"
_UPDATE = "archestra__update_skill"
_SUBMIT = "benchmark__submit_result"


def test_basic_env_strips_both_mutating_tools() -> None:
    assert _tools_to_strip(frozenset()) == {_CREATE, _UPDATE}


def test_allow_list_keeps_only_named_mutating_tool() -> None:
    assert _tools_to_strip(frozenset({_CREATE})) == {_UPDATE}


def test_basic_env_rejects_a_leaked_mutating_tool() -> None:
    present = set(_BASE) | {_SUBMIT, _CREATE}  # create_skill must NOT survive with an empty allow-list
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset(), submit_tool=_SUBMIT)
    assert any("mutate the skill library" in v for v in violations)


def test_allowed_mutating_tool_is_not_a_violation() -> None:
    present = set(_BASE) | {_SUBMIT, _CREATE}
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset({_CREATE}), submit_tool=_SUBMIT)
    assert violations == []


def test_missing_required_tool_is_a_violation() -> None:
    present = (set(_BASE) | {_SUBMIT}) - {"archestra__run_command"}
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset(), submit_tool=_SUBMIT)
    assert any("missing required tools" in v for v in violations)


def test_missing_submit_tool_is_a_violation() -> None:
    violations = _surface_violations(set(_BASE), required=set(_BASE), allowed=frozenset(), submit_tool=_SUBMIT)
    assert any("benchmark tool" in v for v in violations)


def test_missing_allowed_extra_is_a_violation() -> None:
    present = set(_BASE) | {_SUBMIT}  # create_skill allowed but not actually assigned
    violations = _surface_violations(present, required=set(_BASE), allowed=frozenset({_CREATE}), submit_tool=_SUBMIT)
    assert any("missing required tools" in v for v in violations)


def test_expand_runtime_substitutes_known_placeholders_only() -> None:
    out = _expand_runtime("{{cell}} {{agent_id}} {{file:keep.csv}}", {"cell": "c1", "agent_id": "ag-9"})
    assert out == "c1 ag-9 {{file:keep.csv}}"


def test_cell_token_is_skill_name_safe() -> None:
    token = _cell_token("archestra-api/author-skill/claude-opus-4-8[1m]", "claude-opus-4-8[1m]")
    assert re.fullmatch(r"[a-z0-9-]+", token)
    assert token.startswith("claude-opus-4-8-1m-")


def test_cell_token_unique_per_cell() -> None:
    # same model in different tasks -> different token (resources don't collide on one backend)
    assert _cell_token("e/t1/m", "m") != _cell_token("e/t2/m", "m")
    # models that slug identically still differ, via the hash of the full cell key
    assert _cell_token("e/t/a.b", "a.b") != _cell_token("e/t/a-b", "a-b")
