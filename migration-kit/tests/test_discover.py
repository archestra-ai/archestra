import json
from pathlib import Path

import pytest

from contracts import (
    ClaudeMdItem,
    CommandItem,
    HookItem,
    Inventory,
    Item,
    LocalToolItem,
    McpServerItem,
    OpenclawItem,
    SkillItem,
    SubagentItem,
    to_jsonable,
)
from discover import _redact, _redact_value, discover

FIXTURE = Path(__file__).parent / "fixtures" / "sample-setup"


def test_redact_value_catches_embedded_token() -> None:
    sink: list[str] = []
    assert _redact_value("--header=token=ghp_abcdefghij1234567890", "ref", sink) == "<redacted>"
    assert sink == ["ref"]
    assert _redact_value("--root=/data", "ref", []) == "--root=/data"  # not a secret


def test_redact_catches_embedded_token_under_innocuous_key() -> None:
    # the secret pattern appears mid-value under a non-secret-named key.
    sink: list[str] = []
    out = _redact({"note": "connect with sk-abcdefghijklmnop please"}, "cfg", sink)
    assert isinstance(out, dict)
    assert out["note"] == "<redacted>"
    assert sink == ["cfg#note"]


@pytest.fixture(scope="module")
def inv() -> Inventory:
    return discover(FIXTURE)


def _by_id(inv: Inventory, item_id: str) -> Item:
    item = next((it for it in inv.items if it.id == item_id), None)
    assert item is not None, f"no item {item_id}"
    return item


def test_finds_claude_md_as_primary(inv: Inventory) -> None:
    item = _by_id(inv, "claude_md")
    assert isinstance(item, ClaudeMdItem)
    assert "note assistant" in item.data.body.lower()


def test_subagent_carries_tool_allowlist(inv: Inventory) -> None:
    item = _by_id(inv, "subagent:fact-checker")
    assert isinstance(item, SubagentItem)
    assert item.data.tools == "Read, Bash, Skill"


def test_skill_bundles_sibling_files(inv: Inventory) -> None:
    item = _by_id(inv, "skill:summarize-text")
    assert isinstance(item, SkillItem)
    assert {f.path for f in item.files} == {"reference.md"}  # SKILL.md is content, not bundled
    assert item.files[0].encoding == "utf8"
    assert item.data.content.startswith("---")


def test_command_discovered(inv: Inventory) -> None:
    assert isinstance(_by_id(inv, "command:greet"), CommandItem)


def test_local_tool_bundles_script(inv: Inventory) -> None:
    item = _by_id(inv, "local_tool:word_count")
    assert isinstance(item, LocalToolItem)
    assert item.data.entrypoint == "tools/word_count.py"
    assert item.files[0].path == "tools/word_count.py"
    assert "def main" in item.files[0].content


def test_mcp_stdio_and_remote(inv: Inventory) -> None:
    fs = _by_id(inv, "mcp:filesystem")
    assert isinstance(fs, McpServerItem)
    assert fs.data.transport == "local"
    assert fs.data.command == "npx"
    weather = _by_id(inv, "mcp:weather")
    assert isinstance(weather, McpServerItem)
    assert weather.data.transport == "remote"
    assert weather.data.url == "https://mcp.example.com/weather"


def test_mcp_secret_env_is_redacted(inv: Inventory) -> None:
    gh = _by_id(inv, "mcp:github")
    assert isinstance(gh, McpServerItem)
    assert gh.data.env["GITHUB_TOKEN"] == "<redacted>"
    assert any("GITHUB_TOKEN" in r for r in gh.redacted_refs)


def test_hooks_classified(inv: Inventory) -> None:
    guard = _by_id(inv, "hook:PreToolUse:0:0")
    assert isinstance(guard, HookItem)
    assert guard.data.event == "PreToolUse"
    assert guard.data.matcher == "Bash"
    assert guard.data.intent == "guard"  # blocking event
    session = _by_id(inv, "hook:SessionStart:0:0")
    assert isinstance(session, HookItem)
    assert session.data.intent == "passive"


def test_hook_command_inline_secret_redacted(inv: Inventory) -> None:
    session = _by_id(inv, "hook:SessionStart:0:0")
    assert isinstance(session, HookItem)
    assert "ghp_hooksecret" not in session.data.command
    assert "<redacted>" in session.data.command


def test_body_secret_warned_but_left_intact(inv: Inventory) -> None:
    # prose/code bodies are the migration artifact -> kept verbatim, but flagged.
    sub = _by_id(inv, "subagent:fact-checker")
    assert isinstance(sub, SubagentItem)
    assert "sk-bodyleak000000000000" in sub.data.body
    assert any("fact-checker.md" in w for w in inv.warnings)


def test_openclaw_redacted(inv: Inventory) -> None:
    oc = _by_id(inv, "openclaw")
    assert isinstance(oc, OpenclawItem)
    assert oc.data.config["ANTHROPIC_API_KEY"] == "<redacted>"
    assert oc.data.config["heartbeatSeconds"] == 30  # non-secret kept


def test_no_structured_secret_leaks_in_serialized_inventory(inv: Inventory) -> None:
    blob = json.dumps(to_jsonable(inv))
    assert "ghp_examplesecret" not in blob  # mcp env (structured)
    assert "sk-ant-examplesecret" not in blob  # openclaw (structured)
    assert "ghp_hooksecret" not in blob  # hook command (inline-redacted)


def test_symlink_escaping_source_is_not_bundled(tmp_path: Path) -> None:
    # a symlink under a skill dir pointing outside the source tree must not embed its target.
    secret = tmp_path / "outside" / "secret.txt"
    secret.parent.mkdir(parents=True)
    secret.write_text("TOP_SECRET_EXTERNAL_FILE")
    skill_dir = tmp_path / "src" / ".claude" / "skills" / "evil"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: evil\n---\nbody")
    (skill_dir / "leak.txt").symlink_to(secret)

    inv = discover(tmp_path / "src")
    item = _by_id(inv, "skill:evil")
    assert isinstance(item, SkillItem)
    assert all(f.path != "leak.txt" for f in item.files)
    assert "TOP_SECRET_EXTERNAL_FILE" not in json.dumps(to_jsonable(inv))


def test_symlinked_skill_dir_is_skipped(tmp_path: Path) -> None:
    # the skill DIRECTORY itself is a symlink escaping the source tree -> skip it entirely,
    # else its SKILL.md + all its files would be read in from outside.
    external = tmp_path / "external_skill"
    external.mkdir()
    (external / "SKILL.md").write_text("---\nname: ext\n---\nEXTERNAL_SKILL_BODY")
    (external / "data.txt").write_text("EXTERNAL_BUNDLED_FILE")
    skills = tmp_path / "src" / ".claude" / "skills"
    skills.mkdir(parents=True)
    (skills / "ext").symlink_to(external, target_is_directory=True)

    inv = discover(tmp_path / "src")
    assert all(not it.id.startswith("skill:") for it in inv.items)
    blob = json.dumps(to_jsonable(inv))
    assert "EXTERNAL_SKILL_BODY" not in blob
    assert "EXTERNAL_BUNDLED_FILE" not in blob
