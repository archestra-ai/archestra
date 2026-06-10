# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""discover an agentic setup and emit a structured, secret-redacted inventory.

pure parsing: no network, no code execution, no judgment. the model consumes the inventory
and decides the migration plan. stdio package resolution and remote-mcp reachability are
intentionally NOT checked here -- they first surface at apply time.

zero third-party dependencies: frontmatter is parsed by the bundled frontmatter module and
the typed shapes come from contracts, so this runs on a stock python>=3.10 with no install.

usage:
    python3 discover.py <source_dir> [--out inventory.json]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shlex
import sys
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from contracts import SECRET_KEY_RE as _SECRET_KEY
from contracts import SECRET_TOKEN_RE as _SECRET_TOKEN
from contracts import SECRET_VALUE_RE as _SECRET_VALUE
from contracts import (
    BundledFile,
    ClaudeMdData,
    ClaudeMdItem,
    CommandData,
    CommandItem,
    ContractError,
    FrontMatter,
    HookData,
    HookIntent,
    HookItem,
    HookSource,
    Inventory,
    JsonValue,
    LocalToolData,
    LocalToolItem,
    McpServerData,
    McpServerItem,
    OpenclawData,
    OpenclawItem,
    ServerType,
    SkillData,
    SkillItem,
    SubagentData,
    SubagentItem,
    archestra_hook_event,
    as_array,
    as_object,
    redact_tokens,
    require_dict,
    to_jsonable,
    validate_requirements,
)
from frontmatter import parse_frontmatter

# events whose hooks can block the action -- candidates for a tool-invocation policy.
_BLOCKING_EVENTS = {"PreToolUse", "UserPromptSubmit", "PreCompact", "Stop", "SubagentStop"}


def _style(text: str, code: str) -> str:
    if sys.stdout.isatty() and "NO_COLOR" not in os.environ:
        return f"\033[{code}m{text}\033[0m"
    return text


def _is_secret_value(value: str) -> bool:
    # a prefix that looks like a credential, OR a credential-shaped token embedded anywhere.
    return bool(_SECRET_VALUE.match(value) or _SECRET_TOKEN.search(value))


def _redact_value(value: str, ref: str, sink: list[str]) -> str:
    """redact a single structured-config string if it looks like a credential; record the ref."""
    if _is_secret_value(value):
        sink.append(ref)
        return "<redacted>"
    return value


def _warn_if_secret(text: str, ref: str, warnings: list[str]) -> None:
    """flag (do NOT alter) a credential-shaped token in artifact content -- prose/code bodies
    and bundled files are migrated verbatim, so we surface the risk instead of corrupting them."""
    if _SECRET_TOKEN.search(text):
        warnings.append(f"possible secret left intact in {ref} -- review before sharing the inventory")


def _redact(value: JsonValue, ref: str, sink: list[str]) -> JsonValue:
    """recursively replace secret-looking values; record where each redaction happened."""
    match value:
        case dict():
            out: dict[str, JsonValue] = {}
            for k, v in value.items():
                if isinstance(v, str) and (_SECRET_KEY.search(k) or _is_secret_value(v)):
                    out[k] = "<redacted>"
                    sink.append(f"{ref}#{k}")
                else:
                    out[k] = _redact(v, f"{ref}#{k}", sink)
            return out
        case list():
            return [_redact(v, f"{ref}[{i}]", sink) for i, v in enumerate(value)]
        case str() if _is_secret_value(value):
            sink.append(ref)
            return "<redacted>"
        case _:
            return value


def _meta_str(meta: FrontMatter, key: str) -> str | None:
    value = meta.get(key)
    return value if isinstance(value, str) else None


def _as_opt_str(value: JsonValue) -> str | None:
    return value if isinstance(value, str) else None


def _as_str_list(value: JsonValue) -> list[str]:
    arr = as_array(value)
    return [v for v in arr if isinstance(v, str)] if arr is not None else []


def _is_contained_file(path: Path, root: Path) -> bool:
    """a real file that resolves inside root. excludes symlinks escaping the source tree --
    following one would embed an arbitrary external file (e.g. /etc/shadow) into the inventory."""
    return path.is_file() and path.resolve().is_relative_to(root.resolve())


def _read_bundled(path: Path, rel_to: Path) -> BundledFile:
    rel = path.relative_to(rel_to).as_posix()
    raw = path.read_bytes()
    try:
        return BundledFile(path=rel, content=raw.decode("utf-8"), encoding="utf8")
    except UnicodeDecodeError:
        return BundledFile(path=rel, content=base64.b64encode(raw).decode("ascii"), encoding="base64")


def _classify_hook(event: str, command: str) -> HookIntent:
    """advisory intent hint for the model: a deterministic guard vs passive logging. the guard
    logic often lives in a referenced script we don't read, so this is a HINT -- the model must
    inspect the hook before deciding to translate it to a policy."""
    if event in _BLOCKING_EVENTS or re.search(r"sys\.exit\(\s*2\s*\)|exit 2", command):
        return "guard"
    return "passive"


def _redact_env(name: str, env_raw: JsonValue, sink: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    env_obj = as_object(env_raw)
    if env_obj is None:
        return out
    for key, value in env_obj.items():
        if isinstance(value, str) and (_SECRET_KEY.search(key) or _is_secret_value(value)):
            out[key] = "<redacted>"
            sink.append(f"mcp:{name}#env#{key}")
        else:
            out[key] = value if isinstance(value, str) else json.dumps(value)
    return out


def discover(root: Path) -> Inventory:
    # resolve up front so path math (containment, relative_to, $CLAUDE_PROJECT_DIR expansion) is
    # consistent whether the caller passed an absolute or a relative source dir.
    root = root.resolve()
    inv = Inventory(source_root=str(root))
    seen: set[Path] = set()

    def mark(p: Path) -> None:
        seen.add(p.resolve())

    def read(path: Path) -> str:
        return path.read_text(encoding="utf-8", errors="replace")

    def note_unparsed(doc_unparsed: list[str], rel: str) -> None:
        for line in doc_unparsed:
            inv.unknowns.append(f"{rel} (unparsed frontmatter: {line.strip()})")

    # 1. root CLAUDE.md -> primary agent
    for cm in (root / "CLAUDE.md", root / ".claude" / "CLAUDE.md"):
        if _is_contained_file(cm, root):
            doc = parse_frontmatter(read(cm))
            rel = cm.relative_to(root).as_posix()
            note_unparsed(doc.unparsed_lines, rel)
            _warn_if_secret(doc.body, rel, inv.warnings)
            inv.items.append(ClaudeMdItem(
                id="claude_md", name=root.name or "primary", path=rel,
                summary="root orchestration prompt -> primary agent system prompt",
                data=ClaudeMdData(body=doc.body, frontmatter=doc.frontmatter),
            ))
            mark(cm)
            break

    # 2. subagents -> skills (preferred)
    for f in sorted((root / ".claude" / "agents").glob("*.md")):
        if not _is_contained_file(f, root):
            continue
        doc = parse_frontmatter(read(f))
        name = _meta_str(doc.frontmatter, "name") or f.stem
        rel = f.relative_to(root).as_posix()
        note_unparsed(doc.unparsed_lines, rel)
        _warn_if_secret(doc.body, rel, inv.warnings)
        description = _meta_str(doc.frontmatter, "description")
        tools = doc.frontmatter.get("tools")
        inv.items.append(SubagentItem(
            id=f"subagent:{name}", name=name, path=rel, summary=(description or "")[:200],
            data=SubagentData(body=doc.body, description=description, tools=tools),
        ))
        mark(f)

    # 3. skills -> skills (clean)
    for skill_md in sorted((root / ".claude" / "skills").glob("*/SKILL.md")):
        # reject a skill reached through a symlinked dir that escapes the source tree.
        if not _is_contained_file(skill_md, root):
            continue
        skill_dir = skill_md.parent
        content = read(skill_md)
        doc = parse_frontmatter(content)
        name = _meta_str(doc.frontmatter, "name") or skill_dir.name
        rel = skill_md.relative_to(root).as_posix()
        note_unparsed(doc.unparsed_lines, rel)
        files = [
            _read_bundled(p, skill_dir)
            for p in sorted(skill_dir.rglob("*"))
            if p != skill_md and _is_contained_file(p, skill_dir)
        ]
        _warn_if_secret(content, rel, inv.warnings)
        for bf in files:
            if bf.encoding == "utf8":
                _warn_if_secret(bf.content, f"{skill_dir.relative_to(root).as_posix()}/{bf.path}", inv.warnings)
        inv.items.append(SkillItem(
            id=f"skill:{name}", name=name, path=rel,
            summary=(_meta_str(doc.frontmatter, "description") or "")[:200],
            data=SkillData(content=content, frontmatter=doc.frontmatter), files=files,
        ))
        for p in skill_dir.rglob("*"):
            mark(p)

    # 4. slash commands -> skills (best-effort)
    for f in sorted((root / ".claude" / "commands").glob("*.md")):
        if not _is_contained_file(f, root):
            continue
        doc = parse_frontmatter(read(f))
        name = _meta_str(doc.frontmatter, "name") or f.stem
        rel = f.relative_to(root).as_posix()
        note_unparsed(doc.unparsed_lines, rel)
        _warn_if_secret(doc.body, rel, inv.warnings)
        inv.items.append(CommandItem(
            id=f"command:{name}", name=name, path=rel,
            summary=(_meta_str(doc.frontmatter, "description") or "")[:200],
            data=CommandData(body=doc.body, frontmatter=doc.frontmatter),
        ))
        mark(f)

    # 5. local python tools -> skills (best-effort). heuristic: *.py under a tools/ dir.
    for f in sorted((root / "tools").glob("*.py")):
        if not _is_contained_file(f, root):
            continue
        bundled = _read_bundled(f, root)
        if bundled.encoding == "utf8":
            _warn_if_secret(bundled.content, bundled.path, inv.warnings)
        entry = f.relative_to(root).as_posix()
        inv.items.append(LocalToolItem(
            id=f"local_tool:{f.stem}", name=f.stem, path=entry,
            summary=f"local python tool {f.name} -> skill wrapping the script",
            data=LocalToolData(entrypoint=entry), files=[bundled],
        ))
        mark(f)

    # 6. mcp servers + hooks from .mcp.json and settings*.json
    for cfg_path in (root / ".mcp.json", root / ".claude" / "settings.json",
                     root / ".claude" / "settings.local.json"):
        if not cfg_path.is_file():
            continue
        mark(cfg_path)
        rel = cfg_path.relative_to(root).as_posix()
        try:
            parsed_cfg: JsonValue = json.loads(read(cfg_path))
        except json.JSONDecodeError:
            inv.unknowns.append(f"{rel} (invalid json)")
            continue
        cfg = as_object(parsed_cfg)
        if cfg is None:
            inv.unknowns.append(f"{rel} (not a json object)")
            continue
        _discover_mcp_servers(inv, cfg.get("mcpServers"), rel)
        _discover_hooks(inv, cfg.get("hooks"), rel, root, mark)

    # 7. openclaw config -> report-only (schema unverified)
    for oc in (root / "openclaw.json", root / ".openclaw" / "openclaw.json"):
        if oc.is_file():
            mark(oc)
            rel = oc.relative_to(root).as_posix()
            try:
                parsed_oc: JsonValue = json.loads(read(oc))
            except json.JSONDecodeError:
                inv.unknowns.append(f"{rel} (invalid json)")
                continue
            raw = as_object(parsed_oc)
            if raw is None:
                inv.unknowns.append(f"{rel} (not a json object)")
                continue
            refs: list[str] = []
            config = require_dict(_redact(raw, "openclaw", refs), ctx="openclaw")
            inv.items.append(OpenclawItem(
                id="openclaw", name="openclaw", path=rel,
                summary="openclaw runtime config -> report-only (manual migration)",
                data=OpenclawData(config=config), redacted_refs=refs,
            ))

    # 8. unrecognized files under .claude/ -> surface for the model
    claude_dir = root / ".claude"
    if claude_dir.is_dir():
        for p in sorted(claude_dir.rglob("*")):
            if p.is_file() and p.resolve() not in seen:
                inv.unknowns.append(p.relative_to(root).as_posix())

    return inv


def _discover_mcp_servers(inv: Inventory, servers: JsonValue, rel: str) -> None:
    servers_obj = as_object(servers)
    if servers_obj is None:
        return
    for name, spec in servers_obj.items():
        spec_obj = as_object(spec)
        if spec_obj is None:
            inv.unknowns.append(f"{rel} (mcpServers.{name} is not an object)")
            continue
        refs: list[str] = []
        url = _as_opt_str(spec_obj.get("url"))
        server_type: ServerType = "remote" if url else "local"
        command = _as_opt_str(spec_obj.get("command"))
        # command/args/url are structured config -> redact embedded secrets (env handled below).
        if command is not None:
            command = _redact_value(command, f"mcp:{name}#command", refs)
        if url is not None:
            url = _redact_value(url, f"mcp:{name}#url", refs)
        args = [_redact_value(a, f"mcp:{name}#args[{i}]", refs)
                for i, a in enumerate(_as_str_list(spec_obj.get("args")))]
        inv.items.append(McpServerItem(
            id=f"mcp:{name}", name=name, path=rel,
            summary=f"{server_type} mcp server -> catalog item (+ optional install)",
            data=McpServerData(
                transport=server_type, command=command, args=args,
                env=_redact_env(name, spec_obj.get("env"), refs), url=url,
            ),
            redacted_refs=refs,
        ))


# a leading shell `KEY=VALUE` environment assignment (env-prefix before the interpreter).
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# $CLAUDE_PROJECT_DIR / ${CLAUDE_PROJECT_DIR} -- expanded to the source root for path resolution.
_PROJECT_DIR_RE = re.compile(r"\$\{?CLAUDE_PROJECT_DIR\}?")
# runners that take a script path as a later argument (so a .py/.sh after one is the hook script).
_INTERPRETERS = frozenset({"python", "python3", "sh", "bash", "zsh", "node", "uv", "env",
                           "ruby", "deno", "bun", "perl"})


@dataclass(frozen=True)
class _HookCmd:
    """outcome of inspecting a hook command for a referenced script (already secret-redacted)."""
    source: HookSource
    script: Path | None  # resolved contained path when source == "bundled"
    has_env_prefix: bool
    has_extra_args: bool


def _parse_hook_command(command: str, root: Path) -> _HookCmd:
    """classify a hook command: a contained referenced .py/.sh (bundled), a self-contained shell
    snippet (inline), or a referenced script we cannot resolve / unparsable quoting (unresolved)."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return _HookCmd("unresolved", None, has_env_prefix=False, has_extra_args=False)

    idx = 0
    has_env_prefix = False
    while idx < len(tokens) and _ENV_ASSIGN_RE.match(tokens[idx]):
        has_env_prefix = True
        idx += 1
    rest = tokens[idx:]
    if not rest:  # empty or env-assignments-only command: nothing to run
        return _HookCmd("unresolved", None, has_env_prefix=has_env_prefix, has_extra_args=False)
    script_pos = _script_position(rest, root)
    if script_pos is None:
        return _HookCmd("inline", None, has_env_prefix=has_env_prefix, has_extra_args=False)

    # tokens between the interpreter and the script (e.g. `uv run --with rich x.py`) are
    # dropped on migration just like trailing arguments, so both count as extra args.
    has_extra_args = script_pos + 1 < len(rest) or script_pos > 1
    candidate = Path(_expand_project_dir(rest[script_pos], root))
    resolved = candidate if candidate.is_absolute() else root / candidate
    if _is_contained_file(resolved, root):
        # resolve: root is resolved, so an unresolved alias (symlinked parent, /tmp on macOS)
        # would crash relative_to in _read_bundled; this also normalizes any `..` segments.
        return _HookCmd("bundled", resolved.resolve(), has_env_prefix=has_env_prefix, has_extra_args=has_extra_args)
    return _HookCmd("unresolved", None, has_env_prefix=has_env_prefix, has_extra_args=has_extra_args)


def _script_position(rest: list[str], root: Path) -> int | None:
    """index of the hook script in `rest` (tokens after any env prefix): the executable itself when
    it is a .py/.sh, else the first .py/.sh argument of a known interpreter/runner. None otherwise --
    a `.py`/`.sh` buried in an `echo`/`cat` argument is not a script invocation."""
    if not rest:
        return None
    if _expand_project_dir(rest[0], root).endswith((".py", ".sh")):
        return 0
    if Path(rest[0]).name in _INTERPRETERS:
        return next(
            (k for k in range(1, len(rest)) if _expand_project_dir(rest[k], root).endswith((".py", ".sh"))),
            None,
        )
    return None


def _expand_project_dir(token: str, root: Path) -> str:
    return _PROJECT_DIR_RE.sub(str(root), token)


def _pep723_requirements(content: str, ref: str, warnings: list[str]) -> list[str]:
    """extract PEP-723 inline `dependencies` from a python hook so they become hook requirements.
    archestra runs python hooks via `uv run --with <requirements>`, so declared deps must be carried."""
    deps = _extract_dependencies_block(content)
    if not deps:
        return []
    try:
        return validate_requirements(deps, ctx=ref)
    except ContractError as exc:
        warnings.append(f"{ref}: ignored unparseable PEP-723 dependencies -- {exc}")
        return []


# the start of a PEP-723 `dependencies = [ ... ]` array (minimal, stdlib-only: python 3.10 has no
# tomllib, and we only need this one key's list-of-strings).
_DEPS_START_RE = re.compile(r"^dependencies\s*=\s*\[", re.MULTILINE)


def _extract_dependencies_block(content: str) -> list[str]:
    lines = content.splitlines()
    try:
        start = lines.index("# /// script")
    except ValueError:
        return []
    end = next((k for k in range(start + 1, len(lines)) if lines[k] == "# ///"), None)
    if end is None:
        return []
    body: list[str] = []
    for line in lines[start + 1 : end]:
        if line.startswith("# "):
            body.append(line[2:])
        elif line == "#":
            body.append("")
        else:
            return []  # a non-comment line inside the block -> malformed, don't guess
    return _scan_dependency_strings("\n".join(body))


def _scan_dependency_strings(toml: str) -> list[str]:
    """pull the quoted requirement strings out of a `dependencies = [...]` array, scanning quote by
    quote so a `]` inside a value (e.g. `requests[security]`) does not truncate the array early."""
    match = _DEPS_START_RE.search(toml)
    if match is None:
        return []
    deps: list[str] = []
    i, n = match.end(), len(toml)
    while i < n:
        ch = toml[i]
        if ch == "]":
            break
        if ch == "#":  # toml comment: a quoted string inside it is not a requirement
            nl = toml.find("\n", i + 1)
            if nl == -1:
                break
            i = nl + 1
            continue
        if ch in "\"'":
            close = toml.find(ch, i + 1)
            if close == -1:
                break  # unterminated string -> malformed, stop
            deps.append(toml[i + 1 : close])
            i = close + 1
        else:
            i += 1
    return deps


def _discover_hooks(
    inv: Inventory, hooks: JsonValue, rel: str, root: Path, mark: Callable[[Path], None]
) -> None:
    hooks_obj = as_object(hooks)
    if hooks_obj is None:
        return
    for event, entries in hooks_obj.items():
        entries_arr = as_array(entries)
        if entries_arr is None:
            continue
        for i, entry in enumerate(entries_arr):
            entry_obj = as_object(entry)
            if entry_obj is None:
                continue
            matcher = _as_opt_str(entry_obj.get("matcher"))
            handlers_arr = as_array(entry_obj.get("hooks"))
            if handlers_arr is None:
                continue
            for j, h in enumerate(handlers_arr):
                h_obj = as_object(h)
                if h_obj is None:
                    continue
                raw_command = h_obj.get("command")
                command = redact_tokens(raw_command if isinstance(raw_command, str) else "")
                intent = _classify_hook(event, command)
                # the same event/indices can recur across .mcp.json and settings*.json,
                # so the config path is part of the id.
                inv.items.append(_build_hook_item(
                    inv, item_id=f"hook:{rel}:{event}:{i}:{j}", event=event, name=f"{event}#{i}.{j}",
                    rel=rel, matcher=matcher, command=command, intent=intent, root=root, mark=mark,
                ))


def _build_hook_item(
    inv: Inventory, *, item_id: str, event: str, name: str, rel: str, matcher: str | None,
    command: str, intent: HookIntent, root: Path, mark: Callable[[Path], None],
) -> HookItem:
    parsed = _parse_hook_command(command, root)
    files: list[BundledFile] = []
    file_name: str | None = None
    script_path: str | None = None
    requirements: list[str] = []

    if parsed.source == "bundled" and parsed.script is not None:
        bundled = _read_bundled(parsed.script, root)
        files = [bundled]
        file_name = parsed.script.name
        script_path = bundled.path
        mark(parsed.script)
        if bundled.encoding == "utf8":
            _warn_if_secret(bundled.content, script_path, inv.warnings)
            if parsed.script.suffix == ".py":
                requirements = _pep723_requirements(bundled.content, script_path, inv.warnings)

    target = archestra_hook_event(event)
    note = _hook_note(parsed, target)
    summary = f"{event} hook ({intent}, {parsed.source}){note}"
    return HookItem(
        id=item_id, name=name, path=rel, summary=summary,
        data=HookData(
            event=event, command=command, intent=intent, source=parsed.source, matcher=matcher,
            file_name=file_name, script_path=script_path, requirements=requirements,
        ),
        files=files,
    )


def _hook_note(parsed: _HookCmd, target: object) -> str:
    parts: list[str] = []
    if target is None:
        parts.append("event has no archestra equivalent -> manual")
    # only a bundled script loses its env prefix / extra argv on migration; an inline
    # command is carried verbatim into the wrapper, env assignments included.
    if parsed.source == "bundled" and (parsed.has_env_prefix or parsed.has_extra_args):
        parts.append("command sets env/args not migratable to a hook")
    if parsed.source == "unresolved":
        parts.append("command not resolvable to a runnable script -> manual")
    return f"; {'; '.join(parts)}" if parts else ""


def _hook_bucket(hook: HookItem) -> str:
    """which summary bucket a discovered hook falls into. an unmappable event or unresolvable script
    has no native-hook target -> manual. otherwise a guard needs review (native hook vs tool policy is
    a judgment call) and a non-guard migrates cleanly as a native hook."""
    mappable = archestra_hook_event(hook.data.event) is not None and hook.data.source != "unresolved"
    if not mappable:
        return "manual"
    return "review" if hook.data.intent == "guard" else "likely"


def _print_summary(inv: Inventory, out: Path) -> None:
    hooks = [it for it in inv.items if isinstance(it, HookItem)]
    likely = sum(1 for it in inv.items if it.kind in {"claude_md", "skill", "command", "local_tool"})
    likely += sum(1 for it in hooks if _hook_bucket(it) == "likely")
    review = sum(1 for it in inv.items if it.kind in {"subagent", "mcp_server"})
    review += sum(1 for it in hooks if _hook_bucket(it) == "review")
    manual = sum(1 for it in inv.items if it.kind == "openclaw")
    manual += sum(1 for it in hooks if _hook_bucket(it) == "manual")
    manual += len(inv.unknowns)
    redacted = sum(len(it.redacted_refs) for it in inv.items)

    likely_note = "agent prompt, skills, commands, local tools, native hooks"
    review_note = "subagents, MCP install choices, guard hooks"
    manual_note = "unsupported/unresolved hooks, openclaw, unknown files"
    print(_style(f"🔎 discovered {len(inv.items)} items; wrote {out}", "36;1"))
    counts = Counter(it.kind for it in inv.items)
    kinds = ", ".join(f"{kind}={count}" for kind, count in sorted(counts.items())) or "none"
    print(f"  inventory: {kinds}")
    print(f"  {_style('✅ likely migrates', '32;1')}: {likely} item(s) ({likely_note})")
    print(f"  {_style('⚠️  needs review', '33;1')}: {review} item(s) ({review_note})")
    print(f"  {_style('🛠️  manual/report-only', '34;1')}: {manual} item(s) ({manual_note})")
    safety = f"{redacted} structured value(s) redacted; {len(inv.warnings)} content warning(s)"
    print(f"  {_style('🔐 safety', '35;1')}: {safety}")
    for unknown in inv.unknowns:
        print(f"  unknown: {unknown}")
    for warning in inv.warnings:
        print(f"  warning: {warning}")
    print(_style("➡️  next: ask the migrate-to-archestra skill to draft a preview plan from this inventory.", "36;1"))
    print("      approve that plan before running apply.py against Archestra.")


def main() -> int:
    ap = argparse.ArgumentParser(description="discover an agentic setup into an inventory")
    ap.add_argument("source_dir", type=Path)
    ap.add_argument("--out", type=Path, default=Path("inventory.json"))
    args = ap.parse_args()

    root = args.source_dir.expanduser().resolve()
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 1

    inv = discover(root)
    args.out.write_text(json.dumps(to_jsonable(inv), indent=2), encoding="utf-8")
    _print_summary(inv, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
