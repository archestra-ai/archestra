"""offline tests for the deterministic decision->payload builder."""
from pathlib import Path

import pytest

import yaml

from apply import Decision, _build_payload, _item_index, _redacted_for_print
from discover import discover

FIXTURE = Path(__file__).parent / "fixtures" / "sample-setup"


@pytest.fixture(scope="module")
def index():
    inv = discover(FIXTURE)
    return _item_index(inv.model_dump())


def _decide(index, source_id, target_kind, **kw):
    d = Decision(source_id=source_id, target_kind=target_kind, scope="personal", **kw)
    return _build_payload(d, index[source_id])


def test_claude_md_builds_agent(index):
    name, payload = _decide(index, "claude_md", "agent")
    assert payload["agentType"] == "agent"
    assert payload["scope"] == "personal"
    assert "note assistant" in payload["systemPrompt"].lower()


def test_subagent_builds_skill_with_allowlist_note(index):
    name, payload = _decide(index, "subagent:fact-checker", "skill")
    fm = yaml.safe_load(payload["content"].split("---", 2)[1])
    assert fm["name"] == "fact-checker"
    assert "not enforced" in payload["content"].lower()
    assert "Read, Bash, Skill" in payload["content"]


def test_skill_is_verbatim(index):
    name, payload = _decide(index, "skill:summarize-text", "skill")
    assert payload["content"] == index["skill:summarize-text"]["data"]["content"]
    assert {f["path"] for f in payload["files"]} == {"reference.md"}


def test_local_tool_builds_skill_bundling_script(index):
    name, payload = _decide(index, "local_tool:word_count", "skill")
    assert "python3 tools/word_count.py" in payload["content"]
    assert payload["files"][0]["path"] == "tools/word_count.py"


def test_remote_mcp_builds_remote_catalog(index):
    name, payload = _decide(index, "mcp:weather", "mcp_catalog")
    assert payload["serverType"] == "remote"
    assert payload["remoteConfig"]["url"] == "https://mcp.example.com/weather"


def test_stdio_mcp_redacted_env_becomes_prompted_secret(index):
    name, payload = _decide(index, "mcp:github", "mcp_catalog")
    assert payload["serverType"] == "local"
    env = {e["key"]: e for e in payload["localConfig"]["environment"]}
    assert env["GITHUB_TOKEN"]["type"] == "secret"
    assert env["GITHUB_TOKEN"]["promptOnInstallation"] is True
    assert "value" not in env["GITHUB_TOKEN"]  # secret value not carried


def test_llm_key_requires_user_supplied_secret(index):
    # openclaw item exists but is report-only; build an llm_key from it requires answers.
    with pytest.raises(ValueError, match="apiKey"):
        _decide(index, "openclaw", "llm_key")
    name, payload = _decide(index, "openclaw", "llm_key",
                            user_answers={"apiKey": "sk-ant-real", "provider": "anthropic"})
    assert payload["apiKey"] == "sk-ant-real"
    assert payload["provider"] == "anthropic"


def test_generated_frontmatter_is_valid_yaml_with_hostile_name(index):
    # a subagent name with yaml-significant chars must not break the frontmatter.
    item = dict(index["subagent:fact-checker"])
    d = Decision(source_id="subagent:fact-checker", target_kind="skill", scope="personal",
                 name_override='evil: name "with" #chars')
    _, payload = _build_payload(d, item)
    fm = payload["content"].split("---", 2)[1]
    assert yaml.safe_load(fm)["name"] == 'evil: name "with" #chars'


def test_dry_run_redaction_hides_user_secrets():
    assert _redacted_for_print("llm_key", {"apiKey": "sk-real", "provider": "anthropic"})["apiKey"] == "<redacted>"
    out = _redacted_for_print("mcp_install", {"environmentValues": {"GITHUB_TOKEN": "ghp_real"}})
    assert out["environmentValues"]["GITHUB_TOKEN"] == "<redacted>"


def test_tool_policy_requires_extracted_semantics(index):
    with pytest.raises(ValueError, match="tool_policy requires"):
        _decide(index, "hook:PreToolUse:0:0", "tool_policy")
    name, payload = _decide(index, "hook:PreToolUse:0:0", "tool_policy",
                            user_answers={"tool_name": "shell", "key": "command",
                                          "operator": "regex", "value": "rm\\s+-rf\\s+/"})
    assert payload["tool_name"] == "shell"
    assert payload["conditions"][0]["operator"] == "regex"
    assert payload["action"] == "block_always"
