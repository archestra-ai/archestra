"""Typed TOML accessors shared by the env loader (envs.py) and the task loader (tasks.py).

Validation is loud: a malformed or missing field raises SystemExit naming the offending context,
so a misconfigured benchmark never degrades into a silently partial run.
"""

from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]*")


def parse_toml(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise SystemExit(f"{path.name}: cannot parse TOML: {exc}") from exc


def is_slug(value: str) -> bool:
    return _SLUG_RE.fullmatch(value) is not None


def req_str(d: Mapping[str, Any], key: str, ctx: str, *, default: str | None = None) -> str:
    value = d.get(key, default)
    if value is None:
        raise SystemExit(f"{ctx}: missing required string {key!r}")
    if not isinstance(value, str):
        raise SystemExit(f"{ctx}: {key!r} must be a string, got {type(value).__name__}")
    return value


def opt_str(d: Mapping[str, Any], key: str, ctx: str) -> str | None:
    value = d.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise SystemExit(f"{ctx}: {key!r} must be a string, got {type(value).__name__}")
    return value


def req_int(d: Mapping[str, Any], key: str, ctx: str, *, default: int) -> int:
    value = d.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise SystemExit(f"{ctx}: {key!r} must be an integer, got {type(value).__name__}")
    return value


def opt_int(d: Mapping[str, Any], key: str, ctx: str) -> int | None:
    value = d.get(key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise SystemExit(f"{ctx}: {key!r} must be an integer, got {type(value).__name__}")
    return value


def opt_bool(d: Mapping[str, Any], key: str, ctx: str, *, default: bool = False) -> bool:
    value = d.get(key, default)
    if not isinstance(value, bool):
        raise SystemExit(f"{ctx}: {key!r} must be a boolean, got {type(value).__name__}")
    return value


def table(d: Mapping[str, Any], key: str, ctx: str, *, default: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
    value = d.get(key, default)
    if value is None:
        raise SystemExit(f"{ctx}: missing required table [{key}]")
    if not isinstance(value, dict):
        raise SystemExit(f"{ctx}: [{key}] must be a table, got {type(value).__name__}")
    return value


def rows(d: Mapping[str, Any], key: str, ctx: str) -> list[Mapping[str, Any]]:
    value = d.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise SystemExit(f"{ctx}: [[{key}]] must be an array of tables")
    return value


def strs(d: Mapping[str, Any], key: str, ctx: str) -> list[str]:
    value = d.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise SystemExit(f"{ctx}: {key!r} must be an array of strings")
    return value


def str_map(d: Mapping[str, Any], key: str, ctx: str) -> dict[str, str]:
    value = d.get(key, {})
    if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
        raise SystemExit(f"{ctx}: [{key}] must be a table of string values")
    return dict(value)
