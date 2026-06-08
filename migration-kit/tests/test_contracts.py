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
                                       matcher="Bash")),
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


def test_require_dict_and_list_raise_on_wrong_shape() -> None:
    with pytest.raises(c.ContractError, match="object"):
        c.require_dict([1, 2], ctx="x")
    with pytest.raises(c.ContractError, match="array"):
        c.require_list({"a": 1}, ctx="x")
