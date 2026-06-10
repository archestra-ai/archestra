"""tests for the typed cross-script contracts: round-trip + boundary validation."""
import json

import pytest

import contracts as c


def _roundtrip(inv: c.Inventory) -> c.Inventory:
    return c.parse_inventory(json.loads(json.dumps(c.to_jsonable(inv))))


def test_inventory_roundtrips_through_json() -> None:
    inv = c.Inventory(
        source_root="/x",
        items=[
            c.ClaudeMdItem(id="claude_md", name="root", path="CLAUDE.md",
                           data=c.ClaudeMdData(body="hi", frontmatter={"name": "root"})),
            c.SubagentItem(id="subagent:a", name="a", path="a.md",
                           data=c.SubagentData(body="b", tools=["Read", "Bash"])),
            c.McpServerItem(id="mcp:gh", name="gh", path=".mcp.json",
                            redacted_refs=["mcp:gh#env#T"],
                            data=c.McpServerData(transport="local", command="npx",
                                                 env={"T": "<redacted>"})),
            c.HookItem(id="hook:PreToolUse:0:0", name="h", path="settings.json",
                       data=c.HookData(event="PreToolUse", command="x", intent="guard",
                                       source="bundled", matcher="Bash",
                                       file_name="guard.py", script_path="hooks/guard.py",
                                       requirements=["httpx>=0.27"])),
            c.OpenclawItem(id="openclaw", name="openclaw", path="openclaw.json",
                           data=c.OpenclawData(config={"k": 1, "nested": {"a": [1, 2]}})),
        ],
        unknowns=["weird.file"],
        warnings=["careful"],
    )
    assert _roundtrip(inv) == inv


def test_parse_item_rejects_unknown_kind() -> None:
    with pytest.raises(c.ContractError, match="unknown item kind"):
        c.parse_item({"kind": "bogus", "id": "x", "name": "x", "path": "p", "data": {}}, ctx="t")


def test_parse_item_rejects_missing_required_field() -> None:
    with pytest.raises(c.ContractError, match="body"):
        c.parse_item({"kind": "claude_md", "id": "x", "name": "x", "path": "p", "data": {}}, ctx="t")


def test_parse_bundled_file_rejects_bad_encoding() -> None:
    with pytest.raises(c.ContractError, match="encoding"):
        c.parse_bundled_file({"path": "p", "content": "c", "encoding": "rot13"}, ctx="t")


def test_parse_plan_roundtrips_and_validates() -> None:
    plan = c.MigrationPlan(
        schema_version=1, default_scope="personal",
        decisions=[c.Decision(source_id="claude_md", target_kind="agent", scope="personal"),
                   c.Decision(source_id="cmd", target_kind="skill", scope="team", action="skip")],
    )
    back = c.parse_plan(json.loads(json.dumps(c.to_jsonable(plan))))
    assert back == plan


def test_parse_plan_rejects_bad_enums() -> None:
    base = {"source_id": "x", "scope": "personal"}
    with pytest.raises(c.ContractError, match="target kind"):
        c.parse_decision({**base, "target_kind": "nope"}, ctx="d")
    with pytest.raises(c.ContractError, match="scope"):
        c.parse_decision({"source_id": "x", "target_kind": "agent", "scope": "galaxy"}, ctx="d")
    with pytest.raises(c.ContractError, match="migrate"):
        c.parse_decision({**base, "target_kind": "agent", "action": "delete"}, ctx="d")


def test_user_answer_validators_reject_bad_values() -> None:
    with pytest.raises(c.ContractError, match="provider"):
        c.require_provider({"provider": "huggingface"}, ctx="a")
    with pytest.raises(c.ContractError, match="operator"):
        c.require_operator({"operator": "matches"}, ctx="a")
    with pytest.raises(c.ContractError, match="action"):
        c.optional_action({"action": "obliterate"}, ctx="a")


def test_user_answer_validators_accept_good_values() -> None:
    assert c.require_provider({"provider": "anthropic"}, ctx="a") == "anthropic"
    assert c.require_operator({"operator": "regex"}, ctx="a") == "regex"
    assert c.optional_action({}, ctx="a") == "block_always"  # default
    assert c.optional_action({"action": "require_approval"}, ctx="a") == "require_approval"


def test_archestra_hook_event_maps_supported_events_only() -> None:
    assert c.archestra_hook_event("SessionStart") == "session_start"
    assert c.archestra_hook_event("PreToolUse") == "pre_tool_use"
    assert c.archestra_hook_event("PostToolUse") == "post_tool_use"
    for unsupported in ("UserPromptSubmit", "Stop", "SubagentStop", "PreCompact", "Notification"):
        assert c.archestra_hook_event(unsupported) is None


def test_archestra_file_name_validates_basename_and_extension() -> None:
    assert c.archestra_file_name("guard.py", ctx="f") == "guard.py"
    assert c.archestra_file_name("pre_tool-use.sh", ctx="f") == "pre_tool-use.sh"
    for bad in ("guard.txt", "../guard.py", "dir/guard.py", ".hidden.py", "guard", "a" * 256 + ".py"):
        with pytest.raises(c.ContractError, match="file name"):
            c.archestra_file_name(bad, ctx="f")


def test_validate_requirements_trims_and_bounds() -> None:
    assert c.validate_requirements(["  httpx>=0.27 ", "pyyaml"], ctx="r") == ["httpx>=0.27", "pyyaml"]
    assert c.validate_requirements([], ctx="r") == []
    with pytest.raises(c.ContractError, match="non-empty"):
        c.validate_requirements(["  "], ctx="r")
    with pytest.raises(c.ContractError, match="single line"):
        c.validate_requirements(["foo\nbar"], ctx="r")
    with pytest.raises(c.ContractError, match="at most"):
        c.validate_requirements([f"pkg{i}" for i in range(21)], ctx="r")
    with pytest.raises(c.ContractError, match="exceeds"):
        c.validate_requirements(["x" * 201], ctx="r")


def test_require_requirements_is_none_when_absent() -> None:
    assert c.require_requirements({}, ctx="a") is None
    assert c.require_requirements({"requirements": ["httpx"]}, ctx="a") == ["httpx"]


def test_optional_agent_id_requires_uuid_shape() -> None:
    uid = "0d3f6b1e-1a2b-4c3d-8e9f-0123456789ab"
    assert c.optional_agent_id({"agentId": uid}, ctx="a") == uid
    assert c.optional_agent_id({}, ctx="a") is None
    with pytest.raises(c.ContractError, match="UUID"):
        c.optional_agent_id({"agentId": "not-a-uuid"}, ctx="a")


def test_optional_file_name_validates_when_present() -> None:
    assert c.optional_file_name({"fileName": "g.sh"}, ctx="a") == "g.sh"
    assert c.optional_file_name({}, ctx="a") is None
    with pytest.raises(c.ContractError, match="file name"):
        c.optional_file_name({"fileName": "g.txt"}, ctx="a")


def test_require_hook_content_enforces_length() -> None:
    assert c.require_hook_content("x", ctx="c") == "x"
    with pytest.raises(c.ContractError, match="length"):
        c.require_hook_content("", ctx="c")
    with pytest.raises(c.ContractError, match="length"):
        c.require_hook_content("x" * (c.HOOK_CONTENT_MAX + 1), ctx="c")


def test_require_dict_and_list_raise_on_wrong_shape() -> None:
    with pytest.raises(c.ContractError, match="object"):
        c.require_dict([1, 2], ctx="x")
    with pytest.raises(c.ContractError, match="array"):
        c.require_list({"a": 1}, ctx="x")


def test_secret_key_regex_matches_real_keys_not_innocent_words() -> None:
    # delimited credential components match (component boundary = end / non-alnum / camelCase hump).
    for key in ("API_KEY", "apiKey", "access_token", "ANTHROPIC_API_KEY", "client-secret",
                "DB_PASSWORD", "authorization", "credentials", "X-Api-Key"):
        assert c.SECRET_KEY_RE.search(key), f"{key} should be detected as secret-named"
    # words that merely contain a credential substring must NOT match.
    for key in ("monkey", "tokenize", "secretary", "keynote", "keyboard", "donkey"):
        assert not c.SECRET_KEY_RE.search(key), f"{key} should not be a false positive"
