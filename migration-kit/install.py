#!/usr/bin/env python3
"""one-command installer for the migrate-to-archestra skill.

    curl -fsSL https://raw.githubusercontent.com/archestra-ai/archestra/main/migration-kit/install.py | python3

it downloads only the files needed to RUN the skill (SKILL.md + scripts/ + references/) via the
GitHub contents API -- a few hundred KB, not the whole repo -- and writes them into your Claude Code
skills directory. the skill can migrate a broader agentic pilot: Claude-style files, MCP config,
local tools, hooks, and similar hand-rolled setup artifacts. like the skill's own scripts, this
installer is zero-dependency: stock python>=3.10, no uv/pip, stdlib only.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

REPO = "archestra-ai/archestra"
DEFAULT_REF = "main"
KIT_SUBDIR = "migration-kit"
# only these are needed to RUN the skill, and they are the only paths the installer manages.
# tests/, pyproject.toml, this installer, and the README are contributor/meta artifacts.
MANAGED = ("SKILL.md", "scripts", "references")
SKILL_NAME = "migrate-to-archestra"
DEFAULT_DEST = Path.home() / ".claude" / "skills" / SKILL_NAME
CONTENTS_API = "https://api.github.com/repos/" + REPO + "/contents/{path}"
# requests must target these hosts (api for listings, raw for file bodies); nothing else.
GITHUB_HOSTS = ("https://api.github.com/", "https://raw.githubusercontent.com/")
FETCH_TIMEOUT_S = 30
MAX_TREE_DEPTH = 8  # the real tree nests one level; this just bounds a hostile/looping response.


class InstallError(RuntimeError):
    """a user-facing install failure; main() turns it into a clean message + non-zero exit."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """refuse to follow redirects, so a 3xx can never bounce a request to an unpinned host."""

    def http_error_302(self, req: urllib.request.Request, fp: object, code: int, msg: str,
                       headers: object) -> None:
        raise InstallError(f"refusing unexpected redirect ({code}) from {req.full_url}")

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


_OPENER = urllib.request.build_opener(_NoRedirect())


def _style(text: str, code: str) -> str:
    if sys.stdout.isatty() and "NO_COLOR" not in os.environ:
        return f"\033[{code}m{text}\033[0m"
    return text


def _http_get(url: str, allowed_hosts: tuple[str, ...]) -> bytes:
    # pin the host BEFORE opening so an attacker-supplied url can't reach an arbitrary host at all.
    if not url.startswith(allowed_hosts):
        raise InstallError(f"refusing request to unexpected host: {url}")
    # GitHub's API rejects requests without a User-Agent; default CA verification stays on.
    request = urllib.request.Request(url, headers={"User-Agent": f"{SKILL_NAME}-installer"})
    try:
        with _OPENER.open(request, timeout=FETCH_TIMEOUT_S) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise InstallError(f"GitHub returned HTTP {exc.code} for {url}") from exc
    except urllib.error.URLError as exc:
        raise InstallError(f"could not reach GitHub ({url}): {exc.reason}") from exc
    except (http.client.HTTPException, OSError) as exc:  # e.g. IncompleteRead, timeout, reset mid-read
        raise InstallError(f"download failed for {url}: {exc}") from exc


def _list_dir(path: str, ref: str, api: str, allowed_hosts: tuple[str, ...]) -> list[dict[str, object]]:
    query = urllib.parse.urlencode({"ref": ref})
    url = api.format(path=urllib.parse.quote(path, safe="/")) + "?" + query
    try:
        payload = json.loads(_http_get(url, allowed_hosts))
    except json.JSONDecodeError as exc:
        raise InstallError(f"invalid JSON listing for {path!r}: {exc}") from exc
    if not isinstance(payload, list):  # a file path returns an object; we only list directories
        raise InstallError(f"expected a directory listing at {path!r}")
    if not all(isinstance(item, dict) for item in payload):
        raise InstallError(f"malformed listing entry at {path!r}")
    return payload


def _valid_name(name: object) -> bool:
    return isinstance(name, str) and name not in ("", ".", "..") and "/" not in name and "\\" not in name


def _collect(entry: dict[str, object], rel: str, ref: str, api: str, allowed_hosts: tuple[str, ...],
             out: list[tuple[str, bytes]], depth: int) -> None:
    """recurse a contents-API entry, appending (path-relative-to-kit, bytes) for each file."""
    match entry.get("type"):
        case "file":
            url = entry.get("download_url")
            if not isinstance(url, str):
                raise InstallError(f"missing download url for {rel}")
            out.append((rel, _http_get(url, allowed_hosts)))
        case "dir":
            if depth >= MAX_TREE_DEPTH:
                raise InstallError(f"directory nesting too deep at {rel}")
            # reconstruct the listing path from our own validated rel -- never trust the API's path.
            for child in _list_dir(f"{KIT_SUBDIR}/{rel}", ref, api, allowed_hosts):
                name = child.get("name")
                if not _valid_name(name):
                    raise InstallError(f"invalid entry name under {rel}: {name!r}")
                _collect(child, f"{rel}/{name}", ref, api, allowed_hosts, out, depth + 1)
        case other:
            # symlink/submodule inside the runtime tree is never legitimate here.
            raise InstallError(f"unexpected entry type {other!r} at {rel}")


def fetch_kit_files(ref: str, *, api: str = CONTENTS_API,
                    allowed_hosts: tuple[str, ...] = GITHUB_HOSTS) -> list[tuple[str, bytes]]:
    """fetch just the runtime allowlist from migration-kit/, returning (rel_path, bytes) pairs."""
    out: list[tuple[str, bytes]] = []
    for entry in _list_dir(KIT_SUBDIR, ref, api, allowed_hosts):
        name = entry.get("name")
        if isinstance(name, str) and name in MANAGED:
            _collect(entry, name, ref, api, allowed_hosts, out, depth=0)
    if not out:
        raise InstallError(f"no runtime files found under {KIT_SUBDIR}/ for ref {ref!r} -- is the ref correct?")
    return out


def _is_managed(rel: str) -> bool:
    """exact-shape allowlist: the SKILL.md file, or anything under scripts/ or references/."""
    return rel == "SKILL.md" or rel in ("scripts", "references") or rel.startswith(("scripts/", "references/"))


def _clean_managed(dest: Path) -> None:
    """remove the paths the installer manages so --force can't leave stale files behind."""
    for name in MANAGED:
        path = dest / name
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)


def _safe_target(dest: Path, rel: str) -> Path:
    """resolve rel under dest, rejecting absolute/backslash paths and any '..' traversal."""
    if rel.startswith("/") or "\\" in rel:
        raise InstallError(f"refusing unsafe path: {rel!r}")
    pure = PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts:
        raise InstallError(f"refusing unsafe path: {rel!r}")
    dest_root = dest.resolve()
    target = (dest_root / pure).resolve()
    # belt-and-suspenders: even after the '..' check, confirm containment post-resolve.
    if target != dest_root and dest_root not in target.parents:
        raise InstallError(f"refusing path escaping destination: {rel!r}")
    return target


def write_kit(files: list[tuple[str, bytes]], dest: Path, force: bool) -> list[Path]:
    """write fetched (rel_path, bytes) pairs into dest.

    validation is a first pass that touches nothing on disk; only once every path is known-good do we
    mutate the destination. so a bad input can't leave a half-written install -- nor, under --force,
    delete the existing one before failing.
    """
    if dest.is_symlink():
        raise InstallError(f"destination is a symlink, refusing to install through it: {dest}")
    if dest.exists():
        if not dest.is_dir():
            raise InstallError(f"destination exists and is not a directory: {dest}")
        if any(dest.iterdir()) and not force:
            raise InstallError(f"destination is not empty: {dest} (pass --force to overwrite)")

    # pass 1 -- validate (path-safety before the allowlist, so the dangerous check runs first).
    planned: list[tuple[Path, bytes]] = []
    for rel, data in files:
        target = _safe_target(dest, rel)
        if not _is_managed(rel):
            raise InstallError(f"refusing path outside the runtime allowlist: {rel!r}")
        planned.append((target, data))

    # pass 2 -- commit; the destination is mutated only from here on.
    if force and dest.is_dir():
        _clean_managed(dest)
    written: list[Path] = []
    for target, data in planned:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        written.append(target)
    return written


def install(ref: str, dest: Path, force: bool) -> list[Path]:
    return write_kit(fetch_kit_files(ref), dest, force)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the migrate-to-archestra skill.")
    parser.add_argument("--ref", default=DEFAULT_REF, help=f"git ref to install from (default: {DEFAULT_REF})")
    parser.add_argument("--dest", type=Path, default=DEFAULT_DEST, help=f"install directory (default: {DEFAULT_DEST})")
    parser.add_argument("--force", action="store_true", help="overwrite an existing non-empty destination")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    try:
        written = install(args.ref, args.dest, args.force)
    except InstallError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(_style(f"✅ installed {len(written)} files into {args.dest}", "32;1"))
    print(_style("➡️  next: open Claude Code in the source project and ask:", "36;1"))
    print("      Use the migrate-to-archestra skill to migrate this pilot into my Archestra instance.")
    print("      If needed, include the source path and Archestra URL explicitly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
