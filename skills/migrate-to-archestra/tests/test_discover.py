from pathlib import Path

import pytest

from discover import discover

FIXTURE = Path(__file__).parent / "fixtures" / "sample-setup"


@pytest.fixture(scope="module")
def inv():
    return discover(FIXTURE)


def _by_id(inv, item_id):
    return next((it for it in inv.items if it.id == item_id), None)


def test_finds_claude_md_as_primary(inv):
    item = _by_id(inv, "claude_md")
    assert item is not None
    assert item.kind == "claude_md"
    assert "note assistant" in item.data["body"].lower()


def test_subagent_carries_tool_allowlist(inv):
    item = _by_id(inv, "subagent:fact-checker")
    assert item is not None
    assert item.kind == "subagent"
    assert item.data["tools"] == "Read, Bash, Skill"


def test_skill_bundles_sibling_files(inv):
    item = _by_id(inv, "skill:summarize-text")
    assert item is not None
    paths = {f.path for f in item.files}
    assert paths == {"reference.md"}  # SKILL.md is content, not a bundled file
    assert item.files[0].encoding == "utf8"
    assert item.data["content"].startswith("---")


def test_command_discovered(inv):
    assert _by_id(inv, "command:greet") is not None


def test_local_tool_bundles_script(inv):
    item = _by_id(inv, "local_tool:word_count")
    assert item is not None
    assert item.data["entrypoint"] == "tools/word_count.py"
    assert item.files[0].path == "tools/word_count.py"
    assert "def main" in item.files[0].content


def test_mcp_stdio_and_remote(inv):
    fs = _by_id(inv, "mcp:filesystem")
    assert fs.data["transport"] == "local"
    assert fs.data["command"] == "npx"
    weather = _by_id(inv, "mcp:weather")
    assert weather.data["transport"] == "remote"
    assert weather.data["url"] == "https://mcp.example.com/weather"


def test_mcp_secret_env_is_redacted(inv):
    gh = _by_id(inv, "mcp:github")
    assert gh.data["env"]["GITHUB_TOKEN"] == "<redacted>"
    assert any("GITHUB_TOKEN" in r for r in gh.redacted_refs)


def test_hooks_classified(inv):
    guard = _by_id(inv, "hook:PreToolUse:0:0")
    assert guard.data["event"] == "PreToolUse"
    assert guard.data["matcher"] == "Bash"
    assert guard.data["intent"] == "guard"  # blocking event
    session = _by_id(inv, "hook:SessionStart:0:0")
    assert session.data["intent"] == "passive"


def test_hook_command_inline_secret_redacted(inv):
    session = _by_id(inv, "hook:SessionStart:0:0")
    assert "ghp_hooksecret" not in session.data["command"]
    assert "<redacted>" in session.data["command"]


def test_body_secret_warned_but_left_intact(inv):
    # prose/code bodies are the migration artifact -> kept verbatim, but flagged.
    sub = _by_id(inv, "subagent:fact-checker")
    assert "sk-bodyleak000000000000" in sub.data["body"]
    assert any("fact-checker.md" in w for w in inv.warnings)


def test_openclaw_redacted(inv):
    oc = _by_id(inv, "openclaw")
    assert oc.kind == "openclaw"
    assert oc.data["ANTHROPIC_API_KEY"] == "<redacted>"
    assert oc.data["heartbeatSeconds"] == 30  # non-secret kept


def test_no_structured_secret_leaks_in_serialized_inventory(inv):
    blob = inv.model_dump_json()
    assert "ghp_examplesecret" not in blob  # mcp env (structured)
    assert "sk-ant-examplesecret" not in blob  # openclaw (structured)
    assert "ghp_hooksecret" not in blob  # hook command (inline-redacted)
