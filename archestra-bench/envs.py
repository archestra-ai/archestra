"""Load benchmark environments from TOML.

An environment (`envs/<id>.toml`) bundles a single agent, a web-pinned skill surface, MCP fixtures,
and the tasks that run against it. This module parses and validates those files into the typed
configs the harness consumes; the in-memory task model lives in tasks.py (this module only builds it).

Validation is loud: any malformed or missing field raises SystemExit naming the offending file/task,
so a misconfigured environment never degrades into a silently partial run.
"""

from __future__ import annotations

import json
import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tasks import McpFixture, StagedFile, StageSpec, TaskConfig, TextReplacement, VerifierSpec

_DEFAULT_CAP = 10
_DEFAULT_MAX_FORMAT_ATTEMPTS = 3
_DEFAULT_SYSTEM_PROMPT = "You are an expert software engineer completing a benchmark task."
_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]*")


@dataclass(frozen=True)
class SkillRef:
    """a web skill ref imported pinned to `ref` (commit/branch/tag). `path` scopes discovery."""

    repo: str
    path: str | None
    ref: str
    cap: int = _DEFAULT_CAP


@dataclass(frozen=True)
class EnvConfig:
    """one environment: a single agent, its skill/mcp surface, and the tasks that run in it."""

    id: str
    name: str
    agent_name: str
    agent_system_prompt: str
    skills: tuple[SkillRef, ...]
    mcps: tuple[McpFixture, ...]
    tasks: tuple[TaskConfig, ...]


def load_envs(envs_dir: Path) -> dict[str, EnvConfig]:
    """Load every `envs/*.toml`, validating env ids are db-slug-safe and task ids globally unique.

    Paths inside a TOML (`upstream_dir`, `result_schema_file`) resolve relative to the bench root
    (the directory containing `envs/`)."""
    root = envs_dir.parent
    files = sorted(envs_dir.glob("*.toml"))
    if not files:
        raise SystemExit(f"no environment files found in {envs_dir}")
    envs: dict[str, EnvConfig] = {}
    task_owner: dict[str, str] = {}
    for path in files:
        env = _load_env(path, root)
        if env.id in envs:
            raise SystemExit(f"duplicate environment id {env.id!r} (in {path.name})")
        for task in env.tasks:
            if task.id in task_owner:
                raise SystemExit(
                    f"task id {task.id!r} is defined in both {task_owner[task.id]!r} and {env.id!r}; "
                    "task ids must be globally unique across environments"
                )
            task_owner[task.id] = env.id
        envs[env.id] = env
    return envs


# === per-env parsing ===


def _load_env(path: Path, root: Path) -> EnvConfig:
    ctx = path.name
    data = _parse_toml(path)
    env_id = _str(data, "id", ctx)
    if not _is_slug(env_id):
        raise SystemExit(f"{ctx}: env id {env_id!r} must be lowercase alphanumeric with dashes (db-slug-safe)")
    name = _str(data, "name", ctx, default=env_id)
    agent = _table(data, "agent", ctx, default={})
    agent_name = _str(agent, "name", f"{ctx} [agent]", default=f"{env_id}-agent")
    agent_prompt = _str(agent, "system_prompt", f"{ctx} [agent]", default=_DEFAULT_SYSTEM_PROMPT)
    skills = tuple(_skill_ref(row, f"{ctx} [[skills]]") for row in _rows(data, "skills", ctx))
    mcps = tuple(_mcp(row, f"{ctx} [[mcps]]") for row in _rows(data, "mcps", ctx))
    task_rows = _rows(data, "tasks", ctx)
    if not task_rows:
        raise SystemExit(f"{ctx}: environment {env_id!r} declares no tasks")
    tasks = tuple(_task(row, root, ctx) for row in task_rows)
    return EnvConfig(
        id=env_id,
        name=name,
        agent_name=agent_name,
        agent_system_prompt=agent_prompt,
        skills=skills,
        mcps=mcps,
        tasks=tasks,
    )


def _skill_ref(row: Mapping[str, Any], ctx: str) -> SkillRef:
    cap = _int(row, "cap", ctx, default=_DEFAULT_CAP)
    if cap < 1:
        raise SystemExit(f"{ctx}: cap must be >= 1, got {cap}")
    ref = _str(row, "ref", ctx)
    # the pin is carried as `.../tree/<ref>`, which cannot represent a ref containing a slash
    # (e.g. a `feature/x` branch) -- use a commit SHA or a slash-free tag.
    if "/" in ref:
        raise SystemExit(f"{ctx}: ref {ref!r} must not contain '/' (use a commit SHA or a slash-free tag)")
    return SkillRef(repo=_str(row, "repo", ctx), path=_opt_str(row, "path", ctx), ref=ref, cap=cap)


def _mcp(row: Mapping[str, Any], ctx: str) -> McpFixture:
    return McpFixture(name=_str(row, "name", ctx), server_url=_str(row, "server_url", ctx))


def _task(row: Mapping[str, Any], root: Path, env_ctx: str) -> TaskConfig:
    task_id = _str(row, "id", f"{env_ctx} [[tasks]]")
    ctx = f"{env_ctx} task {task_id!r}"
    upstream_dir = (root / _str(row, "upstream_dir", ctx)).resolve()
    if not upstream_dir.is_dir():
        raise SystemExit(f"{ctx}: upstream_dir {upstream_dir} does not exist")
    stage_rows = _rows(row, "stages", ctx)
    if not stage_rows:
        raise SystemExit(f"{ctx}: task declares no stages")
    max_attempts = _int(row, "max_format_attempts", ctx, default=_DEFAULT_MAX_FORMAT_ATTEMPTS)
    if max_attempts < 1:
        raise SystemExit(f"{ctx}: max_format_attempts must be >= 1, got {max_attempts}")
    return TaskConfig(
        id=task_id,
        upstream_dir=upstream_dir,
        stages=tuple(_stage(s, ctx) for s in stage_rows),
        result_schema=_result_schema(row, root, ctx),
        verifier=_verifier(_table(row, "verifier", ctx), f"{ctx} [verifier]"),
        mcps=tuple(_mcp(m, f"{ctx} [[mcps]]") for m in _rows(row, "mcps", ctx)),
        max_format_attempts=max_attempts,
    )


def _result_schema(row: Mapping[str, Any], root: Path, ctx: str) -> dict[str, Any]:
    inline, file = "result_schema" in row, "result_schema_file" in row
    if inline == file:
        raise SystemExit(f"{ctx}: set exactly one of result_schema (inline) or result_schema_file")
    if file:
        path = (root / _str(row, "result_schema_file", ctx)).resolve()
        try:
            schema = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(f"{ctx}: cannot read result_schema_file {path}: {exc}") from exc
    else:
        schema = row["result_schema"]
    if not isinstance(schema, dict):
        raise SystemExit(f"{ctx}: result_schema must be a JSON object")
    return schema


def _stage(row: Mapping[str, Any], ctx: str) -> StageSpec:
    text = _opt_str(row, "text", ctx) or ""
    instruction_file = _opt_str(row, "instruction_file", ctx)
    if not text and instruction_file is None:
        raise SystemExit(f"{ctx}: a stage needs at least one of text / instruction_file")
    return StageSpec(
        text=text,
        instruction_file=instruction_file,
        files=tuple(_staged_file(f, ctx) for f in _rows(row, "files", ctx)),
        text_replacements=tuple(_replacement(r, ctx) for r in _rows(row, "text_replacements", ctx)),
    )


def _staged_file(row: Mapping[str, Any], ctx: str) -> StagedFile:
    return StagedFile(
        upstream=_str(row, "upstream", ctx),
        dest=_str(row, "dest", ctx),
        mime_type=_str(row, "mime_type", ctx, default="application/octet-stream"),
    )


def _replacement(row: Mapping[str, Any], ctx: str) -> TextReplacement:
    return TextReplacement(frm=_str(row, "frm", ctx), to=_str(row, "to", ctx))


def _verifier(table: Mapping[str, Any], ctx: str) -> VerifierSpec:
    return VerifierSpec(
        deps=tuple(_strs(table, "deps", ctx)),
        test_file=_str(table, "test_file", ctx),
        data_file=_str(table, "data_file", ctx),
        report_env=_str(table, "report_env", ctx),
        data_env=_str(table, "data_env", ctx),
        env=_str_map(table, "env", ctx),
        oracle_file=_opt_str(table, "oracle_file", ctx),
        oracle_replacements=tuple(_replacement(r, ctx) for r in _rows(table, "oracle_replacements", ctx)),
    )


# === typed TOML accessors (each raises SystemExit on a type/shape mismatch) ===


def _parse_toml(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise SystemExit(f"{path.name}: cannot parse TOML: {exc}") from exc


def _is_slug(value: str) -> bool:
    return _SLUG_RE.fullmatch(value) is not None


def _str(d: Mapping[str, Any], key: str, ctx: str, *, default: str | None = None) -> str:
    value = d.get(key, default)
    if value is None:
        raise SystemExit(f"{ctx}: missing required string {key!r}")
    if not isinstance(value, str):
        raise SystemExit(f"{ctx}: {key!r} must be a string, got {type(value).__name__}")
    return value


def _opt_str(d: Mapping[str, Any], key: str, ctx: str) -> str | None:
    value = d.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise SystemExit(f"{ctx}: {key!r} must be a string, got {type(value).__name__}")
    return value


def _int(d: Mapping[str, Any], key: str, ctx: str, *, default: int) -> int:
    value = d.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise SystemExit(f"{ctx}: {key!r} must be an integer, got {type(value).__name__}")
    return value


def _table(d: Mapping[str, Any], key: str, ctx: str, *, default: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
    value = d.get(key, default)
    if value is None:
        raise SystemExit(f"{ctx}: missing required table [{key}]")
    if not isinstance(value, dict):
        raise SystemExit(f"{ctx}: [{key}] must be a table, got {type(value).__name__}")
    return value


def _rows(d: Mapping[str, Any], key: str, ctx: str) -> list[Mapping[str, Any]]:
    value = d.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise SystemExit(f"{ctx}: [[{key}]] must be an array of tables")
    return value


def _strs(d: Mapping[str, Any], key: str, ctx: str) -> list[str]:
    value = d.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise SystemExit(f"{ctx}: {key!r} must be an array of strings")
    return value


def _str_map(d: Mapping[str, Any], key: str, ctx: str) -> dict[str, str]:
    value = d.get(key, {})
    if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
        raise SystemExit(f"{ctx}: [{key}] must be a table of string values")
    return dict(value)
