"""Load benchmark environments from TOML.

An environment (`envs/<id>.toml`) bundles a single agent, a web-pinned skill surface, remote MCP
servers, and the ids of the tasks that run against it. Tasks themselves are self-contained under
`tasks/<id>/` (see tasks.py); the env only references them by id.

Validation is loud: any malformed or missing field raises SystemExit naming the offending file/task,
so a misconfigured environment never degrades into a silently partial run.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import tomlconf
from tasks import Task, load_task

_DEFAULT_SYSTEM_PROMPT = "You are an expert software engineer completing a benchmark task."
_TOOL_SHORT_RE = re.compile(r"[a-z][a-z0-9_]*")  # archestra built-in short name (e.g. create_skill)


@dataclass(frozen=True)
class SkillRef:
    """a web skill ref imported pinned to `ref` (commit/branch/tag). `path` scopes discovery.

    `cap` bounds how many discovered skills are imported; None imports all of them."""

    repo: str
    path: str | None
    ref: str
    cap: int | None = None


@dataclass(frozen=True)
class Mcp:
    """a remote (HTTP) MCP server the agent may use, seeded as a remote catalog item by URL."""

    name: str
    server_url: str


@dataclass(frozen=True)
class EnvConfig:
    """one environment: a single agent, its skill/mcp surface, and the tasks that run in it."""

    id: str
    name: str
    agent_name: str
    agent_system_prompt: str
    skills: tuple[SkillRef, ...]
    mcps: tuple[Mcp, ...]
    tasks: tuple[Task, ...]
    tools: tuple[str, ...] = ()  # extra archestra__* short names to assign (e.g. create_skill)
    # when true, all lanes of this env share one backend (seeded once); each lane still gets its own
    # agent + benchmark MCP. Only safe for envs whose tasks do NOT mutate shared backend state -- a
    # mutating env (e.g. one that creates/counts skills) must stay isolated (default) so concurrent
    # lanes never desync. See run.py's lane execution.
    share_backend: bool = False


def load_envs(envs_dir: Path) -> dict[str, EnvConfig]:
    """Load every `envs/*.toml`, validating env ids are db-slug-safe and task ids globally unique.

    Task ids referenced by an env resolve to `tasks/<id>/` under the bench root (the directory
    containing `envs/`)."""
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


def _load_env(path: Path, root: Path) -> EnvConfig:
    ctx = path.name
    data = tomlconf.parse_toml(path)
    env_id = tomlconf.req_str(data, "id", ctx)
    if not tomlconf.is_slug(env_id):
        raise SystemExit(f"{ctx}: env id {env_id!r} must be lowercase alphanumeric with dashes (db-slug-safe)")
    name = tomlconf.req_str(data, "name", ctx, default=env_id)
    agent = tomlconf.table(data, "agent", ctx, default={})
    agent_name = tomlconf.req_str(agent, "name", f"{ctx} [agent]", default=f"{env_id}-agent")
    agent_prompt = tomlconf.req_str(agent, "system_prompt", f"{ctx} [agent]", default=_DEFAULT_SYSTEM_PROMPT)
    skills = tuple(_skill_ref(row, f"{ctx} [[skills]]") for row in tomlconf.rows(data, "skills", ctx))
    mcps = _mcps(tomlconf.rows(data, "mcps", ctx), f"{ctx} [[mcps]]")
    task_ids = tomlconf.strs(data, "tasks", ctx)
    if not task_ids:
        raise SystemExit(f"{ctx}: environment {env_id!r} declares no tasks")
    for task_id in task_ids:
        if not tomlconf.is_slug(task_id):
            raise SystemExit(f"{ctx}: task id {task_id!r} must be lowercase alphanumeric with dashes (slug-safe)")
    tasks = tuple(load_task((root / "tasks" / task_id).resolve()) for task_id in task_ids)
    return EnvConfig(
        id=env_id,
        name=name,
        agent_name=agent_name,
        agent_system_prompt=agent_prompt,
        skills=skills,
        mcps=mcps,
        tasks=tasks,
        tools=_tool_names(tomlconf.strs(data, "tools", ctx), f"{ctx} tools"),
        share_backend=tomlconf.opt_bool(data, "share_backend", ctx),
    )


def _tool_names(names: list[str], ctx: str) -> tuple[str, ...]:
    """validate each extra tool is an archestra built-in short name; reject duplicates."""
    for name in names:
        if not _TOOL_SHORT_RE.fullmatch(name):
            raise SystemExit(f"{ctx}: tool {name!r} must be a lowercase archestra short name (e.g. create_skill)")
    if len(names) != len(set(names)):
        raise SystemExit(f"{ctx}: duplicate tool name(s) in {names}")
    return tuple(names)


def _skill_ref(row: Mapping[str, Any], ctx: str) -> SkillRef:
    cap = tomlconf.opt_int(row, "cap", ctx)
    if cap is not None and cap < 1:
        raise SystemExit(f"{ctx}: cap must be >= 1, got {cap}")
    ref = tomlconf.req_str(row, "ref", ctx)
    # the pin is carried as `.../tree/<ref>`, which cannot represent a ref containing a slash
    # (e.g. a `feature/x` branch) -- use a commit SHA or a slash-free tag.
    if "/" in ref:
        raise SystemExit(f"{ctx}: ref {ref!r} must not contain '/' (use a commit SHA or a slash-free tag)")
    return SkillRef(repo=tomlconf.req_str(row, "repo", ctx), path=tomlconf.opt_str(row, "path", ctx), ref=ref, cap=cap)


def _mcps(mcp_rows: list[Mapping[str, Any]], ctx: str) -> tuple[Mcp, ...]:
    mcps = tuple(
        Mcp(name=tomlconf.req_str(r, "name", ctx), server_url=tomlconf.req_str(r, "server_url", ctx))
        for r in mcp_rows
    )
    names = [m.name for m in mcps]
    if len(names) != len(set(names)):
        raise SystemExit(f"{ctx}: duplicate MCP name(s) in {names}")
    return mcps
