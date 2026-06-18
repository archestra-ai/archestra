"""Env loading: the real envs parse, and the extra-tool allow-list is validated."""

from __future__ import annotations

from pathlib import Path

import pytest

from envs import _tool_names, load_envs

_ENVS = Path(__file__).resolve().parent.parent / "envs"


def test_real_envs_parse_with_tool_surface() -> None:
    envs = load_envs(_ENVS)
    assert {"basic", "archestra-api"} <= set(envs)
    assert envs["basic"].tools == ()  # basic keeps the strict default (no mutating tools)
    api = envs["archestra-api"]
    assert api.tools == ("create_skill",)
    assert {t.id for t in api.tasks} == {"author-skill", "letter-count"}


def test_share_backend_flag() -> None:
    envs = load_envs(_ENVS)
    # clean, skill-heavy env opts into a shared backend; the mutating self-API env stays isolated.
    assert envs["basic"].share_backend is True
    assert envs["archestra-api"].share_backend is False


def test_tool_names_rejects_non_short_name() -> None:
    with pytest.raises(SystemExit, match="archestra short name"):
        _tool_names(["Create-Skill"], "ctx")


def test_tool_names_rejects_duplicates() -> None:
    with pytest.raises(SystemExit, match="duplicate"):
        _tool_names(["create_skill", "create_skill"], "ctx")
