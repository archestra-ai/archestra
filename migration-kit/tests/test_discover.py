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
from discover import (
    _dangling_refs,
    _extract_dependencies_block,
    _parse_hook_command,
    _redact,
    _redact_value,
    _script_position,
    discover,
)

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
    guard = _by_id(inv, "hook:.claude/settings.json:PreToolUse:0:0")
    assert isinstance(guard, HookItem)
    assert guard.data.event == "PreToolUse"
    assert guard.data.matcher == "Bash"
    assert guard.data.intent == "guard"  # blocking event
    session = _by_id(inv, "hook:.claude/settings.json:SessionStart:0:0")
    assert isinstance(session, HookItem)
    assert session.data.intent == "passive"


def test_bundled_hook_resolves_script_and_pep723(inv: Inventory) -> None:
    guard = _by_id(inv, "hook:.claude/settings.json:PreToolUse:0:0")
    assert isinstance(guard, HookItem)
    assert guard.data.source == "bundled"
    assert guard.data.file_name == "pre_tool_use.py"
    assert guard.data.script_path == "hooks/pre_tool_use.py"
    assert guard.data.requirements == ["pyyaml>=6.0"]  # extracted from PEP-723 inline metadata
    assert [f.path for f in guard.files] == ["hooks/pre_tool_use.py"]


def test_inline_hook_has_no_bundled_script(inv: Inventory) -> None:
    post = _by_id(inv, "hook:.claude/settings.json:PostToolUse:0:0")
    assert isinstance(post, HookItem)
    assert post.data.source == "inline"
    assert post.data.file_name is None
    assert post.files == []


def test_env_prefix_hook_is_flagged_in_summary(inv: Inventory) -> None:
    # the SessionStart command has a `TOKEN=...` env prefix that a hook cannot represent.
    session = _by_id(inv, "hook:.claude/settings.json:SessionStart:0:0")
    assert isinstance(session, HookItem)
    assert session.data.source == "bundled"
    assert "env/args" in session.summary


def test_unsupported_event_hook_noted_for_manual(inv: Inventory) -> None:
    ups = _by_id(inv, "hook:.claude/settings.json:UserPromptSubmit:0:0")
    assert isinstance(ups, HookItem)
    assert "no archestra equivalent" in ups.summary


def test_unresolved_hook_when_script_missing(tmp_path: Path) -> None:
    src = tmp_path / "src"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(json.dumps({
        "hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/hooks/gone.py\""}
        ]}]}
    }))
    inv = discover(src)
    hook = _by_id(inv, "hook:.claude/settings.json:PreToolUse:0:0")
    assert isinstance(hook, HookItem)
    assert hook.data.source == "unresolved"
    assert hook.data.file_name is None


def test_same_hook_slot_in_two_config_files_gets_distinct_ids(tmp_path: Path) -> None:
    src = tmp_path / "src"
    (src / ".claude").mkdir(parents=True)
    entry = {"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}}
    (src / ".claude" / "settings.json").write_text(json.dumps(entry))
    (src / ".claude" / "settings.local.json").write_text(json.dumps(entry))
    inv = discover(src)
    ids = [it.id for it in inv.items if isinstance(it, HookItem)]
    assert len(ids) == len(set(ids)) == 2


def test_empty_or_env_only_command_is_unresolved(tmp_path: Path) -> None:
    # neither "" (e.g. a missing command field) nor a bare env assignment runs anything,
    # so synthesizing an inline wrapper from them would create a no-op hook.
    src = tmp_path / "src"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(json.dumps({
        "hooks": {"PreToolUse": [{"hooks": [{"type": "command"}, {"type": "command", "command": "FOO=bar"}]}]}
    }))
    inv = discover(src)
    for j in (0, 1):
        hook = _by_id(inv, f"hook:.claude/settings.json:PreToolUse:0:{j}")
        assert isinstance(hook, HookItem)
        assert hook.data.source == "unresolved"


def test_bundled_hook_resolves_with_relative_root(monkeypatch: pytest.MonkeyPatch) -> None:
    # discover() resolves the root, so a relative source dir must still bundle referenced scripts.
    monkeypatch.chdir(FIXTURE.parent)
    inv = discover(Path(FIXTURE.name))
    guard = _by_id(inv, "hook:.claude/settings.json:PreToolUse:0:0")
    assert isinstance(guard, HookItem)
    assert guard.data.source == "bundled"
    assert guard.data.script_path == "hooks/pre_tool_use.py"


def test_pep723_extracts_dependencies_with_extras() -> None:
    # a `]` inside a value (extras) must not truncate the array.
    content = "\n".join([
        "# /// script",
        "# dependencies = [",
        '#   "requests[security]>=2",',
        '#   "pyyaml",',
        "# ]",
        "# ///",
        "print(1)",
    ])
    assert _extract_dependencies_block(content) == ["requests[security]>=2", "pyyaml"]


def test_pep723_ignores_quoted_strings_in_comments() -> None:
    content = "\n".join([
        "# /// script",
        "# dependencies = [",
        '#   "foo",  # pinned for "bar" reasons',
        "# ]",
        "# ///",
    ])
    assert _extract_dependencies_block(content) == ["foo"]


def test_script_position_only_matches_executable_or_interpreter_arg(tmp_path: Path) -> None:
    assert _script_position(["python3", "-u", "hook.py"], tmp_path) == 2
    assert _script_position(["uv", "run", "--with", "rich", "hook.py"], tmp_path) == 4
    assert _script_position(["./hook.sh"], tmp_path) == 0
    assert _script_position(["echo", "note.py"], tmp_path) is None  # not a script invocation


def test_script_path_in_echo_argument_is_inline_not_bundled(tmp_path: Path) -> None:
    parsed = _parse_hook_command('echo "$CLAUDE_PROJECT_DIR/hooks/a.py"', tmp_path)
    assert parsed.source == "inline"


def test_interpreter_flags_before_script_count_as_extra_args(tmp_path: Path) -> None:
    # `--with rich` would be dropped on migration just like trailing argv, so it must be flagged.
    (tmp_path / "hook.py").write_text("print(1)")
    parsed = _parse_hook_command("uv run --with rich hook.py", tmp_path)
    assert parsed.source == "bundled"
    assert parsed.has_extra_args
    plain = _parse_hook_command("python3 hook.py", tmp_path)
    assert plain.source == "bundled"
    assert not plain.has_extra_args


def test_bundled_script_through_symlinked_root_alias_does_not_crash(tmp_path: Path) -> None:
    # an absolute command path spelled via an unresolved alias of the source root (symlinked
    # parent; /tmp vs /private/tmp on macOS) must still bundle, not crash discover().
    real = tmp_path / "real"
    (real / ".claude").mkdir(parents=True)
    (real / "hooks").mkdir()
    (real / "hooks" / "a.py").write_text("print(1)")
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    (real / ".claude" / "settings.json").write_text(json.dumps({
        "hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": f"python3 {alias / 'hooks' / 'a.py'}"}
        ]}]}
    }))
    inv = discover(real)
    hook = _by_id(inv, "hook:.claude/settings.json:PreToolUse:0:0")
    assert isinstance(hook, HookItem)
    assert hook.data.source == "bundled"
    assert hook.data.script_path == "hooks/a.py"


def test_inline_env_prefix_is_not_flagged(tmp_path: Path) -> None:
    # an inline wrapper carries the command verbatim, env assignment included -- nothing is lost.
    src = tmp_path / "src"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(json.dumps({
        "hooks": {"PostToolUse": [{"hooks": [{"type": "command", "command": "FOO=bar echo done"}]}]}
    }))
    inv = discover(src)
    hook = _by_id(inv, "hook:.claude/settings.json:PostToolUse:0:0")
    assert isinstance(hook, HookItem)
    assert hook.data.source == "inline"
    assert "env/args" not in hook.summary


def test_hook_command_inline_secret_redacted(inv: Inventory) -> None:
    session = _by_id(inv, "hook:.claude/settings.json:SessionStart:0:0")
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


# --- dangling references: surface repo files a migrated body points at but we didn't capture ---


def test_dangling_refs_flags_only_existing_unbundled_files(tmp_path: Path) -> None:
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "run.sh").write_text("echo hi")
    body = "run `scripts/run.sh`, `scripts/missing.sh`, and `$CLAUDE_PROJECT_DIR/scripts/run.sh`"
    refs = _dangling_refs(body, [tmp_path], tmp_path, bundled=set())
    assert set(refs) == {"scripts/run.sh"}  # missing.sh skipped; the two run.sh refs dedupe to one


def test_dangling_refs_skips_bundled_files(tmp_path: Path) -> None:
    (tmp_path / "scripts").mkdir()
    real = tmp_path / "scripts" / "run.sh"
    real.write_text("echo hi")
    # a file that travels with this artifact is safe even though it exists in the repo.
    assert _dangling_refs("see scripts/run.sh", [tmp_path], tmp_path, bundled={real.resolve()}) == []


def test_dangling_refs_resolves_against_multiple_bases(tmp_path: Path) -> None:
    # a skill body may address a sibling by skill-dir-relative `../shared.md` OR a tool by
    # repo-root-relative `tools/x.py`; both should resolve and flag.
    skills = tmp_path / ".claude" / "skills"
    (skills / "dcf").mkdir(parents=True)
    (skills / "shared.md").write_text("shared")
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "x.py").write_text("x")
    refs = _dangling_refs("read ../shared.md then run tools/x.py", [skills / "dcf", tmp_path],
                          tmp_path, bundled=set())
    assert set(refs) == {".claude/skills/shared.md", "tools/x.py"}


def test_dangling_refs_ignores_root_escaping_ref(tmp_path: Path) -> None:
    # ../../etc/x.sh resolves outside the repo -> never flagged (and never read).
    assert _dangling_refs("see ../../outside.sh", [tmp_path], tmp_path, bundled=set()) == []


def test_discover_warns_on_dangling_command_reference(tmp_path: Path) -> None:
    src = tmp_path / "src"
    (src / ".claude" / "commands").mkdir(parents=True)
    (src / ".claude" / "commands" / "greet.md").write_text("Run `scripts/run.sh` to greet.")
    (src / "scripts").mkdir()
    (src / "scripts" / "run.sh").write_text("echo hi")  # exists but lives outside captured dirs

    inv = discover(src)
    assert any("scripts/run.sh" in w for w in inv.warnings)
    assert len(inv.warnings) == 1  # no secrets in this fixture, so the dangle is the only warning


def test_discover_flags_ref_captured_as_separate_item(tmp_path: Path) -> None:
    # the cross-artifact break: a command points at a tool captured as its OWN local_tool, so the
    # tool is NOT bundled into the command's skill -> it still dangles and must be flagged.
    src = tmp_path / "src"
    (src / ".claude" / "commands").mkdir(parents=True)
    (src / ".claude" / "commands" / "run.md").write_text("Run `python3 tools/foo.py`.")
    (src / "tools").mkdir()
    (src / "tools" / "foo.py").write_text("print('hi')")  # captured separately as a local_tool

    inv = discover(src)
    assert any(it.id == "local_tool:foo" for it in inv.items)  # captured as its own item...
    assert any("tools/foo.py" in w for w in inv.warnings)      # ...yet still flagged for the command


def test_fixture_skill_flags_repo_root_tool_reference(inv: Inventory) -> None:
    # summarize-text's SKILL.md runs `python3 tools/word_count.py`; that tool is captured as its
    # own local_tool, not bundled into the skill, so the skill's reference dangles.
    assert any("tools/word_count.py" in w for w in inv.warnings)
