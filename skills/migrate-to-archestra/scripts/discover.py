# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6", "pydantic>=2"]
# ///
"""discover an agentic setup and emit a structured, secret-redacted inventory.

pure parsing: no network, no code execution, no judgment. the model consumes the
inventory and decides the migration plan. stdio package resolution and remote-mcp
reachability are intentionally NOT checked here -- they first surface at apply time.

usage:
    uv run discover.py <source_dir> [--out inventory.json]
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel

SCHEMA_VERSION = 1
ItemKind = Literal[
    "claude_md", "subagent", "skill", "command", "local_tool", "mcp_server", "hook", "openclaw"
]

# key names whose values are redacted from structured config (never code/prose bodies).
_SECRET_KEY = re.compile(r"(key|token|secret|password|passwd|api[_-]?key|authorization|credential)", re.I)
# value shapes that look like credentials even under an innocuous key.
_SECRET_VALUE = re.compile(r"^(sk-|gh[psoru]_|xox[baprs]-|AIza|ya29\.|eyJ[A-Za-z0-9_-]{10,})")
# credential-shaped tokens embedded anywhere in a string (commands, prose, code).
_SECRET_TOKEN = re.compile(
    r"(sk-[A-Za-z0-9_-]{8,}|gh[psoru]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}"
    r"|AIza[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)


def _redact_inline(text: str) -> str:
    """replace credential-shaped tokens inside a config string (e.g. a hook command)."""
    return _SECRET_TOKEN.sub("<redacted>", text)


def _warn_if_secret(text: str, ref: str, warnings: list[str]) -> None:
    """flag (do NOT alter) a credential-shaped token in artifact content -- prose/code bodies
    and bundled files are migrated verbatim, so we surface the risk instead of corrupting them."""
    if _SECRET_TOKEN.search(text):
        warnings.append(f"possible secret left intact in {ref} -- review before sharing the inventory")


class BundledFile(BaseModel):
    path: str
    content: str
    encoding: Literal["utf8", "base64"]


class InventoryItem(BaseModel):
    id: str
    kind: ItemKind
    name: str
    path: str
    summary: str = ""
    data: dict[str, Any] = {}
    files: list[BundledFile] = []
    redacted_refs: list[str] = []


class Inventory(BaseModel):
    schema_version: int = SCHEMA_VERSION
    source_root: str
    items: list[InventoryItem] = []
    unknowns: list[str] = []
    warnings: list[str] = []


def _redact(value: Any, ref: str, sink: list[str]) -> Any:
    """recursively replace secret-looking values; record where each redaction happened."""
    match value:
        case dict():
            out = {}
            for k, v in value.items():
                if isinstance(v, str) and (_SECRET_KEY.search(k) or _SECRET_VALUE.match(v)):
                    out[k] = "<redacted>"
                    sink.append(f"{ref}#{k}")
                else:
                    out[k] = _redact(v, f"{ref}#{k}", sink)
            return out
        case list():
            return [_redact(v, f"{ref}[{i}]", sink) for i, v in enumerate(value)]
        case str() if _SECRET_VALUE.match(value):
            sink.append(ref)
            return "<redacted>"
        case _:
            return value


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """split a markdown doc into (yaml frontmatter dict, body)."""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            meta = yaml.safe_load(parts[1]) or {}
            return (meta if isinstance(meta, dict) else {}, parts[2].lstrip("\n"))
    return {}, text


def _read_bundled(path: Path, rel_to: Path) -> BundledFile:
    rel = path.relative_to(rel_to).as_posix()
    raw = path.read_bytes()
    try:
        return BundledFile(path=rel, content=raw.decode("utf-8"), encoding="utf8")
    except UnicodeDecodeError:
        return BundledFile(path=rel, content=base64.b64encode(raw).decode("ascii"), encoding="base64")


# events whose hooks can block the action -- candidates for a tool-invocation policy.
_BLOCKING_EVENTS = {"PreToolUse", "UserPromptSubmit", "PreCompact", "Stop", "SubagentStop"}


def _classify_hook(event: str, command: str) -> str:
    """advisory intent hint for the model: a deterministic guard vs passive logging.
    the guard logic often lives in a referenced script we don't read, so this is a HINT --
    the model must inspect the hook before deciding to translate it to a policy."""
    if event in _BLOCKING_EVENTS or re.search(r"sys\.exit\(\s*2\s*\)|exit 2", command):
        return "guard"
    return "passive"


def discover(root: Path) -> Inventory:
    inv = Inventory(source_root=str(root))
    seen: set[Path] = set()

    def mark(p: Path) -> None:
        seen.add(p.resolve())

    # 1. root CLAUDE.md -> primary agent
    for cm in (root / "CLAUDE.md", root / ".claude" / "CLAUDE.md"):
        if cm.is_file():
            meta, body = _parse_frontmatter(cm.read_text(encoding="utf-8", errors="replace"))
            rel = cm.relative_to(root).as_posix()
            _warn_if_secret(body, rel, inv.warnings)
            inv.items.append(InventoryItem(
                id="claude_md", kind="claude_md", name=root.name or "primary", path=rel,
                summary="root orchestration prompt -> primary agent system prompt",
                data={"body": body, "frontmatter": meta},
            ))
            mark(cm)
            break

    # 2. subagents -> skills (preferred)
    for f in sorted((root / ".claude" / "agents").glob("*.md")):
        meta, body = _parse_frontmatter(f.read_text(encoding="utf-8", errors="replace"))
        name = str(meta.get("name") or f.stem)
        tools = meta.get("tools")
        rel = f.relative_to(root).as_posix()
        _warn_if_secret(body, rel, inv.warnings)
        inv.items.append(InventoryItem(
            id=f"subagent:{name}", kind="subagent", name=name, path=rel,
            summary=str(meta.get("description") or "")[:200],
            data={"description": meta.get("description"), "tools": tools, "body": body},
        ))
        mark(f)

    # 3. skills -> skills (clean)
    for skill_md in sorted((root / ".claude" / "skills").glob("*/SKILL.md")):
        skill_dir = skill_md.parent
        meta, _ = _parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
        name = str(meta.get("name") or skill_dir.name)
        files = [
            _read_bundled(p, skill_dir)
            for p in sorted(skill_dir.rglob("*"))
            if p.is_file() and p != skill_md
        ]
        content = skill_md.read_text(encoding="utf-8", errors="replace")
        _warn_if_secret(content, skill_md.relative_to(root).as_posix(), inv.warnings)
        for bf in files:
            if bf.encoding == "utf8":
                _warn_if_secret(bf.content, f"{skill_dir.relative_to(root).as_posix()}/{bf.path}", inv.warnings)
        inv.items.append(InventoryItem(
            id=f"skill:{name}", kind="skill", name=name, path=skill_md.relative_to(root).as_posix(),
            summary=str(meta.get("description") or "")[:200],
            data={"content": content, "frontmatter": meta},
            files=files,
        ))
        for p in skill_dir.rglob("*"):
            mark(p)

    # 4. slash commands -> skills (best-effort)
    for f in sorted((root / ".claude" / "commands").glob("*.md")):
        meta, body = _parse_frontmatter(f.read_text(encoding="utf-8", errors="replace"))
        name = str(meta.get("name") or f.stem)
        rel = f.relative_to(root).as_posix()
        _warn_if_secret(body, rel, inv.warnings)
        inv.items.append(InventoryItem(
            id=f"command:{name}", kind="command", name=name, path=rel,
            summary=str(meta.get("description") or "")[:200],
            data={"frontmatter": meta, "body": body},
        ))
        mark(f)

    # 5. local python tools -> skills (best-effort). heuristic: *.py under a tools/ dir.
    for f in sorted((root / "tools").glob("*.py")):
        bundled = _read_bundled(f, root)
        if bundled.encoding == "utf8":
            _warn_if_secret(bundled.content, bundled.path, inv.warnings)
        inv.items.append(InventoryItem(
            id=f"local_tool:{f.stem}", kind="local_tool", name=f.stem,
            path=f.relative_to(root).as_posix(),
            summary=f"local python tool {f.name} -> skill wrapping the script",
            data={"entrypoint": f.relative_to(root).as_posix()}, files=[bundled],
        ))
        mark(f)

    # 6. mcp servers from .mcp.json and settings*.json
    for cfg_path in (root / ".mcp.json", root / ".claude" / "settings.json",
                     root / ".claude" / "settings.local.json"):
        if not cfg_path.is_file():
            continue
        mark(cfg_path)
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            inv.unknowns.append(f"{cfg_path.relative_to(root).as_posix()} (invalid json)")
            continue
        for name, spec in (cfg.get("mcpServers") or {}).items():
            refs: list[str] = []
            server_type = "remote" if spec.get("url") else "local"
            data = _redact(
                {"transport": server_type, "command": spec.get("command"),
                 "args": spec.get("args") or [], "env": spec.get("env") or {}, "url": spec.get("url")},
                f"mcp:{name}", refs,
            )
            inv.items.append(InventoryItem(
                id=f"mcp:{name}", kind="mcp_server", name=name,
                path=cfg_path.relative_to(root).as_posix(),
                summary=f"{server_type} mcp server -> catalog item (+ optional install)",
                data=data, redacted_refs=refs,
            ))
        # 6b. hooks live in settings.json
        for event, entries in (cfg.get("hooks") or {}).items():
            for i, entry in enumerate(entries if isinstance(entries, list) else []):
                for j, h in enumerate(entry.get("hooks", [])):
                    cmd = _redact_inline(str(h.get("command", "")))
                    intent = _classify_hook(event, cmd)
                    inv.items.append(InventoryItem(
                        id=f"hook:{event}:{i}:{j}", kind="hook", name=f"{event}#{i}.{j}",
                        path=cfg_path.relative_to(root).as_posix(),
                        summary=f"{event} hook ({intent})",
                        data={"event": event, "matcher": entry.get("matcher"),
                              "command": cmd, "intent": intent},
                    ))

    # 7. openclaw config -> report-only (schema unverified)
    for oc in (root / "openclaw.json", root / ".openclaw" / "openclaw.json"):
        if oc.is_file():
            mark(oc)
            refs2: list[str] = []
            try:
                raw = json.loads(oc.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                inv.unknowns.append(f"{oc.relative_to(root).as_posix()} (invalid json)")
                continue
            inv.items.append(InventoryItem(
                id="openclaw", kind="openclaw", name="openclaw",
                path=oc.relative_to(root).as_posix(),
                summary="openclaw runtime config -> report-only (manual migration)",
                data=_redact(raw, "openclaw", refs2), redacted_refs=refs2,
            ))

    # 8. unrecognized files under .claude/ -> surface for the model
    claude_dir = root / ".claude"
    if claude_dir.is_dir():
        for p in sorted(claude_dir.rglob("*")):
            if p.is_file() and p.resolve() not in seen:
                inv.unknowns.append(p.relative_to(root).as_posix())

    return inv


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
    args.out.write_text(inv.model_dump_json(indent=2), encoding="utf-8")
    kinds = sorted({it.kind for it in inv.items})
    print(f"discovered {len(inv.items)} items ({', '.join(kinds) or 'none'}); "
          f"{len(inv.unknowns)} unknown; {len(inv.warnings)} warning(s); wrote {args.out}")
    for w in inv.warnings:
        print(f"  warning: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
