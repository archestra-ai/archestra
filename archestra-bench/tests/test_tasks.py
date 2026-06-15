"""load_task: parsing + the anti-cheating confinement of staged files to inputs/."""

from __future__ import annotations

from pathlib import Path

import pytest

from tasks import load_task

_SCHEMA = """
[result_schema]
type = "object"
required = ["x"]
  [result_schema.properties.x]
  type = "number"
"""


def _make_task(tmp_path: Path, stages_toml: str, *, with_input: bool = True) -> Path:
    d = tmp_path / "demo-task"
    d.mkdir()
    (d / "task.toml").write_text(stages_toml + _SCHEMA, encoding="utf-8")
    (d / "verifier.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")
    if with_input:
        (d / "inputs").mkdir()
        (d / "inputs" / "data.csv").write_text("payload", encoding="utf-8")
    (d / "expected").mkdir()
    (d / "expected" / "truth.json").write_text("{}", encoding="utf-8")
    return d


def test_loads_valid_task(tmp_path: Path) -> None:
    toml = """
[[stages]]
text = "do the thing"
  [[stages.files]]
  src = "data.csv"
  dest = "/home/sandbox/attachments/data.csv"
"""
    task = load_task(_make_task(tmp_path, toml))
    assert task.id == "demo-task"
    assert task.stages[0].files[0].src == "data.csv"
    assert task.artifact_key is None


def test_rejects_parent_traversal(tmp_path: Path) -> None:
    toml = """
[[stages]]
text = "leak the answer"
  [[stages.files]]
  src = "../expected/truth.json"
  dest = "/home/sandbox/attachments/x"
"""
    with pytest.raises(SystemExit, match="escapes inputs/"):
        load_task(_make_task(tmp_path, toml))


def test_rejects_absolute_src(tmp_path: Path) -> None:
    toml = """
[[stages]]
text = "absolute"
  [[stages.files]]
  src = "/etc/passwd"
  dest = "/home/sandbox/attachments/x"
"""
    with pytest.raises(SystemExit, match="must be relative"):
        load_task(_make_task(tmp_path, toml))


def test_rejects_missing_staged_file(tmp_path: Path) -> None:
    toml = """
[[stages]]
text = "missing"
  [[stages.files]]
  src = "nope.csv"
  dest = "/home/sandbox/attachments/x"
"""
    with pytest.raises(SystemExit, match="does not exist"):
        load_task(_make_task(tmp_path, toml))


def test_rejects_no_stages(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="no stages"):
        load_task(_make_task(tmp_path, "", with_input=False))


def test_expands_file_placeholder(tmp_path: Path) -> None:
    task = load_task(_make_task(tmp_path, '[[stages]]\ntext = "data: {{file:inputs/data.csv}}"\n'))
    assert task.stages[0].text == "data: payload"


def test_file_placeholder_rejects_escape(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="escapes the task dir"):
        load_task(_make_task(tmp_path, '[[stages]]\ntext = "{{file:../../etc/hosts}}"\n'))


def test_file_placeholder_rejects_missing(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="does not exist"):
        load_task(_make_task(tmp_path, '[[stages]]\ntext = "{{file:inputs/nope.csv}}"\n'))


def test_loads_state_rest(tmp_path: Path) -> None:
    toml = (
        '[[stages]]\ntext = "go"\n\n[state]\n'
        'rest = ["/api/skills?search=x&limit=10", "/api/agents/{{agent_id}}/tools"]\n'
    )
    task = load_task(_make_task(tmp_path, toml))
    assert task.state_rest == ("/api/skills?search=x&limit=10", "/api/agents/{{agent_id}}/tools")


def test_state_rest_defaults_empty(tmp_path: Path) -> None:
    assert load_task(_make_task(tmp_path, '[[stages]]\ntext = "go"\n')).state_rest == ()


def test_rejects_non_api_state_path(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="must start with /api/"):
        load_task(_make_task(tmp_path, '[[stages]]\ntext = "go"\n\n[state]\nrest = ["/health"]\n'))


def test_rejects_absolute_url_state_path(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="relative /api/ path"):
        load_task(_make_task(tmp_path, '[[stages]]\ntext = "go"\n\n[state]\nrest = ["http://evil/api/x"]\n'))


def test_rejects_traversal_state_path(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="'\\.\\.' segment"):
        load_task(_make_task(tmp_path, '[[stages]]\ntext = "go"\n\n[state]\nrest = ["/api/../secret"]\n'))
