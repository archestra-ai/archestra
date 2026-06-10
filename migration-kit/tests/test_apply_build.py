"""offline tests for the deterministic decision->payload builder."""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
import yaml

from apply import (
    BuiltAgent,
    BuiltCatalog,
    BuiltHook,
    BuiltInstall,
    BuiltLlmKey,
    BuiltPolicy,
    BuiltSkill,
    _build_payload,
    _Built,
    _flag_hook_collisions,
    _redacted_for_print,
)
from archestra_client import CatalogCreate, LlmKeyCreate, LocalConfig, McpEnvVar
from contracts import ContractError, Decision, HookData, HookItem, Item, SkillItem, to_jsonable
from discover import discover

FIXTURE = Path(__file__).parent / "fixtures" / "sample-setup"
SCRIPTS = Path(__file__).parent.parent / "scripts"


@pytest.fixture(scope="module")
def index() -> dict[str, Item]:
    inv = discover(FIXTURE)
    return {it.id: it for it in inv.items}


def _decide(index: dict[str, Item], source_id: str, target_kind: str, **kw: Any):
    decision = Decision(source_id=source_id, target_kind=target_kind, scope="personal", **kw)
    return _build_payload(decision, index[source_id])


def test_claude_md_builds_agent(index: dict[str, Item]) -> None:
    _, built = _decide(index, "claude_md", "agent")
    assert isinstance(built, BuiltAgent)
    assert built.payload.agentType == "agent"
    assert built.payload.scope == "personal"
    assert built.payload.systemPrompt is not None
    assert "note assistant" in built.payload.systemPrompt.lower()


def test_subagent_builds_skill_with_allowlist_note(index: dict[str, Item]) -> None:
    _, built = _decide(index, "subagent:fact-checker", "skill")
    assert isinstance(built, BuiltSkill)
    fm = yaml.safe_load(built.payload.content.split("---", 2)[1])
    assert fm["name"] == "fact-checker"
    assert "not enforced" in built.payload.content.lower()
    assert "Read, Bash, Skill" in built.payload.content


def test_skill_is_verbatim(index: dict[str, Item]) -> None:
    _, built = _decide(index, "skill:summarize-text", "skill")
    assert isinstance(built, BuiltSkill)
    source = index["skill:summarize-text"]
    assert isinstance(source, SkillItem)
    assert built.payload.content == source.data.content
    assert {f.path for f in built.payload.files} == {"reference.md"}


def test_team_scoped_skill_requires_team_ids(index: dict[str, Item]) -> None:
    with pytest.raises(ContractError, match="teamIds"):
        _build_payload(
            Decision(source_id="skill:summarize-text", target_kind="skill", scope="team"),
            index["skill:summarize-text"],
        )


def test_team_scoped_skill_carries_team_ids(index: dict[str, Item]) -> None:
    _, built = _build_payload(
        Decision(
            source_id="skill:summarize-text",
            target_kind="skill",
            scope="team",
            user_answers={"teamIds": ["team-a", "team-b", "team-a"]},
        ),
        index["skill:summarize-text"],
    )
    assert isinstance(built, BuiltSkill)
    assert built.payload.scope == "team"
    assert built.payload.teamIds == ["team-a", "team-b"]


def test_local_tool_builds_skill_bundling_script(index: dict[str, Item]) -> None:
    _, built = _decide(index, "local_tool:word_count", "skill")
    assert isinstance(built, BuiltSkill)
    assert "python3 tools/word_count.py" in built.payload.content
    assert built.payload.files[0].path == "tools/word_count.py"


def test_remote_mcp_builds_remote_catalog(index: dict[str, Item]) -> None:
    _, built = _decide(index, "mcp:weather", "mcp_catalog")
    assert isinstance(built, BuiltCatalog)
    assert built.payload.serverType == "remote"
    assert built.payload.serverUrl == "https://mcp.example.com/weather"


def test_team_scoped_agent_carries_team_ids(index: dict[str, Item]) -> None:
    _, built = _build_payload(
        Decision(
            source_id="claude_md",
            target_kind="agent",
            scope="team",
            user_answers={"teamIds": ["team-a", "team-b"]},
        ),
        index["claude_md"],
    )
    assert isinstance(built, BuiltAgent)
    assert built.payload.teams == ["team-a", "team-b"]


def test_team_scoped_install_uses_single_team_id(index: dict[str, Item]) -> None:
    _, built = _build_payload(
        Decision(
            source_id="mcp:github",
            target_kind="mcp_install",
            scope="team",
            user_answers={"teamIds": ["team-a"], "agentIds": ["agent-a"]},
        ),
        index["mcp:github"],
    )
    assert isinstance(built, BuiltInstall)
    assert built.team_id == "team-a"
    assert built.agent_ids == ["agent-a"]


def test_team_scoped_llm_key_carries_team_id(index: dict[str, Item]) -> None:
    _, built = _build_payload(
        Decision(
            source_id="openclaw",
            target_kind="llm_key",
            scope="team",
            user_answers={"provider": "anthropic", "apiKey": "sk-ant-real", "teamId": "team-a"},
        ),
        index["openclaw"],
    )
    assert isinstance(built, BuiltLlmKey)
    assert built.payload.teamId == "team-a"


def test_team_answer_precedence_when_both_present(index: dict[str, Item]) -> None:
    """pins the divergent precedence: multi-team kinds prefer teamIds, single-team kinds
    prefer teamId, when a plan carries both answers."""
    both = {"teamIds": ["team-a", "team-b"], "teamId": "team-c"}
    _, built = _build_payload(
        Decision(source_id="claude_md", target_kind="agent", scope="team", user_answers=both),
        index["claude_md"],
    )
    assert isinstance(built, BuiltAgent)
    assert built.payload.teams == ["team-a", "team-b"]
    _, built = _build_payload(
        Decision(
            source_id="mcp:github", target_kind="mcp_install", scope="team", user_answers=both,
        ),
        index["mcp:github"],
    )
    assert isinstance(built, BuiltInstall)
    assert built.team_id == "team-c"


def test_stdio_mcp_redacted_env_becomes_prompted_secret(index: dict[str, Item]) -> None:
    _, built = _decide(index, "mcp:github", "mcp_catalog")
    assert isinstance(built, BuiltCatalog)
    assert built.payload.serverType == "local"
    assert built.payload.localConfig is not None
    env = {e.key: e for e in built.payload.localConfig.environment}
    assert env["GITHUB_TOKEN"].type == "secret"
    assert env["GITHUB_TOKEN"].promptOnInstallation is True
    assert env["GITHUB_TOKEN"].value is None  # secret value not carried


def test_llm_key_requires_user_supplied_secret(index: dict[str, Item]) -> None:
    # provider present but apiKey missing -> the apiKey requirement is what fails.
    with pytest.raises(ContractError, match="apiKey"):
        _decide(index, "openclaw", "llm_key", user_answers={"provider": "anthropic"})
    _, built = _decide(index, "openclaw", "llm_key",
                       user_answers={"apiKey": "sk-ant-real", "provider": "anthropic"})
    assert isinstance(built, BuiltLlmKey)
    assert built.payload.apiKey == "sk-ant-real"
    assert built.payload.provider == "anthropic"


def test_llm_key_rejects_unknown_provider(index: dict[str, Item]) -> None:
    with pytest.raises(ContractError, match="provider"):
        _decide(index, "openclaw", "llm_key",
                user_answers={"apiKey": "sk-ant-real", "provider": "not-a-provider"})


def test_generated_frontmatter_is_valid_yaml_with_hostile_name(index: dict[str, Item]) -> None:
    # a subagent name with yaml-significant chars must not break the frontmatter.
    _, built = _build_payload(
        Decision(source_id="subagent:fact-checker", target_kind="skill", scope="personal",
                 name_override='evil: name "with" #chars'),
        index["subagent:fact-checker"],
    )
    assert isinstance(built, BuiltSkill)
    fm = built.payload.content.split("---", 2)[1]
    assert yaml.safe_load(fm)["name"] == 'evil: name "with" #chars'


def test_dry_run_redaction_hides_user_secrets() -> None:
    llm = _redacted_for_print(BuiltLlmKey(LlmKeyCreate(
        provider="anthropic", scope="personal", apiKey="sk-real", name="k")))
    assert llm["apiKey"] == "<redacted>"
    install = _redacted_for_print(BuiltInstall(
        catalog_name="fs", scope="personal", environment_values={"GITHUB_TOKEN": "ghp_real"}, agent_ids=[]))
    env = install["environmentValues"]
    assert isinstance(env, dict)
    assert env["GITHUB_TOKEN"] == "<redacted>"
    catalog = _redacted_for_print(BuiltCatalog(CatalogCreate(
        name="github",
        serverType="local",
        scope="personal",
        localConfig=LocalConfig(
            command="run --token=ghp_commandsecret00000",
            arguments=["--key", "sk-argsecret00000000"],
            environment=[McpEnvVar(key="GITHUB_TOKEN", type="secret", value="ghp_real")],
        ),
    )))
    local = catalog["localConfig"]
    assert isinstance(local, dict)
    catalog_env = local["environment"]
    assert isinstance(catalog_env, list)
    assert isinstance(catalog_env[0], dict)
    assert catalog_env[0]["value"] == "<redacted>"
    # a credential embedded in the launch command/args is scrubbed (CodeQL clear-text logging).
    assert "ghp_commandsecret00000" not in json.dumps(catalog)
    assert "sk-argsecret00000000" not in json.dumps(catalog)
    # a remote server URL with basic-auth + a secret query param is scrubbed too.
    remote = _redacted_for_print(BuiltCatalog(CatalogCreate(
        name="weather", serverType="remote", scope="personal",
        serverUrl="https://user:hunter2@mcp.example.com/w?api_key=plaintextsecret&region=us")))
    shown_url = json.dumps(remote)
    assert "hunter2" not in shown_url
    assert "plaintextsecret" not in shown_url
    assert "region=us" in shown_url  # non-secret query param preserved

def test_tool_policy_requires_extracted_semantics(index: dict[str, Item]) -> None:
    with pytest.raises(ContractError, match="user_answers"):
        _decide(index, "hook:.claude/settings.json:PreToolUse:0:0", "tool_policy")
    _, built = _decide(index, "hook:.claude/settings.json:PreToolUse:0:0", "tool_policy",
                       user_answers={"tool_name": "shell", "key": "command",
                                      "operator": "regex", "value": "rm\\s+-rf\\s+/"})
    assert isinstance(built, BuiltPolicy)
    assert built.tool_name == "shell"
    assert built.conditions[0].operator == "regex"
    assert built.action == "block_always"


def test_bundled_hook_builds_native_hook_with_pep723_requirements(index: dict[str, Item]) -> None:
    _, built = _decide(index, "hook:.claude/settings.json:PreToolUse:0:0", "hook")
    assert isinstance(built, BuiltHook)
    assert built.event == "pre_tool_use"
    assert built.file_name == "pre_tool_use.py"
    assert built.requirements == ["pyyaml>=6.0"]  # extracted from the script's PEP-723 block
    assert "rm" in built.content  # the script body is carried verbatim
    assert built.agent_id is None  # apply fills the primary agent at execute time


def test_inline_hook_synthesizes_shell_wrapper(index: dict[str, Item]) -> None:
    _, built = _decide(index, "hook:.claude/settings.json:PostToolUse:0:0", "hook")
    assert isinstance(built, BuiltHook)
    assert built.event == "post_tool_use"
    assert built.file_name == "PostToolUse.sh"
    assert built.content.startswith("#!/bin/sh\n")
    assert "tool-finished" in built.content
    assert built.requirements == []


def test_hook_user_answers_override_filename_and_requirements(index: dict[str, Item]) -> None:
    _, built = _decide(index, "hook:.claude/settings.json:PreToolUse:0:0", "hook",
                       user_answers={"fileName": "guard.py", "requirements": ["httpx>=0.27"]})
    assert isinstance(built, BuiltHook)
    assert built.file_name == "guard.py"
    assert built.requirements == ["httpx>=0.27"]


def test_hook_accepts_explicit_agent_id(index: dict[str, Item]) -> None:
    uid = "0d3f6b1e-1a2b-4c3d-8e9f-0123456789ab"
    _, built = _decide(index, "hook:.claude/settings.json:PreToolUse:0:0", "hook", user_answers={"agentId": uid})
    assert isinstance(built, BuiltHook)
    assert built.agent_id == uid


def test_hook_unsupported_event_is_rejected(index: dict[str, Item]) -> None:
    with pytest.raises(ContractError, match="no archestra equivalent"):
        _decide(index, "hook:.claude/settings.json:UserPromptSubmit:0:0", "hook")


def test_hook_sh_rejects_requirements(index: dict[str, Item]) -> None:
    with pytest.raises(ContractError, match="no requirements"):
        _decide(index, "hook:.claude/settings.json:PostToolUse:0:0", "hook", user_answers={"requirements": ["httpx"]})


def test_hook_rejects_bad_file_name_override(index: dict[str, Item]) -> None:
    with pytest.raises(ContractError, match="file name"):
        _decide(index, "hook:.claude/settings.json:PreToolUse:0:0", "hook", user_answers={"fileName": "guard.txt"})


def test_hook_redacted_print_omits_script_body() -> None:
    # the verbatim script body is never echoed in dry-run output (only its size), so a secret
    # embedded in a bundled hook cannot leak there.
    content = "#!/bin/sh\ncurl -H 'auth: ghp_realhooktoken000000'\n"
    shown = _redacted_for_print(BuiltHook(
        event="session_start", file_name="s.sh", content=content,
        requirements=[], enabled=True, agent_id=None))
    assert "content" not in shown
    assert "ghp_realhooktoken000000" not in json.dumps(shown)
    assert shown["content_chars"] == len(content)


def test_inline_hook_with_redacted_secret_is_refused() -> None:
    # a synthesized wrapper carrying the literal "<redacted>" would be a silently broken hook.
    item = HookItem(id="hook:PreToolUse:0:0", name="h", path="settings.json",
                    data=HookData(event="PreToolUse", command="curl -H 'auth: <redacted>'",
                                  intent="passive", source="inline"))
    with pytest.raises(ContractError, match="redacted secret"):
        _build_payload(Decision(source_id="hook:PreToolUse:0:0", target_kind="hook",
                                scope="personal"), item)


def test_unresolved_hook_is_refused() -> None:
    item = HookItem(id="hook:PreToolUse:0:0", name="h", path="settings.json",
                    data=HookData(event="PreToolUse", command="python3 gone.py",
                                  intent="guard", source="unresolved"))
    with pytest.raises(ContractError, match="could not be resolved"):
        _build_payload(Decision(source_id="hook:PreToolUse:0:0", target_kind="hook",
                                scope="personal"), item)


def test_flag_hook_collisions_invalidates_duplicate_event_and_file() -> None:
    decision = Decision(source_id="hook:x", target_kind="hook", scope="personal")
    hook = BuiltHook(event="pre_tool_use", file_name="g.py", content="x",
                     requirements=[], enabled=True, agent_id=None)
    out = _flag_hook_collisions([_Built(decision, "a", hook, ""), _Built(decision, "b", hook, "")])
    assert out[0].built is hook
    assert out[1].built is None
    assert "distinct user_answers.fileName" in out[1].error


def _run_apply_cli(tmp_path: Path, plan: dict[str, object], *args: str,
                   env: dict[str, str]) -> tuple[subprocess.CompletedProcess[str], Path]:
    """run apply.py as a real subprocess: real argv, explicit env, no in-process patching."""
    inventory_path = tmp_path / "inventory.json"
    plan_path = tmp_path / "migration_plan.json"
    result_path = tmp_path / "migration_result.json"
    inventory_path.write_text(json.dumps(to_jsonable(discover(FIXTURE))), encoding="utf-8")
    plan_path.write_text(json.dumps(plan), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "apply.py"),
         "--inventory", str(inventory_path), "--plan", str(plan_path),
         "--out", str(result_path), *args],
        capture_output=True, text=True, env=env, check=False,
    )
    return proc, result_path


def test_real_apply_preflight_invalid_plan_makes_no_network(tmp_path: Path) -> None:
    requests: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            requests.append(f"GET {self.path}")
            self.send_response(500)
            self.end_headers()

        def do_POST(self) -> None:
            requests.append(f"POST {self.path}")
            self.send_response(500)
            self.end_headers()

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        proc, result_path = _run_apply_cli(tmp_path, {
            "schema_version": 1,
            "default_scope": "team",
            "decisions": [
                {"source_id": "claude_md", "target_kind": "agent", "scope": "team"},
                {"source_id": "skill:summarize-text", "target_kind": "skill", "scope": "team"},
            ],
        }, env={
            **os.environ,
            "ARCHESTRA_BASE_URL": f"http://127.0.0.1:{server.server_address[1]}",
            "ARCHESTRA_API_KEY": "arch_test",
        })

        assert proc.returncode == 1
        assert requests == []
        result = json.loads(result_path.read_text(encoding="utf-8"))
        assert result["summary"] == {"invalid": 2}
    finally:
        server.shutdown()
        thread.join()


def test_dry_run_writes_planned_result_without_network(tmp_path: Path) -> None:
    """pins the --dry-run dispatch: exits 0, writes the result file, needs no env vars."""
    env = {k: v for k, v in os.environ.items()
           if k not in ("ARCHESTRA_BASE_URL", "ARCHESTRA_API_KEY")}
    proc, result_path = _run_apply_cli(tmp_path, {
        "schema_version": 1,
        "default_scope": "personal",
        "decisions": [{"source_id": "claude_md", "target_kind": "agent", "scope": "personal"}],
    }, "--dry-run", env=env)

    assert proc.returncode == 0
    assert "[dry-run]" in proc.stdout
    result = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["summary"] == {"planned": 1}
    assert result["ops"][0]["target_kind"] == "agent"
